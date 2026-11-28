-- ============ DÉMO, CLASSEMENT DES LIGNES (presse) ET PRÉVISION DU RISQUE DE RETARD ============
-- Tout est calculé à partir de nos relevés : l'historique compact daily_line_stats (une ligne par jour et par ligne,
-- gardé pour toujours) + le détail encore en base (trains, idfm_trains : les 2 derniers jours) pour les jours que
-- l'historique ne contient pas encore. Aucune donnée individuelle.

-- Une ligne par jour et par ligne, sans double compte (le détail ne sert que pour les jours absents de l'historique).
CREATE OR REPLACE FUNCTION public.lp_line_days(p_since TEXT) RETURNS TABLE (
  day TEXT, net TEXT, line_id TEXT, mode TEXT, n BIGINT, late5 BIGINT, late15 BIGINT, cancelled BIGINT, sum_delay BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.service_date, CASE s.source WHEN 'idfm' THEN 'idf' ELSE 'sncf' END, s.line_id, s.mode, s.n_trains::bigint,
         s.n_late5::bigint, s.n_late15::bigint, s.n_cancelled::bigint, s.sum_delay_s
    FROM daily_line_stats s WHERE s.service_date >= p_since AND s.line_id <> '?'
  UNION ALL
  SELECT t.service_date, 'sncf', t.route_id, MAX(t.mode), COUNT(*), COUNT(*) FILTER (WHERE COALESCE(t.arrival_delay_s, 0) >= 300),
         COUNT(*) FILTER (WHERE COALESCE(t.arrival_delay_s, 0) >= 900), COUNT(*) FILTER (WHERE t.status IN ('CANCELED', 'CANCELLED')),
         SUM(GREATEST(COALESCE(t.arrival_delay_s, 0), 0))
    FROM trains t
   WHERE t.service_date >= p_since AND t.route_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM daily_line_stats s WHERE s.service_date = t.service_date AND s.source = 'sncf')
   GROUP BY t.service_date, t.route_id
  UNION ALL
  SELECT t.service_date, 'idf', t.line_id, MAX(t.mode), COUNT(*), COUNT(*) FILTER (WHERE COALESCE(t.arrival_delay_s, 0) >= 300),
         COUNT(*) FILTER (WHERE COALESCE(t.arrival_delay_s, 0) >= 900), COUNT(*) FILTER (WHERE t.status IN ('CANCELED', 'CANCELLED')),
         SUM(GREATEST(COALESCE(t.arrival_delay_s, 0), 0))
    FROM idfm_trains t
   WHERE t.service_date >= p_since AND t.line_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM daily_line_stats s WHERE s.service_date = t.service_date AND s.source = 'idfm')
   GROUP BY t.service_date, t.line_id $$;

-- Depuis quand on enregistre (pour dire honnêtement sur combien de jours reposent les chiffres)
CREATE OR REPLACE FUNCTION public.public_data_span() RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH d AS (SELECT service_date AS day FROM daily_line_stats UNION SELECT DISTINCT service_date FROM trains)
  SELECT json_build_object('first', MIN(day), 'last', MAX(day), 'days', COUNT(DISTINCT day)) FROM d $$;

