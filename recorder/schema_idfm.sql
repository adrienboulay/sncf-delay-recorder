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
-- Classification (pour filtrer vite et personnaliser : ma ligne, ma gare, maintenant, grave ou pas) :
ALTER TABLE idfm_disruptions ADD COLUMN IF NOT EXISTS category TEXT;      -- interruption | travaux_interruption | travaux | incident | information
ALTER TABLE idfm_disruptions ADD COLUMN IF NOT EXISTS modes TEXT;         -- ex. "RapidTransit,Bus" (modes des lignes touchees)
ALTER TABLE idfm_disruptions ADD COLUMN IF NOT EXISTS tags TEXT;          -- ex. "Actualite"
ALTER TABLE idfm_disruptions ADD COLUMN IF NOT EXISTS replacement_bus BOOLEAN;  -- bus ou cars de remplacement annonces
ALTER TABLE idfm_disruptions ADD COLUMN IF NOT EXISTS active_from BIGINT; -- debut de la premiere periode (UTC, s)
ALTER TABLE idfm_disruptions ADD COLUMN IF NOT EXISTS active_to BIGINT;   -- fin de la derniere periode (UTC, s)
ALTER TABLE idfm_disruptions ADD COLUMN IF NOT EXISTS sections TEXT;      -- troncons touches : [{line, from, to}] (JSON)
ALTER TABLE idfm_disruption_lines ADD COLUMN IF NOT EXISTS mode TEXT;     -- Metro, RapidTransit (RER), LocalTrain (Transilien/TER), Tramway, Bus
CREATE INDEX IF NOT EXISTS idfm_disruptions_active ON idfm_disruptions(active_to, active_from);
CREATE INDEX IF NOT EXISTS idfm_disruption_lines_line ON idfm_disruption_lines(line_id);
CREATE TABLE IF NOT EXISTS idfm_disruption_periods (     -- chaque periode d'application (une perturbation peut en avoir plusieurs)
  disruption_id TEXT, begin_ts BIGINT, end_ts BIGINT, PRIMARY KEY (disruption_id, begin_ts));
CREATE INDEX IF NOT EXISTS idfm_disruption_periods_t ON idfm_disruption_periods(end_ts, begin_ts);
CREATE TABLE IF NOT EXISTS idfm_disruption_stops (       -- gares / arrets touches, pour « ma gare »
  disruption_id TEXT, line_id TEXT, stop_ref TEXT, stop_name TEXT, PRIMARY KEY (disruption_id, line_id, stop_ref));
CREATE INDEX IF NOT EXISTS idfm_disruption_stops_stop ON idfm_disruption_stops(stop_ref);

-- Nettoyage : on ne suit pas les bus. On supprime les perturbations qui ne touchent AUCUNE ligne suivie (train, RER,
-- metro, tram) et qui n'annoncent pas de bus de remplacement. (Garde-fou : seulement si le referentiel est charge.)
DELETE FROM idfm_disruptions d
WHERE EXISTS (SELECT 1 FROM idfm_ref_lines)
  AND NOT EXISTS (SELECT 1 FROM idfm_disruption_lines dl JOIN idfm_ref_lines l USING (line_id) WHERE dl.disruption_id = d.disruption_id)
  AND COALESCE(d.replacement_bus, lower(COALESCE(d.title,'') || ' ' || COALESCE(d.short_message,'') || ' ' || COALESCE(d.message,''))
        ~ '(bus|cars?) (de )?(remplacement|substitution)|remplac\w* par (des )?(bus|cars)|navettes? de (remplacement|substitution)') IS NOT TRUE;
DELETE FROM idfm_disruption_lines dl WHERE NOT EXISTS (SELECT 1 FROM idfm_disruptions d WHERE d.disruption_id = dl.disruption_id);
DELETE FROM idfm_disruption_periods p WHERE NOT EXISTS (SELECT 1 FROM idfm_disruptions d WHERE d.disruption_id = p.disruption_id);
DELETE FROM idfm_disruption_stops s WHERE NOT EXISTS (SELECT 1 FROM idfm_disruptions d WHERE d.disruption_id = s.disruption_id);

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
ALTER TABLE idfm_disruption_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE idfm_disruption_stops ENABLE ROW LEVEL SECURITY;
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

