-- Base de donnees des retards SNCF.
-- Idempotent : peut etre rejoue a chaque execution sans rien casser.
-- Horodatages en secondes Unix (UTC). Les vues convertissent en heure de Paris.

-- ============ REFERENTIELS (rechargés chaque nuit depuis le GTFS statique) ============
CREATE TABLE IF NOT EXISTS ref_routes (
  route_id TEXT PRIMARY KEY,        -- ex. FR:Line::00F7208C-...:
  agency_id TEXT,
  short_name TEXT,                  -- ex. C30, P53
  long_name TEXT,                   -- ex. Saint-Etienne - Roanne
  route_type INTEGER,               -- 2 = train, 3 = car / bus de remplacement
  color TEXT,
  updated_at BIGINT);

CREATE TABLE IF NOT EXISTS ref_stops (
  stop_id TEXT PRIMARY KEY,         -- StopArea:OCE87723197 (gare) ou StopPoint:OCETrain TER-87723197 (quai par mode)
  uic TEXT,                         -- code UIC a 8 chiffres, commun a la gare et a ses StopPoints
  name TEXT,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  location_type INTEGER,            -- 1 = gare (StopArea), 0 = point d'arret
  parent_station TEXT,
  updated_at BIGINT);
CREATE INDEX IF NOT EXISTS ref_stops_uic ON ref_stops(uic);

CREATE TABLE IF NOT EXISTS ref_trips (
  trip_id TEXT PRIMARY KEY,
  train_num TEXT,                   -- numero commercial (ex. 860851)
  route_id TEXT,
  service_id TEXT,
  headsign TEXT,
  direction_id INTEGER,
  mode TEXT,                        -- TER, OUI (TGV INOUI), OGO (OUIGO), IC, ICN, LYR, TT, ICE, NAV...
  origin_uic TEXT,
  dest_uic TEXT,
  updated_at BIGINT);
CREATE INDEX IF NOT EXISTS ref_trips_num ON ref_trips(train_num);
CREATE INDEX IF NOT EXISTS ref_trips_route ON ref_trips(route_id);

CREATE TABLE IF NOT EXISTS ref_calendar (     -- quels services circulent quel jour (pour compter les trains PREVUS)
  service_id TEXT,
  service_date TEXT,                -- AAAAMMJJ
  PRIMARY KEY (service_id, service_date));
CREATE INDEX IF NOT EXISTS ref_calendar_date ON ref_calendar(service_date);

CREATE TABLE IF NOT EXISTS ref_loads (loaded_at BIGINT, feed_version TEXT, n_routes INTEGER, n_stops INTEGER, n_trips INTEGER, n_calendar INTEGER);

-- ============ TEMPS REEL (enregistré toutes les ~2-5 min) ============
CREATE TABLE IF NOT EXISTS trains (           -- dernier etat connu de chaque train, un par numero et par jour
  train_num TEXT, service_date TEXT, mode TEXT, trip_id TEXT,
  status TEXT, last_stop TEXT, arrival_delay_s INTEGER, max_delay_s INTEGER,
  first_seen BIGINT, last_seen BIGINT,
  PRIMARY KEY (train_num, service_date));
ALTER TABLE trains ADD COLUMN IF NOT EXISTS route_id TEXT;
ALTER TABLE trains ADD COLUMN IF NOT EXISTS origin_uic TEXT;
ALTER TABLE trains ADD COLUMN IF NOT EXISTS dest_uic TEXT;
ALTER TABLE trains ADD COLUMN IF NOT EXISTS sched_departure_ts BIGINT;
ALTER TABLE trains ADD COLUMN IF NOT EXISTS sched_arrival_ts BIGINT;
ALTER TABLE trains ADD COLUMN IF NOT EXISTS departure_delay_s INTEGER;
ALTER TABLE trains ADD COLUMN IF NOT EXISTS n_stops INTEGER;
ALTER TABLE trains ADD COLUMN IF NOT EXISTS n_skipped_stops INTEGER;
CREATE INDEX IF NOT EXISTS trains_date ON trains(service_date);
CREATE INDEX IF NOT EXISTS trains_route ON trains(route_id);

