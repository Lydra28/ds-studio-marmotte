// Durées de conservation (lot 7.4, validées par Romain le 2026-11-06 ; texte
// public : site/src/pages/confidentialite.astro, à garder d'accord avec
// `RETENTION`). `purge` tourne au démarrage du serveur puis chaque jour
// (server/index.ts) ; `deleteAccount` sert la suppression sur demande (CLI
// et admin:ui) et la suppression pour inactivité.
//
// Suppression d'un compte : effacé tout entier s'il n'a jamais rien acheté ;
// sinon anonymisé (plus d'adresse, de mot de passe, de session ni d'usage) et
// gardé 10 ans pour le grand livre des crédits et les identifiants Stripe
// (pièces comptables), puis effacé.
import { addCredits } from './credits.js';
import type { Db, Tx } from './db.js';
import type { Mailer } from './mail.js';

export const RETENTION = {
  /** Compte jamais confirmé : supprimé après ce délai. */
  unverifiedDays: 30,
  /** Compte sans connexion ni requête pendant ce délai : supprimé… */
  inactiveYears: 3,
  /** … après un mail d'avertissement parti ce nombre de jours avant. */
  warningDays: 30,
  /** Jeton de mail expiré : gardé ce délai (traces d'un abus), puis supprimé. */
  emailTokenDays: 30,
  /** Usage appel par appel ; au-delà, total mensuel par compte et origine. */
  usageDetailMonths: 12,
  /** Compte supprimé qui a acheté : ligne anonymisée gardée ce délai. */
  ledgerYears: 10,
} as const;

const DAY = 86400_000;
const minusDays = (d: Date, n: number) => new Date(d.getTime() - n * DAY);
const minusMonths = (d: Date, n: number) => {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() - n);
  return x;
};
const minusYears = (d: Date, n: number) => minusMonths(d, 12 * n);

// Abonnement Stripe en cours : tout statut sauf terminé. Un compte avec un
// abonnement en cours ou un solde positif acheté n'est jamais supprimé
// d'office. Un solde seulement offert (bienvenue, geste admin) ne protège
// pas : sinon tout compte confirmé qui n'a jamais servi resterait à vie.
const ACTIVE_SUBSCRIPTION = `(subscription_status IS NOT NULL AND subscription_status NOT IN ('canceled', 'incomplete_expired'))`;
const PURCHASED = `(stripe_customer_id IS NOT NULL OR EXISTS (SELECT 1 FROM credit_events c WHERE c.account_id = a.id AND c.reason = 'topup'))`;
const PROTECTED = `((credit_cents > 0 AND ${PURCHASED}) OR ${ACTIVE_SUBSCRIPTION})`;

// « A acheté » : client Stripe ou recharge au grand livre ; décide entre
// effacer et anonymiser.
interface StateRow {
  credit_cents: number;
  active: boolean;
  purchased: boolean;
  deleted: boolean;
}
const STATE_SQL = `SELECT credit_cents, ${ACTIVE_SUBSCRIPTION} AS active, deleted_at IS NOT NULL AS deleted, ${PURCHASED} AS purchased
    FROM accounts a WHERE id = $1`;

export type DeleteResult =
  | { ok: true; mode: 'erased' | 'anonymised'; forfeitedCents: number }
  | { ok: false; error: string };

/** Ce que supprimer le compte ferait, sans rien changer (confirmation de la CLI et de admin:ui). */
export async function deletionPreview(db: Pick<Db, 'query'>, accountId: string) {
  const { rows } = await db.query<StateRow>(STATE_SQL, [accountId]);
  const r = rows[0];
  if (!r) return null;
  return { creditCents: Number(r.credit_cents), activeSubscription: r.active, mode: r.purchased ? ('anonymised' as const) : ('erased' as const), deleted: r.deleted };
}

/**
 * Supprime un compte (demande de la personne ou inactivité). Refusé tant
 * qu'un abonnement Stripe est en cours : le résilier d'abord. Le solde
 * restant est perdu (ligne au grand livre si le compte est anonymisé).
 */
export async function deleteAccount(db: Db, accountId: string, now: Date): Promise<DeleteResult> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<StateRow>(STATE_SQL + ' FOR UPDATE', [accountId]);
    const r = rows[0];
    if (!r) return { ok: false, error: 'Compte introuvable.' };
    if (r.deleted) return { ok: false, error: 'Compte déjà supprimé.' };
    if (r.active) return { ok: false, error: 'Abonnement Stripe en cours : le résilier d’abord (tableau de bord Stripe, résiliation immédiate).' };
    const credit = Number(r.credit_cents);
    if (!r.purchased) {
      // Rien d'acheté : aucune pièce comptable à garder, tout part (cascade).
      await tx.query('DELETE FROM accounts WHERE id = $1', [accountId]);
      return { ok: true, mode: 'erased', forfeitedCents: Math.max(0, credit) };
    }
    if (credit !== 0) await addCredits(tx, { accountId, deltaCents: -credit, reason: 'admin', ref: `deletion:${accountId}`, now });
    await purgeDetail(tx, accountId);
    await tx.query(
      `UPDATE accounts SET email = 'supprime+' || id || '@invalid', password_hash = '!', email_verified_at = NULL,
              plan = 'free', gifted = false, monthly_included_cents = 0, included_since = NULL,
              inactivity_warned_at = NULL, deleted_at = $2
        WHERE id = $1`,
      [accountId, now],
    );
    return { ok: true, mode: 'anonymised', forfeitedCents: Math.max(0, credit) };
  });
}

async function purgeDetail(tx: Tx, accountId: string) {
  for (const table of ['sessions', 'email_tokens', 'usage_events', 'usage_monthly'])
    await tx.query(`DELETE FROM ${table} WHERE account_id = $1`, [accountId]);
}

