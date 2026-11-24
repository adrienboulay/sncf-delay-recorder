-- ============ RECHERCHE SUR LA CARTE : LIGNES, DETAIL D'UNE LIGNE, TRAJET A -> B ============
-- Agregats de la journee en cours uniquement, aucune donnee personnelle. Lisibles par la page publique (anon).
CREATE INDEX IF NOT EXISTS idfm_stop_updates_stop ON idfm_stop_updates(stop_ref);

-- ============ CARTE PRE-CALCULEE ============
-- Le calcul des gares prend 1 a 4 s, trop pres du delai de 3 s impose aux requetes publiques. L'enregistreur le refait
-- toutes les 10 min (refresh_public_cache) et la page lit le resultat stocke, instantanement.
CREATE TABLE IF NOT EXISTS public_cache (k TEXT PRIMARY KEY, v JSON, updated_at BIGINT);
ALTER TABLE public_cache ENABLE ROW LEVEL SECURITY;
-- Troncons du reseau (gare -> gare suivante) circules aujourd'hui, avec le retard moyen a l'arrivee du troncon :
-- permet de dessiner les LIGNES colorees quand on dezoome (plus lisible que des milliers de points).
-- Format compact : [lat1, lon1, lat2, lon2, nb de passages, retard moyen (min), nb d'arrets supprimes]. Serveur seulement.
CREATE OR REPLACE FUNCTION public.public_segments_live() RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH d AS (SELECT to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD') AS today),
g AS (SELECT DISTINCT ON (uic) uic, lat, lon FROM ref_stops WHERE location_type = 1 AND uic IS NOT NULL AND lat IS NOT NULL ORDER BY uic, stop_id),
su AS (SELECT u.uic AS a, LEAD(u.uic) OVER w AS b,
              LEAD(GREATEST(COALESCE(u.arrival_delay_s, u.departure_delay_s, 0), 0)) OVER w AS dl, LEAD(u.skipped) OVER w AS sk
       FROM stop_updates u, d WHERE u.service_date = d.today WINDOW w AS (PARTITION BY u.train_num ORDER BY u.stop_index)),
s1 AS (SELECT LEAST(a, b) AS a, GREATEST(a, b) AS b, COUNT(*) AS n, AVG(dl) / 60.0 AS m, COUNT(*) FILTER (WHERE sk) AS c
       FROM su WHERE b IS NOT NULL AND a <> b GROUP BY 1, 2),
ist AS (SELECT stop_ref, COALESCE(parent_ref, stop_ref) AS id FROM idfm_ref_stops WHERE lat IS NOT NULL),
ipos AS (SELECT COALESCE(parent_ref, stop_ref) AS id, AVG(lat) AS lat, AVG(lon) AS lon FROM idfm_ref_stops WHERE lat IS NOT NULL GROUP BY 1),
iu AS (SELECT ist.id AS a, LEAD(ist.id) OVER w AS b,
              LEAD(GREATEST(COALESCE(u.arrival_delay_s, u.departure_delay_s, 0), 0)) OVER w AS dl, LEAD(u.status = 'CANCELLED') OVER w AS sk
       FROM idfm_stop_updates u JOIN idfm_trains t USING (journey_key) JOIN ist ON ist.stop_ref = u.stop_ref, d
       WHERE t.service_date = d.today WINDOW w AS (PARTITION BY u.journey_key ORDER BY COALESCE(u.aimed_departure_ts, u.aimed_arrival_ts))),
s2 AS (SELECT LEAST(a, b) AS a, GREATEST(a, b) AS b, COUNT(*) AS n, AVG(dl) / 60.0 AS m, COUNT(*) FILTER (WHERE sk) AS c
       FROM iu WHERE b IS NOT NULL AND a <> b GROUP BY 1, 2)
SELECT COALESCE(json_agg(json_build_array(x.lat1, x.lon1, x.lat2, x.lon2, x.n, x.m, x.c)), '[]'::json) FROM (
  SELECT round(ga.lat::numeric, 4) AS lat1, round(ga.lon::numeric, 4) AS lon1, round(gb.lat::numeric, 4) AS lat2, round(gb.lon::numeric, 4) AS lon2,
         s1.n, round(s1.m, 1) AS m, s1.c FROM s1 JOIN g ga ON ga.uic = s1.a JOIN g gb ON gb.uic = s1.b
  UNION ALL
  SELECT round(pa.lat::numeric, 4), round(pa.lon::numeric, 4), round(pb.lat::numeric, 4), round(pb.lon::numeric, 4),
         s2.n, round(s2.m, 1), s2.c FROM s2 JOIN ipos pa ON pa.id = s2.a JOIN ipos pb ON pb.id = s2.b) x $$;
REVOKE ALL ON FUNCTION public.public_segments_live() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.refresh_public_cache() RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
INSERT INTO public_cache VALUES ('station_map', public_station_map_live(), EXTRACT(EPOCH FROM now())::bigint)
ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = EXCLUDED.updated_at;
INSERT INTO public_cache VALUES ('segments', public_segments_live(), EXTRACT(EPOCH FROM now())::bigint)
ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = EXCLUDED.updated_at $$;
CREATE OR REPLACE FUNCTION public.public_segments() RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT COALESCE((SELECT v FROM public_cache WHERE k = 'segments' AND updated_at > EXTRACT(EPOCH FROM now())::bigint - 3600), '[]'::json) $$;
REVOKE ALL ON FUNCTION public.public_segments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_segments() TO anon;
CREATE OR REPLACE FUNCTION public.public_station_map() RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT COALESCE((SELECT v FROM public_cache WHERE k = 'station_map' AND updated_at > EXTRACT(EPOCH FROM now())::bigint - 1800),
                public_station_map_live()) $$;
REVOKE ALL ON FUNCTION public.refresh_public_cache() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.public_station_map() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_station_map() TO anon;

-- Lignes ayant circule aujourd'hui (SNCF, hors cars) + toutes les lignes suivies en Ile-de-France (metro et tram compris).
CREATE OR REPLACE FUNCTION public.public_lines() RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH d AS (SELECT to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD') AS today),
s AS (SELECT t.route_id AS id, MAX(t.mode) AS mode, COUNT(*) AS n,
             COUNT(*) FILTER (WHERE COALESCE(t.arrival_delay_s, 0) >= 900) AS late15, COUNT(*) FILTER (WHERE t.status = 'CANCELED') AS cancelled
      FROM trains t, d WHERE t.service_date = d.today AND t.route_id IS NOT NULL GROUP BY t.route_id),
i AS (SELECT t.line_id AS id, COUNT(*) AS n, COUNT(*) FILTER (WHERE COALESCE(t.arrival_delay_s, 0) >= 900) AS late15,
             COUNT(*) FILTER (WHERE t.status = 'CANCELLED') AS cancelled
      FROM idfm_trains t, d WHERE t.service_date = d.today GROUP BY t.line_id)
SELECT COALESCE(json_agg(x), '[]'::json) FROM (
  SELECT 'sncf' AS net, s.id, r.short_name AS name, r.long_name AS long, s.mode, s.n, s.late15, s.cancelled
    FROM s JOIN ref_routes r ON r.route_id = s.id WHERE COALESCE(r.route_type, 2) <> 3
  UNION ALL
  SELECT 'idf', l.line_id, l.short_name, l.long_name, l.mode, COALESCE(i.n, 0), COALESCE(i.late15, 0), COALESCE(i.cancelled, 0)
    FROM idfm_ref_lines l LEFT JOIN i ON i.id = l.line_id) x $$;

-- Detail d'une ligne aujourd'hui : gares desservies (avec leurs chiffres) et jusqu'a 4 traces (une par origine/destination).
-- Metro et tram (pas d'horaire publie) : arrets, nombre de passages et intervalle moyen entre deux rames (gap, min).
CREATE OR REPLACE FUNCTION public.public_line(p_net TEXT, p_id TEXT) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE today TEXT := to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD'); day0 BIGINT; r JSON;
BEGIN
  day0 := EXTRACT(EPOCH FROM (to_date(today, 'YYYYMMDD')::timestamp AT TIME ZONE 'Europe/Paris'))::bigint;
  IF p_net = 'sncf' THEN
    WITH g AS (SELECT DISTINCT ON (uic) uic, name, lat, lon FROM ref_stops WHERE location_type = 1 AND uic IS NOT NULL AND lat IS NOT NULL ORDER BY uic, stop_id),
    tr AS (SELECT * FROM trains WHERE service_date = today AND route_id = p_id),
    st AS (SELECT g.name, round(g.lat::numeric, 5) AS lat, round(g.lon::numeric, 5) AS lon, COUNT(*) AS n,
                  COUNT(*) FILTER (WHERE COALESCE(u.arrival_delay_s, u.departure_delay_s, 0) >= 900) AS late15,
                  COUNT(*) FILTER (WHERE u.skipped) AS cancelled,
                  ROUND(AVG(GREATEST(COALESCE(u.arrival_delay_s, u.departure_delay_s, 0), 0)) / 60.0, 1) AS avg, NULL::numeric AS gap
           FROM tr JOIN stop_updates u ON u.train_num = tr.train_num AND u.service_date = tr.service_date JOIN g ON g.uic = u.uic
           GROUP BY g.uic, g.name, g.lat, g.lon),
    rep AS (SELECT DISTINCT ON (origin_uic, dest_uic) train_num, n_stops FROM tr ORDER BY origin_uic, dest_uic, n_stops DESC NULLS LAST),
    pth AS (SELECT (SELECT json_agg(json_build_array(round(g.lat::numeric, 5), round(g.lon::numeric, 5)) ORDER BY u.stop_index)
                    FROM stop_updates u JOIN g ON g.uic = u.uic WHERE u.train_num = rep.train_num AND u.service_date = today) AS p
            FROM (SELECT * FROM rep ORDER BY n_stops DESC NULLS LAST LIMIT 4) rep)
    SELECT json_build_object('net', 'sncf', 'id', p_id, 'name', ro.short_name, 'long', ro.long_name,
      'mode', (SELECT MAX(mode) FROM tr), 'n', (SELECT COUNT(*) FROM tr),
      'late15', (SELECT COUNT(*) FROM tr WHERE COALESCE(arrival_delay_s, 0) >= 900),
      'cancelled', (SELECT COUNT(*) FROM tr WHERE status = 'CANCELED'),
      'stops', COALESCE((SELECT json_agg(st) FROM st), '[]'::json),
      'paths', COALESCE((SELECT json_agg(p) FROM pth WHERE p IS NOT NULL), '[]'::json))
    INTO r FROM (SELECT p_id AS route_id) k LEFT JOIN ref_routes ro ON ro.route_id = k.route_id;
  ELSIF p_net = 'idf' THEN
    WITH tr AS (SELECT * FROM idfm_trains WHERE service_date = today AND line_id = p_id),
    st AS (SELECT MIN(s.name) AS name, round(AVG(s.lat)::numeric, 5) AS lat, round(AVG(s.lon)::numeric, 5) AS lon, COUNT(*) AS n,
                  COUNT(*) FILTER (WHERE COALESCE(u.arrival_delay_s, u.departure_delay_s, 0) >= 900) AS late15,
                  COUNT(*) FILTER (WHERE u.status = 'CANCELLED') AS cancelled,
                  ROUND(AVG(GREATEST(COALESCE(u.arrival_delay_s, u.departure_delay_s, 0), 0)) / 60.0, 1) AS avg, NULL::numeric AS gap
           FROM tr JOIN idfm_stop_updates u USING (journey_key) JOIN idfm_ref_stops s ON s.stop_ref = u.stop_ref
           WHERE s.lat IS NOT NULL GROUP BY COALESCE(s.parent_ref, s.stop_ref)),
    mt AS (SELECT MIN(s.name) AS name, round(AVG(s.lat)::numeric, 5) AS lat, round(AVG(s.lon)::numeric, 5) AS lon,
                  SUM(h.n_passages)::bigint AS n, 0::bigint AS late15, 0::bigint AS cancelled, NULL::numeric AS avg,
                  ROUND(SUM(h.sum_gap_s)::numeric / NULLIF(SUM(h.n_gaps), 0) / 60.0, 1) AS gap
           FROM idfm_metro_hourly h JOIN idfm_ref_stops s ON s.stop_ref = h.stop_ref
           WHERE h.line_id = p_id AND h.hour_ts >= day0 AND s.lat IS NOT NULL GROUP BY COALESCE(s.parent_ref, s.stop_ref)),
    rep AS (SELECT DISTINCT ON (dest_name) journey_key, n_calls FROM tr ORDER BY dest_name, n_calls DESC NULLS LAST),
    pth AS (SELECT (SELECT json_agg(json_build_array(round(s.lat::numeric, 5), round(s.lon::numeric, 5))
                           ORDER BY COALESCE(u.aimed_departure_ts, u.aimed_arrival_ts))
                    FROM idfm_stop_updates u JOIN idfm_ref_stops s ON s.stop_ref = u.stop_ref
                    WHERE u.journey_key = rep.journey_key AND s.lat IS NOT NULL) AS p
            FROM (SELECT * FROM rep ORDER BY n_calls DESC NULLS LAST LIMIT 4) rep)
    SELECT json_build_object('net', 'idf', 'id', p_id, 'name', l.short_name, 'long', l.long_name, 'mode', l.mode,
      'n', (SELECT COUNT(*) FROM tr), 'late15', (SELECT COUNT(*) FROM tr WHERE COALESCE(arrival_delay_s, 0) >= 900),
      'cancelled', (SELECT COUNT(*) FROM tr WHERE status = 'CANCELLED'),
      'stops', COALESCE((SELECT json_agg(x) FROM (SELECT * FROM st UNION ALL SELECT * FROM mt WHERE NOT EXISTS (SELECT 1 FROM st)) x), '[]'::json),
      'paths', COALESCE((SELECT json_agg(p) FROM pth WHERE p IS NOT NULL), '[]'::json))
    INTO r FROM idfm_ref_lines l WHERE l.line_id = p_id;
  END IF;
  RETURN r;
END $$;

-- Trajet direct A -> B aujourd'hui (meme reseau) : trains qui desservent A puis B, retards au depart de A et a l'arrivee a B,
-- bilan de la journee (n, late15, cancelled), les trains a partir d'il y a 1 h 30, et le trace du prochain train (sinon du dernier parti). Identifiants = ceux de public_station_map().
CREATE OR REPLACE FUNCTION public.public_trip(p_net TEXT, p_from TEXT, p_to TEXT) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE today TEXT := to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD'); r JSON;
BEGIN
  IF p_net = 'sncf' THEN
    WITH g AS (SELECT DISTINCT ON (uic) uic, name, lat, lon FROM ref_stops WHERE location_type = 1 AND uic IS NOT NULL AND lat IS NOT NULL ORDER BY uic, stop_id),
    m AS (SELECT t.train_num AS num, t.mode, t.route_id AS line_id, ro.short_name AS line,
                 ua.stop_index AS ia, ub.stop_index AS ib,
                 COALESCE(ua.sched_departure_ts, ua.sched_arrival_ts) AS dep, ua.departure_delay_s AS dep_delay,
                 COALESCE(ub.sched_arrival_ts, ub.sched_departure_ts) AS arr, ub.arrival_delay_s AS arr_delay,
                 (COALESCE(ua.skipped, FALSE) OR COALESCE(ub.skipped, FALSE) OR t.status = 'CANCELED') AS cancelled
          FROM stop_updates ua JOIN stop_updates ub ON ub.train_num = ua.train_num AND ub.service_date = ua.service_date AND ub.stop_index > ua.stop_index
          JOIN trains t ON t.train_num = ua.train_num AND t.service_date = ua.service_date LEFT JOIN ref_routes ro ON ro.route_id = t.route_id
          WHERE ua.service_date = today AND ua.uic = p_from AND ub.uic = p_to),
    f AS (SELECT * FROM m ORDER BY cancelled, (dep < EXTRACT(EPOCH FROM now())::bigint - 600), abs(dep - EXTRACT(EPOCH FROM now())::bigint) LIMIT 1)
    SELECT json_build_object('net', 'sncf',
      'n', (SELECT COUNT(*) FROM m), 'late15', (SELECT COUNT(*) FROM m WHERE COALESCE(arr_delay, 0) >= 900),
      'cancelled', (SELECT COUNT(*) FROM m WHERE cancelled),
      'trains', COALESCE((SELECT json_agg(x ORDER BY x.dep) FROM (SELECT num, mode, line_id, line, dep, dep_delay, arr, arr_delay, cancelled FROM m
                 WHERE arr >= EXTRACT(EPOCH FROM now())::bigint - 5400 ORDER BY dep LIMIT 40) x), '[]'::json),
      'line_ids', (SELECT json_agg(DISTINCT line_id) FROM m WHERE line_id IS NOT NULL),
      'path', (SELECT json_agg(json_build_array(g.name, round(g.lat::numeric, 5), round(g.lon::numeric, 5)) ORDER BY u.stop_index)
               FROM f JOIN stop_updates u ON u.train_num = f.num AND u.service_date = today AND u.stop_index BETWEEN f.ia AND f.ib JOIN g ON g.uic = u.uic))
    INTO r;
  ELSIF p_net = 'idf' THEN
    WITH sa AS (SELECT stop_ref FROM idfm_ref_stops WHERE COALESCE(parent_ref, stop_ref) = p_from),
         sb AS (SELECT stop_ref FROM idfm_ref_stops WHERE COALESCE(parent_ref, stop_ref) = p_to),
    m AS (SELECT t.journey_key AS k, t.train_num AS num, t.mode, t.line_id, l.short_name AS line,
                 COALESCE(ua.aimed_departure_ts, ua.aimed_arrival_ts) AS dep, ua.departure_delay_s AS dep_delay,
                 COALESCE(ub.aimed_arrival_ts, ub.aimed_departure_ts) AS arr, ub.arrival_delay_s AS arr_delay,
                 (COALESCE(ua.status, '') = 'CANCELLED' OR COALESCE(ub.status, '') = 'CANCELLED' OR COALESCE(t.status, '') = 'CANCELLED') AS cancelled
          FROM idfm_stop_updates ua JOIN idfm_stop_updates ub USING (journey_key) JOIN idfm_trains t USING (journey_key)
          LEFT JOIN idfm_ref_lines l ON l.line_id = t.line_id
          WHERE t.service_date = today AND ua.stop_ref IN (SELECT stop_ref FROM sa) AND ub.stop_ref IN (SELECT stop_ref FROM sb)
            AND COALESCE(ua.aimed_departure_ts, ua.aimed_arrival_ts) < COALESCE(ub.aimed_arrival_ts, ub.aimed_departure_ts)),
    f AS (SELECT * FROM m ORDER BY cancelled, (dep < EXTRACT(EPOCH FROM now())::bigint - 600), abs(dep - EXTRACT(EPOCH FROM now())::bigint) LIMIT 1)
    SELECT json_build_object('net', 'idf',
      'n', (SELECT COUNT(*) FROM m), 'late15', (SELECT COUNT(*) FROM m WHERE COALESCE(arr_delay, 0) >= 900),
      'cancelled', (SELECT COUNT(*) FROM m WHERE cancelled),
      'trains', COALESCE((SELECT json_agg(x ORDER BY x.dep) FROM (SELECT num, mode, line_id, line, dep, dep_delay, arr, arr_delay, cancelled FROM m
                 WHERE arr >= EXTRACT(EPOCH FROM now())::bigint - 5400 ORDER BY dep LIMIT 40) x), '[]'::json),
      'line_ids', (SELECT json_agg(DISTINCT line_id) FROM m WHERE line_id IS NOT NULL),
      'path', (SELECT json_agg(json_build_array(s.name, round(s.lat::numeric, 5), round(s.lon::numeric, 5)) ORDER BY COALESCE(u.aimed_departure_ts, u.aimed_arrival_ts))
               FROM f JOIN idfm_stop_updates u ON u.journey_key = f.k JOIN idfm_ref_stops s ON s.stop_ref = u.stop_ref
               WHERE s.lat IS NOT NULL AND COALESCE(u.aimed_departure_ts, u.aimed_arrival_ts) >= f.dep
                 AND COALESCE(u.aimed_arrival_ts, u.aimed_departure_ts) <= f.arr))
    INTO r;
  END IF;
  RETURN r;
END $$;

REVOKE ALL ON FUNCTION public.public_lines() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_line(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_trip(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_lines() TO anon;
GRANT EXECUTE ON FUNCTION public.public_line(TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.public_trip(TEXT, TEXT, TEXT) TO anon;
