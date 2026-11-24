-- ============ DETAIL D'UNE GARE / STATION (panneau de droite de la carte) ============
-- Lignes qui la desservent aujourd'hui (avec leurs chiffres), prochains departs connus en temps reel (heure prevue, retard,
-- destination), regularite des metros / trams. Agregats publics uniquement. Identifiants = ceux de public_station_map().
CREATE OR REPLACE FUNCTION public.public_station(p_net TEXT, p_id TEXT) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE today TEXT := to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD'); t0 BIGINT := EXTRACT(EPOCH FROM now())::bigint; r JSON;
BEGIN
  IF p_net = 'sncf' THEN
    WITH g AS (SELECT DISTINCT ON (uic) uic, name, lat, lon FROM ref_stops WHERE location_type = 1 AND uic IS NOT NULL ORDER BY uic, stop_id),
    p AS (SELECT u.train_num AS num, t.mode, t.route_id AS line_id, ro.short_name AS line, gd.name AS dest, t.dest_uic,
                 COALESCE(u.sched_departure_ts, u.sched_arrival_ts) AS sched,
                 COALESCE(u.departure_delay_s, u.arrival_delay_s, 0) AS delay, u.arrival_delay_s,
                 (COALESCE(u.skipped, FALSE) OR t.status = 'CANCELED') AS cancelled
          FROM stop_updates u JOIN trains t ON t.train_num = u.train_num AND t.service_date = u.service_date
          LEFT JOIN ref_routes ro ON ro.route_id = t.route_id LEFT JOIN g gd ON gd.uic = t.dest_uic
          WHERE u.uic = p_id AND u.service_date = today)
    SELECT json_build_object('net', 'sncf', 'id', p_id, 'name', (SELECT name FROM g WHERE uic = p_id),
      'n', (SELECT COUNT(*) FROM p), 'late15', (SELECT COUNT(*) FROM p WHERE COALESCE(arrival_delay_s, delay) >= 900),
      'cancelled', (SELECT COUNT(*) FROM p WHERE cancelled),
      'avg', (SELECT ROUND(AVG(GREATEST(delay, 0)) / 60.0, 1) FROM p),
      'lines', COALESCE((SELECT json_agg(x ORDER BY x.n DESC) FROM (
          SELECT line_id AS id, MAX(line) AS name, MAX(mode) AS mode, COUNT(*) AS n,
                 COUNT(*) FILTER (WHERE COALESCE(arrival_delay_s, delay) >= 900) AS late15, COUNT(*) FILTER (WHERE cancelled) AS cancelled
          FROM p WHERE line_id IS NOT NULL GROUP BY line_id) x), '[]'::json),
      'next', COALESCE((SELECT json_agg(x ORDER BY x.sched) FROM (
          SELECT num, mode, line_id, line, dest, sched, delay, cancelled FROM p
          WHERE COALESCE(dest_uic, '') <> p_id AND sched + GREATEST(delay, 0) >= t0 - 120
          ORDER BY sched + GREATEST(delay, 0) LIMIT 40) x), '[]'::json))
    INTO r;
  ELSIF p_net = 'idf' THEN
    WITH s AS (SELECT stop_ref, name, lat, lon FROM idfm_ref_stops WHERE COALESCE(parent_ref, stop_ref) = p_id),
    p AS (SELECT t.train_num AS num, t.mode, t.line_id, l.short_name AS line, t.dest_name AS dest,
                 COALESCE(u.aimed_departure_ts, u.aimed_arrival_ts) AS sched, u.aimed_departure_ts,
                 COALESCE(u.departure_delay_s, u.arrival_delay_s, 0) AS delay, u.arrival_delay_s,
                 (COALESCE(u.status, '') = 'CANCELLED' OR COALESCE(t.status, '') = 'CANCELLED') AS cancelled
          FROM idfm_stop_updates u JOIN idfm_trains t USING (journey_key) LEFT JOIN idfm_ref_lines l ON l.line_id = t.line_id
          WHERE u.stop_ref IN (SELECT stop_ref FROM s) AND t.service_date = today),
    m AS (SELECT h.line_id, SUM(h.n_passages) AS n, SUM(h.sum_gap_s)::numeric / NULLIF(SUM(h.n_gaps), 0) AS gap_s,
                 AVG(7200.0 / NULLIF(f.n_trips, 0)) AS planned_s
          FROM idfm_metro_hourly h
          LEFT JOIN idfm_planned_frequency f ON f.line_id = h.line_id
               AND f.service_date = to_char(to_timestamp(h.hour_ts) AT TIME ZONE 'Europe/Paris', 'YYYYMMDD')
               AND f.hour = EXTRACT(HOUR FROM to_timestamp(h.hour_ts) AT TIME ZONE 'Europe/Paris')
          WHERE h.stop_ref IN (SELECT stop_ref FROM s) AND h.hour_ts >= t0 - 3 * 3600 GROUP BY h.line_id)
    SELECT json_build_object('net', 'idf', 'id', p_id, 'name', (SELECT MIN(name) FROM s),
      'n', (SELECT COUNT(*) FROM p), 'late15', (SELECT COUNT(*) FROM p WHERE COALESCE(arrival_delay_s, delay) >= 900),
      'cancelled', (SELECT COUNT(*) FROM p WHERE cancelled),
      'avg', (SELECT ROUND(AVG(GREATEST(delay, 0)) / 60.0, 1) FROM p),
      'lines', COALESCE((SELECT json_agg(x ORDER BY x.n DESC) FROM (
          SELECT line_id AS id, MAX(line) AS name, MAX(mode) AS mode, COUNT(*) AS n,
                 COUNT(*) FILTER (WHERE COALESCE(arrival_delay_s, delay) >= 900) AS late15, COUNT(*) FILTER (WHERE cancelled) AS cancelled,
                 NULL::numeric AS gap, NULL::numeric AS planned
          FROM p WHERE line_id IS NOT NULL GROUP BY line_id
          UNION ALL
          SELECT m.line_id, l.short_name, l.mode, m.n, 0, 0, ROUND(m.gap_s / 60.0, 1), ROUND(m.planned_s / 60.0, 1)
          FROM m JOIN idfm_ref_lines l USING (line_id) WHERE m.line_id NOT IN (SELECT line_id FROM p WHERE line_id IS NOT NULL)) x), '[]'::json),
      'next', COALESCE((SELECT json_agg(x ORDER BY x.sched) FROM (
          SELECT num, mode, line_id, line, dest, sched, delay, cancelled FROM p
          WHERE aimed_departure_ts IS NOT NULL AND sched + GREATEST(delay, 0) >= t0 - 120
          ORDER BY sched + GREATEST(delay, 0) LIMIT 40) x), '[]'::json),
      -- Metro / tram : prochaines rames ESTIMEES par ligne et direction (idfm_metro_next, mis a jour toutes les 2 min)
      'metro_next', COALESCE((SELECT json_agg(x ORDER BY x.line, x.dest) FROM (
          SELECT n.line_id, MIN(l.short_name) AS line, n.dest, (array_agg(DISTINCT n.expected_ts ORDER BY n.expected_ts))[1:3] AS t
          FROM idfm_metro_next n LEFT JOIN idfm_ref_lines l USING (line_id)
          WHERE n.stop_ref IN (SELECT stop_ref FROM s) AND n.expected_ts >= t0 - 30 AND n.updated_at >= t0 - 600
          GROUP BY n.line_id, n.dest) x), '[]'::json))
    INTO r;
  END IF;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.public_station(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_station(TEXT, TEXT) TO anon;

-- Detail d'un train SNCF du jour (panneau « grandes lignes » deroulant) : arrets dans l'ordre avec horaires prevus, retards,
-- arrets supprimes, et alertes publiees pour ce train. Donnees publiques du flux SNCF, aucune donnee personnelle.
CREATE OR REPLACE FUNCTION public.public_train(p_num TEXT) RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH d AS (SELECT MAX(service_date) AS sd FROM trains
           WHERE train_num = p_num AND service_date <= to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD')),
t AS (SELECT t.* FROM trains t, d WHERE t.train_num = p_num AND t.service_date = d.sd),
g AS (SELECT DISTINCT ON (uic) uic, name FROM ref_stops WHERE location_type = 1 AND uic IS NOT NULL ORDER BY uic, stop_id)
SELECT json_build_object('num', p_num, 'mode', t.mode, 'status', t.status, 'max_delay', t.max_delay_s,
  'line', (SELECT short_name FROM ref_routes WHERE route_id = t.route_id), 'long', (SELECT long_name FROM ref_routes WHERE route_id = t.route_id),
  'stops', COALESCE((SELECT json_agg(json_build_array(g.name, u.sched_arrival_ts, u.sched_departure_ts, u.arrival_delay_s, u.departure_delay_s,
                     COALESCE(u.skipped, FALSE), u.uic) ORDER BY u.stop_index)
            FROM stop_updates u LEFT JOIN g ON g.uic = u.uic WHERE u.train_num = p_num AND u.service_date = t.service_date), '[]'::json),
  'alerts', COALESCE((SELECT json_agg(DISTINCT COALESCE(NULLIF(a.header_fr, ''), left(a.description_fr, 200)))
            FROM alert_trains x JOIN alerts a USING (alert_id) WHERE x.train_num = p_num AND x.service_date = t.service_date), '[]'::json))
FROM t $$;
REVOKE ALL ON FUNCTION public.public_train(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_train(TEXT) TO anon;

-- Tous les points d'arret d'un meme lieu (quais metro, RER, gare SNCF...) a partir d'une position et d'un nom :
-- a moins de 250 m, ou a moins de 600 m avec le meme premier mot (Chatelet / Chatelet - Les Halles). Sert a ouvrir la
-- meme fiche « gare » que l'on clique un arret de ligne, une gare ou une station depuis la vue d'une ligne.
CREATE OR REPLACE FUNCTION public.public_nearby_ids(p_lat DOUBLE PRECISION, p_lon DOUBLE PRECISION, p_name TEXT) RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH p AS (SELECT p_lat AS lat, p_lon AS lon, cos(radians(p_lat)) AS c, lower(split_part(COALESCE(p_name, ''), ' ', 1)) AS w),
idf AS (SELECT DISTINCT ON (COALESCE(s.parent_ref, s.stop_ref)) 'idf' AS net, COALESCE(s.parent_ref, s.stop_ref) AS id, s.name,
               111000 * sqrt((s.lat - p.lat) ^ 2 + ((s.lon - p.lon) * p.c) ^ 2) AS dist
        FROM idfm_ref_stops s, p WHERE s.lat BETWEEN p.lat - .006 AND p.lat + .006 AND s.lon BETWEEN p.lon - .009 AND p.lon + .009
        ORDER BY COALESCE(s.parent_ref, s.stop_ref), dist),
sn AS (SELECT DISTINCT ON (r.uic) 'sncf' AS net, r.uic AS id, r.name,
              111000 * sqrt((r.lat - p.lat) ^ 2 + ((r.lon - p.lon) * p.c) ^ 2) AS dist
       FROM ref_stops r, p WHERE r.location_type = 1 AND r.uic IS NOT NULL
         AND r.lat BETWEEN p.lat - .006 AND p.lat + .006 AND r.lon BETWEEN p.lon - .009 AND p.lon + .009
       ORDER BY r.uic, dist)
SELECT COALESCE(json_agg(json_build_object('net', x.net, 'id', x.id, 'name', x.name, 'dist', round(x.dist)) ORDER BY x.dist), '[]'::json)
FROM (SELECT * FROM idf UNION ALL SELECT * FROM sn) x, p
WHERE x.dist < 250 OR (x.dist < 600 AND p.w <> '' AND lower(split_part(x.name, ' ', 1)) = p.w) $$;
REVOKE ALL ON FUNCTION public.public_nearby_ids(DOUBLE PRECISION, DOUBLE PRECISION, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_nearby_ids(DOUBLE PRECISION, DOUBLE PRECISION, TEXT) TO anon;
