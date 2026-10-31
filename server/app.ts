// Application Hono du serveur DS-Studio, construite à partir de ses
// dépendances (base, mails, horloge…) pour être testée sans réseau ni
// processus. Routes sous `/v1`, réponses JSON, erreurs `{ error }` (cadrage
// §3 O2-O3, plan du lot 2). `index.ts` l'alimente et la sert.
import { Hono } from 'hono';
import { authRoutes, requireAccount } from './auth.js';
import { ApiError, clock, type Deps } from './core.js';
import { issueLicense } from './license.js';
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

  app.get('/v1/health', async (c) => {
    const { rows } = await deps.db.query<{ value: string }>("SELECT value FROM app_meta WHERE key = 'schema'");
    return c.json({ ok: true, version: deps.version, schema: rows[0]?.value ?? null, at: clock(deps)().toISOString() });
  });

  app.route('/v1/auth', authRoutes(deps));

  // Le compte de la session et son usage : ce que l'app affiche dans
  // Réglages (lot 3). Centimes de dollar (crédits OpenRouter).
  app.get('/v1/me', async (c) => {
    const me = await account(c);
    const usage = await usageSummary(deps.db, me, clock(deps)());
    return c.json({
      ...me,
      usage: {
        todayCents: usage.todayCents,
        monthCents: usage.monthCents,
        resetAt: usage.resetAt,
        includedLeftCents: Math.max(0, me.monthlyIncludedCents - usage.monthProCents),
      },
    });
  });

  app.route('/v1/relay', relayRoutes(deps));

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
