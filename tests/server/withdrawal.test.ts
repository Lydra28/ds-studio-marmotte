import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminApp } from '../../server/admin-ui.js';
import { handleEvent } from '../../server/billing.js';
import { deleteAccount } from '../../server/retention.js';
import { connect, testApp } from './helpers.js';

// Rétractation (option A du 2026-11-06, server/withdrawal.ts) : registre des
// achats par le webhook, 14 jours, remboursement de ce qui n'a pas servi,
// accusé de réception par mail, suivi dans admin:ui. Sans Stripe configuré.
const DAY = 86400_000;
const user = (n: number) => ({ email: `retract${n}@exemple.test`, password: 'mot-de-passe-solide' });
let seq = 0;
type T = Awaited<ReturnType<typeof testApp>>;

const accountId = async (t: T, email: string) => (await t.db.query<{ id: string }>('SELECT id FROM accounts WHERE email = $1', [email])).rows[0].id;
const paid = (t: T, id: string, mode: 'payment' | 'subscription', amount: number) =>
  handleEvent(
    t.db,
    {
      id: `evt_w${++seq}`,
      type: 'checkout.session.completed',
      data: {
        object: { id: `cs_w${seq}`, mode, payment_status: 'paid', amount_total: amount, currency: 'eur', client_reference_id: id, customer: `cus_w${seq}`, subscription: mode === 'subscription' ? `sub_w${seq}` : null, metadata: null },
      },
    } as never,
    t.now(),
  );
const list = async (t: T, token: string) =>
  (await t.api('/v1/billing/withdrawals', { token })).body as { days: number; email: string; purchases: { id: number; kind: string; label: string; refundCents: number; until: string }[] };
const credit = async (t: T, id: string) => Number((await t.db.query<{ c: number }>('SELECT credit_cents AS c FROM accounts WHERE id = $1', [id])).rows[0].c);

