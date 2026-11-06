// Point d'entrée du serveur (Render ou `npm run dev:server`) : variables
// d'environnement, migrations, puis écoute. Secrets uniquement dans
// l'environnement (Render) ou `server/.env` en local, jamais dans le dépôt.
import { serve } from '@hono/node-server';
import * as Sentry from '@sentry/node';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { stripeClient } from './billing.js';
import { memoryDb, migrate, pgDb, waitForDb } from './db.js';
import { generateKeys, loadKeys, type LicenseKeys } from './license.js';
import { consoleMailer, resendMailer } from './mail.js';
import { formatPurge, purge } from './retention.js';

const env = process.env;

// Dossier `server/`, que l'on tourne depuis les sources (`server/index.ts`)
// ou depuis le bundle (`server/dist/index.mjs`) : celui qui porte le
// package.json du serveur.
async function serverDir(): Promise<URL> {
  for (const rel of ['./', '../']) {
    const dir = new URL(rel, import.meta.url);
    try {
      const pkg = JSON.parse(await readFile(new URL('package.json', dir), 'utf8')) as { name?: string };
      if (pkg.name === 'ds-studio-server') return dir;
    } catch {
      /* pas ici */
    }
  }
  throw new Error('server/package.json introuvable');
}
const dir = await serverDir();

if (!env.DATABASE_URL) {
  try {
    process.loadEnvFile(new URL('.env', dir));
  } catch {
    /* Pas de server/.env : l'environnement doit tout fournir. */
  }
}
const required = (name: string) => {
  const value = env[name];
  if (!value) {
    console.error(`Variable ${name} manquante.`);
    process.exit(1);
  }
  return value;
};

const pkg = JSON.parse(await readFile(new URL('package.json', dir), 'utf8')) as { version: string };
const version = `${pkg.version}${env.RENDER_GIT_COMMIT ? '+' + env.RENDER_GIT_COMMIT.slice(0, 7) : ''}`;

// Sentry : erreurs inattendues seulement (pas de traces, pas de données
// personnelles). `SENTRY_TEST_EVENT=1` envoie un message au démarrage pour
// vérifier le branchement, à retirer ensuite.
const sentryDsn = env.SENTRY_DSN || '';
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    release: `ds-studio-server@${version}`,
    environment: env.RENDER ? 'production' : 'development',
    tracesSampleRate: 0,
  });
  if (env.SENTRY_TEST_EVENT) Sentry.captureMessage(`Test Sentry au démarrage de ${version}`);
}

// `DATABASE_URL=memory` : Postgres en mémoire (PGlite, dépendance de
// développement), pour `npm run dev:server` sans base installée ; tout est
// perdu à l'arrêt. Render fournit une vraie URL.
const url = required('DATABASE_URL');
const db = url === 'memory' ? await memoryDb() : await pgDb(url);
if (url === 'memory') console.warn('Base en mémoire : données perdues à l’arrêt (développement seulement).');
else await waitForDb(db);
// Dossier des migrations résolu depuis `server/`, pas depuis le bundle.
const applied = await migrate(db, fileURLToPath(new URL('migrations/', dir)));
if (applied.length) console.log(`Migrations appliquées : ${applied.join(', ')}`);

const port = Number(env.PORT ?? 8787);
// Mails : Resend avec sa clé ; sans clé (développement), les mails et leurs
// liens s'écrivent dans la console.
const mailer = env.RESEND_API_KEY
  ? resendMailer(env.RESEND_API_KEY, env.MAIL_FROM ?? 'DS-Studio <no-reply@design-system-studio.fr>')
  : consoleMailer();
// Clé de signature des licences : PEM Ed25519 dans l'environnement. Sans
// elle (développement), une paire éphémère : les licences émises ne
// survivent pas au redémarrage.
let keys: LicenseKeys;
if (env.LICENSE_PRIVATE_KEY) {
  keys = loadKeys(env.LICENSE_PRIVATE_KEY);
  // La clé publique embarquée dans l'app (`server/license-public.pem`, suivie
  // par git) doit être celle de la clé privée du serveur, sinon aucune licence
  // émise ne sera acceptée : on refuse de démarrer.
  const committed = await readFile(new URL('license-public.pem', dir), 'utf8').catch(() => '');
  if (committed && committed.trim() !== keys.publicKeyPem.trim()) {
    console.error('LICENSE_PRIVATE_KEY ne correspond pas à server/license-public.pem : licences invalides, arrêt.');
    process.exit(1);
  }
} else {
  keys = generateKeys();
  console.warn('LICENSE_PRIVATE_KEY absente : clé de licence éphémère (développement seulement).');
}
// Clé OpenRouter du serveur (dédiée, avec limite de dépense) : sans elle,
// le relais répond 503 et le reste fonctionne.
const openRouterKey = env.OPENROUTER_API_KEY ?? '';
if (!openRouterKey) console.warn('OPENROUTER_API_KEY absente : relais OpenRouter désactivé (503).');
// Stripe (lot 4) : clé secrète et secret de signature du webhook, test ou
// live ensemble ; sans eux, les routes de paiement répondent 503.
const stripeKey = env.STRIPE_SECRET_KEY ?? '';
const stripeWebhookSecret = env.STRIPE_WEBHOOK_SECRET ?? '';
if (!stripeKey || !stripeWebhookSecret) console.warn('STRIPE_SECRET_KEY ou STRIPE_WEBHOOK_SECRET absente : paiement désactivé (503).');
else console.log(`Stripe en mode ${stripeKey.startsWith('sk_live_') ? 'LIVE' : 'test'}.`);
const siteUrl = env.SITE_URL ? env.SITE_URL.replace(/\/+$/, '') : undefined;
const app = createApp({
  db,
  mailer,
  keys,
  openRouter: { apiKey: openRouterKey },
  billing:
    stripeKey && stripeWebhookSecret
      ? {
          client: stripeClient(stripeKey),
          webhookSecret: stripeWebhookSecret,
          live: stripeKey.startsWith('sk_live_'),
          termsConsent: env.STRIPE_TERMS_CONSENT === '1',
        }
      : undefined,
  publicUrl: (env.API_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, ''),
  cookieDomain: env.COOKIE_DOMAIN || undefined,
  siteUrl,
  // Rétractations (server/withdrawal.ts) : adresse de contact publique des mentions légales par défaut.
  adminEmail: env.ADMIN_EMAIL || 'aubertromain85@gmail.com',
  version,
  report: sentryDsn ? (err) => Sentry.captureException(err) : undefined,
});
const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
  console.log(`Serveur DS-Studio ${version} sur le port ${port}`);
});

// Durées de conservation (server/retention.ts) : une minute après le
// démarrage puis chaque jour ; chaque redéploiement relance un passage.
const runPurge = () =>
  purge(db, mailer, new Date(), siteUrl).then(
    (r) => {
      console.log(`Conservation : ${formatPurge(r)}`);
      if (r.errors.length && sentryDsn) Sentry.captureMessage(`Conservation : ${r.errors.length} erreur(s)`);
    },
    (err) => {
      console.error('Conservation en échec :', err);
      if (sentryDsn) Sentry.captureException(err);
    },
  );
setTimeout(runPurge, 60_000).unref();
setInterval(runPurge, 24 * 3600_000).unref();

// Arrêt propre (Render envoie SIGTERM au redéploiement).
const stop = () => {
  server.close(() => {
    Promise.all([db.close(), sentryDsn ? Sentry.flush(2000) : null]).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
