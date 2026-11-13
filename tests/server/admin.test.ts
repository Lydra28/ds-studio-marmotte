import assert from 'node:assert/strict';
import test from 'node:test';
import { accountHistory, runAdmin } from '../../server/admin.js';
import { addCredits } from '../../server/credits.js';
import { recordPurchase } from '../../server/withdrawal.js';
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
    assert.equal((await t.api('/v1/me', { token })).body.dailyCapCents, 10, 'offert : plafonné d’office');
    assert.equal((await chat()).status, 200, 'offert : l’appel passe');

    assert.equal(await runAdmin(t.db, ['cap', user.email, 'abc'], out, t.now()), 1);
    assert.equal(await runAdmin(t.db, ['cap', user.email, '500'], out, t.now()), 0);
    assert.equal((await t.api('/v1/me', { token })).body.dailyCapCents, 500);

    lines.length = 0;
    assert.equal(await runAdmin(t.db, ['usage', user.email], out, t.now()), 0);
    assert.match(lines[0], /free \(offert\) ; aujourd’hui 0\.8 c, mois 0\.8 c, plafond 500 c, crédits -0,02 €, inclus restant 0,00 €/);
    assert.equal(lines.length, 3, 'une ligne de résumé, deux appels');
    assert.match(lines[1], /2026-10-31 12:00 other deepseek\/deepseek-v4\.1-flash-1017 100\+50 jetons 0\.4 c → gift$/);
    assert.match(lines[2], /0\.4 c → credits \(3 c€\)$/, 'bienvenue débitée de 3 centimes d’euro (0,4 × 5,5 = 2,2)');

    lines.length = 0;
    assert.equal(await runAdmin(t.db, ['credit', user.email, 'abc'], out, t.now()), 1);
    assert.equal(await runAdmin(t.db, ['credit', user.email, '0'], out, t.now()), 1);
    assert.equal(await runAdmin(t.db, ['credit', user.email, '500'], out, t.now()), 0);
    assert.match(lines.at(-1)!, /\+500 c, crédits 4,98 €/);
    assert.equal((await t.api('/v1/me', { token })).body.creditCents, 498);
    assert.equal(await runAdmin(t.db, ['credit', user.email, '-99'], out, t.now()), 0);
    assert.match(lines.at(-1)!, /-99 c, crédits 3,99 €/);
    const ledger = await t.db.query<{ reason: string; delta_cents: number }>('SELECT reason, delta_cents FROM credit_events ORDER BY id');
    assert.deepEqual(ledger.rows.map((r) => [r.reason, r.delta_cents]), [['welcome', 1], ['admin', 500], ['admin', -99]]);
  } finally {
    await t.close();
  }
});

