import assert from 'node:assert/strict';
import test from 'node:test';
import { migrate, waitForDb } from '../../server/db.js';
import { testApp, testDb } from './helpers.js';

test('serveur : /v1/health répond avec la version et le schéma de la base', async () => {
  const t = await testApp();
  try {
    const health = await t.api('/v1/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true, version: 'test', schema: '8', at: '2026-10-31T12:00:00.000Z', origin: 'off', guard: 'off' });
    const missing = await t.api('/v1/nulle-part');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'Route inconnue.');
  } finally {
    await t.close();
  }
});

// Revue du 2026-11-13, n° 9 : l'URL onrender.com contourne Cloudflare. Le
// secret d'origine que Cloudflare ajoute distingue les deux chemins ; premier
// temps noté seulement, second temps refusé, /v1/health toujours ouvert.
test('serveur : secret d’origine, noté puis refusé, /v1/health ouvert et seul exempté', async () => {
  const secret = 'secret-de-test-assez-long-pour-l-exemple';
  const via = (ip: string, value = secret) => ({ 'x-ds-origin-secret': value, 'cf-connecting-ip': ip });
  const signup = (t: Awaited<ReturnType<typeof testApp>>, n: number, headers: Record<string, string>) =>
    t.api('/v1/auth/signup', { json: { email: `origine-${n}@example.com`, password: 'mot-de-passe-solide-1' }, headers });

  // Premier temps : la vérification se lit dans /v1/health ; une requête sans
  // le secret (règle Cloudflare absente ou fausse) est servie comme avant, et
  // chacun garde son propre compteur d'inscriptions.
  const journal = await testApp({ originSecret: { value: secret, enforce: false } });
  try {
    assert.deepEqual([(await journal.api('/v1/health', { headers: via('1.1.1.1') })).body.origin, (await journal.api('/v1/health')).body.origin], ['ok', 'bad']);
    assert.equal((await journal.api('/v1/health', { headers: via('1.1.1.1', 'faux') })).body.origin, 'bad');
    assert.equal((await journal.api('/v1/health')).body.guard, 'journal');
    assert.equal((await signup(journal, 0, { 'cf-connecting-ip': '10.0.0.1' })).status, 201, 'sans secret : servi');
    assert.equal((await signup(journal, 1, via('2.2.2.2', 'faux'))).status, 201, 'secret faux : servi');
    assert.equal((await signup(journal, 2, via('2.2.2.2'))).status, 201);
  } finally {
    await journal.close();
  }

  // Second temps : sans le secret, 403 partout sauf /v1/health.
  const refus = await testApp({ originSecret: { value: secret, enforce: true } });
  try {
    assert.equal((await refus.api('/v1/health')).status, 200);
    assert.equal((await refus.api('/v1/health')).body.guard, 'refus');
    const direct = await refus.api('/v1/me');
    assert.equal(direct.status, 403);
    assert.match(String(direct.body.error), /Accès direct refusé/);
    assert.equal((await refus.api('/v1/billing/webhook', { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await refus.api('/v1/me', { method: 'OPTIONS', headers: { origin: 'https://design-system-studio.fr' } })).status, 403, 'préflight direct refusé');
    // Seul /v1/health est exempté, au caractère près ; le reste n'existe pas.
    assert.equal((await refus.api('/v1/health/')).status, 403);
    assert.equal((await refus.api('/V1/me')).status, 404);
    assert.equal((await signup(refus, 0, via('3.3.3.3'))).status, 201, 'par Cloudflare : servi');
    assert.equal((await refus.api('/v1/me', { headers: via('3.3.3.3') })).status, 401, 'par Cloudflare : jusqu’au contrôle du compte');
  } finally {
    await refus.close();
  }
});

test('serveur : les migrations ne s’appliquent qu’une fois et s’annulent en bloc si l’une casse', async () => {
  const db = await testDb();
  try {
    assert.deepEqual(await migrate(db), [], 'déjà appliquées par testDb');
    const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    assert.deepEqual(
      rows.map((r) => r.name),
      ['0001_init.sql', '0002_accounts.sql', '0003_usage.sql', '0004_billing.sql', '0005_retention.sql', '0006_withdrawal.sql', '0007_daily_cap.sql', '0008_oauth.sql'],
    );
    // Un dossier de migrations cassé : rien n'est enregistré, rien n'est laissé à moitié.
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(tmpdir() + '/ds-mig-');
    await writeFile(dir + '/0002_casse.sql', 'CREATE TABLE demi (id int); CREATE TABLE demi (id int);');
    await assert.rejects(migrate(db, dir), /Migration 0002_casse\.sql échouée/);
    const after = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
    assert.equal(after.rows.length, 8);
    const demi = await db.query("SELECT to_regclass('demi') AS t");
    assert.equal(demi.rows[0].t, null, 'la table de la migration cassée ne doit pas exister');
  } finally {
    await db.close();
  }
});

test('serveur : au démarrage, on attend une base qui n’écoute pas encore, jamais une base qui refuse', async () => {
  const connectError = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' });
  let failures = 2;
  const flaky = { query: async () => { if (failures-- > 0) throw connectError; return { rows: [] }; } };
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  assert.equal(await waitForDb(flaky, { delayMs: 10, log: () => {}, sleep }), 3, 'troisième essai');
  assert.deepEqual(waits, [10, 10]);
  // Même erreur enveloppée (AggregateError de Node quand plusieurs adresses échouent).
  failures = 1;
  const wrapped = { query: async () => { if (failures-- > 0) throw new AggregateError([connectError], 'connect'); return { rows: [] }; } };
  assert.equal(await waitForDb(wrapped, { delayMs: 1, log: () => {}, sleep }), 2);
  // Essais épuisés : la dernière erreur sort.
  const down = { query: async () => { throw connectError; } };
  await assert.rejects(waitForDb(down, { attempts: 3, delayMs: 1, log: () => {}, sleep }), /ECONNREFUSED/);
  // Une erreur qui n'est pas de connexion (mot de passe, SQL) ne se réessaie pas.
  const refused = { query: async () => { throw Object.assign(new Error('password authentication failed'), { code: '28P01' }); } };
  const before = waits.length;
  await assert.rejects(waitForDb(refused, { delayMs: 1, log: () => {}, sleep }), /password/);
  assert.equal(waits.length, before, 'aucune attente');
});

test('migration 0007 : seuls les comptes restés à 200 passent à 50 ; offert et plafond posé à la main ne bougent pas', async () => {
  const db = await testDb();
  try {
    const add = (email: string, gifted: boolean, cap: number) =>
      db.query("INSERT INTO accounts (email, password_hash, gifted, daily_cap_cents) VALUES ($1, 'x', $2, $3)", [email, gifted, cap]);
    await add('ancien@example.com', false, 200);
    await add('offert@example.com', true, 200);
    await add('pose@example.com', false, 500);
    await db.query("INSERT INTO accounts (email, password_hash) VALUES ('neuf@example.com', 'x')");
    const { readFile } = await import('node:fs/promises');
    await db.exec(await readFile(new URL('../../server/migrations/0007_daily_cap.sql', import.meta.url), 'utf8'));
    const { rows } = await db.query<{ email: string; daily_cap_cents: number }>('SELECT email, daily_cap_cents FROM accounts ORDER BY email');
    assert.deepEqual(
      Object.fromEntries(rows.map((r) => [r.email, r.daily_cap_cents])),
      { 'ancien@example.com': 50, 'neuf@example.com': 50, 'offert@example.com': 200, 'pose@example.com': 500 },
    );
  } finally {
    await db.close();
  }
});
