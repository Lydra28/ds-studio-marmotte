// Stripe (lot 4, cadrage O4) : abonnement Pro et recharges de crédits par
// Checkout, portail client, webhooks signés et idempotents, catalogue posé
// par `npm run admin -- stripe-setup`. Le client Stripe est injectable : vrai
// SDK en production, faux objet dans les tests (zéro réseau) ; la
// vérification de signature reste celle du SDK. Montants de test, provisoires
// (revoir quand les dix générations du lot 7 sont mesurées).
import { Hono } from 'hono';
import Stripe from 'stripe';
import { z } from 'zod';
import { body, htmlPage, requireAccount, type Account } from './auth.js';
import { ApiError, clock, type Deps } from './core.js';
import { addCredits, PRO_INCLUDED_CENTS, WELCOME_CENTS } from './credits.js';
import type { Db, Tx } from './db.js';
import { recordPurchase } from './withdrawal.js';

export type Pack = '5' | '10' | '20';
/** Catalogue : un produit et un prix par clé, retrouvés par `lookup_key` (jamais d'identifiant de prix en configuration). */
export const CATALOG = [
  { key: 'pro_monthly', name: 'DS-Studio Pro', unitAmount: 999, recurring: true },
  { key: 'credits_5', name: 'Crédits DS-Studio · 5 €', unitAmount: 500, recurring: false },
  { key: 'credits_10', name: 'Crédits DS-Studio · 10 €', unitAmount: 1000, recurring: false },
  { key: 'credits_20', name: 'Crédits DS-Studio · 20 €', unitAmount: 2000, recurring: false },
] as const;
export const PACKS: Record<Pack, string> = { '5': 'credits_5', '10': 'credits_10', '20': 'credits_20' };
/**
 * Débit moyen d'une génération, centimes d'euro, par origine : sert aux
 * « ≈ N générations » de l'app et du site. Mesure du 2026-11-05 (Mur 0,46 à
 * 0,77 c$, assistant 0,03 à 0,34 c$, × RATE 5,5 arrondi : 4 et 1,24 c€) ;
 * revoir avec RATE.
 */
export const GENERATION_CENTS = { wall: 4, assistant: 1 } as const;
/** Mode de paiement du serveur : clé live, clé de test, ou pas de Stripe. */
export type BillingMode = 'live' | 'test' | 'off';
/**
 * Catalogue public (lot 7) : seule source des prix pour l'app (Réglages,
 * via /v1/me) et le site vitrine (GET /v1/billing/catalog). Montants en
 * centimes d'euro.
 */
export function catalog(mode: BillingMode) {
  const amount = (key: string) => CATALOG.find((i) => i.key === key)?.unitAmount ?? 0;
  return {
    currency: 'eur' as const,
    mode,
    pro: { amountCents: amount('pro_monthly'), interval: 'month' as const, includedCents: PRO_INCLUDED_CENTS },
    packs: (Object.entries(PACKS) as [Pack, string][]).map(([pack, key]) => ({ pack, amountCents: amount(key) })),
    welcomeCents: WELCOME_CENTS,
    generationCents: GENERATION_CENTS,
  };
}
export const billingMode = (billing: Billing | undefined): BillingMode => (!billing ? 'off' : billing.live ? 'live' : 'test');
/** Événements à cocher sur l'endpoint webhook du Dashboard (runbook server.md). */
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
] as const;
const PRICES_TTL_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ref = string | { id: string } | null | undefined;
const idOf = (r: Ref) => (typeof r === 'string' ? r : (r?.id ?? null));

/** Un événement Stripe tel que le webhook le reçoit ; `Stripe.Event` s'y conforme. */
export interface WebhookEvent {
  id: string;
  type: string;
  data: { object: unknown };
}

