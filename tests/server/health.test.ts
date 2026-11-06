import assert from 'node:assert/strict';
import test from 'node:test';
import { migrate, waitForDb } from '../../server/db.js';
import { testApp, testDb } from './helpers.js';

test('serveur : /v1/health répond avec la version et le schéma de la base', async () => {
  const t = await testApp();
  try {
    const health = await t.api('/v1/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true, version: 'test', schema: '5', at: '2026-10-31T12:00:00.000Z' });
    const missing = await t.api('/v1/nulle-part');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'Route inconnue.');
  } finally {
    await t.close();
  }
});

test('serveur : les migrations ne s’appliquent qu’une fois et s’annulent en bloc si l’une casse', async () => {
  const db = await testDb();
  try {
    assert.deepEqual(await migrate(db), [], 'déjà appliquées par testDb');
    const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    assert.deepEqual(
      rows.map((r) => r.name),
      ['0001_init.sql', '0002_accounts.sql', '0003_usage.sql', '0004_billing.sql', '0005_retention.sql'],
    );
    // Un dossier de migrations cassé : rien n'est enregistré, rien n'est laissé à moitié.
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(tmpdir() + '/ds-mig-');
    await writeFile(dir + '/0002_casse.sql', 'CREATE TABLE demi (id int); CREATE TABLE demi (id int);');
    await assert.rejects(migrate(db, dir), /Migration 0002_casse\.sql échouée/);
    const after = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
    assert.equal(after.rows.length, 5);
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
