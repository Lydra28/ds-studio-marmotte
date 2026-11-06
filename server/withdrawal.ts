// Droit de rétractation (lot 7.4, option A validée par Romain le 2026-11-06 ;
// texte public : CGV section 4). 14 jours après chaque achat (recharge ou
// premier paiement de Pro, registre `purchases` rempli par le webhook), la
// personne se rétracte depuis son compte sur le site : bouton « Se rétracter
// du contrat ici », puis déclaration (nom, contrat, adresse de l'accusé) et
// « Confirmer la rétractation » (fonction de rétractation, ordonnance
// 2026-2, en vigueur depuis le 19 juin 2026). Accusé de réception par mail
// tout de suite, avec la date et l'heure ; Romain est prévenu par mail et
// rembourse dans Stripe sous 14 jours, puis le marque dans admin:ui.
// Remboursé : ce qui n'a pas servi. Recharge : le solde restant, au plus le
// montant du pack (retiré du solde à la déclaration). Pro : au prorata du
// mois restant (inclus coupé à la déclaration ; Romain résilie l'abonnement
// dans Stripe).
// shortcut: remboursement et résiliation faits à la main dans Stripe ; à
// automatiser (refunds.create, subscriptions.cancel) quand les rétractations
// dépassent quelques-unes par mois.
import { Hono } from 'hono';
import { z } from 'zod';
import { body, requireAccount } from './auth.js';
import { ApiError, clock, type Deps } from './core.js';
import { addCredits } from './credits.js';
import type { Db, Tx } from './db.js';

export const WITHDRAWAL_DAYS = 14;
/** Délai légal de remboursement après la déclaration. */
export const REFUND_DAYS = 14;
const DAY = 86400_000;

export interface PurchaseRow {
  id: string | number;
  account_id: string;
  kind: 'credits' | 'pro';
  amount_cents: number;
  purchased_at: Date | string;
  withdrawn_at: Date | string | null;
  refund_cents: number | null;
  refunded_at: Date | string | null;
}

const plusMonth = (d: Date) => {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + 1);
  return x;
};
const eur = (c: number) => (c / 100).toFixed(2).replace('.', ',') + ' €';
const when = (d: Date) => d.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' });
const day = (d: Date) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });

export const purchaseLabel = (p: Pick<PurchaseRow, 'kind' | 'amount_cents' | 'purchased_at'>) =>
  `${p.kind === 'pro' ? 'Abonnement DS-Studio Pro' : `Recharge de crédits de ${eur(p.amount_cents)}`} du ${day(new Date(p.purchased_at))}`;

/** Montant à rembourser si la personne se rétracte maintenant : ce qui n'a pas servi. */
export function refundFor(p: Pick<PurchaseRow, 'kind' | 'amount_cents' | 'purchased_at'>, creditCents: number, now: Date) {
  if (p.kind === 'credits') return Math.max(0, Math.min(p.amount_cents, Math.floor(creditCents)));
  const start = new Date(p.purchased_at);
  const length = plusMonth(start).getTime() - start.getTime();
  const left = Math.max(0, Math.min(1, 1 - (now.getTime() - start.getTime()) / length));
  return Math.floor(p.amount_cents * left);
}

/** Achats de moins de 14 jours sans rétractation, avec ce qui serait remboursé. */
export async function withdrawable(db: Pick<Db, 'query'>, accountId: string, now: Date) {
  const { rows } = await db.query<PurchaseRow & { credit_cents: number }>(
    `SELECT p.*, a.credit_cents FROM purchases p JOIN accounts a ON a.id = p.account_id
      WHERE p.account_id = $1 AND p.withdrawn_at IS NULL AND p.purchased_at > $2
      ORDER BY p.purchased_at DESC`,
    [accountId, new Date(now.getTime() - WITHDRAWAL_DAYS * DAY)],
  );
  return rows.map((p) => ({
    id: Number(p.id),
    kind: p.kind,
    label: purchaseLabel(p),
    amountCents: p.amount_cents,
    purchasedAt: new Date(p.purchased_at).toISOString(),
    until: new Date(new Date(p.purchased_at).getTime() + WITHDRAWAL_DAYS * DAY).toISOString(),
    refundCents: refundFor(p, Number(p.credit_cents), now),
  }));
}

/** Achat enregistré par le webhook (dans sa transaction) ; une fois par session Checkout. */
export async function recordPurchase(tx: Tx, m: { accountId: string; kind: 'credits' | 'pro'; ref: string; amountCents: number; now: Date }) {
  await tx.query(
    'INSERT INTO purchases (account_id, kind, ref, amount_cents, purchased_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (ref) DO NOTHING',
    [m.accountId, m.kind, m.ref, m.amountCents, m.now],
  );
}

export type WithdrawResult = { purchaseId: number; label: string; refundCents: number; receivedAt: string; refundBy: string; kind: 'credits' | 'pro' };

