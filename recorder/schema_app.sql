-- ============ APPLICATION WEB : detail d'un train du jour (ou d'hier), SNCF et Ile-de-France ============
-- Sert au check-in (« je suis dans ce train ») et au justificatif : horaires prevus, retards, arrets supprimes,
-- et, pour chaque arret en retard, l'enregistrement canonique EXACT de l'empreinte de la nuit (delay_roots.py) :
-- v1|<reseau>|<AAAAMMJJ>|<train>|<arret>|<retard s>|<statut>. Le justificatif le recopie pour pouvoir, plus tard,
-- prouver sa presence dans l'empreinte publiee sur Solana.
CREATE OR REPLACE FUNCTION public.public_journey_train(p_net TEXT, p_num TEXT, p_day TEXT) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r JSON; k BIGINT;
BEGIN
  IF p_day !~ '^\d{8}$' THEN RETURN NULL; END IF;
  IF p_net = 'sncf' THEN
    WITH g AS (SELECT DISTINCT ON (uic) uic, name, lat, lon FROM ref_stops WHERE location_type = 1 AND uic IS NOT NULL ORDER BY uic, stop_id),
    u AS (SELECT u.*, GREATEST(COALESCE(u.arrival_delay_s, u.departure_delay_s, 0), 0) AS d FROM stop_updates u
           WHERE u.train_num = p_num AND u.service_date = p_day)
    SELECT json_build_object('net', 'sncf', 'num', p_num, 'day', p_day, 'mode', t.mode, 'status', t.status,
      'line', ro.short_name, 'long', ro.long_name, 'dest', gd.name,
      'stops', COALESCE((SELECT json_agg(json_build_object('stop', COALESCE(u.uic, u.stop_id), 'name', g.name, 'lat', g.lat, 'lon', g.lon,
                 'sched_arr', u.sched_arrival_ts, 'sched_dep', u.sched_departure_ts, 'arr_delay', u.arrival_delay_s, 'dep_delay', u.departure_delay_s,
                 'skipped', COALESCE(u.skipped, FALSE),
                 'rec', CASE WHEN COALESCE(u.skipped, FALSE) OR u.d >= 60 THEN
                          'v1|sncf|' || p_day || '|' || p_num || '|' || COALESCE(u.uic, u.stop_id) || '|' || u.d::int || '|' ||
                          CASE WHEN u.skipped THEN 'SKIPPED' ELSE 'LATE' END END) ORDER BY u.stop_index)
                 FROM u LEFT JOIN g ON g.uic = u.uic), '[]'::json))
      INTO r
      FROM trains t LEFT JOIN ref_routes ro ON ro.route_id = t.route_id LEFT JOIN g gd ON gd.uic = t.dest_uic
     WHERE t.train_num = p_num AND t.service_date = p_day;
  ELSIF p_net = 'idf' THEN
    SELECT journey_key INTO k FROM idfm_trains
     WHERE service_date = p_day AND (train_num = p_num OR 'J' || journey_key::text = p_num) ORDER BY journey_key LIMIT 1;
    IF k IS NULL THEN RETURN NULL; END IF;
    WITH u AS (SELECT u.*, GREATEST(COALESCE(u.arrival_delay_s, u.departure_delay_s, 0), 0) AS d FROM idfm_stop_updates u WHERE u.journey_key = k)
    SELECT json_build_object('net', 'idf', 'num', COALESCE(NULLIF(t.train_num, ''), 'J' || t.journey_key::text), 'day', p_day,
      'mode', COALESCE(l.mode, t.mode), 'status', t.status, 'line', l.short_name, 'line_id', t.line_id, 'long', l.long_name, 'dest', t.dest_name,
      'stops', COALESCE((SELECT json_agg(json_build_object('stop', u.stop_ref, 'name', s.name, 'lat', s.lat, 'lon', s.lon,
                 'sched_arr', u.aimed_arrival_ts, 'sched_dep', u.aimed_departure_ts, 'arr_delay', u.arrival_delay_s, 'dep_delay', u.departure_delay_s,
                 'skipped', COALESCE(u.status, '') = 'CANCELLED',
                 'rec', CASE WHEN COALESCE(u.status, '') = 'CANCELLED' OR u.d >= 60 THEN
                          'v1|idf|' || p_day || '|' || COALESCE(NULLIF(t.train_num, ''), 'J' || t.journey_key::text) || '|' || u.stop_ref || '|' || u.d::int || '|' ||
                          CASE WHEN u.status = 'CANCELLED' THEN 'SKIPPED' ELSE 'LATE' END END)
                 ORDER BY COALESCE(u.aimed_departure_ts, u.aimed_arrival_ts))
                 FROM u LEFT JOIN idfm_ref_stops s ON s.stop_ref = u.stop_ref), '[]'::json))
      INTO r
      FROM idfm_trains t LEFT JOIN idfm_ref_lines l ON l.line_id = t.line_id WHERE t.journey_key = k;
  END IF;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.public_journey_train(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_journey_train(TEXT, TEXT, TEXT) TO anon, service_role;
