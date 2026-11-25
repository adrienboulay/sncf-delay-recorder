-- ============ ASSISTANT (copilote) : recherche de gare par nom + compteur anti-abus ============

-- Gares SNCF et arrets Ile-de-France dont le nom contient tous les mots de la recherche (accents et tirets ignores).
-- Identifiants = ceux de public_station() / public_trip(). Au plus 8 resultats, les noms exacts puis les debuts de nom d'abord.
CREATE OR REPLACE FUNCTION public.lp_norm(t TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
SELECT trim(regexp_replace(lower(translate(COALESCE(t, ''),
  'ÀÂÄÉÈÊËÎÏÔÖÙÛÜÇàâäéèêëîïôöùûüç''-',
  'aaaeeeeiioouuucaaaeeeeiioouuuc  ')), '\s+', ' ', 'g')) $$;

CREATE OR REPLACE FUNCTION public.public_find_stop(p_q TEXT) RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH q AS (SELECT lp_norm(left(p_q, 80)) AS q),
w AS (SELECT DISTINCT x AS w FROM q, regexp_split_to_table(q.q, ' ') x WHERE length(x) >= 2),
c AS (
  SELECT DISTINCT ON (uic) 'sncf' AS net, uic AS id, name, lat, lon FROM ref_stops
   WHERE location_type = 1 AND uic IS NOT NULL ORDER BY uic, stop_id),
i AS (
  SELECT 'idf' AS net, COALESCE(parent_ref, stop_ref) AS id, MIN(name) AS name, AVG(lat) AS lat, AVG(lon) AS lon
    FROM idfm_ref_stops GROUP BY COALESCE(parent_ref, stop_ref)),
a AS (SELECT * FROM c UNION ALL SELECT * FROM i),
m AS (
  SELECT a.*, lp_norm(a.name) AS nn FROM a
   WHERE EXISTS (SELECT 1 FROM w)
     AND NOT EXISTS (SELECT 1 FROM w WHERE position(w.w IN lp_norm(a.name)) = 0))
SELECT COALESCE(json_agg(json_build_object('net', net, 'id', id, 'name', name,
         'lat', round(lat::numeric, 5), 'lon', round(lon::numeric, 5))), '[]'::json)
FROM (SELECT m.* FROM m, q
      ORDER BY (m.nn = q.q) DESC, (m.nn LIKE q.q || '%') DESC, length(m.nn), m.net DESC LIMIT 8) x $$;
REVOKE ALL ON FUNCTION public.public_find_stop(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_find_stop(TEXT) TO anon;

-- Compteur de messages par jour : par visiteur (empreinte anonyme, jamais l'adresse IP en clair) et au total.
-- Protege l'offre gratuite du fournisseur d'IA. Appele uniquement par la fonction serveur (cle de service).
CREATE TABLE IF NOT EXISTS assistant_usage (
  day TEXT NOT NULL,
  who TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, who));
ALTER TABLE assistant_usage ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.assistant_hit(p_who TEXT, p_limit INTEGER, p_global INTEGER) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d TEXT := to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD'); mine INTEGER; total INTEGER;
BEGIN
  DELETE FROM assistant_usage WHERE day < to_char((now() - interval '7 days') AT TIME ZONE 'Europe/Paris', 'YYYYMMDD');
  SELECT COALESCE(SUM(n), 0) INTO total FROM assistant_usage WHERE day = d;
  IF total >= p_global THEN RETURN FALSE; END IF;
  INSERT INTO assistant_usage AS u (day, who, n) VALUES (d, left(p_who, 64), 1)
  ON CONFLICT (day, who) DO UPDATE SET n = u.n + 1 RETURNING n INTO mine;
  RETURN mine <= p_limit;
END $$;
REVOKE ALL ON FUNCTION public.assistant_hit(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
