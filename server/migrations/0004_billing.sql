-- Lot 4 : prix de vente par-dessus le coût (cadrage O4). Les soldes passent en
-- centimes d'euro de valeur vendue : chaque appel débite ceil(coût × RATE),
-- au moins 1 centime (server/credits.ts) ; le coût LLM reste en centimes de
-- dollar dans usage_events.cost_cents. Grand livre des crédits (jamais
-- crédité deux fois), événements Stripe vus (idempotence des webhooks),
-- client et abonnement Stripe sur le compte.
ALTER TABLE usage_events
  ADD COLUMN charged_cents integer NOT NULL DEFAULT 0; -- centimes d'euro débités (crédits) ou consommés (inclus Pro) ; 0 : offert

ALTER TABLE accounts
  ALTER COLUMN credit_cents TYPE integer USING round(credit_cents)::integer, -- désormais centimes d'euro
  ADD COLUMN stripe_customer_id text UNIQUE,
  ADD COLUMN stripe_subscription_id text UNIQUE,
  ADD COLUMN subscription_status text,              -- statut Stripe : active, trialing, past_due, canceled…
  ADD COLUMN current_period_end timestamptz,
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN included_since timestamptz,            -- début de la période des crédits inclus Pro (chaque facture payée)
  ADD COLUMN welcome_credited_at timestamptz;       -- crédit de bienvenue posé à la confirmation du mail

CREATE TABLE credit_events (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  delta_cents integer NOT NULL,
  reason text NOT NULL CHECK (reason IN ('welcome', 'topup', 'admin')),
  ref text UNIQUE,                                  -- welcome:<compte>, session Checkout… : jamais appliqué deux fois
  created_at timestamptz NOT NULL
);
CREATE INDEX credit_events_account_time_idx ON credit_events (account_id, created_at);

CREATE TABLE stripe_events (
  id text PRIMARY KEY,                              -- evt_…
  type text NOT NULL,
  received_at timestamptz NOT NULL
);

INSERT INTO app_meta (key, value) VALUES ('schema', '4')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
