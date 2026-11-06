-- Durées de conservation (lot 7.4, validées par Romain le 2026-11-06), appliquées
-- par `purge` de server/retention.ts chaque jour :
--   compte jamais confirmé : supprimé 30 jours après sa création ;
--   compte inactif 3 ans : mail d'avertissement, supprimé 30 jours après
--     (jamais avec un solde positif ou un abonnement en cours) ;
--   sessions expirées : supprimées ; jetons de mail : 30 jours après expiration ;
--   usage détaillé : 12 mois, puis un total mensuel par compte et par origine ;
--   compte supprimé : ligne anonymisée (plus d'adresse ni de mot de passe),
--     grand livre des crédits et identifiants Stripe gardés 10 ans (obligation
--     comptable), puis ligne effacée.
-- Non destructif : colonnes et table ajoutées, aucune donnée retirée ici.
ALTER TABLE accounts
  ADD COLUMN last_active_at timestamptz,            -- connexion ou requête authentifiée (au plus une mise à jour par heure)
  ADD COLUMN inactivity_warned_at timestamptz,      -- mail « suppression dans 30 jours » parti ; remis à zéro à la reconnexion
  ADD COLUMN deleted_at timestamptz;                -- compte supprimé (anonymisé) ; NULL : compte vivant

-- Dernière activité connue avant cette colonne : création, sessions, usage.
UPDATE accounts a SET last_active_at = GREATEST(
  a.created_at,
  (SELECT max(s.last_seen_at) FROM sessions s WHERE s.account_id = a.id),
  (SELECT max(u.created_at) FROM usage_events u WHERE u.account_id = a.id)
);
ALTER TABLE accounts ALTER COLUMN last_active_at SET NOT NULL, ALTER COLUMN last_active_at SET DEFAULT now();
CREATE INDEX accounts_last_active_idx ON accounts (last_active_at) WHERE deleted_at IS NULL;

-- Usage de plus de 12 mois, résumé par mois (UTC) : plus de modèle, de jetons ni d'heure.
CREATE TABLE usage_monthly (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  month date NOT NULL,                              -- premier jour du mois
  origin text NOT NULL,
  calls integer NOT NULL,
  cost_cents numeric(14, 6) NOT NULL,               -- coût LLM, centimes de dollar
  charged_cents integer NOT NULL,                   -- centimes d'euro débités
  PRIMARY KEY (account_id, month, origin)
);

INSERT INTO app_meta (key, value) VALUES ('schema', '5')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
