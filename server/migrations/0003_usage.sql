-- Usage LLM et soldes (étape 2.4). Un seul compteur (cadrage O4) : chaque
-- appel relayé vers OpenRouter laisse un événement ; les soldes du jour et du
-- mois se lisent en sommant. Unité : centimes de dollar (1 crédit OpenRouter
-- = 1 $) ; le lot 4 pose les prix de vente en euros par-dessus.
CREATE TABLE usage_events (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  origin text NOT NULL CHECK (origin IN ('assistant', 'wall', 'other')), -- en-tête X-DS-Origin
  model text NOT NULL,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  cost_cents numeric(14, 6) NOT NULL,          -- coût LLM réel, centimes
  cost_source text NOT NULL CHECK (cost_source IN ('openrouter', 'estimate', 'unknown')),
  charged_to text NOT NULL CHECK (charged_to IN ('gift', 'pro', 'credits')),
  generation_id text,                           -- id OpenRouter, pour recouper avec leur relevé
  created_at timestamptz NOT NULL               -- horloge du serveur, pas de la base
);
CREATE INDEX usage_events_account_time_idx ON usage_events (account_id, created_at);

ALTER TABLE accounts
  ADD COLUMN credit_cents numeric(14, 6) NOT NULL DEFAULT 0,    -- crédits prépayés, débités à l'usage (le lot 4 les remplit)
  ADD COLUMN monthly_included_cents integer NOT NULL DEFAULT 0; -- usage inclus Pro par mois (le lot 4 le fixe)

INSERT INTO app_meta (key, value) VALUES ('schema', '3')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
