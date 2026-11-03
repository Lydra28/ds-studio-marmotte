// Crédits et prix de vente (lot 4, cadrage O4). Unité des soldes : centimes
// d'euro de valeur vendue. Le coût LLM (centimes de dollar, usage_events)
// est débité multiplié par RATE, arrondi au centime supérieur : change,
// variation des prix OpenRouter et marge, repère de references/server.md
// (6 appels = 0,02 $). Montants de test, provisoires (revoir quand les dix
// générations du lot 7 sont mesurées).
import type { Db } from './db.js';

/** Centimes d'euro débités par centime de dollar de coût LLM. */
export const RATE = 3;
/** Crédit de bienvenue : 1 centime = exactement une génération, le serveur laissant le dernier appel passer sous zéro. */
export const WELCOME_CENTS = 1;
/** Crédits inclus chaque mois dans Pro, centimes d'euro (prix de test). */
export const PRO_INCLUDED_CENTS = 300;

/** Débit d'un appel : au moins 1 centime dès que le coût est connu et positif. */
export const chargedCents = (costCents: number) => (costCents <= 0 ? 0 : Math.max(1, Math.ceil(costCents * RATE)));

export type CreditReason = 'welcome' | 'topup' | 'admin';

// Mouvement de crédits, journalisé dans credit_events ; avec `ref`, jamais
// appliqué deux fois (webhook Stripe relancé, bienvenue rejouée). Vrai si
// appliqué, faux si la référence était déjà passée.
export async function addCredits(
  db: Db,
  m: { accountId: string; deltaCents: number; reason: CreditReason; ref?: string | null; now: Date },
): Promise<boolean> {
  if (!Number.isInteger(m.deltaCents) || m.deltaCents === 0) throw new Error('addCredits : entier de centimes non nul attendu.');
  const { rows } = await db.query<{ account_id: string }>(
    `WITH e AS (
       INSERT INTO credit_events (account_id, delta_cents, reason, ref, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (ref) DO NOTHING
       RETURNING account_id
     )
     UPDATE accounts a SET credit_cents = a.credit_cents + $2 FROM e WHERE a.id = e.account_id RETURNING a.id AS account_id`,
    [m.accountId, m.deltaCents, m.reason, m.ref ?? null, m.now],
  );
  return rows.length === 1;
}
