"""Controle : nombre de lignes par table et par vue (aucune donnee detaillee, car les logs Actions sont publics)."""
import os
import psycopg

TABLES = ["ref_routes", "ref_stops", "ref_trips", "ref_calendar", "trains", "stop_updates", "observations",
          "alerts", "alert_trains", "polls", "v_trains", "v_route_punctuality", "v_station_punctuality", "v_delay_tiers",
          "idfm_ref_lines", "idfm_ref_stops", "idfm_trains", "idfm_stop_updates", "idfm_observations",
          "idfm_metro_hourly", "idfm_disruptions", "idfm_disruption_lines", "idfm_polls", "daily_line_stats", "archive_log"]

with psycopg.connect(os.environ["DATABASE_URL"]) as con:
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
    # Perturbations : combien concernent nos lignes (train/metro/tram), et combien sont actives MAINTENANT.
    import json, time, datetime, collections
    def parse_t(s):
        for f in ("%Y%m%dT%H%M%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ"):
            try: return datetime.datetime.strptime(s, f).replace(tzinfo=datetime.timezone.utc if s.endswith("Z") else None)
            except (TypeError, ValueError): pass
    from zoneinfo import ZoneInfo
    now = datetime.datetime.now(ZoneInfo("Europe/Paris")).replace(tzinfo=None)  # periodes en heure de Paris
    rows = con.execute("SELECT d.disruption_id, d.cause, d.severity, d.periods, MIN(l.mode) FROM idfm_disruptions d "
                       "LEFT JOIN idfm_disruption_lines dl USING (disruption_id) LEFT JOIN idfm_ref_lines l USING (line_id) "
                       "GROUP BY 1,2,3,4").fetchall()
    c = collections.Counter()
    for _, cause, sev, periods, mode in rows:
        ps = [(parse_t(p.get("begin")), parse_t(p.get("end"))) for p in json.loads(periods or "[]")]
        ps = [(b.replace(tzinfo=None) if b else None, e.replace(tzinfo=None) if e else None) for b, e in ps]
        active = any((b is None or b <= now) and (e is None or e >= now) for b, e in ps)
        c[(mode or "BUS/autre", cause, sev, "active" if active else "a venir/finie")] += 1
    print("IDF perturbations (mode, cause, severite, etat) :")
    for k, n in sorted(c.items(), key=lambda x: -x[1])[:20]: print("   ", k, n)
    print("poids par table (donnees + index) :", [(r[0], r[1]) for r in con.execute(
        "SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_catalog.pg_statio_user_tables "
        "ORDER BY pg_total_relation_size(relid) DESC LIMIT 12")])
    print("taille de la base :", con.execute("SELECT pg_size_pretty(pg_database_size(current_database()))").fetchone()[0])
