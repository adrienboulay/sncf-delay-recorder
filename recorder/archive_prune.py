"""Chaque nuit : resume, archive puis purge le detail ancien, pour rester sous les 500 Mo gratuits de Supabase.

Pour chaque jour termine (service_date <= avant-hier, heure de Paris) :
  1. daily_line_stats : une ligne par jour et par ligne (trains, retards, suppressions). Petit, conserve pour toujours.
  2. Archive : export CSV compresse (gzip) de chaque table detaillee, envoye dans Supabase Storage
     (bucket prive "archive", 1 Go gratuit, separe des 500 Mo de la base) : archive/AAAA/MM/JJ/<table>.csv.gz
  3. Purge : le detail des jours plus vieux que KEEP_DAYS est supprime de la base, SEULEMENT si l'archive est confirmee.

Variables : DATABASE_URL ; SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (sans elles : resume seulement, ni archive ni purge) ;
KEEP_DAYS (defaut 2). N'affiche que des compteurs (journaux publics).
"""
import datetime, gzip, io, json, os, time, urllib.parse, urllib.request
from zoneinfo import ZoneInfo
import psycopg
from sncf_common import apply_schema

PARIS = ZoneInfo("Europe/Paris")
BUCKET = "archive"

# Pour chaque table detaillee : la requete qui selectionne UN jour (%(d)s = AAAAMMJJ) et la requete de purge.
DAY_START = "EXTRACT(EPOCH FROM (to_date(%(d)s, 'YYYYMMDD')::timestamp AT TIME ZONE 'Europe/Paris'))::bigint"
TABLES = {
    "trains":        ("SELECT * FROM trains WHERE service_date = %(d)s",
                      "DELETE FROM trains WHERE service_date = %(d)s"),
    "stop_updates":  ("SELECT * FROM stop_updates WHERE service_date = %(d)s",
                      "DELETE FROM stop_updates WHERE service_date = %(d)s"),
    "observations":  ("SELECT * FROM observations WHERE service_date = %(d)s",
                      "DELETE FROM observations WHERE service_date = %(d)s"),
    "alert_trains":  ("SELECT * FROM alert_trains WHERE service_date = %(d)s",
                      "DELETE FROM alert_trains WHERE service_date = %(d)s"),
    "alerts":        (f"SELECT * FROM alerts WHERE last_seen >= {DAY_START} AND last_seen < {DAY_START} + 86400",
                      f"DELETE FROM alerts WHERE last_seen < {DAY_START} + 86400"),
    "idfm_trains":   ("SELECT * FROM idfm_trains WHERE service_date = %(d)s",
                      "DELETE FROM idfm_trains WHERE service_date = %(d)s"),
    "idfm_stop_updates": ("SELECT u.* FROM idfm_stop_updates u JOIN idfm_trains t USING (journey_key) WHERE t.service_date = %(d)s",
                          "DELETE FROM idfm_stop_updates u USING idfm_trains t WHERE u.journey_key = t.journey_key AND t.service_date = %(d)s"),
    "idfm_observations": ("SELECT o.* FROM idfm_observations o JOIN idfm_trains t USING (journey_key) WHERE t.service_date = %(d)s",
                          "DELETE FROM idfm_observations o USING idfm_trains t WHERE o.journey_key = t.journey_key AND t.service_date = %(d)s"),
    "idfm_metro_hourly": (f"SELECT * FROM idfm_metro_hourly WHERE hour_ts >= {DAY_START} AND hour_ts < {DAY_START} + 86400",
                          f"DELETE FROM idfm_metro_hourly WHERE hour_ts < {DAY_START} + 86400"),
    "idfm_disruptions": (f"SELECT * FROM idfm_disruptions WHERE last_seen >= {DAY_START} AND last_seen < {DAY_START} + 86400",
                         None),  # petit : garde en base
}
# Ordre de purge : les tables qui dependent d'idfm_trains avant elle.
PURGE_ORDER = ["idfm_stop_updates", "idfm_observations", "idfm_trains", "stop_updates", "observations", "alert_trains",
               "trains", "alerts", "idfm_metro_hourly"]

