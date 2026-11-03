import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { CATALOG, handleEvent, setupCatalog, stripeWebhooks, type BillingClient } from '../../server/billing.js';
import { PRO_INCLUDED_CENTS } from '../../server/credits.js';
import { connect, testApp, type TestApp } from './helpers.js';

const SECRET = 'whsec_test_secret';
const user = { email: 'client@example.com', password: 'un-mot-de-passe-solide' };

// Faux Stripe : enregistre les appels, sert un catalogue en mémoire, rend des
// URL factices. La vérification de signature est celle du SDK.
function fakeStripe() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let n = 0;
  const prices = new Map<string, { id: string; lookup_key: string | null; unit_amount: number | null; active: boolean; product: string }>();
  const log = (method: string, params: unknown) => calls.push({ method, params: params as Record<string, unknown> });
  const client: BillingClient = {
    customers: { create: async (p) => (log('customers.create', p), { id: `cus_${++n}` }) },
    products: { create: async (p) => (log('products.create', p), { id: `prod_${++n}` }) },
    prices: {
      list: async (p) => {
        log('prices.list', p);
        const keys = p.lookup_keys ?? [];
        return { data: [...prices.values()].filter((x) => x.lookup_key !== null && keys.includes(x.lookup_key) && (p.active === undefined || x.active === p.active)) };
      },
      create: async (p) => {
        log('prices.create', p);
        const id = `price_${++n}`;
        if (p.transfer_lookup_key) for (const x of prices.values()) if (x.lookup_key === p.lookup_key) x.lookup_key = null;
        prices.set(id, { id, lookup_key: p.lookup_key ?? null, unit_amount: p.unit_amount ?? null, active: true, product: String(p.product) });
        return { id };
      },
    },
    checkout: { sessions: { create: async (p) => (log('checkout.sessions.create', p), { id: `cs_test_${++n}`, url: `https://checkout.stripe.test/${n}` }) } },
    billingPortal: { sessions: { create: async (p) => (log('billingPortal.sessions.create', p), { url: 'https://portal.stripe.test/' }) } },
    webhooks: stripeWebhooks,
  };
  return { client, calls, prices, only: (method: string) => calls.filter((c) => c.method === method) };
}

const sign = (payload: string, secret = SECRET) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
};
const webhook = (t: TestApp, event: object, header?: string) => {
  const payload = JSON.stringify(event);
  return t.api('/v1/billing/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': header ?? sign(payload), 'content-type': 'application/json' } });
};
const chat = (t: TestApp, token: string) => t.api('/v1/relay/chat', { json: { messages: [{ role: 'user', content: 'x' }] }, token });
const me = async (t: TestApp, token: string) => (await t.api('/v1/me', { token })).body as Record<string, unknown> & { usage: { includedLeftCents: number }; subscription: Record<string, unknown> | null };

async function billingApp() {
  const stripe = fakeStripe();
  await setupCatalog(stripe.client, () => {});
  stripe.calls.length = 0;
  const t = await testApp({ billing: { client: stripe.client, webhookSecret: SECRET } });
  return { t, stripe };
}

let seq = 0;
const event = (type: string, object: Record<string, unknown>) => ({ id: `evt_${++seq}`, type, data: { object } });

test('facturation : sans Stripe configuré, checkout, portail et webhook répondent 503', async () => {
  const t = await testApp();
  try {
    const token = await connect(t, user);
    assert.equal((await t.api('/v1/billing/checkout', { json: { kind: 'pro' }, token })).status, 503);
    assert.equal((await t.api('/v1/billing/portal', { json: {}, token })).status, 503);
    assert.equal((await webhook(t, event('ping', {}))).status, 503);
    assert.equal((await t.api('/v1/billing/checkout', { json: { kind: 'pro' } })).status, 401, 'connexion requise avant tout');
  } finally {
    await t.close();
  }
});

