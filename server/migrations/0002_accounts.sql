-- Comptes, sessions et jetons de mail (étape 2.2). Le serveur ne garde que
-- cela : ni projet ni conversation (cadrage O2).
CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,                 -- en minuscules, sans espaces
  password_hash text NOT NULL,                -- scrypt, voir server/passwords.ts
  email_verified_at timestamptz,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  gifted boolean NOT NULL DEFAULT false,      -- « offert » : Pro et crédits sans paiement
  daily_cap_cents integer NOT NULL DEFAULT 200, -- plafond de coût LLM par jour
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Une session = un jeton aléatoire remis au client ; seul son empreinte SHA-256 est gardée.
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client text NOT NULL DEFAULT 'app' CHECK (client IN ('app', 'site')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_account_idx ON sessions (account_id);

-- Jetons envoyés par mail (vérification de l'adresse, mot de passe oublié), usage unique.
CREATE TABLE email_tokens (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify', 'reset')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX email_tokens_account_idx ON email_tokens (account_id);

INSERT INTO app_meta (key, value) VALUES ('schema', '2')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
