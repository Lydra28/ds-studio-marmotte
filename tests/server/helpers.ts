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
  // Un schéma jetable par test, posé dans le `search_path` de chaque
  // connexion du pool (paramètre `options` de l'URL) : un `SET` ne tiendrait
  // que sur une connexion, et pg-pool jette celle d'une requête en erreur.
  const schema = 'test_' + randomBytes(6).toString('hex');
  const admin = await pgDb(url);
  await admin.exec(`CREATE SCHEMA ${schema}`);
  await admin.close();
  const db = await pgDb(`${url}${url.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`);
  const scoped: Db = {
    query: (text, params) => db.query(text, params),
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn),
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
  const openRouter = fakeOpenRouter();
  const app = createApp({
    db,
    mailer,
    keys,
    openRouter: { apiKey: 'test-key', fetch: openRouter.fetch },
    publicUrl: 'http://server.test',
    version: 'test',
    now: () => new Date(t),
    ...overrides,
  });
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
  return { app, db, api, mailer, keys, openRouter, tick, now: () => new Date(t), close: () => db.close() };
}
export type TestApp = Awaited<ReturnType<typeof testApp>>;

// Inscription, adresse confirmée, connexion : le jeton de session.
export async function connect(t: TestApp, user: { email: string; password: string }) {
  await t.api('/v1/auth/signup', { json: user });
  await t.api('/v1/auth/verify', { json: { token: lastToken(t.mailer, user.email) } });
  const login = await t.api('/v1/auth/login', { json: user });
  if (login.status !== 200) throw new Error('connexion impossible : ' + JSON.stringify(login.body));
  return String(login.body.token);
}

// Réponse OpenRouter simulée : 100 + 50 jetons, 0,004 $ (0,4 centime).
export const completion = (usage: Record<string, number | undefined> = {}, content = 'Réponse simulée.') =>
  Response.json({
    id: 'gen-test',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.004, ...usage },
  });

export interface FakeCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

// Faux OpenRouter : enregistre les appels, répond selon `state.reply`,
// sert des prix publics selon `state.prices`. Aucun réseau.
export function fakeOpenRouter() {
  const calls: FakeCall[] = [];
  const state = {
    reply: ((_call: FakeCall) => completion()) as (call: FakeCall) => Response | Promise<Response>,
    prices: { data: [{ id: 'deepseek/deepseek-v4.1-flash-1017', pricing: { prompt: '0.00000015', completion: '0.0000006' } }] } as unknown,
  };
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/models')) return Response.json(state.prices);
    const call: FakeCall = {
      url: u,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    calls.push(call);
    // Comme fetch : un appel arrêté (signal) rejette, même si la réponse tarde.
    const signal = init?.signal;
    if (!signal) return state.reply(call);
    if (signal.aborted) throw signal.reason;
    return Promise.race([
      Promise.resolve(state.reply(call)),
      new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    ]);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, state };
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