/** Enregistre la déclaration : achat marqué, solde ou inclus coupé, montant figé. */
export async function withdraw(db: Db, m: { accountId: string; purchaseId: number; name: string; now: Date }): Promise<WithdrawResult> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<PurchaseRow & { credit_cents: number }>(
      `SELECT p.*, a.credit_cents FROM purchases p JOIN accounts a ON a.id = p.account_id
        WHERE p.id = $1 AND p.account_id = $2 FOR UPDATE OF p, a`,
      [m.purchaseId, m.accountId],
    );
    const p = rows[0];
    if (!p) throw new ApiError('Achat introuvable sur ce compte.', 404);
    if (p.withdrawn_at) throw new ApiError('Rétractation déjà reçue pour cet achat.', 409);
    const until = new Date(p.purchased_at).getTime() + WITHDRAWAL_DAYS * DAY;
    if (m.now.getTime() > until) throw new ApiError(`Délai de ${WITHDRAWAL_DAYS} jours dépassé pour cet achat.`, 409);
    const refund = refundFor(p, Number(p.credit_cents), m.now);
    await tx.query('UPDATE purchases SET withdrawn_at = $2, withdrawal_name = $3, refund_cents = $4 WHERE id = $1', [p.id, m.now, m.name, refund]);
    if (p.kind === 'credits' && refund > 0)
      await addCredits(tx, { accountId: m.accountId, deltaCents: -refund, reason: 'withdrawal', ref: `withdrawal:${p.id}`, now: m.now });
    if (p.kind === 'pro') await tx.query('UPDATE accounts SET monthly_included_cents = 0 WHERE id = $1', [m.accountId]);
    return {
      purchaseId: Number(p.id),
      kind: p.kind,
      label: purchaseLabel(p),
      refundCents: refund,
      receivedAt: m.now.toISOString(),
      refundBy: new Date(m.now.getTime() + REFUND_DAYS * DAY).toISOString(),
    };
  });
}

/** Rétractations reçues, à rembourser d'abord (admin:ui). */
export async function listWithdrawals(db: Pick<Db, 'query'>) {
  const { rows } = await db.query<PurchaseRow & { email: string; withdrawal_name: string | null }>(
    `SELECT p.*, a.email FROM purchases p JOIN accounts a ON a.id = p.account_id
      WHERE p.withdrawn_at IS NOT NULL ORDER BY p.refunded_at IS NOT NULL, p.withdrawn_at DESC LIMIT 100`,
  );
  return rows.map((p) => ({
    id: Number(p.id),
    email: p.email,
    name: p.withdrawal_name,
    label: purchaseLabel(p),
    kind: p.kind,
    amountCents: p.amount_cents,
    refundCents: p.refund_cents ?? 0,
    withdrawnAt: new Date(p.withdrawn_at!).toISOString(),
    refundBy: new Date(new Date(p.withdrawn_at!).getTime() + REFUND_DAYS * DAY).toISOString(),
    refundedAt: p.refunded_at ? new Date(p.refunded_at).toISOString() : null,
  }));
}

export async function markRefunded(db: Pick<Db, 'query'>, purchaseId: number, now: Date) {
  const { rows } = await db.query('UPDATE purchases SET refunded_at = $2 WHERE id = $1 AND withdrawn_at IS NOT NULL AND refunded_at IS NULL RETURNING id', [
    purchaseId,
    now,
  ]);
  return rows.length === 1;
}

const withdrawBody = z.object({
  purchaseId: z.number().int().positive(),
  name: z.string().trim().min(2, 'Indique ton nom.').max(120),
});

export function withdrawalRoutes(deps: Deps) {
  const app = new Hono();
  const account = requireAccount(deps);
  const now = clock(deps);

  app.get('/withdrawals', async (c) => {
    const me = await account(c);
    return c.json({ days: WITHDRAWAL_DAYS, email: me.email, purchases: await withdrawable(deps.db, me.id, now()) });
  });

  app.post('/withdraw', async (c) => {
    const me = await account(c);
    const input = await body(c, withdrawBody);
    const r = await withdraw(deps.db, { accountId: me.id, purchaseId: input.purchaseId, name: input.name, now: now() });
    const received = when(new Date(r.receivedAt));
    const refund =
      r.refundCents > 0
        ? `Montant remboursé : ${eur(r.refundCents)} (${r.kind === 'pro' ? 'part du mois restant' : 'crédits non utilisés'}), sur le moyen de paiement de l’achat, au plus tard le ${day(new Date(r.refundBy))}.`
        : `Montant remboursé : 0 € (${r.kind === 'pro' ? 'mois écoulé' : 'crédits déjà utilisés'}).`;
    // Accusé de réception sur un support durable (mail), sans délai. La
    // déclaration est déjà enregistrée : un mail en échec est signalé, pas perdu.
    let mailed = true;
    try {
      await deps.mailer.send({
        to: me.email,
        subject: 'DS-Studio : accusé de réception de ta rétractation',
        text:
          `Bonjour ${input.name},\n\nNous avons reçu ta rétractation le ${received} pour : ${r.label}.\n\n${refund}\n` +
          (r.kind === 'pro' ? '\nL’abonnement Pro est résilié sans renouvellement, et son usage inclus est arrêté.\n' : '') +
          `\nRomain Aubert, DS-Studio`,
      });
    } catch (e) {
      mailed = false;
      deps.report?.(e);
    }
    if (deps.adminEmail) {
      try {
        await deps.mailer.send({
          to: deps.adminEmail,
          subject: `DS-Studio : rétractation à rembourser (${eur(r.refundCents)})`,
          text:
            `Rétractation reçue le ${received}.\nCompte : ${me.email}\nNom déclaré : ${input.name}\nAchat : ${r.label}\n` +
            `À rembourser : ${eur(r.refundCents)} avant le ${day(new Date(r.refundBy))}.\n\n` +
            `Stripe → Clients → ${me.email} → le paiement → Rembourser (montant partiel si besoin).` +
            (r.kind === 'pro' ? ' Puis l’abonnement → Annuler l’abonnement → Immédiatement.' : '') +
            `\nEnsuite : npm run admin:ui → Rétractations → Remboursé.` +
            (mailed ? '' : '\n\nATTENTION : l’accusé de réception au client n’est pas parti, l’envoyer à la main.'),
        });
      } catch (e) {
        deps.report?.(e);
      }
    }
    return c.json({ ...r, mailed });
  });

  return app;
}
