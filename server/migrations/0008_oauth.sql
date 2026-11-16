-- Connexion avec Google et GitHub (cadrage du 2026-11-16). Un compte peut
-- n'avoir aucun mot de passe : il se connecte par un fournisseur, ou en crée
-- un par « mot de passe oublié ».
ALTER TABLE accounts ALTER COLUMN password_hash DROP NOT NULL;

-- Identité chez un fournisseur (identifiant stable `sub` Google, `id` GitHub),
-- rattachée à un compte. L'adresse est celle vue à la dernière connexion.
CREATE TABLE account_identities (
  provider text NOT NULL CHECK (provider IN ('google', 'github')),
  subject text NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX account_identities_account_idx ON account_identities (account_id);

-- Connexion de l'app par le site : l'app demande un lien (code secret gardé
-- par elle, code court montré à l'écran), le site connecté l'approuve, l'app
-- récupère alors sa session. Seule l'empreinte du code secret est gardée.
-- Empreinte de l'IP et pays de la demande : un navigateur sur un autre réseau
-- doit saisir le code (lien envoyé par un tiers), et le mail d'alerte cite le pays.
CREATE TABLE app_links (
  device_hash text PRIMARY KEY,
  user_code text NOT NULL UNIQUE,
  ip_hash text,
  country text,
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  approved_at timestamptz
);
CREATE INDEX app_links_account_idx ON app_links (account_id);

INSERT INTO app_meta (key, value) VALUES ('schema', '8')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