STATS_SQL = """
INSERT INTO daily_line_stats
SELECT service_date, 'sncf', COALESCE(route_id, '?'), MAX(mode), COUNT(*),
       SUM((status = 'CANCELED')::int), SUM((COALESCE(arrival_delay_s,0) >= 300)::int), SUM((COALESCE(arrival_delay_s,0) >= 900)::int),
       SUM((COALESCE(arrival_delay_s,0) >= 1800)::int), SUM((COALESCE(arrival_delay_s,0) >= 3600)::int),
       SUM(GREATEST(COALESCE(arrival_delay_s,0), 0)), MAX(max_delay_s)
FROM trains WHERE service_date = %(d)s GROUP BY service_date, COALESCE(route_id, '?')
ON CONFLICT (service_date, source, line_id) DO UPDATE SET n_trains = EXCLUDED.n_trains, n_cancelled = EXCLUDED.n_cancelled,
  n_late5 = EXCLUDED.n_late5, n_late15 = EXCLUDED.n_late15, n_late30 = EXCLUDED.n_late30, n_late60 = EXCLUDED.n_late60,
  sum_delay_s = EXCLUDED.sum_delay_s, max_delay_s = EXCLUDED.max_delay_s;
INSERT INTO daily_line_stats
SELECT service_date, 'idfm', line_id, MAX(mode), COUNT(*),
       SUM((status = 'CANCELED')::int), SUM((COALESCE(arrival_delay_s,0) >= 300)::int), SUM((COALESCE(arrival_delay_s,0) >= 900)::int),
       SUM((COALESCE(arrival_delay_s,0) >= 1800)::int), SUM((COALESCE(arrival_delay_s,0) >= 3600)::int),
       SUM(GREATEST(COALESCE(arrival_delay_s,0), 0)), MAX(max_delay_s)
FROM idfm_trains WHERE service_date = %(d)s GROUP BY service_date, line_id
ON CONFLICT (service_date, source, line_id) DO UPDATE SET n_trains = EXCLUDED.n_trains, n_cancelled = EXCLUDED.n_cancelled,
  n_late5 = EXCLUDED.n_late5, n_late15 = EXCLUDED.n_late15, n_late30 = EXCLUDED.n_late30, n_late60 = EXCLUDED.n_late60,
  sum_delay_s = EXCLUDED.sum_delay_s, max_delay_s = EXCLUDED.max_delay_s;
"""


def storage(method, path, body=None, ctype="application/json"):
    u = urllib.parse.urlparse(os.environ["SUPABASE_URL"].strip())
    url = f"{u.scheme}://{u.netloc}/storage/v1/" + path  # on ignore un eventuel chemin colle apres l'adresse (/rest/v1/...)
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    headers = {"apikey": key, "Content-Type": ctype, "x-upsert": "true"}
    if not key.startswith("sb_secret_"):  # ancienne cle « service_role » (JWT) : aussi dans Authorization
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def ensure_bucket():
    import re
    u = os.environ["SUPABASE_URL"].strip()
    # Diagnostic sans rien reveler : la forme attendue est https://<ref>.supabase.co
    print("SUPABASE_URL au format https://<ref>.supabase.co :", bool(re.fullmatch(r"https://[a-z0-9]{20}\.supabase\.co/?", u)),
          "| se termine par un chemin :", bool(re.search(r"supabase\.co/.+", u)),
          "| cle de type :", "sb_secret" if os.environ["SUPABASE_SERVICE_ROLE_KEY"].startswith("sb_secret_")
          else ("JWT" if os.environ["SUPABASE_SERVICE_ROLE_KEY"].startswith("eyJ") else "autre"), flush=True)
    st, body = storage("GET", f"bucket/{BUCKET}")
    if st != 200:
        print(f"lecture du bucket : {st} {body[:200]!r}", flush=True)
        st, body = storage("POST", "bucket", json.dumps({"id": BUCKET, "name": BUCKET, "public": False}).encode())
        if st not in (200, 201): raise RuntimeError(f"creation du bucket impossible ({st}) {body[:200]!r}")