/** Ce que le serveur demande à Stripe ; le vrai SDK s'y conforme, les tests le simulent. */
export interface BillingClient {
  customers: { create(params: Stripe.CustomerCreateParams): Promise<{ id: string }> };
  products: { create(params: Stripe.ProductCreateParams): Promise<{ id: string }> };
  prices: {
    list(params: Stripe.PriceListParams): Promise<{ data: { id: string; lookup_key: string | null; unit_amount: number | null; active: boolean; product: string | { id: string } }[] }>;
    create(params: Stripe.PriceCreateParams): Promise<{ id: string }>;
  };
  checkout: { sessions: { create(params: Stripe.Checkout.SessionCreateParams): Promise<{ id: string; url: string | null }> } };
  billingPortal: { sessions: { create(params: Stripe.BillingPortal.SessionCreateParams): Promise<{ url: string }> } };
  webhooks: { constructEvent(payload: string, header: string, secret: string): WebhookEvent };
}
export interface Billing {
  client: BillingClient;
  /** Secret de signature de l'endpoint webhook (`whsec_…`), différent en test et en live. */
  webhookSecret: string;
  /** Clé `sk_live_` : vrais paiements (lot 7). Absent : mode test. */
  live?: boolean;
  /**
   * Case « J'accepte les conditions de vente » sur la page Stripe (lot 7).
   * Stripe refuse la session tant que l'URL des CGV manque dans ses Public
   * details : n'activer (`STRIPE_TERMS_CONSENT=1`) qu'après l'avoir posée.
   */
  termsConsent?: boolean;
}

export function stripeClient(secretKey: string): BillingClient {
  const stripe = new Stripe(secretKey, { appInfo: { name: 'DS-Studio', url: 'https://design-system-studio.fr' } });
  return {
    customers: { create: (p) => stripe.customers.create(p) },
    products: { create: (p) => stripe.products.create(p) },
    prices: { list: (p) => stripe.prices.list(p), create: (p) => stripe.prices.create(p) },
    checkout: { sessions: { create: (p) => stripe.checkout.sessions.create(p) } },
    billingPortal: { sessions: { create: (p) => stripe.billingPortal.sessions.create(p) } },
    webhooks: { constructEvent: (payload, header, secret) => stripe.webhooks.constructEvent(payload, header, secret) },
  };
}
/** Vérificateur de signature du SDK, sans client ni réseau (les tests l'injectent dans leur faux client). */
export const stripeWebhooks: BillingClient['webhooks'] = Stripe.webhooks;

// Catalogue : crée ce qui manque, remplace un prix dont le montant a changé
// (les prix Stripe sont immuables : nouveau prix, `lookup_key` transféré),
// ne touche à rien d'à jour. Même commande en test puis en live.
export async function setupCatalog(client: BillingClient, out: (line: string) => void) {
  for (const item of CATALOG) {
    const { data } = await client.prices.list({ lookup_keys: [item.key], limit: 1 });
    const current = data[0];
    if (current && current.active && current.unit_amount === item.unitAmount) {
      out(`${item.key} : déjà en place (${current.id}, ${item.unitAmount} c)`);
      continue;
    }
    const product = (current && idOf(current.product)) || (await client.products.create({ name: item.name })).id;
    const price = await client.prices.create({
      product,
      currency: 'eur',
      unit_amount: item.unitAmount,
      lookup_key: item.key,
      transfer_lookup_key: true,
      ...(item.recurring ? { recurring: { interval: 'month' } } : {}),
    });
    out(`${item.key} : ${current ? 'nouveau prix' : 'produit et prix créés'} (${price.id}, ${item.unitAmount} c)`);
  }
}

const SUBSCRIPTION_ENDED = new Set(['canceled', 'unpaid', 'incomplete_expired']);
const SUBSCRIPTION_LIVE = new Set(['active', 'trialing', 'past_due']);
const unixDate = (s: number | null | undefined) => (typeof s === 'number' ? new Date(s * 1000) : null);

async function accountByCustomer(tx: Tx, customer: Ref) {
  const id = idOf(customer);
  if (!id) return null;
  const { rows } = await tx.query<{ id: string }>('SELECT id FROM accounts WHERE stripe_customer_id = $1', [id]);
  return rows[0]?.id ?? null;
}