test('rétractation : recharge enregistrée, solde non utilisé remboursé, accusé et mail à Romain', async () => {
  const t = await testApp({ adminEmail: 'romain@exemple.test' });
  try {
    const token = await connect(t, user(1));
    const id = await accountId(t, user(1).email);
    assert.equal(await paid(t, id, 'payment', 1000), 'new');
    assert.equal(await paid(t, id, 'payment', 500), 'new');
    let l = await list(t, token);
    assert.equal(l.days, 14);
    assert.equal(l.email, user(1).email);
    assert.equal(l.purchases.length, 2);
    assert.ok(l.purchases.some((p) => /Recharge de crédits de 5,00 € du/.test(p.label)));

    // 1 501 c au solde ; une part dépensée : il en reste 700.
    await t.db.query('UPDATE accounts SET credit_cents = 700 WHERE id = $1', [id]);
    l = await list(t, token);
    const pack10 = l.purchases.find((p) => p.label.includes('10,00'))!;
    assert.equal(pack10.refundCents, 700, 'au plus ce qui reste au solde');

    t.tick(3 * DAY);
    const before = t.mailer.sent.length;
    const r = await t.api('/v1/billing/withdraw', { json: { purchaseId: pack10.id, name: 'Camille Test' }, token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.refundCents, 700);
    assert.equal(r.body.mailed, true);
    assert.equal(await credit(t, id), 0, 'remboursé retiré du solde');
    const ledger = await t.db.query<{ delta_cents: number; reason: string }>("SELECT delta_cents, reason FROM credit_events WHERE account_id = $1 AND reason = 'withdrawal'", [id]);
    assert.deepEqual(ledger.rows.map((e) => e.delta_cents), [-700]);

    const mails = t.mailer.sent.slice(before);
    assert.equal(mails.length, 2);
    assert.equal(mails[0].to, user(1).email);
    assert.match(mails[0].subject, /accusé de réception/);
    assert.match(mails[0].text, /Bonjour Camille Test,[\s\S]*Nous avons reçu ta rétractation le .*Recharge de crédits de 10,00 €[\s\S]*7,00 €/);
    assert.equal(mails[1].to, 'romain@exemple.test');
    assert.match(mails[1].text, /À rembourser : 7,00 € avant le/);

    assert.equal((await t.api('/v1/billing/withdraw', { json: { purchaseId: pack10.id, name: 'Camille Test' }, token })).status, 409, 'une seule fois');
    assert.equal((await list(t, token)).purchases.length, 1);
    assert.equal((await t.api('/v1/billing/withdraw', { json: { purchaseId: pack10.id, name: 'x' }, token })).status, 400, 'nom trop court');

    // Autre compte : achat introuvable.
    const other = await connect(t, user(2));
    const pack5 = l.purchases.find((p) => p.label.includes('5,00'))!;
    assert.equal((await t.api('/v1/billing/withdraw', { json: { purchaseId: pack5.id, name: 'Intrus' }, token: other })).status, 404);

    // Après 14 jours : plus proposé, refusé.
    t.tick(12 * DAY);
    assert.equal((await list(t, token)).purchases.length, 0);
    assert.equal((await t.api('/v1/billing/withdraw', { json: { purchaseId: pack5.id, name: 'Camille Test' }, token })).status, 409);
    assert.equal((await t.api('/v1/billing/withdrawals')).status, 401, 'compte exigé');
  } finally {
    await t.close();
  }
});

test('rétractation : Pro remboursé au prorata du mois restant, inclus coupé ; renouvellement jamais proposé', async () => {
  const t = await testApp();
  try {
    const token = await connect(t, user(1));
    const id = await accountId(t, user(1).email);
    assert.equal(await paid(t, id, 'subscription', 999), 'new');
    t.tick(3 * DAY);
    const [pro] = (await list(t, token)).purchases;
    assert.equal(pro.kind, 'pro');
    // T0 = 31 octobre : un mois va jusqu'au 1er décembre (31 jours), 28 restent.
    assert.equal(pro.refundCents, Math.floor((999 * 28) / 31));
    const r = await t.api('/v1/billing/withdraw', { json: { purchaseId: pro.id, name: 'Camille Test' }, token });
    assert.equal(r.status, 200);
    assert.equal(r.body.refundCents, 902);
    const a = (await t.db.query<{ monthly_included_cents: number }>('SELECT monthly_included_cents FROM accounts WHERE id = $1', [id])).rows[0];
    assert.equal(a.monthly_included_cents, 0);
    assert.match(t.mailer.sent.at(-1)!.text, /résilié sans renouvellement/);
    const n = Number((await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM purchases')).rows[0].n);
    await handleEvent(t.db, { id: 'evt_renew', type: 'invoice.paid', data: { object: { customer: `cus_w${seq}`, parent: { subscription_details: { subscription: `sub_w${seq}` } } } } } as never, t.now());
    assert.equal(Number((await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM purchases')).rows[0].n), n, 'renouvellement : pas un nouvel achat');
  } finally {
    await t.close();
  }
});

test('rétractation : accusé en échec, déclaration gardée et Romain prévenu', async () => {
  const t = await testApp({ adminEmail: 'romain@exemple.test' });
  try {
    const token = await connect(t, user(1));
    const id = await accountId(t, user(1).email);
    await paid(t, id, 'payment', 500);
    const [p] = (await list(t, token)).purchases;
    const send = t.mailer.send.bind(t.mailer);
    t.mailer.send = async (m) => {
      if (m.to !== 'romain@exemple.test') throw new Error('Resend en panne');
      return send(m);
    };
    const r = await t.api('/v1/billing/withdraw', { json: { purchaseId: p.id, name: 'Camille Test' }, token });
    assert.equal(r.status, 200);
    assert.equal(r.body.mailed, false);
    assert.match(t.mailer.sent.at(-1)!.text, /ATTENTION : l’accusé de réception au client n’est pas parti/);
    assert.ok((await t.db.query('SELECT 1 FROM purchases WHERE withdrawn_at IS NOT NULL')).rows.length === 1);
  } finally {
    await t.close();
  }
});

test('rétractation : CORS du site, suivi admin:ui, nom effacé à la suppression du compte', async () => {
  const site = 'https://site.test';
  const t = await testApp({ siteUrl: site });
  try {
    const pre = await t.api('/v1/billing/withdraw', { method: 'OPTIONS', headers: { origin: site, 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), site);

    const token = await connect(t, user(1));
    const id = await accountId(t, user(1).email);
    await paid(t, id, 'payment', 500);
    const [p] = (await list(t, token)).purchases;
    await t.api('/v1/billing/withdraw', { json: { purchaseId: p.id, name: 'Camille Test' }, token });

    const origin = 'http://127.0.0.1:4999';
    const admin = createAdminApp({ db: t.db, token: 'jeton', origin, label: 'test', now: t.now });
    const call = (path: string, post = false) =>
      admin.request(origin + path, {
        method: post ? 'POST' : 'GET',
        headers: { host: '127.0.0.1:4999', 'x-admin-token': 'jeton', origin, 'content-type': 'application/json' },
        body: post ? '{}' : undefined,
      });
    let w = ((await (await call('/api/withdrawals')).json()) as { withdrawals: Record<string, unknown>[] }).withdrawals;
    assert.equal(w.length, 1);
    assert.equal(w[0].email, user(1).email);
    assert.equal(w[0].name, 'Camille Test');
    assert.equal(w[0].refundCents, 500);
    assert.equal(w[0].refundedAt, null);
    assert.equal((await call(`/api/withdrawals/${w[0].id}/refunded`, true)).status, 200);
    assert.equal((await call(`/api/withdrawals/${w[0].id}/refunded`, true)).status, 409, 'une fois');
    w = ((await (await call('/api/withdrawals')).json()) as { withdrawals: Record<string, unknown>[] }).withdrawals;
    assert.ok(w[0].refundedAt);

    const del = await deleteAccount(t.db, id, t.now());
    assert.deepEqual(del, { ok: true, mode: 'anonymised', forfeitedCents: 1 });
    const kept = (await t.db.query<{ withdrawal_name: string | null; amount_cents: number }>('SELECT withdrawal_name, amount_cents FROM purchases')).rows;
    assert.deepEqual(kept, [{ withdrawal_name: null, amount_cents: 500 }], 'achat gardé, nom effacé');
  } finally {
    await t.close();
  }
});
