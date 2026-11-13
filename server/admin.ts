// Administration du serveur, depuis un poste (jamais exposée en HTTP) :
//   npm run admin -- keys                    paire Ed25519 qui signe les licences
//   npm run admin -- grant <mail>            compte offert (Pro et jamais débité)
//   npm run admin -- cap <mail> <centimes>   plafond journalier de coût LLM
//   npm run admin -- usage <mail>            usage du jour, du mois, crédits, derniers appels
//   npm run admin -- credit <mail> <centimes> ajoute (négatif : retire) des crédits, centimes d'euro (lot 4)
//   npm run admin -- stripe-setup            produits et prix Stripe par lookup_key (STRIPE_SECRET_KEY : test ou live)
//   npm run admin -- delete-account <mail> [confirmer]  suppression sur demande (RGPD) ; sans « confirmer », dit ce qui partirait
//   npm run admin -- stripe-test-reset [confirmer]      fin du mode test Stripe, juste après les clés live ; sans « confirmer », aperçu
// Base : `DATABASE_URL` (server/.env en local ; depuis le poste, l'URL
// externe de la base Render). `keys` n'a pas besoin de base.
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setupCatalog, stripeClient, type BillingClient } from './billing.js';
import { pgDb, type Db } from './db.js';
import { addCredits } from './credits.js';
import { generateKeys } from './license.js';
import { usageSummary } from './relay.js';
import { deleteAccount, deletionPreview } from './retention.js';

/** Plafond journalier d'un compte offert, centimes de dollar de coût réel (3,17 € par mois au pire). */
export const GIFT_DAILY_CAP_CENTS = 10;
const USAGE = 'Usage : npm run admin -- keys | grant <mail> | cap <mail> <centimes> | usage <mail> | credit <mail> <centimes> | stripe-setup | stripe-test-reset [confirmer] | delete-account <mail> [confirmer]';

interface Row {
  id: string;
  email: string;
  plan: 'free' | 'pro';
  gifted: boolean;
  daily_cap_cents: number;
  credit_cents: number;
  monthly_included_cents: number;
  included_since: Date | string | null;
}
const cents = (n: number | string) => String(Math.round(Number(n) * 1000) / 1000);
const euros = (c: number | string) => (Number(c) / 100).toFixed(2).replace('.', ',') + ' €';
const iso = (d: Date | string) => new Date(d).toISOString().slice(0, 16).replace('T', ' ');

/** Plafond journalier par défaut d'un compte (colonne `daily_cap_cents`), rendu en retirant l'offert. */
export const DEFAULT_DAILY_CAP_CENTS = 50; // décision du 2026-11-06 (migration 0007)

export interface AccountView {
  id: string;
  email: string;
  verified: boolean;
  plan: 'free' | 'pro';
  gifted: boolean;
  subscriptionStatus: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  dailyCapCents: number;
  creditCents: number;
  includedLeftCents: number;
  todayCents: number;
  monthCents: number;
  lastUseAt: string | null;
  createdAt: string;
}

const isoOrNull = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