CREATE TABLE IF NOT EXISTS stop_updates (     -- retard GARE PAR GARE (dernier etat connu) : indispensable pour le check-in
  train_num TEXT, service_date TEXT, stop_index INTEGER, stop_id TEXT, uic TEXT,
  sched_arrival_ts BIGINT, sched_departure_ts BIGINT,
  arrival_delay_s INTEGER, departure_delay_s INTEGER,
  skipped BOOLEAN,                  -- arret supprime (le train ne s'y arrete plus)
  last_seen BIGINT,
  PRIMARY KEY (train_num, service_date, stop_id));
CREATE INDEX IF NOT EXISTS stop_updates_uic ON stop_updates(uic, service_date);

CREATE TABLE IF NOT EXISTS observations (     -- historique : une ligne a chaque changement de retard ou de statut
  train_num TEXT, service_date TEXT, observed_at BIGINT, feed_ts BIGINT,
  status TEXT, arrival_delay_s INTEGER, max_delay_s INTEGER);
CREATE INDEX IF NOT EXISTS obs_idx ON observations(train_num, service_date);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id TEXT PRIMARY KEY, cause INTEGER, effect INTEGER, header_fr TEXT, description_fr TEXT,
  trains TEXT, active_start BIGINT, active_end BIGINT, first_seen BIGINT, last_seen BIGINT);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS cause_label TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS effect_label TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS route_ids TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS stop_uics TEXT;

CREATE TABLE IF NOT EXISTS alert_trains (     -- lien alerte <-> trains concernes (pour les jointures)
  alert_id TEXT, train_num TEXT, service_date TEXT,
  PRIMARY KEY (alert_id, train_num, service_date));
CREATE INDEX IF NOT EXISTS alert_trains_num ON alert_trains(train_num, service_date);

CREATE TABLE IF NOT EXISTS polls (polled_at BIGINT, feed_ts BIGINT, n_trains INTEGER, n_alerts INTEGER, error TEXT);