-- Probabilite de chaque palier de retard par ligne francilienne (meme principe que v_delay_tiers pour la SNCF) : sert aux prix.
DROP VIEW IF EXISTS v_idfm_delay_tiers CASCADE;
CREATE VIEW v_idfm_delay_tiers WITH (security_invoker = true) AS
SELECT line_id, line_code, line_name, line_mode, COUNT(*) AS n_trains,
       AVG((COALESCE(arrival_delay_s, 0) >= 300)::int)  AS p_5,
       AVG((COALESCE(arrival_delay_s, 0) >= 600)::int)  AS p_10,
       AVG((COALESCE(arrival_delay_s, 0) >= 900)::int)  AS p_15,
       AVG((COALESCE(arrival_delay_s, 0) >= 1800)::int) AS p_30,
       AVG((COALESCE(arrival_delay_s, 0) >= 3600)::int) AS p_60,
       AVG(cancelled::int) AS p_cancelled
FROM v_idfm_trains GROUP BY line_id, line_code, line_name, line_mode;

-- Frequence PREVUE du metro et des trams sans horaire temps reel (GTFS IDFM, rechargee chaque nuit, 8 jours a venir) :
-- nombre de courses qui partent de leur terminus, par ligne, jour et heure (heure de Paris), tous sens confondus.
CREATE TABLE IF NOT EXISTS idfm_planned_frequency (
  line_id TEXT, service_date TEXT, hour SMALLINT, n_trips INTEGER,
  PRIMARY KEY (line_id, service_date, hour));
ALTER TABLE idfm_planned_frequency ENABLE ROW LEVEL SECURITY;

-- Regularite du metro : attente mesuree (ecart moyen entre rames) comparee a l'intervalle prevu.
-- excess_wait_s > 0 : les voyageurs attendent plus que prevu (signe de perturbation, meme sans message officiel).
DROP VIEW IF EXISTS v_metro_regularity CASCADE;
CREATE VIEW v_metro_regularity WITH (security_invoker = true) AS
WITH obs AS (
  SELECT line_id, hour_ts,
         to_char(to_timestamp(hour_ts) AT TIME ZONE 'Europe/Paris', 'YYYYMMDD') AS service_date,
         EXTRACT(HOUR FROM to_timestamp(hour_ts) AT TIME ZONE 'Europe/Paris')::int AS hour,
         SUM(n_passages) AS n_passages, SUM(sum_gap_s)::numeric / NULLIF(SUM(n_gaps), 0) AS mean_gap_s, MAX(max_gap_s) AS max_gap_s
  FROM idfm_metro_hourly GROUP BY line_id, hour_ts)
SELECT o.line_id, l.short_name AS line_code, l.mode AS line_mode, o.hour_ts, o.service_date, o.hour, o.n_passages,
       ROUND(o.mean_gap_s) AS mean_gap_s, o.max_gap_s,
       ROUND(7200.0 / NULLIF(p.n_trips, 0)) AS planned_interval_s,         -- 2 sens : 3600 / (n_trips / 2)
       ROUND(o.mean_gap_s - 7200.0 / NULLIF(p.n_trips, 0)) AS excess_wait_s
FROM obs o
LEFT JOIN idfm_planned_frequency p ON p.line_id = o.line_id AND p.service_date = o.service_date AND p.hour = o.hour
LEFT JOIN idfm_ref_lines l ON l.line_id = o.line_id;

-- Perturbations ACTIVES maintenant, une ligne par (perturbation, ligne touchee), avec la classification.
-- Exemples : WHERE line_code = 'B' ; WHERE category IN ('interruption','travaux_interruption') ; WHERE line_mode = 'METRO'.
DROP VIEW IF EXISTS v_idfm_disruptions_active CASCADE;
CREATE VIEW v_idfm_disruptions_active WITH (security_invoker = true) AS
SELECT d.disruption_id, d.category, d.cause, d.severity, d.replacement_bus, d.title, d.short_message,
       p.begin_ts, p.end_ts, dl.line_id, l.short_name AS line_code, l.mode AS line_mode
FROM idfm_disruptions d
JOIN idfm_disruption_periods p ON p.disruption_id = d.disruption_id
     AND p.begin_ts <= EXTRACT(EPOCH FROM now())::bigint AND p.end_ts >= EXTRACT(EPOCH FROM now())::bigint
LEFT JOIN idfm_disruption_lines dl ON dl.disruption_id = d.disruption_id
LEFT JOIN idfm_ref_lines l ON l.line_id = dl.line_id;