-- Classement des lignes les moins ponctuelles sur les p_days derniers jours terminés (aujourd'hui exclu : journée incomplète).
-- Seuil de volume pour qu'une ligne à 4 trains ne se retrouve pas en tête. Cars de remplacement exclus.
CREATE OR REPLACE FUNCTION public.public_worst_lines(p_days INTEGER DEFAULT 7) RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH p AS (SELECT to_char((now() AT TIME ZONE 'Europe/Paris') - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 7), 1), 60)), 'YYYYMMDD') AS since,
                    to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD') AS today),
  a AS (SELECT d.net, d.line_id, MAX(d.mode) AS mode, COUNT(DISTINCT d.day) AS days, SUM(d.n) AS n, SUM(d.late5) AS late5,
               SUM(d.late15) AS late15, SUM(d.cancelled) AS cancelled, SUM(d.sum_delay) AS sum_delay, MIN(d.day) AS d0, MAX(d.day) AS d1
          FROM p, lp_line_days(p.since) d WHERE d.day < p.today GROUP BY d.net, d.line_id),
  named AS (
    SELECT a.*, r.short_name AS name, r.long_name AS long FROM a JOIN ref_routes r ON r.route_id = a.line_id
     WHERE a.net = 'sncf' AND COALESCE(r.route_type, 2) <> 3
    UNION ALL
    SELECT a.*, l.short_name, l.long_name FROM a JOIN idfm_ref_lines l ON l.line_id = a.line_id WHERE a.net = 'idf'),
  ranked AS (SELECT *, round(100.0 * late15 / NULLIF(n, 0), 1) AS pct15, round(100.0 * late5 / NULLIF(n, 0), 1) AS pct5,
                    round(100.0 * cancelled / NULLIF(n, 0), 1) AS pctx, round(sum_delay / 60.0 / NULLIF(n, 0), 1) AS avg_min
               FROM named WHERE n >= 50)
  SELECT json_build_object(
    'since', (SELECT MIN(d0) FROM ranked), 'until', (SELECT MAX(d1) FROM ranked), 'days_asked', p_days,
    'n_lines', (SELECT COUNT(*) FROM ranked), 'n_trains', (SELECT COALESCE(SUM(n), 0) FROM ranked),
    'national_pct15', (SELECT round(100.0 * SUM(late15) / NULLIF(SUM(n), 0), 1) FROM ranked),
    'worst', (SELECT COALESCE(json_agg(x ORDER BY x.pct15 DESC, x.n DESC), '[]'::json) FROM (
       SELECT net, line_id AS id, name, long, mode, days, n, late15, cancelled, pct15, pct5, pctx, avg_min FROM ranked ORDER BY pct15 DESC, n DESC LIMIT 15) x),
    'best', (SELECT COALESCE(json_agg(x ORDER BY x.pct15, x.n DESC), '[]'::json) FROM (
       SELECT net, line_id AS id, name, long, mode, days, n, late15, cancelled, pct15, pct5, pctx, avg_min FROM ranked WHERE n >= 150 ORDER BY pct15, n DESC LIMIT 5) x)) $$;

-- Risque de retard d'une ou plusieurs lignes : part des trains à +5 et +15 min et des suppressions, sur tout notre historique,
-- le même jour de la semaine compté double. Lissé vers la moyenne du réseau (comme 30 trains « moyens » en plus), pour qu'un
-- petit échantillon ne donne jamais 0 % ou 100 %. Indicatif : on renvoie le nombre de jours et de trains observés.
CREATE OR REPLACE FUNCTION public.public_line_risk(p_net TEXT, p_ids TEXT[]) RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH p AS (SELECT to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD') AS today,
                    to_char(now() AT TIME ZONE 'Europe/Paris' + interval '1 day', 'YYYYMMDD') AS tomorrow,
                    EXTRACT(ISODOW FROM now() AT TIME ZONE 'Europe/Paris')::int AS dow),
  d AS (SELECT x.*, CASE WHEN EXTRACT(ISODOW FROM to_date(x.day, 'YYYYMMDD'))::int = p.dow THEN 2 ELSE 1 END AS w
          FROM p, lp_line_days('20250101') x WHERE x.net = p_net AND x.day < p.today),
  nat AS (SELECT SUM(late5)::numeric / NULLIF(SUM(n), 0) AS r5, SUM(late15)::numeric / NULLIF(SUM(n), 0) AS r15,
                 SUM(cancelled)::numeric / NULLIF(SUM(n), 0) AS rx FROM d),
  l AS (SELECT d.line_id, COUNT(DISTINCT d.day) AS days, SUM(d.n) AS n, SUM(d.w * d.n) AS wn,
               SUM(d.w * d.late5) AS w5, SUM(d.w * d.late15) AS w15, SUM(d.w * d.cancelled) AS wx
          FROM d WHERE d.line_id = ANY (p_ids[1:10]) GROUP BY d.line_id),
  td AS (SELECT x.line_id, SUM(x.n) AS n, SUM(x.late15) AS late15 FROM p, lp_line_days(p.today) x
          WHERE x.net = p_net AND x.day = p.today AND x.line_id = ANY (p_ids[1:10]) GROUP BY x.line_id),
  st AS (SELECT COALESCE(json_agg(json_build_object('title', title, 'start', start_date, 'end', end_date) ORDER BY start_date), '[]'::json) AS j
           FROM p, strike_forecasts s WHERE COALESCE(s.transport, TRUE) AND s.start_date <= p.tomorrow AND COALESCE(s.end_date, s.start_date) >= p.today)
  SELECT json_build_object(
    'span', (SELECT public_data_span()),
    'strikes', (SELECT j FROM st),
    'lines', (SELECT COALESCE(json_agg(json_build_object('id', l.line_id, 'days', l.days, 'n', l.n,
        'p5', round(100 * (l.w5 + 30 * nat.r5) / (l.wn + 30)), 'p15', round(100 * (l.w15 + 30 * nat.r15) / (l.wn + 30)),
        'px', round(100 * (l.wx + 30 * nat.rx) / (l.wn + 30), 1),
        'today_n', td.n, 'today_late15', td.late15)), '[]'::json)
      FROM l CROSS JOIN nat LEFT JOIN td ON td.line_id = l.line_id)) $$;