test('facturation : Checkout recharge puis Pro, client Stripe créé une fois ; 409 déjà Pro ou offert ; portail ; 400 pack inconnu', async () => {
  const { t, stripe } = await billingApp();
  try {
    const token = await connect(t, user);
    assert.equal((await t.api('/v1/billing/portal', { json: {}, token })).status, 409, 'rien à gérer avant un achat');

    const topup = await t.api('/v1/billing/checkout', { json: { kind: 'credits', pack: '10' }, token });
    assert.equal(topup.status, 200, JSON.stringify(topup.body));
    assert.match(String(topup.body.url), /^https:\/\/checkout\.stripe\.test\//);
    const [customer] = stripe.only('customers.create');
    assert.equal(customer.params.email, user.email);
    const accountId = (customer.params.metadata as { account_id: string }).account_id;
    const [session] = stripe.only('checkout.sessions.create');
    assert.equal(session.params.mode, 'payment');
    assert.match(String(session.params.customer), /^cus_\d+$/);
    assert.equal(session.params.client_reference_id, accountId);
    assert.deepEqual(session.params.line_items, [{ price: [...stripe.prices.values()].find((p) => p.lookup_key === 'credits_10')!.id, quantity: 1 }]);
    assert.equal(session.params.success_url, 'http://server.test/v1/billing/done?s=ok');
    assert.equal(session.params.cancel_url, 'http://server.test/v1/billing/done?s=cancel');
    assert.equal(session.params.locale, 'fr');
    assert.equal('stripeCustomerId' in (await me(t, token)), false, 'identifiant client jamais rendu à l’app');

    const pro = await t.api('/v1/billing/checkout', { json: { kind: 'pro' }, token });
    assert.equal(pro.status, 200);
    assert.equal(stripe.only('customers.create').length, 1, 'client Stripe réutilisé');
    const proSession = stripe.only('checkout.sessions.create')[1];
    assert.equal(proSession.params.mode, 'subscription');
    assert.equal(proSession.params.customer, session.params.customer, 'même client Stripe');
    assert.deepEqual(proSession.params.subscription_data, { metadata: { account_id: accountId } });
    assert.equal((proSession.params.line_items as { price: string }[])[0].price, [...stripe.prices.values()].find((p) => p.lookup_key === 'pro_monthly')!.id);

    const portal = await t.api('/v1/billing/portal', { json: {}, token });
    assert.equal(portal.status, 200);
    assert.equal(portal.body.url, 'https://portal.stripe.test/');
    assert.equal(stripe.only('billingPortal.sessions.create')[0].params.return_url, 'http://server.test/v1/billing/done?s=portal');

    assert.equal((await t.api('/v1/billing/checkout', { json: { kind: 'credits', pack: '50' }, token })).status, 400);
    await t.db.query("UPDATE accounts SET plan = 'pro' WHERE email = $1", [user.email]);
    assert.equal((await t.api('/v1/billing/checkout', { json: { kind: 'pro' }, token })).status, 409, 'déjà Pro');
    await t.db.query("UPDATE accounts SET plan = 'free', gifted = true WHERE email = $1", [user.email]);
    assert.equal((await t.api('/v1/billing/checkout', { json: { kind: 'pro' }, token })).status, 409, 'offert');
    assert.equal((await t.api('/v1/billing/checkout', { json: { kind: 'credits', pack: '5' }, token })).status, 200, 'un compte offert peut recharger');

    const pages = await Promise.all(['ok', 'cancel', 'portal'].map((s) => t.api(`/v1/billing/done?s=${s}`)));
    assert.deepEqual(pages.map((p) => p.status), [200, 200, 200]);
    assert.match(String(pages[0].body.html), /Paiement enregistré/);
  } finally {
    await t.close();
  }
});

test('facturation : catalogue absent → 503 explicite ; stripe-setup crée, remplace un montant changé, ne touche à rien d’à jour', async () => {
  const stripe = fakeStripe();
  const lines: string[] = [];
  await setupCatalog(stripe.client, (l) => lines.push(l));
  assert.equal(stripe.only('products.create').length, CATALOG.length);
  assert.equal(stripe.only('prices.create').length, CATALOG.length);
  assert.ok(lines.every((l) => /produit et prix créés/.test(l)), lines.join('\n'));
  const pro = stripe.only('prices.create').find((c) => c.params.lookup_key === 'pro_monthly')!;
  assert.deepEqual(pro.params.recurring, { interval: 'month' });
  assert.equal(pro.params.currency, 'eur');
  assert.equal(pro.params.unit_amount, 900);
  assert.equal(stripe.only('prices.create').find((c) => c.params.lookup_key === 'credits_5')!.params.recurring, undefined);

  stripe.calls.length = 0;
  lines.length = 0;
  await setupCatalog(stripe.client, (l) => lines.push(l));
  assert.equal(stripe.only('prices.create').length + stripe.only('products.create').length, 0, 'rien à créer');
  assert.ok(lines.every((l) => /déjà en place/.test(l)));

  const current = [...stripe.prices.values()].find((p) => p.lookup_key === 'pro_monthly')!;
  current.unit_amount = 800;
  stripe.calls.length = 0;
  await setupCatalog(stripe.client, () => {});
  assert.equal(stripe.only('products.create').length, 0, 'même produit');
  const replaced = stripe.only('prices.create');
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].params.product, current.product);
  assert.equal(replaced[0].params.transfer_lookup_key, true);
  assert.equal(current.lookup_key, null, 'clé transférée au nouveau prix');

  const empty = fakeStripe();
  const t = await testApp({ billing: { client: empty.client, webhookSecret: SECRET } });
  try {
    const token = await connect(t, user);
    const res = await t.api('/v1/billing/checkout', { json: { kind: 'pro' }, token });
    assert.equal(res.status, 503);
    assert.match(String(res.body.error), /stripe-setup/);
  } finally {
    await t.close();
  }
});

