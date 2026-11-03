import assert from 'node:assert/strict';
import test from 'node:test';
import { runAdmin } from '../../server/admin.js';
import { connect, testApp } from './helpers.js';

const user = { email: 'associe@example.com', password: 'un-mot-de-passe-solide' };

test('administration : keys sans base ; grant, cap, usage et credit sur un compte ; refus explicites', async () => {
  const t = await testApp();
  const lines: string[] = [];
  const out = (l: string) => lines.push(l);
  try {
    assert.equal(await runAdmin(null, ['keys'], out), 0);
    assert.match(lines.join('\n'), /BEGIN PRIVATE KEY[\s\S]*BEGIN PUBLIC KEY/);
    lines.length = 0;

    assert.equal(await runAdmin(null, ['grant', user.email], out), 1, 'pas de base');
    assert.equal(await runAdmin(t.db, ['grant'], out), 1, 'mail manquant');
    assert.equal(await runAdmin(t.db, ['bidule', user.email], out), 1, 'commande inconnue');
    assert.equal(await runAdmin(t.db, ['grant', user.email], out), 1, 'compte inconnu');
    assert.match(lines.at(-1)!, /Aucun compte/);
    lines.length = 0;

    const token = await connect(t, user);
    const chat = () => t.api('/v1/relay/chat', { json: { messages: [{ role: 'user', content: 'x' }] }, token });
    assert.equal((await chat()).status, 200, 'génération de bienvenue');
    assert.equal((await chat()).status, 402, 'puis gratuit sans crédits');
    assert.equal(await runAdmin(t.db, ['grant', 'Associe@Example.com '], out, t.now()), 0, 'adresse normalisée');
    assert.match(lines.at(-1)!, /compte offert/);
    assert.equal((await t.api('/v1/me', { token })).body.gifted, true);
    assert.equal((await chat()).status, 200, 'offert : l’appel passe');

    assert.equal(await runAdmin(t.db, ['cap', user.email, 'abc'], out, t.now()), 1);
    assert.equal(await runAdmin(t.db, ['cap', user.email, '500'], out, t.now()), 0);
    assert.equal((await t.api('/v1/me', { token })).body.dailyCapCents, 500);

    lines.length = 0;
    assert.equal(await runAdmin(t.db, ['usage', user.email], out, t.now()), 0);
    assert.match(lines[0], /free \(offert\) ; aujourd’hui 0\.8 c, mois 0\.8 c, plafond 500 c, crédits -0,01 €, inclus restant 0,00 €/);
    assert.equal(lines.length, 3, 'une ligne de résumé, deux appels');
    assert.match(lines[1], /2026-10-31 12:00 other deepseek\/deepseek-v4\.1-flash-1017 100\+50 jetons 0\.4 c → gift$/);
    assert.match(lines[2], /0\.4 c → credits \(2 c€\)$/, 'bienvenue débitée de 2 centimes d’euro');

    lines.length = 0;
    assert.equal(await runAdmin(t.db, ['credit', user.email, 'abc'], out, t.now()), 1);
    assert.equal(await runAdmin(t.db, ['credit', user.email, '0'], out, t.now()), 1);
    assert.equal(await runAdmin(t.db, ['credit', user.email, '500'], out, t.now()), 0);
    assert.match(lines.at(-1)!, /\+500 c, crédits 4,99 €/);
    assert.equal((await t.api('/v1/me', { token })).body.creditCents, 499);
    assert.equal(await runAdmin(t.db, ['credit', user.email, '-99'], out, t.now()), 0);
    assert.match(lines.at(-1)!, /-99 c, crédits 4,00 €/);
    const ledger = await t.db.query<{ reason: string; delta_cents: number }>('SELECT reason, delta_cents FROM credit_events ORDER BY id');
    assert.deepEqual(ledger.rows.map((r) => [r.reason, r.delta_cents]), [['welcome', 1], ['admin', 500], ['admin', -99]]);
  } finally {
    await t.close();
  }
});
