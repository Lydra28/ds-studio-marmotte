// Application Hono du serveur DS-Studio, construite à partir de ses
// dépendances (base, mails, horloge…) pour être testée sans réseau ni
// processus. Routes sous `/v1`, réponses JSON, erreurs `{ error }` (cadrage
// §3 O2-O3, plan du lot 2). `index.ts` l'alimente et la sert.
import { Hono } from 'hono';
import { authRoutes, requireAccount } from './auth.js';
import { ApiError, clock, type Deps } from './core.js';

export { ApiError, type Deps } from './core.js';

export function createApp(deps: Deps) {
  const app = new Hono();
  const account = requireAccount(deps);

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: 'Erreur interne du serveur DS-Studio.' }, 500);
  });
  app.notFound((c) => c.json({ error: 'Route inconnue.' }, 404));

  app.get('/v1/health', async (c) => {
    const { rows } = await deps.db.query<{ value: string }>("SELECT value FROM app_meta WHERE key = 'schema'");
    return c.json({ ok: true, version: deps.version, schema: rows[0]?.value ?? null, at: clock(deps)().toISOString() });
  });

  app.route('/v1/auth', authRoutes(deps));

  // Le compte de la session : ce que l'app affiche dans Réglages (lot 3).
  app.get('/v1/me', async (c) => c.json(await account(c)));

  return app;
}

export type App = ReturnType<typeof createApp>;