test('webhook : signature fausse 400 ; type inconnu 200 ignoré ; même événement deux fois appliqué une fois', async () => {
  const { t } = await billingApp();
  try {
    const token = await connect(t, user);
    const payload = JSON.stringify(event('ping', {}));
    assert.equal((await webhook(t, JSON.parse(payload) as object, 't=1,v1=deadbeef')).status, 400);
    assert.equal((await webhook(t, JSON.parse(payload) as object, sign(payload, 'whsec_autre'))).status, 400, 'autre secret');
    const unknown = await webhook(t, JSON.parse(payload) as object);
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.body, { received: true, handled: 'ignored' });

    const accountId = (await t.db.query<{ id: string }>('SELECT id FROM accounts')).rows[0].id;
    const paid = event('checkout.session.completed', {
      id: 'cs_test_a',
      mode: 'payment',
      payment_status: 'paid',
      amount_total: 1000,
      currency: 'eur',
      client_reference_id: accountId,
      customer: 'cus_a',
      subscription: null,
      metadata: { account_id: accountId, kind: 'credits' },
    });
    assert.deepEqual((await webhook(t, paid)).body, { received: true, handled: 'new' });
    assert.deepEqual((await webhook(t, paid)).body, { received: true, handled: 'seen' }, 'relance Stripe');
    assert.equal((await me(t, token)).creditCents, 1001, '1 de bienvenue + 10 € une seule fois');
    const ledger = await t.db.query<{ reason: string; delta_cents: number; ref: string }>('SELECT reason, delta_cents, ref FROM credit_events ORDER BY id');
    assert.deepEqual(ledger.rows.slice(1), [{ reason: 'topup', delta_cents: 1000, ref: 'checkout:cs_test_a' }]);
    assert.equal(Number((await t.db.query<{ n: string | number }>('SELECT count(*) AS n FROM stripe_events')).rows[0].n), 2, 'inconnu + paiement ; signatures fausses jamais mémorisées');
  } finally {
    await t.close();
  }
});

