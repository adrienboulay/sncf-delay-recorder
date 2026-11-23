-- ============ ILE-DE-FRANCE (PRIM / Ile-de-France Mobilites) ============
-- Applique apres schema.sql. Idempotent. Tables compactes : la base gratuite Supabase est limitee a 500 Mo.

-- Migration unique : la premiere version (23/11 au soir) utilisait des cles texte longues. On la remplace.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'idfm_stop_updates' AND column_name = 'journey_ref') THEN
    DROP TABLE IF EXISTS idfm_stop_updates, idfm_observations, idfm_trains, idfm_headways CASCADE;
  END IF;
END $$;

-- Referentiels (recharges chaque nuit depuis le GTFS IDFM) : seulement train/RER, metro, tram, funiculaire.
CREATE TABLE IF NOT EXISTS idfm_ref_lines (
  line_id TEXT PRIMARY KEY,          -- ex. C01742 (= RER A) ; LineRef temps reel : STIF:Line::C01742:
  short_name TEXT, long_name TEXT,
  mode TEXT,                         -- RER, TRANSILIEN, TER, METRO, TRAM, FUNI
  route_type INTEGER, agency TEXT, color TEXT, updated_at BIGINT);
CREATE TABLE IF NOT EXISTS idfm_ref_stops (
  stop_ref TEXT PRIMARY KEY,         -- Q:22088 (quai, = STIF:StopPoint:Q:22088:) ou SP:43104 (zone d'arret, = STIF:StopArea:SP:43104:)
  gtfs_stop_id TEXT, name TEXT, lat DOUBLE PRECISION, lon DOUBLE PRECISION, parent_ref TEXT, updated_at BIGINT);

-- Temps reel des trains (RER, Transilien, TER IDF) et des trams qui publient un horaire prevu.
CREATE TABLE IF NOT EXISTS idfm_trains (
  journey_key BIGINT PRIMARY KEY,    -- empreinte (md5, 8 octets) de journey_ref : cle courte pour les tables detaillees
  journey_ref TEXT,                  -- DatedVehicleJourneyRef (unique par circulation)
  service_date TEXT, line_id TEXT, mode TEXT, train_num TEXT, operator TEXT,
  dest_name TEXT, status TEXT, last_stop_ref TEXT,
  arrival_delay_s INTEGER, max_delay_s INTEGER, n_calls SMALLINT, n_cancelled SMALLINT,
  sched_arrival_ts BIGINT, first_seen BIGINT, last_seen BIGINT);
CREATE INDEX IF NOT EXISTS idfm_trains_date ON idfm_trains(service_date);
CREATE INDEX IF NOT EXISTS idfm_trains_line ON idfm_trains(line_id);

CREATE TABLE IF NOT EXISTS idfm_stop_updates (   -- retard gare par gare (dernier etat connu)
  journey_key BIGINT, stop_ref TEXT,
  aimed_arrival_ts BIGINT, aimed_departure_ts BIGINT, arrival_delay_s INTEGER, departure_delay_s INTEGER,
  status TEXT, platform TEXT, last_seen BIGINT,
  PRIMARY KEY (journey_key, stop_ref));

CREATE TABLE IF NOT EXISTS idfm_observations (   -- une ligne a chaque changement de retard ou de statut
  journey_key BIGINT, observed_at BIGINT, status TEXT, arrival_delay_s INTEGER, max_delay_s INTEGER);
CREATE INDEX IF NOT EXISTS idfm_observations_key ON idfm_observations(journey_key);

-- Metro et trams RATP : pas d'horaire prevu publie. On RECONSTITUE les passages reels (derniere heure estimee
-- avant que la rame quitte le flux) et on les agrege par heure, arret et sens : nombre de passages et ecarts entre rames.
CREATE TABLE IF NOT EXISTS idfm_metro_hourly (
  line_id TEXT, stop_ref TEXT, direction TEXT, hour_ts BIGINT,   -- debut de l'heure (UTC, secondes)
  n_passages INTEGER, n_gaps INTEGER, sum_gap_s BIGINT, max_gap_s INTEGER,
  PRIMARY KEY (line_id, stop_ref, direction, hour_ts));

-- Perturbations (Messages Info Trafic, requete globale).
CREATE TABLE IF NOT EXISTS idfm_disruptions (
  disruption_id TEXT PRIMARY KEY, cause TEXT, severity TEXT, title TEXT, short_message TEXT, message TEXT,
  periods TEXT, last_update TEXT, first_seen BIGINT, last_seen BIGINT);
CREATE TABLE IF NOT EXISTS idfm_disruption_lines (
  disruption_id TEXT, line_id TEXT, PRIMARY KEY (disruption_id, line_id));

CREATE TABLE IF NOT EXISTS idfm_polls (polled_at BIGINT, n_journeys INTEGER, n_trains INTEGER, n_headway_lines INTEGER,
                                       n_disruptions INTEGER, error TEXT);

-- ============ HISTORIQUE COMPACT (conserve pour toujours) + JOURNAL D'ARCHIVAGE ============
-- Une ligne par jour et par ligne de transport : sert aux prix une fois le detail archive et purge.
CREATE TABLE IF NOT EXISTS daily_line_stats (
  service_date TEXT, source TEXT, line_id TEXT, mode TEXT,          -- source : sncf | idfm
  n_trains INTEGER, n_cancelled INTEGER, n_late5 INTEGER, n_late15 INTEGER, n_late30 INTEGER, n_late60 INTEGER,
  sum_delay_s BIGINT, max_delay_s INTEGER,
  PRIMARY KEY (service_date, source, line_id));
CREATE TABLE IF NOT EXISTS archive_log (
  service_date TEXT, table_name TEXT, n_rows INTEGER, gz_bytes INTEGER, path TEXT, archived_at BIGINT,
  PRIMARY KEY (service_date, table_name));

ALTER TABLE idfm_ref_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE idfm_ref_stops ENABLE ROW LEVEL SECURITY;
ALTER TABLE idfm_trains ENABLE ROW LEVEL SECURITY;
ALTER TABLE idfm_stop_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE idfm_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE idfm_metro_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE idfm_disruptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE idfm_disruption_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE idfm_polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_line_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_log ENABLE ROW LEVEL SECURITY;

-- Chaque train francilien enrichi (ligne, mode, tranche de retard).
DROP VIEW IF EXISTS v_idfm_trains CASCADE;
CREATE VIEW v_idfm_trains WITH (security_invoker = true) AS
SELECT t.*, l.short_name AS line_code, l.long_name AS line_name, l.mode AS line_mode,
       (t.status = 'CANCELED') AS cancelled,
       CASE WHEN t.status = 'CANCELED' THEN 'supprime'
            WHEN COALESCE(t.arrival_delay_s, 0) < 300 THEN '0-4'
            WHEN t.arrival_delay_s < 900 THEN '5-14'
            WHEN t.arrival_delay_s < 1800 THEN '15-29'
            WHEN t.arrival_delay_s < 3600 THEN '30-59' ELSE '60+' END AS delay_tier
FROM idfm_trains t LEFT JOIN idfm_ref_lines l ON l.line_id = t.line_id;