// Tous les comptes avec leur usage (coût réel en centimes de dollar, jour et
// mois UTC comme le relais), les plus coûteux du mois d'abord.
export async function listAccounts(db: Pick<Db, 'query'>, now: Date): Promise<AccountView[]> {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const { rows } = await db.query<{
    id: string;
    email: string;
    email_verified_at: Date | string | null;
    plan: 'free' | 'pro';
    gifted: boolean;
    subscription_status: string | null;
    current_period_end: Date | string | null;
    cancel_at_period_end: boolean;
    daily_cap_cents: number;
    credit_cents: number;
    monthly_included_cents: number;
    created_at: Date | string;
    today: number | string;
    month: number | string;
    included_used: number | string;
    last_use: Date | string | null;
  }>(
    `SELECT a.id, a.email, a.email_verified_at, a.plan, a.gifted, a.subscription_status, a.current_period_end,
            a.cancel_at_period_end, a.daily_cap_cents, a.credit_cents, a.monthly_included_cents, a.created_at,
            COALESCE(SUM(u.cost_cents) FILTER (WHERE u.created_at >= $1), 0)::float8 AS today,
            COALESCE(SUM(u.cost_cents) FILTER (WHERE u.created_at >= $2), 0)::float8 AS month,
            COALESCE(SUM(u.charged_cents) FILTER (WHERE u.charged_to = 'pro' AND u.created_at >= COALESCE(a.included_since, $2)), 0)::int AS included_used,
            MAX(u.created_at) AS last_use
       FROM accounts a LEFT JOIN usage_events u ON u.account_id = a.id
      WHERE a.deleted_at IS NULL
      GROUP BY a.id
      ORDER BY month DESC, a.created_at DESC`,
    [day, month],
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    verified: Boolean(r.email_verified_at),
    plan: r.plan,
    gifted: r.gifted,
    subscriptionStatus: r.subscription_status,
    periodEnd: isoOrNull(r.current_period_end),
    cancelAtPeriodEnd: r.cancel_at_period_end,
    dailyCapCents: r.daily_cap_cents,
    creditCents: r.credit_cents,
    includedLeftCents: r.plan === 'pro' ? Math.max(0, r.monthly_included_cents - Number(r.included_used)) : 0,
    todayCents: Number(r.today),
    monthCents: Number(r.month),
    lastUseAt: isoOrNull(r.last_use),
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

// Derniers appels et mouvements de crédits d'un compte.
export async function accountHistory(db: Pick<Db, 'query'>, accountId: string) {
  const usage = await db.query<{ created_at: Date | string; origin: string; cost_cents: number | string; charged_to: string; charged_cents: number }>(
    'SELECT created_at, origin, cost_cents, charged_to, charged_cents FROM usage_events WHERE account_id = $1 ORDER BY id DESC LIMIT 20',
    [accountId],
  );
  const credits = await db.query<{ created_at: Date | string; delta_cents: number; reason: string; ref: string | null }>(
    'SELECT created_at, delta_cents, reason, ref FROM credit_events WHERE account_id = $1 ORDER BY id DESC LIMIT 20',
    [accountId],
  );
  return {
    usage: usage.rows.map((e) => ({ at: new Date(e.created_at).toISOString(), origin: e.origin, costCents: Number(e.cost_cents), chargedTo: e.charged_to, chargedCents: e.charged_cents })),
    // Motif d'un mouvement admin : dans `ref` (`admin:<uuid>:<motif>`), sans migration.
    credits: credits.rows.map((e) => ({
      at: new Date(e.created_at).toISOString(),
      deltaCents: e.delta_cents,
      reason: e.reason,
      note: e.reason === 'admin' && e.ref?.startsWith('admin:') ? e.ref.split(':').slice(2).join(':') : null,
    })),
  };
}

// Offert : jamais débité, plafonné d'office à GIFT_DAILY_CAP_CENTS (décision
// du 2026-11-05). Retiré : compte classique, plafond par défaut rendu.
export async function setGift(db: Pick<Db, 'query'>, accountId: string, gifted: boolean): Promise<number | null> {
  const { rows } = await db.query<{ daily_cap_cents: number }>(
    gifted
      ? 'UPDATE accounts SET gifted = true, daily_cap_cents = LEAST(daily_cap_cents, $2) WHERE id = $1 RETURNING daily_cap_cents'
      : 'UPDATE accounts SET gifted = false, daily_cap_cents = $2 WHERE id = $1 RETURNING daily_cap_cents',
    [accountId, gifted ? GIFT_DAILY_CAP_CENTS : DEFAULT_DAILY_CAP_CENTS],
  );
  return rows[0]?.daily_cap_cents ?? null;
}

export async function setCap(db: Pick<Db, 'query'>, accountId: string, cap: number): Promise<boolean> {
  if (!Number.isInteger(cap) || cap < 0) throw new Error('Plafond : nombre entier de centimes attendu.');
  const { rows } = await db.query('UPDATE accounts SET daily_cap_cents = $2 WHERE id = $1 RETURNING id', [accountId, cap]);
  return rows.length === 1;
}

// Crédits offerts (positif) ou retirés (négatif), centimes d'euro, avec motif.
export async function adjustCredits(db: Pick<Db, 'query'>, accountId: string, delta: number, note: string, now: Date): Promise<number | null> {
  const clean = note.trim().replace(/\s+/g, ' ').slice(0, 200);
  await addCredits(db, { accountId, deltaCents: delta, reason: 'admin', ref: `admin:${randomUUID()}${clean ? ':' + clean : ''}`, now });
  const after = await db.query<{ credit_cents: number }>('SELECT credit_cents FROM accounts WHERE id = $1', [accountId]);
  return after.rows[0]?.credit_cents ?? null;
}

// Fin du mode test Stripe, juste après les clés live dans Render : les comptes gardent
// sinon un client et un abonnement de test (« No such customer » en live), un
// Pro et des crédits achetés en test, et des achats de test rétractables.
// Comptes non supprimés seulement (un compte anonymisé ne bouge plus) ;
// grand livre jamais effacé : les crédits achetés sont retirés par un
// mouvement admin à ce motif (à 0 si le solde est déjà dépensé, pour
// marquer le passage) ; un passage suivant ne regarde que les recharges
// d'après ce mouvement (relancer ne retire rien de plus). Refus
// dès qu'un achat live existe : le live a commencé, et toute recharge
// d'avant est alors de test (les crédits ne sont pas typés au grand livre).
// Pas avant les clés live : un webhook de test accepté ensuite recréerait
// client, Pro et achat de test.
export const STRIPE_TEST_RESET_NOTE = 'fin du mode test Stripe';
const TEST_PURCHASE = `p.ref LIKE 'checkout:cs\\_test\\_%'`;

export interface StripeTestResetPlan {
  livePurchases: number;
  accounts: { id: string; email: string; stripe: boolean; pro: boolean; boughtCents: number; removeCents: number }[];
  testPurchases: number;
}

export async function stripeTestResetPlan(db: Pick<Db, 'query'>): Promise<StripeTestResetPlan> {
  const live = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM purchases p WHERE p.ref LIKE 'checkout:cs\\_live\\_%'`);
  // Crédits achetés encore au solde : recharges moins rétractations depuis le
  // dernier retrait de cette commande, jamais plus que le solde.
  const { rows } = await db.query<{ id: string; email: string; plan: 'free' | 'pro'; credit_cents: number; stripe: boolean; bought: number }>(
    `SELECT * FROM (
       SELECT a.id, a.email, a.plan, a.credit_cents,
              (a.stripe_customer_id IS NOT NULL OR a.stripe_subscription_id IS NOT NULL OR a.subscription_status IS NOT NULL
               OR a.current_period_end IS NOT NULL OR a.included_since IS NOT NULL OR a.cancel_at_period_end OR a.plan = 'pro'
               OR EXISTS (SELECT 1 FROM purchases p WHERE p.account_id = a.id AND ${TEST_PURCHASE})) AS stripe,
              COALESCE((SELECT SUM(c.delta_cents) FROM credit_events c
                         WHERE c.account_id = a.id AND c.reason IN ('topup', 'withdrawal')
                           AND c.id > COALESCE((SELECT max(r.id) FROM credit_events r
                                                 WHERE r.account_id = a.id AND r.reason = 'admin' AND r.ref LIKE $1), 0)), 0)::int AS bought
         FROM accounts a
        WHERE a.deleted_at IS NULL) x
      WHERE stripe OR bought > 0
      ORDER BY email`,
    ['admin:%:' + STRIPE_TEST_RESET_NOTE],
  );
  const purchases = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM purchases p JOIN accounts a ON a.id = p.account_id WHERE a.deleted_at IS NULL AND ${TEST_PURCHASE}`,
  );
  return {
    livePurchases: live.rows[0].n,
    accounts: rows.map((r) => ({ id: r.id, email: r.email, stripe: r.stripe, pro: r.plan === 'pro', boughtCents: r.bought, removeCents: Math.max(0, Math.min(r.credit_cents, r.bought)) })),
    testPurchases: purchases.rows[0].n,
  };
}

export async function stripeTestReset(db: Db, now: Date): Promise<StripeTestResetPlan | { error: string }> {
  return db.transaction(async (tx) => {
    // Comptes verrouillés puis plan relu : un appel débité entre l'aperçu et
    // la confirmation, ou pendant, ne fait jamais passer le solde sous zéro.
    await tx.query('SELECT id FROM accounts WHERE deleted_at IS NULL FOR UPDATE');
    const plan = await stripeTestResetPlan(tx);
    if (plan.livePurchases > 0) return { error: `${plan.livePurchases} achat(s) live au registre : le mode live a commencé, rien n’est remis à zéro.` };
    for (const a of plan.accounts) {
      await tx.query(
        `UPDATE accounts SET stripe_customer_id = NULL, stripe_subscription_id = NULL, subscription_status = NULL,
                current_period_end = NULL, cancel_at_period_end = false, included_since = NULL, plan = 'free',
                monthly_included_cents = 0
          WHERE id = $1`,
        [a.id],
      );
      const ref = `admin:${randomUUID()}:${STRIPE_TEST_RESET_NOTE}`;
      if (a.removeCents > 0) await addCredits(tx, { accountId: a.id, deltaCents: -a.removeCents, reason: 'admin', ref, now });
      // Solde déjà dépensé : marqueur à 0 (addCredits refuse 0), sinon un geste
      // admin fait plus tard serait repris à la relance.
      else if (a.boughtCents > 0)
        await tx.query(`INSERT INTO credit_events (account_id, delta_cents, reason, ref, created_at) VALUES ($1, 0, 'admin', $2, $3)`, [a.id, ref, now]);
    }
    await tx.query(`DELETE FROM purchases p USING accounts a WHERE a.id = p.account_id AND a.deleted_at IS NULL AND ${TEST_PURCHASE}`);
    return plan;
  });
}

export async function runAdmin(db: Db | null, argv: string[], out: (line: string) => void, now = new Date(), billing: BillingClient | null = null): Promise<number> {
  const [command, email, value] = argv;
  if (command === 'stripe-setup') {
    if (!billing) {
      out('STRIPE_SECRET_KEY manquante (server/.env ou environnement) : impossible de poser le catalogue.');
      return 1;
    }
    await setupCatalog(billing, out);
    return 0;
  }
  if (command === 'stripe-test-reset') {
    if (!db) {
      out('DATABASE_URL manquante (server/.env ou environnement) : impossible d’administrer.');
      return 1;
    }
    // Ici `email` est le mot de confirmation : stripe-test-reset [confirmer].
    const confirmed = email === 'confirmer';
    const result = confirmed ? await stripeTestReset(db, now) : await stripeTestResetPlan(db);
    if ('error' in result) {
      out(result.error);
      return 1;
    }
    if (!confirmed && result.livePurchases > 0) {
      out(`${result.livePurchases} achat(s) live au registre : le mode live a commencé, rien ne sera remis à zéro.`);
      return 1;
    }
    const verb = confirmed ? '' : ' (aperçu)';
    for (const a of result.accounts) {
      const parts = [a.stripe && 'identifiants Stripe de test effacés', a.pro && 'Pro de test retiré', a.removeCents > 0 ? `crédits achetés en test retirés ${euros(a.removeCents)}` : a.boughtCents > 0 && 'crédits achetés en test déjà dépensés'];
      out(`${a.email}${verb} : ${parts.filter(Boolean).join(', ')}.`);
    }
    out(`${result.accounts.length} compte(s), ${result.testPurchases} achat(s) de test ${confirmed ? 'retirés' : 'à retirer'} du registre de rétractation.`);
    if (!confirmed) out('Pour appliquer : npm run admin -- stripe-test-reset confirmer');
    return confirmed ? 0 : 1;
  }
  if (command === 'keys') {
    const keys = generateKeys();
    out('# Clé privée : variable LICENSE_PRIVATE_KEY du serveur (Render), jamais dans le dépôt.');
    out(keys.privateKeyPem.trimEnd());
    out('');
    out('# Clé publique : server/license-public.pem (suivie par git, embarquée dans l’app au lot 3).');
    out(keys.publicKeyPem.trimEnd());
    return 0;
  }
  if (!command || !['grant', 'cap', 'usage', 'credit', 'delete-account'].includes(command) || !email) {
    out(USAGE);
    return 1;
  }
  if (!db) {
    out('DATABASE_URL manquante (server/.env ou environnement) : impossible d’administrer.');
    return 1;
  }
  const { rows } = await db.query<Row>(
    'SELECT id, email, plan, gifted, daily_cap_cents, credit_cents, monthly_included_cents, included_since FROM accounts WHERE email = $1',
    [email.trim().toLowerCase()],
  );
  const account = rows[0];
  if (!account) {
    out(`Aucun compte ${email}.`);
    return 1;
  }
  if (command === 'delete-account') {
    const p = await deletionPreview(db, account.id);
    if (!p) return 1;
    if (p.activeSubscription) {
      out(`${account.email} : abonnement Stripe en cours, à résilier d’abord (tableau de bord Stripe, résiliation immédiate).`);
      return 1;
    }
    const what = p.mode === 'erased' ? 'tout sera effacé' : 'compte anonymisé, grand livre et identifiants Stripe gardés 10 ans';
    const lost = p.creditCents > 0 ? `, solde perdu ${euros(p.creditCents)}` : '';
    if (value !== 'confirmer') {
      out(`${account.email} : ${what}${lost}. Pour supprimer : npm run admin -- delete-account ${account.email} confirmer`);
      return 1;
    }
    const r = await deleteAccount(db, account.id, now);
    if (!r.ok) {
      out(`${account.email} : ${r.error}`);
      return 1;
    }
    out(`${account.email} : ${r.mode === 'erased' ? 'compte effacé' : 'compte anonymisé'}${lost}.`);
    return 0;
  }
  if (command === 'grant') {
    // Un compte offert n'est jamais débité : tout son usage est un coût,
    // plafonné d'office (décision du 2026-11-05) ; `cap` l'ajuste ensuite.
    const cap = await setGift(db, account.id, true);
    out(`${account.email} : compte offert (palier effectif Pro, jamais débité ; plafond journalier ${cap} centimes de coût réel).`);
    return 0;
  }
  if (command === 'cap') {
    const cap = Number(value);
    if (!Number.isInteger(cap) || cap < 0) {
      out('Plafond : nombre entier de centimes attendu.');
      return 1;
    }
    await setCap(db, account.id, cap);
    out(`${account.email} : plafond journalier ${cap} centimes.`);
    return 0;
  }
  if (command === 'credit') {
    const delta = Number(value);
    if (!Number.isInteger(delta) || delta === 0) {
      out('Crédits : nombre entier de centimes d’euro, non nul, attendu (négatif pour retirer).');
      return 1;
    }
    await addCredits(db, { accountId: account.id, deltaCents: delta, reason: 'admin', now });
    const after = await db.query<{ credit_cents: number }>('SELECT credit_cents FROM accounts WHERE id = $1', [account.id]);
    out(`${account.email} : ${delta > 0 ? '+' : ''}${delta} c, crédits ${euros(after.rows[0].credit_cents)}.`);
    return 0;
  }
  // Coûts en centimes de dollar (c), soldes en euros (lot 4).
  const usage = await usageSummary(db, { id: account.id, includedSince: account.included_since ? new Date(account.included_since).toISOString() : null }, now);
  out(
    `${account.email} : ${account.plan}${account.gifted ? ' (offert)' : ''} ; aujourd’hui ${cents(usage.todayCents)} c, mois ${cents(usage.monthCents)} c, ` +
      `plafond ${account.daily_cap_cents} c, crédits ${euros(account.credit_cents)}, inclus restant ${euros(Math.max(0, account.monthly_included_cents - usage.includedUsedCents))}`,
  );
  const events = await db.query<{ created_at: Date | string; origin: string; model: string; prompt_tokens: number; completion_tokens: number; cost_cents: number | string; charged_to: string; charged_cents: number }>(
    'SELECT created_at, origin, model, prompt_tokens, completion_tokens, cost_cents, charged_to, charged_cents FROM usage_events WHERE account_id = $1 ORDER BY id DESC LIMIT 10',
    [account.id],
  );
  for (const e of events.rows) {
    out(
      `  ${iso(e.created_at)} ${e.origin} ${e.model} ${e.prompt_tokens}+${e.completion_tokens} jetons ${cents(e.cost_cents)} c → ${e.charged_to}` +
        (e.charged_cents > 0 ? ` (${e.charged_cents} c€)` : ''),
    );
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  let db: Db | null = null;
  let billing: BillingClient | null = null;
  if (argv[0] === 'stripe-setup') {
    if (!process.env.STRIPE_SECRET_KEY) {
      try {
        process.loadEnvFile(new URL('.env', import.meta.url));
      } catch {
        /* pas de server/.env */
      }
    }
    const key = process.env.STRIPE_SECRET_KEY;
    if (key) {
      // Seul le préfixe est affiché : jamais la clé.
      console.log(`Stripe en mode ${key.startsWith('sk_live_') ? 'LIVE' : 'test'}.`);
      billing = stripeClient(key);
    }
  } else if (argv[0] !== 'keys') {
    if (!process.env.DATABASE_URL) {
      try {
        process.loadEnvFile(new URL('.env', import.meta.url));
      } catch {
        /* pas de server/.env */
      }
    }
    const url = process.env.DATABASE_URL;
    if (url === 'memory') {
      console.error('DATABASE_URL=memory : base éphémère, rien à administrer.');
      process.exit(1);
    }
    db = url ? await pgDb(url) : null;
  }
  const code = await runAdmin(db, argv, (line) => console.log(line), new Date(), billing);
  await db?.close();
  process.exit(code);
}
