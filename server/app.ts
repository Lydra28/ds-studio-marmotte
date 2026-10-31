// Application Hono du serveur DS-Studio, construite à partir de ses
// dépendances (base, horloge…) pour être testée sans réseau ni processus.
// Routes sous `/v1`, réponses JSON, erreurs `{ error }` (cadrage §3 O2-O3,
// plan du lot 2). `index.ts` l'alimente avec Postgres et la sert.
import { Hono } from 'hono';
import type { Db } from './db.js';

export interface Deps {
  db: Db;
  /** Version affichée par /v1/health (paquet + commit déployé). */
  version: string;
  now?: () => Date;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function createApp(deps: Deps) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: 'Erreur interne du serveur DS-Studio.' }, 500);
  });
  app.notFound((c) => c.json({ error: 'Route inconnue.' }, 404));

  app.get('/v1/health', async (c) => {
    const { rows } = await deps.db.query<{ value: string }>("SELECT value FROM app_meta WHERE key = 'schema'");
    return c.json({ ok: true, version: deps.version, schema: rows[0]?.value ?? null, at: (deps.now ?? (() => new Date()))().toISOString() });
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
