-- Socle : une table de métadonnées lue par /v1/health (preuve que la base
-- répond) et par les scripts d'administration. Les tables métier arrivent
-- avec leur étape (0002 comptes, 0003 usage…).
CREATE TABLE IF NOT EXISTS app_meta (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_meta (key, value) VALUES ('schema', '1')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
