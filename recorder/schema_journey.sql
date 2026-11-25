-- ============ ITINERAIRES AVEC CORRESPONDANCE (carte : « Mon trajet ») ============
-- Trains du jour SNCF + RER / Transilien / TER d'Ile-de-France. Direct ou avec UNE correspondance, a la meme gare ou dans une
-- gare voisine a pied (moins de 400 m : Gare de Lyon SNCF <-> RER, Saint-Michel <-> Notre-Dame...). Metro et tram : pas
-- d'horaires publies, donc pas dans le calcul.

-- Arrets d'Ile-de-France cherches par quai (sinon parcours complet de la table a chaque trajet).
CREATE INDEX IF NOT EXISTS idfm_stop_updates_stop ON idfm_stop_updates(stop_ref);

-- Les « noeuds » du reseau (gares SNCF, zones d'arret IDF desservies par des trains) et les liens a pied entre eux.
CREATE TABLE IF NOT EXISTS lp_nodes (net TEXT, id TEXT, name TEXT, lat DOUBLE PRECISION, lon DOUBLE PRECISION, PRIMARY KEY (net, id));
CREATE TABLE IF NOT EXISTS lp_node_links (a_net TEXT, a_id TEXT, b_net TEXT, b_id TEXT, walk_s INTEGER, PRIMARY KEY (a_net, a_id, b_net, b_id));
CREATE TABLE IF NOT EXISTS lp_meta (k TEXT PRIMARY KEY, v BIGINT);
ALTER TABLE lp_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp_node_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp_meta ENABLE ROW LEVEL SECURITY;

-- Reconstruit les noeuds et les liens (une fois par jour suffit : les gares ne bougent pas).
CREATE OR REPLACE FUNCTION public.refresh_node_links(p_force BOOLEAN DEFAULT FALSE) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t0 BIGINT := EXTRACT(EPOCH FROM now())::bigint;
BEGIN
  IF NOT p_force AND COALESCE((SELECT v FROM lp_meta WHERE k = 'node_links'), 0) > t0 - 86400 THEN RETURN; END IF;
  DELETE FROM lp_nodes;
  INSERT INTO lp_nodes
    SELECT DISTINCT ON (uic) 'sncf', uic, name, lat, lon FROM ref_stops
     WHERE location_type = 1 AND uic IS NOT NULL AND lat IS NOT NULL ORDER BY uic, stop_id;
  INSERT INTO lp_nodes
    SELECT 'idf', COALESCE(s.parent_ref, s.stop_ref), MIN(s.name), AVG(s.lat), AVG(s.lon)
      FROM idfm_ref_stops s
     WHERE s.lat IS NOT NULL AND s.stop_ref IN (SELECT DISTINCT stop_ref FROM idfm_stop_updates)
     GROUP BY COALESCE(s.parent_ref, s.stop_ref)
  ON CONFLICT DO NOTHING;
  DELETE FROM lp_node_links;
  -- Lien de chaque noeud vers lui-meme (marche 0) et vers les noeuds a moins de 400 m (marche 1,2 m/s, au moins 3 min).
  INSERT INTO lp_node_links
    SELECT a.net, a.id, b.net, b.id, CASE WHEN a.net = b.net AND a.id = b.id THEN 0 ELSE GREATEST(180, round(x.d / 1.2))::int END
      FROM lp_nodes a
      JOIN lp_nodes b ON b.lat BETWEEN a.lat - .0045 AND a.lat + .0045 AND b.lon BETWEEN a.lon - .0065 AND a.lon + .0065
      CROSS JOIN LATERAL (SELECT 111000 * sqrt((a.lat - b.lat) ^ 2 + ((a.lon - b.lon) * cos(radians(a.lat))) ^ 2) AS d) x
     WHERE x.d < 400;
  INSERT INTO lp_meta VALUES ('node_links', t0) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
END $$;
REVOKE ALL ON FUNCTION public.refresh_node_links(BOOLEAN) FROM PUBLIC, anon, authenticated;
SELECT public.refresh_node_links();

-- Numero, ligne, mode et terminus d'un train du jour (pour l'affichage des etapes).
CREATE OR REPLACE FUNCTION public.lp_leg_info(p_net TEXT, p_trip TEXT, p_day TEXT) RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT CASE WHEN p_net = 'sncf' THEN
  (SELECT json_build_object('num', t.train_num, 'line_id', t.route_id, 'line', r.short_name, 'mode', t.mode, 'dest', g.name)
     FROM trains t LEFT JOIN ref_routes r ON r.route_id = t.route_id LEFT JOIN lp_nodes g ON g.net = 'sncf' AND g.id = t.dest_uic
    WHERE t.train_num = p_trip AND t.service_date = p_day)
