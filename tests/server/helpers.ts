// Base de test : PGlite en mémoire par défaut (aucun serveur à installer) ;
// avec `DATABASE_URL`, les mêmes tests tournent sur un vrai Postgres (job
// `server` de la CI), chaque test dans un schéma jetable. Mails dans une
// boîte en mémoire. Tests sans réseau.
import { randomBytes } from 'node:crypto';
import { createApp, type Deps } from '../../server/app.js';
import { memoryDb, migrate, pgDb, type Db } from '../../server/db.js';
import { generateKeys } from '../../server/license.js';
import { memoryMailer } from '../../server/mail.js';

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

export const T0 = new Date('2026-10-31T12:00:00Z');

export async function testApp(overrides: Partial<Deps> = {}) {
  const db = overrides.db ?? (await testDb());
  const mailer = memoryMailer();
  // Horloge réglable : `tick(ms)` avance le temps vu par le serveur.
  let t = T0.getTime();
  const tick = (ms: number) => (t += ms);
  const keys = generateKeys();
  const app = createApp({ db, mailer, keys, publicUrl: 'http://server.test', version: 'test', now: () => new Date(t), ...overrides });
  const api = async (path: string, init: RequestInit & { json?: unknown; token?: string } = {}) => {
    const { json, token, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (json !== undefined) headers.set('content-type', 'application/json');
    if (token) headers.set('authorization', `Bearer ${token}`);
    const res = await app.request('http://server.test' + path, {
      ...rest,
      method: rest.method ?? (json !== undefined ? 'POST' : 'GET'),
      headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = { html: text };
    }
    return { status: res.status, body, headers: res.headers };
  };
  return { app, db, api, mailer, keys, tick, now: () => new Date(t), close: () => db.close() };
}

// Le dernier mail reçu par une adresse, et le jeton qu'il contient (lien ou code).
export function lastToken(mailer: ReturnType<typeof memoryMailer>, to: string) {
  const mail = [...mailer.sent].reverse().find((m) => m.to === to);
  if (!mail) throw new Error(`aucun mail pour ${to}`);
  const link = /token=([A-Za-z0-9_-]+)/.exec(mail.text);
  if (link) return link[1];
  const code = /^([A-Za-z0-9_-]{30,})$/m.exec(mail.text);
  if (!code) throw new Error('pas de jeton dans le mail : ' + mail.text);
  return code[1];
}