export interface PurgeReport {
  unverified: number;
  warned: number;
  inactive: number;
  sessions: number;
  emailTokens: number;
  usageRolledUp: number;
  ledgerExpired: number;
  errors: string[];
}

export const formatPurge = (r: PurgeReport) =>
  `${r.unverified} compte(s) non confirmé(s), ${r.warned} avertissement(s), ${r.inactive} compte(s) inactif(s), ` +
  `${r.sessions} session(s), ${r.emailTokens} jeton(s) de mail, ${r.usageRolledUp} appel(s) résumé(s), ${r.ledgerExpired} ligne(s) de plus de 10 ans` +
  (r.errors.length ? ` ; ${r.errors.length} erreur(s) : ${r.errors.join(' | ')}` : '');

/**
 * Applique les durées de conservation. Chaque étape est indépendante : une
 * erreur est notée et la suivante tourne quand même. `siteUrl` : lien de
 * connexion du mail d'avertissement.
 */
export async function purge(db: Db, mailer: Mailer, now: Date, siteUrl?: string): Promise<PurgeReport> {
  const report: PurgeReport = { unverified: 0, warned: 0, inactive: 0, sessions: 0, emailTokens: 0, usageRolledUp: 0, ledgerExpired: 0, errors: [] };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      report.errors.push(`${name} : ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const ids = async (sql: string, params: unknown[]) => (await db.query<{ id: string }>(sql, params)).rows.map((r) => r.id);
  const remove = async (list: string[]) => {
    let n = 0;
    for (const id of list) {
      const r = await deleteAccount(db, id, now);
      if (r.ok) n++;
      else report.errors.push(`compte ${id} : ${r.error}`);
    }
    return n;
  };

  await step('comptes non confirmés', async () => {
    report.unverified = await remove(
      await ids(`SELECT id FROM accounts a WHERE deleted_at IS NULL AND email_verified_at IS NULL AND created_at < $1 AND NOT ${PROTECTED}`, [
        minusDays(now, RETENTION.unverifiedDays),
      ]),
    );
  });

  await step('avertissements', async () => {
    const deadline = new Date(now.getTime() + RETENTION.warningDays * DAY);
    const { rows } = await db.query<{ id: string; email: string }>(
      `SELECT id, email FROM accounts a
        WHERE deleted_at IS NULL AND email_verified_at IS NOT NULL AND inactivity_warned_at IS NULL
          AND last_active_at < $1 AND NOT ${PROTECTED}
        ORDER BY last_active_at LIMIT 200`,
      [minusYears(deadline, RETENTION.inactiveYears)],
    );
    const date = deadline.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    const where = siteUrl ? `dans l’application DS-Studio ou sur ${siteUrl}/compte/` : 'dans l’application DS-Studio';
    for (const a of rows) {
      try {
        await mailer.send({
          to: a.email,
          subject: 'DS-Studio : ton compte sera supprimé dans 30 jours',
          text:
            `Bonjour,\n\nTu ne t’es pas connecté à ton compte DS-Studio depuis ${RETENTION.inactiveYears} ans. ` +
            `Sans connexion d’ici le ${date}, il sera supprimé avec son historique d’usage.\n\n` +
            `Pour le garder, connecte-toi simplement ${where}.\n\nTes projets restent sur ton poste : ils ne sont pas concernés.`,
        });
        await db.query('UPDATE accounts SET inactivity_warned_at = $2 WHERE id = $1', [a.id, now]);
        report.warned++;
      } catch (e) {
        report.errors.push(`avertissement ${a.id} : ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });

  await step('comptes inactifs', async () => {
    report.inactive = await remove(
      await ids(
        `SELECT id FROM accounts a
          WHERE deleted_at IS NULL AND inactivity_warned_at <= $1 AND last_active_at < $2 AND NOT ${PROTECTED}`,
        [minusDays(now, RETENTION.warningDays), minusYears(now, RETENTION.inactiveYears)],
      ),
    );
  });

  await step('sessions', async () => {
    report.sessions = (await db.query('DELETE FROM sessions WHERE expires_at <= $1 RETURNING 1', [now])).rows.length;
  });

  await step('jetons de mail', async () => {
    report.emailTokens = (await db.query('DELETE FROM email_tokens WHERE expires_at < $1 RETURNING 1', [minusDays(now, RETENTION.emailTokenDays)])).rows.length;
  });

  await step('usage', async () => {
    const cutoff = minusMonths(now, RETENTION.usageDetailMonths);
    report.usageRolledUp = await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO usage_monthly (account_id, month, origin, calls, cost_cents, charged_cents)
         SELECT account_id, date_trunc('month', created_at AT TIME ZONE 'UTC')::date, origin, count(*), sum(cost_cents), sum(charged_cents)
           FROM usage_events WHERE created_at < $1 GROUP BY 1, 2, 3
         ON CONFLICT (account_id, month, origin) DO UPDATE SET
           calls = usage_monthly.calls + EXCLUDED.calls,
           cost_cents = usage_monthly.cost_cents + EXCLUDED.cost_cents,
           charged_cents = usage_monthly.charged_cents + EXCLUDED.charged_cents`,
        [cutoff],
      );
      return (await tx.query('DELETE FROM usage_events WHERE created_at < $1 RETURNING 1', [cutoff])).rows.length;
    });
  });

  await step('grand livre', async () => {
    report.ledgerExpired = (await db.query('DELETE FROM accounts WHERE deleted_at < $1 RETURNING 1', [minusYears(now, RETENTION.ledgerYears)])).rows.length;
  });

  return report;
}
