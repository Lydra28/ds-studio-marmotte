-- Droit de rétractation (lot 7.4, option A validée par Romain le 2026-11-06) :
-- 14 jours après chaque achat, rétractation en ligne depuis le compte du site
-- (server/withdrawal.ts), remboursement de ce qui n'a pas servi. Registre des
-- achats rempli par le webhook `checkout.session.completed` (recharges et
-- premier paiement de Pro ; les renouvellements ne sont pas de nouveaux
-- contrats). Pièce comptable : gardée avec le compte anonymisé (retention.ts).
-- Non destructif : table ajoutée, motif du grand livre élargi.
CREATE TABLE purchases (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('credits', 'pro')),
  ref text NOT NULL UNIQUE,                         -- checkout:<cs_…>, comme credit_events.ref
  amount_cents integer NOT NULL,                    -- payé, centimes d'euro
  purchased_at timestamptz NOT NULL,
  withdrawn_at timestamptz,                         -- déclaration de rétractation reçue
  withdrawal_name text,                             -- nom donné dans la déclaration ; effacé à la suppression du compte
  refund_cents integer,                             -- à rembourser, calculé à la déclaration
  refunded_at timestamptz                           -- remboursement fait dans Stripe (marqué dans admin:ui)
);
CREATE INDEX purchases_account_idx ON purchases (account_id, purchased_at);

ALTER TABLE credit_events DROP CONSTRAINT credit_events_reason_check;
ALTER TABLE credit_events ADD CONSTRAINT credit_events_reason_check CHECK (reason IN ('welcome', 'topup', 'admin', 'withdrawal'));

INSERT INTO app_meta (key, value) VALUES ('schema', '6')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