ELSE
  (SELECT json_build_object('num', t.train_num, 'line_id', t.line_id, 'line', l.short_name, 'mode', COALESCE(l.mode, t.mode), 'dest', t.dest_name)
     FROM idfm_trains t LEFT JOIN idfm_ref_lines l ON l.line_id = t.line_id WHERE t.journey_key = p_trip::bigint)
END $$;
REVOKE ALL ON FUNCTION public.lp_leg_info(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- Itineraires A -> B des 3 prochaines heures : directs, et avec une correspondance (arrivee au plus tard dans 8 h).
-- (Etapes MATERIALIZED : calculees une fois, sinon Postgres les recalcule a chaque ligne : 10 s au lieu de 0,1 s.)
-- Les correspondances sont calculees avec les retards CONNUS (heure reelle d'arrivee du 1er train + marche + 2 min
-- <= heure reelle de depart du 2e). Renvoie jusqu'a 40 candidats ; la page garde les meilleurs (partir plus tard,
-- arriver plus tot). Identifiants = ceux de public_station_map().
CREATE OR REPLACE FUNCTION public.public_journey(p_from_net TEXT, p_from_id TEXT, p_to_net TEXT, p_to_id TEXT) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE today TEXT := to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD'); t0 BIGINT := EXTRACT(EPOCH FROM now())::bigint; r JSON;
        alat FLOAT8; alon FLOAT8; blat FLOAT8; blon FLOAT8;