// Abonnement payé (première fois ou renouvellement) : Pro, crédits inclus
// remis, période d'inclus repartie de maintenant.
async function startPro(tx: Tx, accountId: string, customer: Ref, subscription: Ref, now: Date) {
  await tx.query(
    `UPDATE accounts SET stripe_customer_id = COALESCE(stripe_customer_id, $2), stripe_subscription_id = COALESCE($3, stripe_subscription_id),
       plan = 'pro', subscription_status = 'active', monthly_included_cents = $4, included_since = $5, cancel_at_period_end = false
     WHERE id = $1`,
    [accountId, idOf(customer), idOf(subscription), PRO_INCLUDED_CENTS, now],
  );
}

/**
 * Applique un événement Stripe, une seule fois par id (`stripe_events`), dans
 * une transaction. `new` : appliqué ; `seen` : déjà reçu ; `ignored` : type
 * inconnu, compte introuvable ou objet hors périmètre (journalisé).
 */
export async function handleEvent(db: Db, event: WebhookEvent, now: Date): Promise<'new' | 'seen' | 'ignored'> {
  return db.transaction(async (tx) => {
    const seen = await tx.query<{ id: string }>(
      'INSERT INTO stripe_events (id, type, received_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING id',
      [event.id, event.type, now],
    );
    if (seen.rows.length === 0) return 'seen';
    const ignore = (why: string) => {
      console.warn(`Stripe ${event.type} ${event.id} ignoré : ${why}.`);
      return 'ignored' as const;
    };

    if (event.type === 'checkout.session.completed') {
      const s = event.data.object as {
        id: string;
        mode: string;
        payment_status: string;
        amount_total: number | null;
        currency: string | null;
        client_reference_id: string | null;
        customer: Ref;
        subscription: Ref;
        metadata: Record<string, string> | null;
      };
      const ref = s.client_reference_id ?? s.metadata?.account_id ?? null;
      let accountId: string | null = null;
      if (ref && UUID.test(ref)) accountId = (await tx.query<{ id: string }>('SELECT id FROM accounts WHERE id = $1', [ref])).rows[0]?.id ?? null;
      accountId ??= await accountByCustomer(tx, s.customer);
      if (!accountId) return ignore('compte introuvable');
      if (s.mode === 'subscription') {
        await startPro(tx, accountId, s.customer, s.subscription, now);
        if (s.payment_status === 'paid' && s.currency === 'eur' && s.amount_total && s.amount_total > 0)
          await recordPurchase(tx, { accountId, kind: 'pro', ref: `checkout:${s.id}`, amountCents: s.amount_total, now });
        return 'new';
      }
      if (s.mode !== 'payment') return ignore(`mode ${s.mode}`);
      if (s.payment_status !== 'paid') return ignore(`paiement ${s.payment_status}`);
      if (s.currency !== 'eur' || !s.amount_total || s.amount_total <= 0) return ignore(`montant ${s.amount_total} ${s.currency}`);
      await addCredits(tx, { accountId, deltaCents: s.amount_total, reason: 'topup', ref: `checkout:${s.id}`, now });
      await recordPurchase(tx, { accountId, kind: 'credits', ref: `checkout:${s.id}`, amountCents: s.amount_total, now });
      await tx.query('UPDATE accounts SET stripe_customer_id = COALESCE(stripe_customer_id, $2) WHERE id = $1', [accountId, idOf(s.customer)]);
      return 'new';
    }

    if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      const inv = event.data.object as {
        customer: Ref;
        subscription?: Ref;
        parent?: { subscription_details?: { subscription?: Ref } | null } | null;
      };
      const accountId = await accountByCustomer(tx, inv.customer);
      if (!accountId) return ignore('client inconnu');
      const subscription = idOf(inv.parent?.subscription_details?.subscription) ?? idOf(inv.subscription);
      if (!subscription) return ignore('facture sans abonnement');
      if (event.type === 'invoice.paid') await startPro(tx, accountId, inv.customer, subscription, now);
      else await tx.query("UPDATE accounts SET subscription_status = 'past_due' WHERE id = $1 AND plan = 'pro'", [accountId]);
      return 'new';
    }

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object as {
        id: string;
        customer: Ref;
        status: string;
        cancel_at_period_end?: boolean;
        cancel_at?: number | null;
        current_period_end?: number;
        items?: { data?: { current_period_end?: number }[] };
      };
      const accountId = await accountByCustomer(tx, sub.customer);
      if (!accountId) return ignore('client inconnu');
      const periodEnd = unixDate(sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end);
      if (event.type === 'customer.subscription.deleted') {
        // Un ancien abonnement supprimé après un nouveau ne rétrograde pas le compte.
        await tx.query(
          `UPDATE accounts SET plan = 'free', subscription_status = 'canceled', monthly_included_cents = 0, cancel_at_period_end = false, current_period_end = $3
           WHERE id = $1 AND (stripe_subscription_id IS NULL OR stripe_subscription_id = $2)`,
          [accountId, sub.id, periodEnd],
        );
        return 'new';
      }
      const ended = SUBSCRIPTION_ENDED.has(sub.status);
      // Résiliation programmée : le portail (API 2025+) pose une date `cancel_at` (fin de période)
      // et laisse `cancel_at_period_end` à false ; vu en production le 2026-11-03. Les deux formes valent.
      const scheduled = Boolean(sub.cancel_at_period_end) || typeof sub.cancel_at === 'number';
      await tx.query(
        `UPDATE accounts SET stripe_subscription_id = $2, subscription_status = $3, cancel_at_period_end = $4, current_period_end = $5,
           plan = CASE WHEN $6::boolean THEN 'free' WHEN $7::boolean THEN 'pro' ELSE plan END,
           monthly_included_cents = CASE WHEN $6::boolean THEN 0 ELSE monthly_included_cents END
         WHERE id = $1`,
        [accountId, sub.id, sub.status, scheduled, periodEnd, ended, SUBSCRIPTION_LIVE.has(sub.status)],
      );
      return 'new';
    }

    return ignore('type non traité');
  });
}

