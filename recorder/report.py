"""Controle : nombre de lignes par table et par vue (aucune donnee detaillee, car les logs Actions sont publics)."""
import os
import psycopg

TABLES = ["ref_routes", "ref_stops", "ref_trips", "ref_calendar", "trains", "stop_updates", "observations",
          "alerts", "alert_trains", "polls", "v_trains", "v_route_punctuality", "v_station_punctuality", "v_delay_tiers"]

with psycopg.connect(os.environ["DATABASE_URL"]) as con:
    for t in TABLES:
        print(f"{t:24} {con.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]}")
    n, enriched = con.execute("SELECT COUNT(*), COUNT(line_name) FROM v_trains").fetchone()
    print(f"trains relies a une ligne : {enriched}/{n}")
    print("taille de la base :", con.execute("SELECT pg_size_pretty(pg_database_size(current_database()))").fetchone()[0])