BEGIN
  -- Position des deux gares (meme une station de metro, absente des noeuds « train ») : on part de toutes les gares a
  -- moins de 400 m (Chatelet metro -> Chatelet - Les Halles RER).
  SELECT lat, lon INTO alat, alon FROM lp_nodes WHERE net = p_from_net AND id = p_from_id;
  IF alat IS NULL AND p_from_net = 'idf' THEN SELECT AVG(lat), AVG(lon) INTO alat, alon FROM idfm_ref_stops WHERE COALESCE(parent_ref, stop_ref) = p_from_id; END IF;
  SELECT lat, lon INTO blat, blon FROM lp_nodes WHERE net = p_to_net AND id = p_to_id;
  IF blat IS NULL AND p_to_net = 'idf' THEN SELECT AVG(lat), AVG(lon) INTO blat, blon FROM idfm_ref_stops WHERE COALESCE(parent_ref, stop_ref) = p_to_id; END IF;
  WITH
  pa AS (SELECT net, id FROM lp_nodes WHERE lat BETWEEN alat - .0036 AND alat + .0036 AND lon BETWEEN alon - .0054 AND alon + .0054
           AND 111000 * sqrt((lat - alat) ^ 2 + ((lon - alon) * cos(radians(alat))) ^ 2) < 400
         UNION SELECT p_from_net, p_from_id),
  pb AS (SELECT net, id FROM lp_nodes WHERE lat BETWEEN blat - .0036 AND blat + .0036 AND lon BETWEEN blon - .0054 AND blon + .0054
           AND 111000 * sqrt((lat - blat) ^ 2 + ((lon - blon) * cos(radians(blat))) ^ 2) < 400
         UNION SELECT p_to_net, p_to_id),
  sa AS (SELECT 'sncf' AS net, id AS stop, id AS node FROM pa WHERE net = 'sncf'
         UNION ALL SELECT 'idf', s.stop_ref, pa.id FROM pa JOIN idfm_ref_stops s ON pa.net = 'idf' AND COALESCE(s.parent_ref, s.stop_ref) = pa.id),
  sb AS (SELECT 'sncf' AS net, id AS stop, id AS node FROM pb WHERE net = 'sncf'
         UNION ALL SELECT 'idf', s.stop_ref, pb.id FROM pb JOIN idfm_ref_stops s ON pb.net = 'idf' AND COALESCE(s.parent_ref, s.stop_ref) = pb.id),
  -- Departs de A (3 h) et arrivees a B (8 h), trains non supprimes
  ea AS MATERIALIZED (
    SELECT 'sncf' AS net, u.train_num AS trip, NULL::bigint AS k, u.stop_index AS idx, u.sched_departure_ts AS t,
           COALESCE(u.departure_delay_s, 0) AS dl, sa.node
      FROM sa JOIN stop_updates u ON u.uic = sa.stop AND u.service_date = today
      JOIN trains t ON t.train_num = u.train_num AND t.service_date = u.service_date
     WHERE sa.net = 'sncf' AND u.sched_departure_ts IS NOT NULL AND NOT COALESCE(u.skipped, FALSE) AND COALESCE(t.status, '') <> 'CANCELED'
       AND u.sched_departure_ts + GREATEST(COALESCE(u.departure_delay_s, 0), 0) BETWEEN t0 - 300 AND t0 + 10800
    UNION ALL
    SELECT 'idf', u.journey_key::text, u.journey_key, NULL, u.aimed_departure_ts, COALESCE(u.departure_delay_s, 0), sa.node
      FROM sa JOIN idfm_stop_updates u ON u.stop_ref = sa.stop JOIN idfm_trains t ON t.journey_key = u.journey_key
     WHERE sa.net = 'idf' AND t.service_date = today AND u.aimed_departure_ts IS NOT NULL
       AND COALESCE(u.status, '') <> 'CANCELLED' AND COALESCE(t.status, '') <> 'CANCELLED'
       AND u.aimed_departure_ts + GREATEST(COALESCE(u.departure_delay_s, 0), 0) BETWEEN t0 - 300 AND t0 + 10800),
  eb AS MATERIALIZED (
    SELECT 'sncf' AS net, u.train_num AS trip, NULL::bigint AS k, u.stop_index AS idx, COALESCE(u.sched_arrival_ts, u.sched_departure_ts) AS t,
           COALESCE(u.arrival_delay_s, u.departure_delay_s, 0) AS dl, sb.node
      FROM sb JOIN stop_updates u ON u.uic = sb.stop AND u.service_date = today
      JOIN trains t ON t.train_num = u.train_num AND t.service_date = u.service_date
     WHERE sb.net = 'sncf' AND NOT COALESCE(u.skipped, FALSE) AND COALESCE(t.status, '') <> 'CANCELED'
       AND COALESCE(u.sched_arrival_ts, u.sched_departure_ts) BETWEEN t0 - 300 AND t0 + 28800
    UNION ALL
    SELECT 'idf', u.journey_key::text, u.journey_key, NULL, COALESCE(u.aimed_arrival_ts, u.aimed_departure_ts),
           COALESCE(u.arrival_delay_s, u.departure_delay_s, 0), sb.node
      FROM sb JOIN idfm_stop_updates u ON u.stop_ref = sb.stop JOIN idfm_trains t ON t.journey_key = u.journey_key
     WHERE sb.net = 'idf' AND t.service_date = today
       AND COALESCE(u.status, '') <> 'CANCELLED' AND COALESCE(t.status, '') <> 'CANCELLED'
       AND COALESCE(u.aimed_arrival_ts, u.aimed_departure_ts) BETWEEN t0 - 300 AND t0 + 28800),
  dir AS MATERIALIZED (
    SELECT DISTINCT ON (a.net, a.trip) a.net, a.trip, a.t AS dep, a.dl AS ddl, a.node AS na, b.t AS arr, b.dl AS adl, b.node AS nb
      FROM ea a JOIN eb b ON b.net = a.net AND b.trip = a.trip AND b.t > a.t
     ORDER BY a.net, a.trip, b.t),
  -- Arrets apres A des trains qui ne vont pas directement a B
  d1 AS MATERIALIZED (
    SELECT a.net, a.trip, a.t AS dep, a.dl AS ddl, a.node AS na, 'sncf' AS nnet, x.uic AS nid,
           COALESCE(x.sched_arrival_ts, x.sched_departure_ts) AS arr, COALESCE(x.arrival_delay_s, x.departure_delay_s, 0) AS adl
      FROM ea a JOIN stop_updates x ON x.train_num = a.trip AND x.service_date = today AND x.stop_index > a.idx
     WHERE a.net = 'sncf' AND x.uic IS NOT NULL AND NOT COALESCE(x.skipped, FALSE)
       AND NOT EXISTS (SELECT 1 FROM dir WHERE dir.net = a.net AND dir.trip = a.trip)
    UNION ALL
    SELECT a.net, a.trip, a.t, a.dl, a.node, 'idf', COALESCE(s.parent_ref, s.stop_ref),
           COALESCE(x.aimed_arrival_ts, x.aimed_departure_ts), COALESCE(x.arrival_delay_s, x.departure_delay_s, 0)
      FROM ea a JOIN idfm_stop_updates x ON x.journey_key = a.k JOIN idfm_ref_stops s ON s.stop_ref = x.stop_ref
     WHERE a.net = 'idf' AND COALESCE(x.aimed_arrival_ts, x.aimed_departure_ts) > a.t AND COALESCE(x.status, '') <> 'CANCELLED'
       AND NOT EXISTS (SELECT 1 FROM dir WHERE dir.net = a.net AND dir.trip = a.trip)),
  -- Arrets avant B des trains qui ne partent pas directement de A
  u2 AS MATERIALIZED (
    SELECT b.net, b.trip, b.t AS arr, b.dl AS adl, b.node AS nb, 'sncf' AS nnet, x.uic AS nid,
           x.sched_departure_ts AS dep, COALESCE(x.departure_delay_s, 0) AS ddl
      FROM eb b JOIN stop_updates x ON x.train_num = b.trip AND x.service_date = today AND x.stop_index < b.idx
     WHERE b.net = 'sncf' AND x.uic IS NOT NULL AND x.sched_departure_ts IS NOT NULL AND NOT COALESCE(x.skipped, FALSE)
       AND NOT EXISTS (SELECT 1 FROM dir WHERE dir.net = b.net AND dir.trip = b.trip)
    UNION ALL
    SELECT b.net, b.trip, b.t, b.dl, b.node, 'idf', COALESCE(s.parent_ref, s.stop_ref), x.aimed_departure_ts, COALESCE(x.departure_delay_s, 0)
      FROM eb b JOIN idfm_stop_updates x ON x.journey_key = b.k JOIN idfm_ref_stops s ON s.stop_ref = x.stop_ref
     WHERE b.net = 'idf' AND x.aimed_departure_ts IS NOT NULL AND x.aimed_departure_ts < b.t AND COALESCE(x.status, '') <> 'CANCELLED'
       AND NOT EXISTS (SELECT 1 FROM dir WHERE dir.net = b.net AND dir.trip = b.trip)),
  tr AS (
    SELECT d.*, l.walk_s, l.b_net AS n2net, l.b_id AS n2id, u.net AS net2, u.trip AS trip2, u.dep AS dep2, u.ddl AS ddl2,
           u.arr AS arrb, u.adl AS adlb, u.nb
      FROM d1 d JOIN lp_node_links l ON l.a_net = d.nnet AND l.a_id = d.nid
      JOIN u2 u ON u.nnet = l.b_net AND u.nid = l.b_id AND NOT (u.net = d.net AND u.trip = d.trip)
     WHERE u.dep + GREATEST(u.ddl, 0) >= d.arr + GREATEST(d.adl, 0) + l.walk_s + 120
       AND u.dep - d.arr <= 7200),
  -- Pour chaque premier train : la correspondance qui arrive le plus tot (puis celle qui attend le moins)
  best AS (SELECT DISTINCT ON (net, trip) * FROM tr ORDER BY net, trip, arrb + GREATEST(adlb, 0), dep2 DESC),
  cand AS (
    SELECT net, trip, dep, ddl, na, arr AS arr1, adl AS adl1, nb AS n1, NULL::text AS net2, NULL::text AS trip2, NULL::bigint AS dep2,
           NULL::int AS ddl2, NULL::text AS n2, 0 AS walk_s, arr AS arrb, adl AS adlb, nb FROM dir
    UNION ALL
    SELECT net, trip, dep, ddl, na, arr, adl, nid, net2, trip2, dep2, ddl2, n2id, walk_s, arrb, adlb, nb FROM best),
  top AS (SELECT * FROM cand WHERE dep + GREATEST(ddl, 0) >= t0 - 300 ORDER BY arrb + GREATEST(adlb, 0), dep DESC LIMIT 40),
  nm AS (SELECT net, id, name, lat, lon FROM lp_nodes)
  SELECT json_build_object('now', t0, 'journeys', COALESCE(json_agg(json_build_object(
      'dep', c.dep, 'arr', c.arrb, 'arr_delay', c.adlb, 'transfers', CASE WHEN c.trip2 IS NULL THEN 0 ELSE 1 END,
      'walk_s', c.walk_s,
      'legs', CASE WHEN c.trip2 IS NULL THEN json_build_array(
          json_build_object('net', c.net, 'info', lp_leg_info(c.net, c.trip, today),
            'from', json_build_array(fa.name, fa.lat, fa.lon), 'dep', c.dep, 'dep_delay', c.ddl,
            'to', json_build_array(fb.name, fb.lat, fb.lon), 'arr', c.arrb, 'arr_delay', c.adlb))
        ELSE json_build_array(
          json_build_object('net', c.net, 'info', lp_leg_info(c.net, c.trip, today),
            'from', json_build_array(fa.name, fa.lat, fa.lon), 'dep', c.dep, 'dep_delay', c.ddl,
            'to', json_build_array(f1.name, f1.lat, f1.lon), 'arr', c.arr1, 'arr_delay', c.adl1),
          json_build_object('net', c.net2, 'info', lp_leg_info(c.net2, c.trip2, today),
            'from', json_build_array(f2.name, f2.lat, f2.lon), 'dep', c.dep2, 'dep_delay', c.ddl2,
            'to', json_build_array(fb.name, fb.lat, fb.lon), 'arr', c.arrb, 'arr_delay', c.adlb)) END)
      ORDER BY c.dep), '[]'::json))
    INTO r
    FROM top c
    LEFT JOIN nm fa ON fa.net = c.net AND fa.id = c.na
    LEFT JOIN nm fb ON fb.net = COALESCE(c.net2, c.net) AND fb.id = c.nb
    LEFT JOIN nm f1 ON f1.net = c.net AND f1.id = c.n1
    LEFT JOIN nm f2 ON f2.net = c.net2 AND f2.id = c.n2;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.public_journey(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_journey(TEXT, TEXT, TEXT, TEXT) TO anon, service_role;
