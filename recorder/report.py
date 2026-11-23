"""Controle : nombre de lignes par table et par vue (aucune donnee detaillee, car les logs Actions sont publics)."""
import os
import psycopg

TABLES = ["ref_routes", "ref_stops", "ref_trips", "ref_calendar", "trains", "stop_updates", "observations",
          "alerts", "alert_trains", "polls", "v_trains", "v_route_punctuality", "v_station_punctuality", "v_delay_tiers",
          "idfm_ref_lines", "idfm_ref_stops", "idfm_trains", "idfm_stop_updates", "idfm_observations",
          "idfm_metro_hourly", "idfm_disruptions", "idfm_disruption_lines", "idfm_disruption_periods",
          "idfm_disruption_stops", "idfm_polls", "daily_line_stats", "archive_log",
          "v_idfm_trains", "v_idfm_disruptions_active", "v_idfm_delay_tiers", "idfm_planned_frequency",
          "v_metro_regularity"]

with psycopg.connect(os.environ["DATABASE_URL"]) as con:
    # Cadence et erreurs des releves sur les 2 dernieres heures (doit etre ~1 releve / 2 min, sans erreur).
    for name, table in (("SNCF", "polls"), ("IDF", "idfm_polls")):
        n, nerr, med, mx = con.execute(f"""
            WITH p AS (SELECT polled_at, error, polled_at - LAG(polled_at) OVER (ORDER BY polled_at) AS gap
                       FROM {table} WHERE polled_at > EXTRACT(EPOCH FROM now())::bigint - 7200)
            SELECT COUNT(*), COUNT(error) FILTER (WHERE error <> ''),
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY gap), MAX(gap) FROM p""").fetchone()
        print(f"CADENCE {name} (2 h) : {n} releves, {nerr} erreurs, ecart median {med} s, ecart max {mx} s")
    for t, col in (("trains", "last_seen"), ("idfm_trains", "last_seen"), ("idfm_disruptions", "last_seen")):
        age = con.execute(f"SELECT EXTRACT(EPOCH FROM now())::bigint - MAX({col}) FROM {t}").fetchone()[0]
        print(f"FRAICHEUR {t} : derniere ecriture il y a {age} s")
    for t in TABLES:
        print(f"{t:24} {con.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]}")
    n, enriched = con.execute("SELECT COUNT(*), COUNT(line_name) FROM v_trains").fetchone()
    print(f"trains relies a une ligne : {enriched}/{n}")
    print("IDF : trains par mode :", con.execute("SELECT mode, COUNT(*) FROM idfm_trains GROUP BY mode ORDER BY 2 DESC").fetchall())
    n, ok = con.execute("SELECT COUNT(*), COUNT(s.stop_ref) FROM idfm_stop_updates u LEFT JOIN idfm_ref_stops s USING (stop_ref)").fetchone()
    print(f"IDF : passages relies a une gare connue : {ok}/{n}")
    print("IDF : 5 derniers releves (trains, lignes metro/tram, erreur) :",
          [(r[0], r[1], (r[2] or "")[:80]) for r in con.execute("SELECT n_trains, n_headway_lines, error FROM idfm_polls ORDER BY polled_at DESC LIMIT 5")])
    print("IDF metro : heures x arrets enregistres par ligne :", con.execute(
        "SELECT l.short_name, COUNT(*), SUM(h.n_passages) FROM idfm_metro_hourly h JOIN idfm_ref_lines l USING (line_id) "
        "GROUP BY 1 ORDER BY 1").fetchall())
    print("IDF perturbations gardees (categorie, modes) :", con.execute(
        "SELECT category, modes, COUNT(*) FROM idfm_disruptions GROUP BY 1,2 ORDER BY 3 DESC LIMIT 15").fetchall())
    print("IDF perturbations ACTIVES maintenant par mode et categorie :", con.execute(
        "SELECT line_mode, category, COUNT(DISTINCT disruption_id) FROM v_idfm_disruptions_active GROUP BY 1,2 ORDER BY 3 DESC").fetchall())
    print("IDF bus de remplacement annonces (actifs) :", con.execute(
        "SELECT COUNT(DISTINCT disruption_id) FROM v_idfm_disruptions_active WHERE replacement_bus").fetchone()[0])
    print("METRO regularite (derniere heure complete) : ligne, passages, ecart moyen, intervalle prevu, attente en plus (s) :",
          con.execute("SELECT line_code, n_passages, mean_gap_s, planned_interval_s, excess_wait_s FROM v_metro_regularity "
                      "WHERE hour_ts = (SELECT MAX(hour_ts) FROM idfm_metro_hourly) - 3600 ORDER BY line_code").fetchall())
    print("IDF paliers de retard (ligne, n trains, p15, p30) :", [(r[0], r[1], round(float(r[2]), 3), round(float(r[3]), 3))
          for r in con.execute("SELECT line_code, n_trains, p_15, p_30 FROM v_idfm_delay_tiers ORDER BY n_trains DESC LIMIT 8")])
    print("poids par table (donnees + index) :", [(r[0], r[1]) for r in con.execute(
        "SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_catalog.pg_statio_user_tables "
        "ORDER BY pg_total_relation_size(relid) DESC LIMIT 12")])
    print("taille de la base :", con.execute("SELECT pg_size_pretty(pg_database_size(current_database()))").fetchone()[0])
