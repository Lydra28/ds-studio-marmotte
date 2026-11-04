// Application Hono du serveur DS-Studio, construite à partir de ses
// dépendances (base, mails, horloge…) pour être testée sans réseau ni
// processus. Routes sous `/v1`, réponses JSON, erreurs `{ error }` (cadrage
// §3 O2-O3, plan du lot 2). `index.ts` l'alimente et la sert.
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { authRoutes, COOKIE, requireAccount } from './auth.js';
import { billingMode, billingRoutes, catalog } from './billing.js';
import { ApiError, clock, type Deps } from './core.js';
import { effectiveTier, issueLicense } from './license.js';
import { relayRoutes, usageSummary } from './relay.js';

export { ApiError, type Deps } from './core.js';

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

  // Site vitrine (lot 7) : seule origine admise par CORS, avec cookie, et
  // seulement sur les routes du compte. Écriture portée par le cookie
  // (sans en-tête Authorization) : refusée si l'origine n'est pas le site,
  // en plus de SameSite=Lax (sous-domaines voisins compris).
  const siteOrigin = deps.siteUrl ? new URL(deps.siteUrl).origin : null;
  const SITE_ROUTES = /^\/v1\/(auth\/[a-z]+|me|billing\/(checkout|portal))$/;
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

  app.get('/v1/health', async (c) => {
    const { rows } = await deps.db.query<{ value: string }>("SELECT value FROM app_meta WHERE key = 'schema'");
    return c.json({ ok: true, version: deps.version, schema: rows[0]?.value ?? null, at: clock(deps)().toISOString() });
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