-- Personne ne lit ni n'ecrit via l'API publique Supabase tant qu'on n'a pas defini de regles.
-- (Le recorder se connecte en proprietaire de la base et n'est pas concerne.)
ALTER TABLE ref_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ref_stops ENABLE ROW LEVEL SECURITY;
ALTER TABLE ref_trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE ref_calendar ENABLE ROW LEVEL SECURITY;
ALTER TABLE ref_loads ENABLE ROW LEVEL SECURITY;
ALTER TABLE trains ENABLE ROW LEVEL SECURITY;
ALTER TABLE stop_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_trains ENABLE ROW LEVEL SECURITY;
ALTER TABLE polls ENABLE ROW LEVEL SECURITY;

-- ============ VUES DE CALCUL (security_invoker : elles respectent le RLS) ============
DROP VIEW IF EXISTS v_delay_tiers, v_route_punctuality, v_station_punctuality, v_trains CASCADE;

-- Un train par ligne, enrichi : ligne, gares, mode, heure de Paris, jour de semaine, tranche de retard.
CREATE VIEW v_trains WITH (security_invoker = true) AS
SELECT t.train_num, t.service_date, COALESCE(t.mode, rt.mode) AS mode,
       COALESCE(t.route_id, rt.route_id) AS route_id, r.short_name AS line_code, r.long_name AS line_name,
       (r.route_type = 3) AS is_bus,
       COALESCE(t.origin_uic, rt.origin_uic) AS origin_uic, so.name AS origin_name,
       COALESCE(t.dest_uic, rt.dest_uic) AS dest_uic, sd.name AS dest_name,
       t.status, (t.status = 'CANCELED') AS cancelled,
       t.arrival_delay_s, t.max_delay_s, t.departure_delay_s,
       t.arrival_delay_s / 60.0 AS arrival_delay_min,
       to_timestamp(t.sched_departure_ts) AT TIME ZONE 'Europe/Paris' AS sched_departure_local,
       to_timestamp(t.sched_arrival_ts) AT TIME ZONE 'Europe/Paris' AS sched_arrival_local,
       EXTRACT(ISODOW FROM to_timestamp(t.sched_departure_ts) AT TIME ZONE 'Europe/Paris')::int AS weekday,   -- 1 = lundi
       EXTRACT(HOUR FROM to_timestamp(t.sched_departure_ts) AT TIME ZONE 'Europe/Paris')::int AS dep_hour,
       CASE WHEN t.status = 'CANCELED' THEN 'cancelled'
            WHEN COALESCE(t.arrival_delay_s, 0) >= 3600 THEN '60+'
            WHEN COALESCE(t.arrival_delay_s, 0) >= 1800 THEN '30-59'
            WHEN COALESCE(t.arrival_delay_s, 0) >= 900 THEN '15-29'
            WHEN COALESCE(t.arrival_delay_s, 0) >= 300 THEN '5-14'
            ELSE '0-4' END AS delay_bucket,
       t.n_stops, t.n_skipped_stops,
       EXISTS (SELECT 1 FROM alert_trains a WHERE a.train_num = t.train_num) AS has_alert
FROM trains t
LEFT JOIN LATERAL (SELECT * FROM ref_trips x WHERE x.train_num = t.train_num LIMIT 1) rt ON true
LEFT JOIN ref_routes r ON r.route_id = COALESCE(t.route_id, rt.route_id)
LEFT JOIN LATERAL (SELECT name FROM ref_stops s WHERE s.uic = COALESCE(t.origin_uic, rt.origin_uic) AND s.location_type = 1 LIMIT 1) so ON true
LEFT JOIN LATERAL (SELECT name FROM ref_stops s WHERE s.uic = COALESCE(t.dest_uic, rt.dest_uic) AND s.location_type = 1 LIMIT 1) sd ON true;

-- Ponctualite par ligne, jour de semaine et heure de depart : base du calcul des primes.
CREATE VIEW v_route_punctuality WITH (security_invoker = true) AS
SELECT route_id, line_code, line_name, mode, weekday, dep_hour,
       COUNT(*) AS n_trains,
       ROUND(AVG(COALESCE(arrival_delay_s, 0)) / 60.0, 1) AS avg_delay_min,
       ROUND(100.0 * AVG((COALESCE(arrival_delay_s, 0) >= 300)::int), 1)  AS pct_5min,
       ROUND(100.0 * AVG((COALESCE(arrival_delay_s, 0) >= 900)::int), 1)  AS pct_15min,
       ROUND(100.0 * AVG((COALESCE(arrival_delay_s, 0) >= 1800)::int), 1) AS pct_30min,
       ROUND(100.0 * AVG((COALESCE(arrival_delay_s, 0) >= 3600)::int), 1) AS pct_60min,
       ROUND(100.0 * AVG(cancelled::int), 1) AS pct_cancelled
FROM v_trains GROUP BY route_id, line_code, line_name, mode, weekday, dep_hour;

-- Ponctualite par gare (retard a l'arrivee dans CETTE gare) : utile pour le Quotidien (retard a la gare de l'utilisateur).
CREATE VIEW v_station_punctuality WITH (security_invoker = true) AS
SELECT u.uic, s.name AS station_name, COUNT(*) AS n_passages,
       ROUND(AVG(COALESCE(u.arrival_delay_s, 0)) / 60.0, 1) AS avg_arrival_delay_min,
       ROUND(100.0 * AVG((COALESCE(u.arrival_delay_s, 0) >= 600)::int), 1) AS pct_10min,
       ROUND(100.0 * AVG((COALESCE(u.arrival_delay_s, 0) >= 900)::int), 1) AS pct_15min,
       ROUND(100.0 * AVG(u.skipped::int), 1) AS pct_stop_skipped
FROM stop_updates u
LEFT JOIN LATERAL (SELECT name FROM ref_stops x WHERE x.uic = u.uic AND x.location_type = 1 LIMIT 1) s ON true
GROUP BY u.uic, s.name;

-- Probabilites par palier pour le bareme (Quotidien : 10 / 20 / 30 min ; Grandes lignes : 15 / 30 / 60 min).
CREATE VIEW v_delay_tiers WITH (security_invoker = true) AS
SELECT route_id, line_code, line_name, mode, COUNT(*) AS n_trains,
       AVG((COALESCE(arrival_delay_s, 0) >= 600)::int)  AS p_10,
       AVG((COALESCE(arrival_delay_s, 0) >= 900)::int)  AS p_15,
       AVG((COALESCE(arrival_delay_s, 0) >= 1200)::int) AS p_20,
       AVG((COALESCE(arrival_delay_s, 0) >= 1800)::int) AS p_30,
       AVG((COALESCE(arrival_delay_s, 0) >= 3600)::int) AS p_60,
       AVG(cancelled::int) AS p_cancelled
FROM v_trains GROUP BY route_id, line_code, line_name, mode;
