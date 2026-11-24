-- ============ DONNEES PUBLIQUES DE LA CARTE (agregats uniquement, lisibles par la page publique) ============
-- Greves annoncees (agenda public cestlagreve.fr, via strike_watch.py).
CREATE TABLE IF NOT EXISTS strike_forecasts (
  strike_id TEXT PRIMARY KEY, title TEXT, start_date TEXT, end_date TEXT,  -- AAAAMMJJ
  place TEXT, scope TEXT, transport BOOLEAN, source TEXT, first_seen BIGINT, last_seen BIGINT);
ALTER TABLE strike_forecasts ENABLE ROW LEVEL SECURITY;

-- Ponctualite par gare sur la journee en cours (heure de Paris) : SNCF + Ile-de-France.
-- Une ligne par gare ayant au moins 3 passages. Aucune donnee individuelle.
CREATE OR REPLACE FUNCTION public.public_station_map() RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH d AS (SELECT to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD') AS today),
gares AS (SELECT DISTINCT ON (uic) uic, name, lat, lon FROM ref_stops WHERE location_type = 1 AND uic IS NOT NULL AND lat IS NOT NULL ORDER BY uic, stop_id),
sncf AS (
  SELECT 'sncf' AS net, u.uic AS id, g.name, g.lat, g.lon, COUNT(*) AS n,
         COUNT(*) FILTER (WHERE COALESCE(u.arrival_delay_s, u.departure_delay_s, 0) >= 900) AS late15,
         COUNT(*) FILTER (WHERE u.skipped) AS cancelled,
         ROUND(AVG(GREATEST(COALESCE(u.arrival_delay_s, u.departure_delay_s, 0), 0)) / 60.0, 1) AS avg_min
  FROM stop_updates u JOIN gares g ON g.uic = u.uic, d WHERE u.service_date = d.today
  GROUP BY u.uic, g.name, g.lat, g.lon HAVING COUNT(*) >= 3),
idf AS (
  SELECT 'idf' AS net, COALESCE(s.parent_ref, s.stop_ref) AS id, MIN(s.name) AS name, AVG(s.lat) AS lat, AVG(s.lon) AS lon, COUNT(*) AS n,
         COUNT(*) FILTER (WHERE COALESCE(u.arrival_delay_s, u.departure_delay_s, 0) >= 900) AS late15,
         COUNT(*) FILTER (WHERE u.status = 'CANCELLED') AS cancelled,
         ROUND(AVG(GREATEST(COALESCE(u.arrival_delay_s, u.departure_delay_s, 0), 0)) / 60.0, 1) AS avg_min
  FROM idfm_stop_updates u JOIN idfm_trains t USING (journey_key) JOIN idfm_ref_stops s ON s.stop_ref = u.stop_ref, d
  WHERE t.service_date = d.today AND s.lat IS NOT NULL
  GROUP BY COALESCE(s.parent_ref, s.stop_ref) HAVING COUNT(*) >= 3)
SELECT json_build_object(
  'updated_at', (SELECT MAX(polled_at) FROM polls),
  'stations', COALESCE((SELECT json_agg(json_build_object('net', net, 'id', id, 'name', name, 'lat', round(lat::numeric, 5),
              'lon', round(lon::numeric, 5), 'n', n, 'late15', late15, 'cancelled', cancelled, 'avg', avg_min))
              FROM (SELECT * FROM sncf UNION ALL SELECT * FROM idf) x), '[]'::json)) $$;

-- Perturbations en cours et a venir (fenetre de `days` jours) : greves annoncees, travaux et incidents
-- (alertes SNCF + Info Trafic IDFM), avec au plus 25 gares localisees chacune pour la carte.
CREATE OR REPLACE FUNCTION public.public_disruptions(days INTEGER DEFAULT 7) RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH w AS (SELECT EXTRACT(EPOCH FROM now())::bigint AS t0, EXTRACT(EPOCH FROM now())::bigint + LEAST(GREATEST(days, 1), 30) * 86400 AS t1,
                  to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD') AS d0,
                  to_char((now() + make_interval(days => LEAST(GREATEST(days, 1), 30))) AT TIME ZONE 'Europe/Paris', 'YYYYMMDD') AS d1),
gares AS (SELECT DISTINCT ON (uic) uic, name, lat, lon FROM ref_stops WHERE location_type = 1 AND lat IS NOT NULL ORDER BY uic, stop_id),
sncf AS (
  SELECT 'sncf' AS src,
         CASE WHEN a.cause_label = 'STRIKE' THEN 'greve'
              WHEN a.cause_label IN ('MAINTENANCE', 'CONSTRUCTION') THEN 'travaux' ELSE 'incident' END AS kind,
         CASE WHEN a.effect_label = 'NO_SERVICE' THEN 'bloquant' ELSE 'perturbe' END AS severity,
         COALESCE(NULLIF(a.header_fr, ''), left(a.description_fr, 140)) AS title,
         NULLIF(a.active_start, 0) AS t_start, NULLIF(a.active_end, 0) AS t_end,
         (SELECT string_agg(DISTINCT COALESCE(r.short_name, r.long_name), ', ') FROM ref_routes r
           WHERE a.route_ids <> '' AND r.route_id = ANY(string_to_array(a.route_ids, ','))) AS lines,
         (SELECT json_agg(json_build_array(g.name, round(g.lat::numeric, 5), round(g.lon::numeric, 5)))
            FROM (SELECT g.* FROM gares g WHERE a.stop_uics <> '' AND g.uic = ANY(string_to_array(a.stop_uics, ',')) LIMIT 25) g) AS stops,
         to_json(string_to_array(NULLIF(a.route_ids, ''), ',')) AS line_ids
  FROM alerts a, w
  WHERE a.last_seen > w.t0 - 1800                                   -- toujours publiee dans le flux
    AND COALESCE(NULLIF(a.active_end, 0), w.t1) >= w.t0 AND COALESCE(NULLIF(a.active_start, 0), w.t0) <= w.t1),
idf AS (
  SELECT 'idf' AS src,
         CASE WHEN d.category LIKE 'travaux%' THEN 'travaux' WHEN d.category = 'information' THEN 'info' ELSE 'incident' END AS kind,
         CASE WHEN d.severity = 'BLOQUANTE' THEN 'bloquant' ELSE 'perturbe' END AS severity,
         COALESCE(NULLIF(d.short_message, ''), d.title) AS title,
         (SELECT MIN(p.begin_ts) FROM idfm_disruption_periods p WHERE p.disruption_id = d.disruption_id AND p.end_ts >= w.t0) AS t_start,
         (SELECT MAX(p.end_ts) FROM idfm_disruption_periods p WHERE p.disruption_id = d.disruption_id) AS t_end,
         (SELECT string_agg(DISTINCT l.short_name, ', ') FROM idfm_disruption_lines dl JOIN idfm_ref_lines l USING (line_id)
           WHERE dl.disruption_id = d.disruption_id) AS lines,
         (SELECT json_agg(json_build_array(s.name, round(s.lat::numeric, 5), round(s.lon::numeric, 5)))
            FROM (SELECT DISTINCT ON (r.stop_ref) r.* FROM idfm_disruption_stops ds JOIN idfm_ref_stops r ON r.stop_ref = ds.stop_ref
                  WHERE ds.disruption_id = d.disruption_id AND r.lat IS NOT NULL LIMIT 25) s) AS stops,
         (SELECT json_agg(dl.line_id) FROM idfm_disruption_lines dl WHERE dl.disruption_id = d.disruption_id) AS line_ids
  FROM idfm_disruptions d, w
  WHERE d.category <> 'information'
    AND EXISTS (SELECT 1 FROM idfm_disruption_periods p WHERE p.disruption_id = d.disruption_id AND p.end_ts >= w.t0 AND p.begin_ts <= w.t1)),
strikes AS (
  SELECT 'agenda' AS src, 'greve' AS kind, CASE WHEN f.scope = 'national' THEN 'bloquant' ELSE 'perturbe' END AS severity,
         f.title || CASE WHEN f.place <> '' THEN ' · ' || f.place ELSE '' END AS title,
         EXTRACT(EPOCH FROM (to_date(f.start_date, 'YYYYMMDD')::timestamp AT TIME ZONE 'Europe/Paris'))::bigint AS t_start,
         EXTRACT(EPOCH FROM ((to_date(f.end_date, 'YYYYMMDD') + 1)::timestamp AT TIME ZONE 'Europe/Paris'))::bigint - 1 AS t_end,
         NULL::text AS lines, NULL::json AS stops, NULL::json AS line_ids
  FROM strike_forecasts f, w WHERE f.end_date >= w.d0 AND f.start_date <= w.d1)
SELECT json_build_object('generated_at', EXTRACT(EPOCH FROM now())::bigint,
  'items', COALESCE((SELECT json_agg(x ORDER BY (x.kind = 'greve') DESC, x.t_start NULLS FIRST)
                     FROM (SELECT * FROM (SELECT * FROM strikes UNION ALL SELECT * FROM sncf UNION ALL SELECT * FROM idf) u LIMIT 400) x), '[]'::json)) $$;

REVOKE ALL ON FUNCTION public.public_station_map() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_disruptions(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_station_map() TO anon;
GRANT EXECUTE ON FUNCTION public.public_disruptions(INTEGER) TO anon;
