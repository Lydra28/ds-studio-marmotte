// Base de test : PGlite en mémoire par défaut (aucun serveur à installer) ;
// avec `DATABASE_URL`, les mêmes tests tournent sur un vrai Postgres (job
// `server` de la CI), chaque test dans un schéma jetable. Tests sans réseau.
import { randomBytes } from 'node:crypto';
import { createApp, type Deps } from '../../server/app.js';
import { memoryDb, migrate, pgDb, type Db } from '../../server/db.js';

export async function testDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    const db = await memoryDb();
    await migrate(db);
    return db;
  }
  const schema = 'test_' + randomBytes(6).toString('hex');
  const db = await pgDb(url);
  await db.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
  const scoped: Db = {
    query: (text, params) => db.query(text, params),
    exec: (sql) => db.exec(sql),
    close: async () => {
      await db.exec(`DROP SCHEMA ${schema} CASCADE`);
      await db.close();
    },
  };
  await migrate(scoped);
  return scoped;
}

export async function testApp(overrides: Partial<Deps> = {}) {
  const db = overrides.db ?? (await testDb());
  const app = createApp({ db, version: 'test', now: () => new Date('2026-10-31T12:00:00Z'), ...overrides });
  const api = async (path: string, init?: RequestInit) => {
    const res = await app.request('http://server.test' + path, init);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body, headers: res.headers };
  };
  return { app, db, api, close: () => db.close() };
}
