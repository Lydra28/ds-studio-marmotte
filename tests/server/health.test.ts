import assert from 'node:assert/strict';
import test from 'node:test';
import { migrate } from '../../server/db.js';
import { testApp, testDb } from './helpers.js';

test('serveur : /v1/health répond avec la version et le schéma de la base', async () => {
  const t = await testApp();
  try {
    const health = await t.api('/v1/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true, version: 'test', schema: '2', at: '2026-10-31T12:00:00.000Z' });
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
      ['0001_init.sql', '0002_accounts.sql'],
    );
    // Un dossier de migrations cassé : rien n'est enregistré, rien n'est laissé à moitié.
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(tmpdir() + '/ds-mig-');
    await writeFile(dir + '/0002_casse.sql', 'CREATE TABLE demi (id int); CREATE TABLE demi (id int);');
    await assert.rejects(migrate(db, dir), /Migration 0002_casse\.sql échouée/);
    const after = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
    assert.equal(after.rows.length, 2);
    const demi = await db.query("SELECT to_regclass('demi') AS t");
    assert.equal(demi.rows[0].t, null, 'la table de la migration cassée ne doit pas exister');
  } finally {
    await db.close();
  }
});
