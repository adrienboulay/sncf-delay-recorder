-- ============ SITE : mesure d'audience sans cookie, journal d'erreurs, limites anti-abus ============

-- Mesure d'audience : un compteur par jour et par page. Ni cookie, ni adresse IP, ni identifiant.
CREATE TABLE IF NOT EXISTS page_views (day TEXT NOT NULL, path TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, path));
ALTER TABLE page_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON page_views FROM anon, authenticated;
CREATE OR REPLACE FUNCTION public.public_hit(p_path TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p TEXT := lower(COALESCE(p_path, ''));
BEGIN
  IF p = '' THEN p := 'index.html'; END IF;
  IF p !~ '^[a-z0-9-]{1,30}\.html$' THEN RETURN; END IF;          -- seulement nos pages
  INSERT INTO page_views AS v (day, path, n) VALUES (to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD'), p, 1)
  ON CONFLICT (day, path) DO UPDATE SET n = v.n + 1 WHERE v.n < 1000000;
END $$;

-- Journal des erreurs du navigateur (page + message tronqués, aucune donnée personnelle), gardé 30 jours
CREATE TABLE IF NOT EXISTS client_errors (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), page TEXT, msg TEXT);
CREATE INDEX IF NOT EXISTS client_errors_at ON client_errors (at);
ALTER TABLE client_errors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON client_errors FROM anon, authenticated;
CREATE OR REPLACE FUNCTION public.public_log_error(p_page TEXT, p_msg TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (SELECT COUNT(*) FROM client_errors WHERE at > now() - interval '1 minute') >= 30 THEN RETURN; END IF;   -- anti-déluge
  INSERT INTO client_errors (page, msg) VALUES (left(COALESCE(p_page, ''), 40), left(COALESCE(p_msg, ''), 300));
  DELETE FROM client_errors WHERE at < now() - interval '30 days';
END $$;

-- Limites anti-abus sur les formulaires publics (en plus des contraintes de taille et du piège à robots)
CREATE INDEX IF NOT EXISTS waitlist_created ON waitlist (created_at);
CREATE INDEX IF NOT EXISTS reviews_created ON reviews (created_at);
CREATE OR REPLACE FUNCTION public.lp_rate_limit() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INTEGER; lim INTEGER := CASE TG_TABLE_NAME WHEN 'waitlist' THEN 20 ELSE 10 END;
BEGIN
  EXECUTE format('SELECT COUNT(*) FROM %I WHERE created_at > now() - interval ''1 minute''', TG_TABLE_NAME) INTO n;
  IF n >= lim THEN RAISE EXCEPTION 'Trop de demandes, réessaie dans une minute' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS waitlist_rate ON waitlist;
CREATE TRIGGER waitlist_rate BEFORE INSERT ON waitlist FOR EACH ROW EXECUTE FUNCTION public.lp_rate_limit();
DROP TRIGGER IF EXISTS reviews_rate ON reviews;
CREATE TRIGGER reviews_rate BEFORE INSERT ON reviews FOR EACH ROW EXECUTE FUNCTION public.lp_rate_limit();

-- Statistiques du site pour le tableau de bord (clé de service uniquement)
CREATE OR REPLACE FUNCTION public.admin_site() RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT json_build_object(
    'views_by_day', (SELECT COALESCE(json_agg(x ORDER BY x.day), '[]'::json) FROM (SELECT day, SUM(n) AS n FROM page_views GROUP BY day ORDER BY day DESC LIMIT 14) x),
    'top_pages', (SELECT COALESCE(json_agg(x ORDER BY x.n DESC), '[]'::json) FROM (
        SELECT path, SUM(n) AS n FROM page_views WHERE day >= to_char((now() - interval '7 days') AT TIME ZONE 'Europe/Paris', 'YYYYMMDD') GROUP BY path ORDER BY 2 DESC LIMIT 10) x),
    'errors_24h', (SELECT COUNT(*) FROM client_errors WHERE at > now() - interval '24 hours'),
    'errors', (SELECT COALESCE(json_agg(x ORDER BY x.at DESC), '[]'::json) FROM (
        SELECT page, msg, EXTRACT(EPOCH FROM at)::bigint AS at FROM client_errors ORDER BY at DESC LIMIT 15) x)) $$;

REVOKE ALL ON FUNCTION public.public_hit(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_log_error(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_hit(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.public_log_error(TEXT, TEXT) TO anon;
REVOKE ALL ON FUNCTION public.admin_site() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_site() TO service_role;
REVOKE ALL ON FUNCTION public.lp_rate_limit() FROM PUBLIC, anon, authenticated;
