// Point d'entrée du serveur (Render ou `npm run dev:server`) : variables
// d'environnement, migrations, puis écoute. Secrets uniquement dans
// l'environnement (Render) ou `server/.env` en local, jamais dans le dépôt.
import { serve } from '@hono/node-server';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { memoryDb, migrate, pgDb } from './db.js';
import { consoleMailer, resendMailer } from './mail.js';

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

// `DATABASE_URL=memory` : Postgres en mémoire (PGlite, dépendance de
// développement), pour `npm run dev:server` sans base installée ; tout est
// perdu à l'arrêt. Render fournit une vraie URL.
const url = required('DATABASE_URL');
const db = url === 'memory' ? await memoryDb() : await pgDb(url);
if (url === 'memory') console.warn('Base en mémoire : données perdues à l’arrêt (développement seulement).');
// Dossier des migrations résolu depuis `server/`, pas depuis le bundle.
const applied = await migrate(db, fileURLToPath(new URL('migrations/', dir)));
if (applied.length) console.log(`Migrations appliquées : ${applied.join(', ')}`);

const port = Number(env.PORT ?? 8787);
// Mails : Resend avec sa clé ; sans clé (développement), les mails et leurs
// liens s'écrivent dans la console.
const mailer = env.RESEND_API_KEY
  ? resendMailer(env.RESEND_API_KEY, env.MAIL_FROM ?? 'DS-Studio <no-reply@design-system-studio.fr>')
  : consoleMailer();
const app = createApp({
  db,
  mailer,
  publicUrl: (env.API_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, ''),
  cookieDomain: env.COOKIE_DOMAIN || undefined,
  version,
});
const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
  console.log(`Serveur DS-Studio ${version} sur le port ${port}`);
});

// Arrêt propre (Render envoie SIGTERM au redéploiement).
const stop = () => {
  server.close(() => {
    db.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
