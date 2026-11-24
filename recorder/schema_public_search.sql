-- ============ RECHERCHE SUR LA CARTE : LIGNES, DETAIL D'UNE LIGNE, TRAJET A -> B ============
-- Agregats de la journee en cours uniquement, aucune donnee personnelle. Lisibles par la page publique (anon).
CREATE INDEX IF NOT EXISTS idfm_stop_updates_stop ON idfm_stop_updates(stop_ref);

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
-- et le trace (gares intermediaires) du plus complet d'entre eux. Identifiants = ceux de public_station_map().
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
    f AS (SELECT * FROM m ORDER BY cancelled, ib - ia DESC LIMIT 1)
    SELECT json_build_object('net', 'sncf',
      'trains', COALESCE((SELECT json_agg(x ORDER BY x.dep) FROM (SELECT num, mode, line_id, line, dep, dep_delay, arr, arr_delay, cancelled FROM m ORDER BY dep LIMIT 120) x), '[]'::json),
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
    f AS (SELECT * FROM m ORDER BY cancelled, arr - dep DESC LIMIT 1)
    SELECT json_build_object('net', 'idf',
      'trains', COALESCE((SELECT json_agg(x ORDER BY x.dep) FROM (SELECT num, mode, line_id, line, dep, dep_delay, arr, arr_delay, cancelled FROM m ORDER BY dep LIMIT 120) x), '[]'::json),
      'path', (SELECT json_agg(json_build_array(s.name, round(s.lat::numeric, 5), round(s.lon::numeric, 5)) ORDER BY COALESCE(u.aimed_departure_ts, u.aimed_arrival_ts))
               FROM f JOIN idfm_stop_updates u ON u.journey_key = f.k JOIN idfm_ref_stops s ON s.stop_ref = u.stop_ref
               WHERE s.lat IS NOT NULL AND COALESCE(u.aimed_departure_ts, u.aimed_arrival_ts) BETWEEN f.dep AND f.arr))
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