const checkoutSchema = z.object({ kind: z.enum(['pro', 'credits']), pack: z.enum(['5', '10', '20']).optional() });

export function billingRoutes(deps: Deps) {
  const app = new Hono();
  const account = requireAccount(deps);
  const now = clock(deps);
  const billing = () => {
    if (!deps.billing) throw new ApiError('Paiement indisponible sur ce serveur.', 503);
    return deps.billing;
  };
  const done = () => `${deps.publicUrl}/v1/billing/done`;
  // Retours de Stripe : pages du site en ligne, sinon pages minimales de l'API.
  const site = deps.siteUrl;
  const back = {
    ok: site ? `${site}/merci/` : `${done()}?s=ok`,
    cancel: site ? `${site}/paiement-annule/` : `${done()}?s=cancel`,
    portal: site ? `${site}/compte/` : `${done()}?s=portal`,
  };

  // Prix par clé, retenus dix minutes.
  const prices = new Map<string, { id: string; at: number }>();
  async function priceId(client: BillingClient, key: string) {
    const cached = prices.get(key);
    if (cached && now().getTime() - cached.at < PRICES_TTL_MS) return cached.id;
    const { data } = await client.prices.list({ lookup_keys: [key], active: true, limit: 1 });
    if (!data[0]) throw new ApiError(`Prix ${key} introuvable chez Stripe : lance « npm run admin -- stripe-setup ».`, 503);
    prices.set(key, { id: data[0].id, at: now().getTime() });
    return data[0].id;
  }

  // Un client Stripe par compte, créé au premier achat et mémorisé avant la
  // session : tous les événements se retrouvent ensuite par ce client.
  async function customerId(client: BillingClient, me: Account) {
    if (me.stripeCustomerId) return me.stripeCustomerId;
    const customer = await client.customers.create({ email: me.email, metadata: { account_id: me.id } });
    await deps.db.query('UPDATE accounts SET stripe_customer_id = $2 WHERE id = $1 AND stripe_customer_id IS NULL', [me.id, customer.id]);
    const { rows } = await deps.db.query<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM accounts WHERE id = $1', [me.id]);
    return rows[0].stripe_customer_id;
  }

  app.post('/checkout', async (c) => {
    const me = await account(c);
    const { client, termsConsent } = billing();
    const input = await body(c, checkoutSchema);
    if (input.kind === 'pro' && me.gifted) throw new ApiError('Compte offert : Pro est déjà inclus.', 409);
    if (input.kind === 'pro' && me.plan === 'pro') throw new ApiError('Déjà abonné à Pro : gère ton abonnement depuis le portail.', 409);
    const key = input.kind === 'pro' ? 'pro_monthly' : PACKS[input.pack ?? '5'];
    const customer = await customerId(client, me);
    const session = await client.checkout.sessions.create({
      mode: input.kind === 'pro' ? 'subscription' : 'payment',
      customer,
      client_reference_id: me.id,
      line_items: [{ price: await priceId(client, key), quantity: 1 }],
      success_url: back.ok,
      cancel_url: back.cancel,
      locale: 'fr',
      // Service fourni tout de suite à la demande exprès du client, qui garde
      // 14 jours pour se rétracter (CGV section 4, server/withdrawal.ts) : ce
      // qui a servi n'est pas remboursé (art. L221-25 du Code de la consommation).
      ...(termsConsent && site
        ? {
            consent_collection: { terms_of_service: 'required' as const },
            custom_text: {
              terms_of_service_acceptance: {
                message: `J’accepte les [conditions de vente](${site}/cgv/) et demande que le service commence tout de suite. Je garde 14 jours pour me rétracter depuis mon compte ; ce que j’aurai déjà utilisé ne sera pas remboursé.`,
              },
            },
          }
        : {}),
      metadata: { account_id: me.id, kind: input.kind },
      ...(input.kind === 'pro' ? { subscription_data: { metadata: { account_id: me.id } } } : {}),
    });
    if (!session.url) throw new ApiError('Stripe n’a pas rendu d’adresse de paiement.', 502);
    return c.json({ url: session.url });
  });

  app.post('/portal', async (c) => {
    const me = await account(c);
    const { client } = billing();
    if (!me.stripeCustomerId) throw new ApiError('Aucun achat encore : rien à gérer.', 409);
    const session = await client.billingPortal.sessions.create({ customer: me.stripeCustomerId, return_url: back.portal });
    return c.json({ url: session.url });
  });

  // Catalogue public : aucun compte demandé, même réponse pour tous.
  app.get('/catalog', (c) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(catalog(billingMode(deps.billing)));
  });

  // Pages de retour minimales (le site du lot 7 les remplacera).
  app.get('/done', (c) => {
    const s = c.req.query('s');
    if (s === 'ok') return c.html(htmlPage('Paiement enregistré', 'Merci. Retourne dans DS-Studio et clique « Actualiser » dans Réglages → Compte : le solde ou le palier Pro apparaît en quelques secondes.'));
    if (s === 'cancel') return c.html(htmlPage('Paiement annulé', 'Rien n’a été débité. Tu peux fermer cette page et retourner dans DS-Studio.'));
    return c.html(htmlPage('Retour du portail', 'Tes changements sont pris en compte. Retourne dans DS-Studio et clique « Actualiser » dans Réglages → Compte.'));
  });

  // Webhook : corps brut (jamais parsé avant la signature), 400 si la
  // signature est fausse, 200 même pour un événement déjà vu ou inconnu.
  app.post('/webhook', async (c) => {
    const { client, webhookSecret } = billing();
    const raw = await c.req.text();
    let event: WebhookEvent;
    try {
      event = client.webhooks.constructEvent(raw, c.req.header('stripe-signature') ?? '', webhookSecret);
    } catch {
      throw new ApiError('Signature Stripe invalide.', 400);
    }
    const handled = await handleEvent(deps.db, event, now());
    return c.json({ received: true, handled });
  });

  return app;
}