test('administration : stripe-test-reset efface le mode test Stripe, aperçu d’abord, une seule fois, refus après le live', async () => {
  const t = await testApp();
  const lines: string[] = [];
  const out = (l: string) => lines.push(l);
  try {
    const token = await connect(t, user);
    await connect(t, { email: 'autre@example.com', password: 'un-autre-mot-de-passe' });
    await connect(t, { email: 'offert@example.com', password: 'un-mot-de-passe-offert' });
    await connect(t, { email: 'parti@example.com', password: 'un-mot-de-passe-parti' });
    const idOf = async (email: string) => (await t.db.query<{ id: string }>('SELECT id FROM accounts WHERE email = $1', [email])).rows[0].id;
    const id = await idOf(user.email);
    const gifted = await idOf('offert@example.com');
    const gone = await idOf('parti@example.com');
    // Compte offert passé Pro en test ; compte supprimé (anonymisé) : jamais touché.
    await t.db.query(`UPDATE accounts SET gifted = true, plan = 'pro', stripe_customer_id = 'cus_test3', monthly_included_cents = 300 WHERE id = $1`, [gifted]);
    await t.db.query(`UPDATE accounts SET deleted_at = $2, stripe_customer_id = 'cus_test4' WHERE id = $1`, [gone, t.now()]);
    await recordPurchase(t.db, { accountId: gone, kind: 'credits', ref: 'checkout:cs_test_gone', amountCents: 500, now: t.now() });
    await recordPurchase(t.db, { accountId: gifted, kind: 'credits', ref: 'checkout:csXtest_pas_stripe', amountCents: 500, now: t.now() });
    const otherBefore = (await t.db.query('SELECT * FROM accounts WHERE email = $1', ['autre@example.com'])).rows[0];
    // Pro de test, une recharge de test de 500 c, puis une rétractation de 100 c.
    await t.db.query(
      `UPDATE accounts SET plan = 'pro', stripe_customer_id = 'cus_test1', stripe_subscription_id = 'sub_test1', subscription_status = 'active',
              current_period_end = $2, cancel_at_period_end = true, included_since = $2, monthly_included_cents = 300 WHERE id = $1`,
      [id, t.now()],
    );
    await addCredits(t.db, { accountId: id, deltaCents: 500, reason: 'topup', ref: 'checkout:cs_test_a', now: t.now() });
    await recordPurchase(t.db, { accountId: id, kind: 'credits', ref: 'checkout:cs_test_a', amountCents: 500, now: t.now() });
    await recordPurchase(t.db, { accountId: id, kind: 'pro', ref: 'checkout:cs_test_b', amountCents: 900, now: t.now() });
    await addCredits(t.db, { accountId: id, deltaCents: -100, reason: 'withdrawal', ref: 'withdrawal:1', now: t.now() });
    const before = (await t.api('/v1/me', { token })).body;
    assert.equal(before.creditCents, 401, 'bienvenue 1 + recharge 500 - rétractation 100');

    assert.equal(await runAdmin(t.db, ['stripe-test-reset'], out, t.now()), 1, 'aperçu');
    assert.match(lines[0], /^associe@example\.com \(aperçu\) : identifiants Stripe de test effacés, Pro de test retiré, crédits achetés en test retirés 4,00 €\.$/);
    assert.equal(lines[1], 'offert@example.com (aperçu) : identifiants Stripe de test effacés, Pro de test retiré.');
    assert.match(lines[2], /^2 compte\(s\), 2 achat\(s\) de test à retirer/, 'ni le compte supprimé ni un faux cs_test_');
    assert.equal((await t.db.query('SELECT 1 FROM accounts WHERE stripe_customer_id IS NOT NULL')).rows.length, 3, 'aperçu : rien écrit');

    lines.length = 0;
    assert.equal(await runAdmin(t.db, ['stripe-test-reset', 'confirmer'], out, t.now()), 0);
    assert.match(lines[0], /^associe@example\.com : .*retirés 4,00 €\.$/);
    const after = await t.db.query<Record<string, unknown>>(
      `SELECT plan, stripe_customer_id, stripe_subscription_id, subscription_status, current_period_end, cancel_at_period_end, included_since,
              monthly_included_cents, credit_cents
         FROM accounts WHERE id = $1`,
      [id],
    );
    assert.deepEqual(after.rows[0], {
      plan: 'free', stripe_customer_id: null, stripe_subscription_id: null, subscription_status: null,
      current_period_end: null, cancel_at_period_end: false, included_since: null, monthly_included_cents: 0, credit_cents: 1,
    }, 'la bienvenue reste');
    const g = (await t.db.query<{ gifted: boolean; plan: string; stripe_customer_id: string | null }>('SELECT gifted, plan, stripe_customer_id FROM accounts WHERE id = $1', [gifted])).rows[0];
    assert.deepEqual([g.gifted, g.plan, g.stripe_customer_id], [true, 'free', null], 'offert reste offert');
    assert.equal((await t.db.query<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM accounts WHERE id = $1', [gone])).rows[0].stripe_customer_id, 'cus_test4', 'compte supprimé intact');
    assert.deepEqual((await t.db.query('SELECT * FROM accounts WHERE email = $1', ['autre@example.com'])).rows[0], otherBefore, 'autre compte intact');
    assert.deepEqual((await t.db.query<{ ref: string }>('SELECT ref FROM purchases ORDER BY ref')).rows.map((r) => r.ref), ['checkout:csXtest_pas_stripe', 'checkout:cs_test_gone']);
    const ledger = await t.db.query<{ reason: string; delta_cents: number; ref: string }>(`SELECT reason, delta_cents, ref FROM credit_events WHERE account_id = $1 ORDER BY id`, [id]);
    assert.deepEqual(ledger.rows.map((r) => [r.reason, r.delta_cents]), [['welcome', 1], ['topup', 500], ['withdrawal', -100], ['admin', -400]], 'grand livre gardé');
    const history = await accountHistory(t.db, id);
    assert.equal(history.credits[0].note, 'fin du mode test Stripe');

    lines.length = 0;
    assert.equal(await runAdmin(t.db, ['stripe-test-reset', 'confirmer'], out, t.now()), 0, 'relancée : sans effet');
    assert.equal(lines[0], '0 compte(s), 0 achat(s) de test retirés du registre de rétractation.');
    assert.equal((await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM credit_events WHERE account_id = $1', [id])).rows[0].n, 4);

    // Solde déjà dépensé : jamais sous zéro.
    await t.db.query(`UPDATE accounts SET stripe_customer_id = 'cus_test2' WHERE id = $1`, [id]);
    await addCredits(t.db, { accountId: id, deltaCents: 300, reason: 'topup', ref: 'checkout:cs_test_c', now: t.now() });
    await t.db.query('UPDATE accounts SET credit_cents = 50 WHERE id = $1', [id]);
    lines.length = 0;
    assert.equal(await runAdmin(t.db, ['stripe-test-reset', 'confirmer'], out, t.now()), 0);
    assert.match(lines[0], /retirés 0,50 €\.$/);
    assert.equal((await t.db.query<{ credit_cents: number }>('SELECT credit_cents FROM accounts WHERE id = $1', [id])).rows[0].credit_cents, 0, 'jamais plus que le solde');
    // Relancée après un retrait limité : un geste admin d'après n'est pas repris.
    assert.equal(await runAdmin(t.db, ['credit', user.email, '100'], out, t.now()), 0);
    assert.equal(await runAdmin(t.db, ['stripe-test-reset', 'confirmer'], out, t.now()), 0);
    assert.equal((await t.db.query<{ credit_cents: number }>('SELECT credit_cents FROM accounts WHERE id = $1', [id])).rows[0].credit_cents, 100);

    // Solde déjà à 0 : marqueur à 0, un geste admin d'après n'est pas repris.
    await addCredits(t.db, { accountId: id, deltaCents: 200, reason: 'topup', ref: 'checkout:cs_test_d', now: t.now() });
    await t.db.query('UPDATE accounts SET credit_cents = 0 WHERE id = $1', [id]);
    lines.length = 0;
    assert.equal(await runAdmin(t.db, ['stripe-test-reset', 'confirmer'], out, t.now()), 0);
    assert.equal(lines[0], 'associe@example.com : crédits achetés en test déjà dépensés.');
    assert.equal(await runAdmin(t.db, ['credit', user.email, '70'], out, t.now()), 0);
    assert.equal(await runAdmin(t.db, ['stripe-test-reset', 'confirmer'], out, t.now()), 0);
    assert.equal((await t.db.query<{ credit_cents: number }>('SELECT credit_cents FROM accounts WHERE id = $1', [id])).rows[0].credit_cents, 70);

    await recordPurchase(t.db, { accountId: id, kind: 'credits', ref: 'checkout:cs_live_z', amountCents: 500, now: t.now() });
    await t.db.query(`UPDATE accounts SET stripe_customer_id = 'cus_live' WHERE id = $1`, [id]);
    lines.length = 0;
    assert.equal(await runAdmin(t.db, ['stripe-test-reset'], out, t.now()), 1);
    assert.equal(await runAdmin(t.db, ['stripe-test-reset', 'confirmer'], out, t.now()), 1);
    assert.match(lines.join('\n'), /achat\(s\) live au registre/);
    assert.equal((await t.db.query<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM accounts WHERE id = $1', [id])).rows[0].stripe_customer_id, 'cus_live', 'live : rien touché');
    assert.equal(await runAdmin(null, ['stripe-test-reset'], out), 1, 'pas de base');
  } finally {
    await t.close();
  }
});
