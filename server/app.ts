// Application Hono du serveur DS-Studio, construite à partir de ses
// dépendances (base, mails, horloge…) pour être testée sans réseau ni
// processus. Routes sous `/v1`, réponses JSON, erreurs `{ error }` (cadrage
// §3 O2-O3, plan du lot 2). `index.ts` l'alimente et la sert.
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import { authRoutes, COOKIE, requireAccount } from './auth.js';
import { billingMode, billingRoutes, catalog } from './billing.js';
import { ApiError, clock, ORIGIN_HEADER, originCheck, type Deps } from './core.js';
import { effectiveTier, issueLicense } from './license.js';
import { relayRoutes, usageSummary } from './relay.js';
import { withdrawalRoutes } from './withdrawal.js';

export { ApiError, type Deps } from './core.js';

/** Corps JSON des routes hors relais (compte, paiement, rétractation) : quelques champs courts. */
export const MAX_JSON_BYTES = 64 * 1024;
/** Événement Stripe, corps brut signé : quelques Ko, des dizaines pour une grosse facture. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;

export function createApp(deps: Deps) {
  const app = new Hono();
  const account = requireAccount(deps);

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    deps.report?.(err);
    return c.json({ error: 'Erreur interne du serveur DS-Studio.' }, 500);
  });
  app.notFound((c) => c.json({ error: 'Route inconnue.' }, 404));

  // Secret d'origine (revue du 2026-11-13, n° 9) : une requête sans le secret
  // que Cloudflare ajoute est venue en direct par l'URL onrender.com, où l'IP
  // du client (`CF-Connecting-IP`) se falsifie. Premier temps : noté (au plus
  // une ligne par minute, sans le secret) ; second temps (`enforce`) : 403.
  // `/v1/health` reste ouvert : Render le sonde en direct.
  let unverified = 0;
  let unverifiedLoggedAt = 0;
  app.use('/v1/*', async (c, next) => {
    if (c.req.path === '/v1/health') return next();
    if (originCheck(deps, c.req.header(ORIGIN_HEADER)) !== 'bad') return next();
    if (deps.originSecret?.enforce) return c.json({ error: 'Accès direct refusé : passer par api.design-system-studio.fr.' }, 403);
    unverified++;
    const at = clock(deps)().getTime();
    if (at - unverifiedLoggedAt >= 60_000) {
      // Chemin entre guillemets et échappé : un appelant direct ne peut pas écrire de fausses lignes.
      console.warn(`Secret d'origine absent ou faux : ${unverified} requête(s) servie(s) quand même depuis la dernière ligne, dernière ${c.req.method} ${JSON.stringify(c.req.path.slice(0, 200))}.`);
      unverified = 0;
      unverifiedLoggedAt = at;
    }
    return next();
  });

  // Site vitrine (lot 7) : seule origine admise par CORS, avec cookie, et
  // seulement sur les routes du compte. Écriture portée par le cookie
  // (sans en-tête Authorization) : refusée si l'origine n'est pas le site,
  // en plus de SameSite=Lax (sous-domaines voisins compris).
  const siteOrigin = deps.siteUrl ? new URL(deps.siteUrl).origin : null;
  const SITE_ROUTES = /^\/v1\/(auth\/[a-z]+|auth\/app-link\/approve|me|billing\/(checkout|portal|withdrawals|withdraw))$/;
  app.use('/v1/*', async (c, next) => {
    const origin = c.req.header('origin');
    const allowed = siteOrigin !== null && origin === siteOrigin && SITE_ROUTES.test(c.req.path);
    if (c.req.method === 'OPTIONS') {
      if (!allowed) return c.json({ error: 'Origine refusée.' }, 403);
      return c.body(null, 204, {
        'access-control-allow-origin': siteOrigin,
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
        vary: 'Origin',
      });
    }
    const write = c.req.method !== 'GET' && c.req.method !== 'HEAD';
    if (write && !c.req.header('authorization') && getCookie(c, COOKIE) && !allowed)
      return c.json({ error: 'Origine refusée.' }, 403);
    await next();
    if (allowed) {
      c.header('access-control-allow-origin', siteOrigin);
      c.header('access-control-allow-credentials', 'true');
      c.header('vary', 'Origin');
    }
  });

  // Taille des corps (revue du 2026-11-13, n° 9) : sans borne, quelques
  // requêtes de 100 Mo, sans compte, saturaient la mémoire du service. Le
  // relais garde la sienne (images du Mur, `MAX_BODY_BYTES` de relay.ts).
  // Après le CORS : le site lit le 413 au lieu d'une erreur d'origine.
  const tooLarge = (c: Context) => c.json({ error: 'Requête trop lourde.' }, 413);
  const jsonLimit = bodyLimit({ maxSize: MAX_JSON_BYTES, onError: tooLarge });
  const webhookLimit = bodyLimit({ maxSize: MAX_WEBHOOK_BYTES, onError: tooLarge });
  app.use('/v1/*', (c, next) => {
    if (c.req.path.startsWith('/v1/relay/')) return next();
    return (c.req.path === '/v1/billing/webhook' ? webhookLimit : jsonLimit)(c, next);
  });

  app.get('/v1/health', async (c) => {
    const { rows } = await deps.db.query<{ value: string }>("SELECT value FROM app_meta WHERE key = 'schema'");
    // `origin` : vérification du secret pour cette requête même (off, ok, bad), sans rien
    // révéler du secret ; sert à prouver la règle Cloudflare avant de passer au refus.
    const origin = originCheck(deps, c.req.header(ORIGIN_HEADER));
    const guard = !deps.originSecret ? 'off' : deps.originSecret.enforce ? 'refus' : 'journal';
    return c.json({ ok: true, version: deps.version, schema: rows[0]?.value ?? null, at: clock(deps)().toISOString(), origin, guard });
  });

  app.route('/v1/auth', authRoutes(deps));

  // Le compte de la session et son usage : ce que l'app affiche dans
  // Réglages (lot 3). Coûts en centimes de dollar ; soldes (creditCents,
  // includedLeftCents) en centimes d'euro (lot 4).
  app.get('/v1/me', async (c) => {
    const me = await account(c);
    const usage = await usageSummary(deps.db, me, clock(deps)());
    const { stripeCustomerId: _customer, stripeSubscriptionId: _subscription, ...pub } = me;
    return c.json({
      ...pub,
      tier: effectiveTier(me),
      // Crédit de bienvenue encore entier : l'app affiche « une génération offerte ».
      welcome: me.welcomeCreditedAt !== null && !usage.usedCredits,
      subscription: me.subscriptionStatus
        ? { status: me.subscriptionStatus, currentPeriodEnd: me.currentPeriodEnd, cancelAtPeriodEnd: me.cancelAtPeriodEnd }
        : null,
      usage: {
        todayCents: usage.todayCents,
        monthCents: usage.monthCents,
        resetAt: usage.resetAt,
        includedLeftCents: Math.max(0, me.monthlyIncludedCents - usage.includedUsedCents),
      },
      // Prix et repères du moment (lot 7) : l'app n'en garde aucune copie.
      catalog: catalog(billingMode(deps.billing)),
    });
  });

  app.route('/v1/relay', relayRoutes(deps));
  app.route('/v1/billing', billingRoutes(deps));
  // Rétractation : sans Stripe configuré aussi (le registre des achats suffit).
  app.route('/v1/billing', withdrawalRoutes(deps));

  // Licence signée, renouvelée par l'app à chaque lancement connecté ; la clé
  // publique est aussi servie pour vérification croisée.
  app.post('/v1/license', async (c) => {
    const me = await account(c);
    const { token, payload } = issueLicense(deps.keys, me, clock(deps)());
    return c.json({
      license: token,
      expiresAt: new Date(payload.exp).toISOString(),
      graceUntil: new Date(payload.grace).toISOString(),
      tier: payload.tier,
    });
  });
  app.get('/v1/license/key', (c) => c.json({ alg: 'Ed25519', publicKey: deps.keys.publicKeyPem }));

  return app;
}

export type App = ReturnType<typeof createApp>;
