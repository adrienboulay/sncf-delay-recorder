-- ============ PREINSCRIPTION (page publique LateProof) ============
-- Le navigateur n'a QUE le droit d'inserer une inscription (avec consentement) et de lire deux compteurs.
-- Il ne peut lire aucun email ni aucune donnee de la base.
CREATE TABLE IF NOT EXISTS waitlist (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT NOT NULL CHECK (length(email) <= 254 AND email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  lang TEXT NOT NULL DEFAULT 'fr' CHECK (lang IN ('fr', 'en')),
  profile TEXT CHECK (profile IN ('quotidien', 'grandes_lignes', 'les_deux', 'entreprise')),
  line TEXT CHECK (length(line) <= 80),          -- ex. « Lyon - Grenoble » (facultatif)
  consent BOOLEAN NOT NULL CHECK (consent),      -- case cochee obligatoire
  source TEXT CHECK (length(source) <= 40),      -- d'ou vient l'inscrit (lien partage, QR...)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at TIMESTAMPTZ);                      -- date d'envoi du mail de lancement
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_email_unique ON waitlist (lower(email));
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON waitlist FROM anon, authenticated;
GRANT INSERT (email, lang, profile, line, consent, source) ON waitlist TO anon;
DROP POLICY IF EXISTS waitlist_insert ON waitlist;
CREATE POLICY waitlist_insert ON waitlist FOR INSERT TO anon WITH CHECK (consent);

-- Compteur d'inscrits (un nombre, rien d'autre).
CREATE OR REPLACE FUNCTION public.waitlist_count() RETURNS BIGINT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT COUNT(*) FROM waitlist $$;

-- Chiffres du jour pour la page (agregats uniquement) : trains vus, en retard de 15 min ou plus, supprimes.
CREATE OR REPLACE FUNCTION public.public_today_stats() RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH d AS (SELECT to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD') AS today),
  s AS (SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE COALESCE(arrival_delay_s, 0) >= 900) AS late,
               COUNT(*) FILTER (WHERE status = 'CANCELED') AS canc FROM trains, d WHERE service_date = d.today),
  i AS (SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE COALESCE(arrival_delay_s, 0) >= 900) AS late,
               COUNT(*) FILTER (WHERE status = 'CANCELED') AS canc FROM idfm_trains, d WHERE service_date = d.today)
  SELECT json_build_object('trains', s.n + i.n, 'late15', s.late + i.late, 'cancelled', s.canc + i.canc,
                           'updated_at', (SELECT MAX(polled_at) FROM polls))
  FROM s, i $$;

REVOKE ALL ON FUNCTION public.waitlist_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_today_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.waitlist_count() TO anon;
GRANT EXECUTE ON FUNCTION public.public_today_stats() TO anon;