test('webhook checkout.session.completed (paiement) : crédite le montant payé en euros ; devise ou paiement hors périmètre ignorés', async () => {
  const { t } = await billingApp();
  try {
    const token = await connect(t, user);
    assert.equal((await t.api('/v1/billing/checkout', { json: { kind: 'credits', pack: '5' }, token })).status, 200);
    const customer = (await t.db.query<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM accounts')).rows[0].stripe_customer_id;
    const base = { id: 'cs_1', mode: 'payment', payment_status: 'paid', amount_total: 500, currency: 'eur', client_reference_id: null, customer, subscription: null, metadata: null };
    assert.equal((await webhook(t, event('checkout.session.completed', base))).body.handled, 'new', 'retrouvé par le client Stripe');
    assert.equal((await me(t, token)).creditCents, 501);
    assert.equal((await webhook(t, event('checkout.session.completed', { ...base, id: 'cs_2', currency: 'usd' }))).body.handled, 'ignored');
    assert.equal((await webhook(t, event('checkout.session.completed', { ...base, id: 'cs_3', payment_status: 'unpaid' }))).body.handled, 'ignored');
    assert.equal((await webhook(t, event('checkout.session.completed', { ...base, id: 'cs_4', customer: 'cus_inconnu' }))).body.handled, 'ignored');
    assert.equal((await me(t, token)).creditCents, 501, 'rien d’autre crédité');
  } finally {
    await t.close();
  }
});

test('webhook checkout.session.completed (abonnement) puis invoice.paid : Pro, inclus remis, licence pro', async () => {
  const { t } = await billingApp();
  try {
    const token = await connect(t, user);
    assert.equal((await t.api('/v1/billing/checkout', { json: { kind: 'pro' }, token })).status, 200);
    const customer = (await t.db.query<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM accounts')).rows[0].stripe_customer_id;
    const started = await webhook(
      t,
      event('checkout.session.completed', { id: 'cs_pro', mode: 'subscription', payment_status: 'paid', amount_total: 900, currency: 'eur', client_reference_id: null, customer, subscription: 'sub_1', metadata: null }),
    );
    assert.equal(started.body.handled, 'new');
    let m = await me(t, token);
    assert.equal(m.plan, 'pro');
    assert.equal(m.tier, 'pro');
    assert.equal(m.subscription?.status, 'active');
    assert.equal(m.usage.includedLeftCents, PRO_INCLUDED_CENTS);
    assert.equal(m.creditCents, 1, 'crédits intacts');
    assert.equal((await t.api('/v1/license', { token, method: 'POST' })).body.tier, 'pro', 'licence signée Pro');

    assert.equal((await chat(t, token)).status, 200);
    m = await me(t, token);
    assert.equal(m.usage.includedLeftCents, PRO_INCLUDED_CENTS - 2, 'appel pris sur l’inclus');
    assert.equal(m.creditCents, 1);

    t.tick(20 * 86400_000); // sous la durée de session
    const renewed = await webhook(t, event('invoice.paid', { customer, parent: { subscription_details: { subscription: 'sub_1' } }, billing_reason: 'subscription_cycle' }));
    assert.equal(renewed.body.handled, 'new');
    m = await me(t, token);
    assert.equal(m.usage.includedLeftCents, PRO_INCLUDED_CENTS, 'inclus remis au renouvellement');
    assert.equal((await webhook(t, event('invoice.paid', { customer, subscription: null, parent: null }))).body.handled, 'ignored', 'facture sans abonnement');
    assert.equal((await webhook(t, event('invoice.paid', { customer: 'cus_inconnu', subscription: 'sub_x' }))).body.handled, 'ignored');
  } finally {
    await t.close();
  }
});

test('webhook invoice.payment_failed : statut past_due, Pro conservé en attendant les relances Stripe', async () => {
  const { t } = await billingApp();
  try {
    const token = await connect(t, user);
    await t.db.query("UPDATE accounts SET stripe_customer_id = 'cus_p', plan = 'pro', subscription_status = 'active', monthly_included_cents = 300 WHERE email = $1", [user.email]);
    assert.equal((await webhook(t, event('invoice.payment_failed', { customer: 'cus_p', subscription: 'sub_p' }))).body.handled, 'new');
    const m = await me(t, token);
    assert.equal(m.plan, 'pro');
    assert.equal(m.subscription?.status, 'past_due');
    assert.equal(m.usage.includedLeftCents, 300);
  } finally {
    await t.close();
  }
});

test('webhook customer.subscription.updated : fin de période et résiliation programmée affichées ; canceled → gratuit', async () => {
  const { t } = await billingApp();
  try {
    const token = await connect(t, user);
    await t.db.query("UPDATE accounts SET stripe_customer_id = 'cus_u', plan = 'pro', subscription_status = 'active', monthly_included_cents = 300 WHERE email = $1", [user.email]);
    const end = Math.floor(new Date('2026-12-03T12:00:00Z').getTime() / 1000);
    const updated = await webhook(t, event('customer.subscription.updated', { id: 'sub_u', customer: 'cus_u', status: 'active', cancel_at_period_end: true, items: { data: [{ current_period_end: end }] } }));
    assert.equal(updated.body.handled, 'new');
    let m = await me(t, token);
    assert.deepEqual(m.subscription, { status: 'active', currentPeriodEnd: '2026-12-03T12:00:00.000Z', cancelAtPeriodEnd: true });
    assert.equal(m.plan, 'pro');

    // Ancien format (champ au niveau de l'abonnement) accepté aussi.
    assert.equal((await webhook(t, event('customer.subscription.updated', { id: 'sub_u', customer: 'cus_u', status: 'active', cancel_at_period_end: false, current_period_end: end + 86400 }))).body.handled, 'new');
    m = await me(t, token);
    assert.deepEqual(m.subscription, { status: 'active', currentPeriodEnd: '2026-12-04T12:00:00.000Z', cancelAtPeriodEnd: false });

    assert.equal((await webhook(t, event('customer.subscription.updated', { id: 'sub_u', customer: 'cus_u', status: 'canceled', cancel_at_period_end: false }))).body.handled, 'new');
    m = await me(t, token);
    assert.equal(m.plan, 'free');
    assert.equal(m.tier, 'free');
    assert.equal(m.subscription?.status, 'canceled');
    assert.equal(m.usage.includedLeftCents, 0);
  } finally {
    await t.close();
  }
});

test('webhook customer.subscription.deleted : gratuit ; un ancien abonnement supprimé après un nouveau ne rétrograde pas', async () => {
  const { t } = await billingApp();
  try {
    const token = await connect(t, user);
    await t.db.query("UPDATE accounts SET stripe_customer_id = 'cus_d', stripe_subscription_id = 'sub_old', plan = 'pro', subscription_status = 'active', monthly_included_cents = 300 WHERE email = $1", [user.email]);
    assert.equal((await webhook(t, event('customer.subscription.deleted', { id: 'sub_old', customer: 'cus_d', status: 'canceled' }))).body.handled, 'new');
    let m = await me(t, token);
    assert.equal(m.plan, 'free');
    assert.equal(m.subscription?.status, 'canceled');
    assert.equal(m.usage.includedLeftCents, 0);

    // Réabonnement (invoice.paid d'un nouvel abonnement), puis suppression tardive de l'ancien.
    assert.equal((await webhook(t, event('invoice.paid', { customer: 'cus_d', subscription: 'sub_new' }))).body.handled, 'new');
    assert.equal((await me(t, token)).plan, 'pro');
    assert.equal((await webhook(t, event('customer.subscription.deleted', { id: 'sub_old', customer: 'cus_d', status: 'canceled' }))).body.handled, 'new');
    m = await me(t, token);
    assert.equal(m.plan, 'pro', 'le nouvel abonnement tient');
    assert.equal(m.usage.includedLeftCents, 300);

    // handleEvent directement : compte sans client Stripe connu → ignoré, événement quand même mémorisé.
    assert.equal(await handleEvent(t.db, event('customer.subscription.deleted', { id: 'sub_z', customer: 'cus_z', status: 'canceled' }), t.now()), 'ignored');
    assert.equal(await handleEvent(t.db, { id: `evt_${seq}`, type: 'customer.subscription.deleted', data: { object: {} } }, t.now()), 'seen');
  } finally {
    await t.close();
  }
});
