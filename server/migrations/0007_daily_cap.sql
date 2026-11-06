-- Plafond journalier par défaut (lot 7.4, décision de Romain le 2026-11-06) :
-- 50 c$ de coût réel par jour au lieu de 200 (76 générations du Mur ou
-- environ 440 questions). Il borne le dépassement d'un compte payant (dernier
-- appel débité sous zéro, appels en parallèle) et l'usage d'une session volée.
-- Comptes existants : seuls ceux restés à l'ancien défaut passent à 50 ; un
-- plafond posé à la main (`cap`) ou un compte offert ne bouge pas.
ALTER TABLE accounts ALTER COLUMN daily_cap_cents SET DEFAULT 50;

UPDATE accounts SET daily_cap_cents = 50 WHERE daily_cap_cents = 200 AND NOT gifted;

INSERT INTO app_meta (key, value) VALUES ('schema', '7')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
