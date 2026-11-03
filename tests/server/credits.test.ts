import assert from 'node:assert/strict';
import test from 'node:test';
import { addCredits, chargedCents, RATE, WELCOME_CENTS } from '../../server/credits.js';
import { connect, lastToken, testApp } from './helpers.js';

const user = { email: 'bienvenue@example.com', password: 'un-mot-de-passe-solide' };

test('crédits : débit = ceil(coût × RATE), au moins 1 centime, 0 pour un coût nul', () => {
  assert.equal(RATE, 3);
  assert.equal(chargedCents(0), 0, 'coût inconnu : rien');
  assert.equal(chargedCents(0.01), 1, 'plancher');
  assert.equal(chargedCents(0.4), 2, '1,2 arrondi au-dessus');
  assert.equal(chargedCents(1), 3);
  assert.equal(chargedCents(1.01), 4);
});

test('crédits : bienvenue d’un centime à la confirmation du mail, une seule fois ; grand livre idempotent par référence', async () => {
  const t = await testApp();
  try {
    await t.api('/v1/auth/signup', { json: user });
    const before = await t.db.query<{ credit_cents: number; welcome_credited_at: unknown }>('SELECT credit_cents, welcome_credited_at FROM accounts');
    assert.equal(before.rows[0].credit_cents, 0, 'rien avant la confirmation');
    assert.equal(before.rows[0].welcome_credited_at, null);

    const token = await connect(t, user);
    const me = await t.api('/v1/me', { token });
    assert.equal(me.body.creditCents, WELCOME_CENTS);
    assert.equal(me.body.welcome, true, 'crédit de bienvenue entier');
    assert.equal(me.body.subscription, null);
    assert.equal('stripeCustomerId' in me.body, false, 'identifiants Stripe jamais rendus');

    // Un second lien de confirmation (compte déjà confirmé : /resend n'envoie rien ;
    // on rejoue la bienvenue directement) ne crédite pas deux fois.
    const { rows } = await t.db.query<{ id: string }>('SELECT id FROM accounts WHERE email = $1', [user.email]);
    const again = await addCredits(t.db, { accountId: rows[0].id, deltaCents: WELCOME_CENTS, reason: 'welcome', ref: `welcome:${rows[0].id}`, now: t.now() });
    assert.equal(again, false, 'référence déjà passée');
    assert.equal((await t.api('/v1/me', { token })).body.creditCents, WELCOME_CENTS);

    // Sans référence (admin), chaque mouvement passe, y compris négatif.
    assert.equal(await addCredits(t.db, { accountId: rows[0].id, deltaCents: 500, reason: 'admin', now: t.now() }), true);
    assert.equal(await addCredits(t.db, { accountId: rows[0].id, deltaCents: -100, reason: 'admin', now: t.now() }), true);
    assert.equal((await t.api('/v1/me', { token })).body.creditCents, 401);
    await assert.rejects(addCredits(t.db, { accountId: rows[0].id, deltaCents: 0, reason: 'admin', now: t.now() }), /non nul/);
    await assert.rejects(addCredits(t.db, { accountId: rows[0].id, deltaCents: 1.5, reason: 'admin', now: t.now() }), /entier/);

    const ledger = await t.db.query<{ delta_cents: number; reason: string; ref: string | null }>('SELECT delta_cents, reason, ref FROM credit_events ORDER BY id');
    assert.deepEqual(
      ledger.rows.map((r) => [r.delta_cents, r.reason, r.ref]),
      [
        [1, 'welcome', `welcome:${rows[0].id}`],
        [500, 'admin', null],
        [-100, 'admin', null],
      ],
    );
    assert.ok(lastToken(t.mailer, user.email), 'le mail de confirmation est bien parti');
  } finally {
    await t.close();
  }
});