-- Démo pour les juges : de vrais trains en retard d'hier (ou d'aujourd'hui), de préférence déjà scellés sur Solana,
-- grandes lignes d'abord (la garantie G30 s'affiche). Le premier sert au parcours complet, les autres remplissent le bilan du mois.
CREATE OR REPLACE FUNCTION public.public_demo_trips() RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH p AS (SELECT to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD') AS today,
                    to_char(now() AT TIME ZONE 'Europe/Paris' - interval '1 day', 'YYYYMMDD') AS yday),
  g AS (SELECT DISTINCT ON (uic) uic, name, lat, lon FROM ref_stops WHERE location_type = 1 AND uic IS NOT NULL ORDER BY uic, stop_id),
  c AS (SELECT t.*, (r.day IS NOT NULL) AS sealed,
               CASE WHEN t.mode IN ('OUI', 'IC', 'ICN') THEN 0 WHEN t.mode = 'TER' THEN 1 ELSE 2 END AS pref
          FROM p, trains t LEFT JOIN delay_roots r ON r.day = t.service_date AND r.tx_signature IS NOT NULL
         WHERE t.service_date IN (p.yday, p.today) AND t.status NOT IN ('CANCELED', 'CANCELLED')
           AND t.arrival_delay_s BETWEEN 1500 AND 10800 AND t.sched_departure_ts IS NOT NULL AND t.sched_arrival_ts IS NOT NULL
           AND t.origin_uic IS NOT NULL AND t.dest_uic IS NOT NULL AND t.sched_arrival_ts + t.arrival_delay_s < EXTRACT(EPOCH FROM now()))
  SELECT COALESCE(json_agg(x ORDER BY x.rk), '[]'::json) FROM (
    SELECT row_number() OVER (ORDER BY c.sealed DESC, c.pref, abs(c.arrival_delay_s - 3600)) AS rk,
           c.service_date AS day, c.train_num AS num, c.mode, ro.short_name AS line, c.sched_departure_ts AS sched, c.sched_arrival_ts AS sched_arr,
           c.arrival_delay_s AS delay, c.sealed,
           json_build_object('id', c.origin_uic, 'name', go.name, 'lat', go.lat, 'lon', go.lon) AS "from",
           json_build_object('stop', c.dest_uic, 'name', gd.name) AS "to"
      FROM c JOIN g go ON go.uic = c.origin_uic JOIN g gd ON gd.uic = c.dest_uic LEFT JOIN ref_routes ro ON ro.route_id = c.route_id
     ORDER BY 1 LIMIT 6) x $$;

REVOKE ALL ON FUNCTION public.lp_line_days(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.public_data_span(), public.public_worst_lines(INTEGER), public.public_line_risk(TEXT, TEXT[]), public.public_demo_trips() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_data_span(), public.public_worst_lines(INTEGER), public.public_line_risk(TEXT, TEXT[]), public.public_demo_trips() TO anon, service_role;