def export_gz(con, sql, d):
    buf = io.BytesIO()
    n = 0
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9) as gz:
        assert d.isdigit() and len(d) == 8  # date controlee : on peut l'inserer telle quelle dans la requete
        with con.cursor().copy(f"COPY ({sql.replace('%(d)s', repr(d))}) TO STDOUT WITH (FORMAT csv, HEADER)") as cp:
            for chunk in cp:
                gz.write(chunk); n += bytes(chunk).count(b"\n")
    return buf.getvalue(), max(0, n - 1)


def main():
    keep = int(os.environ.get("KEEP_DAYS", "2"))
    can_archive = bool(os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    today = datetime.datetime.now(PARIS).date()
    last_complete = (today - datetime.timedelta(days=2)).strftime("%Y%m%d")
    purge_before = (today - datetime.timedelta(days=keep)).strftime("%Y%m%d")
    with psycopg.connect(os.environ["DATABASE_URL"]) as con:
        apply_schema(con)
        days = sorted({r[0] for r in con.execute(
            "SELECT DISTINCT service_date FROM trains WHERE service_date <= %s UNION "
            "SELECT DISTINCT service_date FROM idfm_trains WHERE service_date <= %s", (last_complete, last_complete))})
        print(f"jours termines en base : {len(days)} ; archivage {'actif' if can_archive else 'INACTIF (secrets Storage absents)'} ; "
              f"purge du detail avant le {purge_before}", flush=True)
        if can_archive: ensure_bucket()
        if can_archive and os.environ.get("SELFTEST") == "1":
            # Auto-test sur les donnees du jour : export compresse -> envoi -> relecture identique -> suppression.
            d = today.strftime("%Y%m%d")
            data, n = export_gz(con, TABLES["idfm_trains"][0], d)
            path = f"selftest/{d}_idfm_trains.csv.gz"
            st, _ = storage("POST", f"object/{BUCKET}/{path}", data, "application/gzip")
            st2, back = storage("GET", f"object/{BUCKET}/{path}")
            st3, _ = storage("DELETE", f"object/{BUCKET}", json.dumps({"prefixes": [path]}).encode())
            ok = st in (200, 201) and st2 == 200 and back == data
            print(f"AUTO-TEST : {n} lignes, {len(data)/1e3:.0f} ko compresses ; envoi {st}, relecture {st2} "
                  f"{'identique' if back == data else 'DIFFERENTE'}, suppression {st3} -> {'OK' if ok else 'ECHEC'}", flush=True)
            if not ok: raise SystemExit(1)
        for d in days:
            for stmt in STATS_SQL.split(";"):  # une requete a la fois (psycopg refuse plusieurs requetes parametrees)
                if stmt.strip(): con.execute(stmt, {"d": d})
            con.commit()
            if not can_archive: continue
            archived = {r[0] for r in con.execute("SELECT table_name FROM archive_log WHERE service_date = %s", (d,))}
            for t, (sel, _) in TABLES.items():
                if t in archived: continue
                data, n = export_gz(con, sel, d)
                path = f"{d[:4]}/{d[4:6]}/{d[6:]}/{t}.csv.gz"
                st, body = storage("POST", f"object/{BUCKET}/{path}", data, "application/gzip")
                if st not in (200, 201):
                    print(f"  {d} {t} : echec de l'envoi ({st}), rien ne sera purge pour ce jour", flush=True); break
                con.execute("INSERT INTO archive_log VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                            (d, t, n, len(data), f"{BUCKET}/{path}", int(time.time())))
                con.commit()
                print(f"  {d} {t:18} {n:8} lignes -> {len(data)/1e6:.2f} Mo compresses", flush=True)
            if d < purge_before:
                archived = {r[0] for r in con.execute("SELECT table_name FROM archive_log WHERE service_date = %s", (d,))}
                if archived >= set(TABLES):
                    for t in PURGE_ORDER:
                        dele = TABLES[t][1]
                        if dele: con.execute(dele, {"d": d})
                    con.commit()
                    print(f"  {d} : detail purge de la base (archive complete)", flush=True)
        print("taille de la base :", con.execute("SELECT pg_size_pretty(pg_database_size(current_database()))").fetchone()[0])


if __name__ == "__main__":
    main()
