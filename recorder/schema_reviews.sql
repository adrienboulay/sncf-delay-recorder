-- ============ AVIS DES VOYAGEURS (page publique avis.html) ============
-- Le navigateur peut seulement DEPOSER un avis (avec consentement). Un avis n'est publie qu'apres validation
-- a la main dans Supabase (colonne approved = true). La page ne lit que les avis valides, sans aucune autre donnee.
CREATE TABLE IF NOT EXISTS reviews (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 40),      -- prenom ou pseudo
  trip TEXT CHECK (length(trip) <= 60),                                 -- ex. « Lyon → Grenoble » (facultatif)
  body TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 10 AND 400),
  lang TEXT NOT NULL DEFAULT 'fr' CHECK (lang IN ('fr', 'en')),
  consent BOOLEAN NOT NULL CHECK (consent),                             -- accord pour publier prenom + avis
  approved BOOLEAN NOT NULL DEFAULT FALSE,                              -- moderation : a passer a true a la main
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON reviews FROM anon, authenticated;
GRANT INSERT (name, trip, body, lang, consent) ON reviews TO anon;
DROP POLICY IF EXISTS reviews_insert ON reviews;
CREATE POLICY reviews_insert ON reviews FOR INSERT TO anon WITH CHECK (consent AND NOT approved);

-- Avis valides, les plus recents d'abord (prenom, trajet, texte, date) : rien d'autre ne sort.
CREATE OR REPLACE FUNCTION public.public_reviews() RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(json_agg(x ORDER BY x.at DESC), '[]'::json) FROM (
    SELECT name, trip, body, lang, EXTRACT(EPOCH FROM created_at)::bigint AS at
    FROM reviews WHERE approved ORDER BY created_at DESC LIMIT 30) x $$;
REVOKE ALL ON FUNCTION public.public_reviews() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_reviews() TO anon;
