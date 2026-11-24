"""Fonctions partagees : telechargement, decodage des identifiants SNCF, ecriture groupee dans Postgres."""
import os, re, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

# Identifiant temps reel / statique, ex. :
# OCESN3614F1187_F:IC:FR:Line::fc526a2c-...::87594002:87547000:8:931:20261123
TRIP_RE = re.compile(r"^OCESN(?P<num>\d+)\w*?_F:(?P<mode>[A-Z]*):(?P<route>FR:Line::[^:]+:):(?P<orig>\d{8}):(?P<dest>\d{8}):")
NUM_RE = re.compile(r"^OCESN(\d+)")
UIC_RE = re.compile(r"(\d{8})$")


def http_get(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": "delay-recorder/0.2"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def parse_trip_id(trip_id):
    """-> dict(num, mode, route_id, origin_uic, dest_uic); champs a None si l'identifiant est court."""
    m = TRIP_RE.match(trip_id)
    if m:
        return dict(num=m.group("num"), mode=m.group("mode") or None, route_id=m.group("route"),
                    origin_uic=m.group("orig"), dest_uic=m.group("dest"))
    n = NUM_RE.match(trip_id)
    return dict(num=n.group(1) if n else None, mode=None, route_id=None, origin_uic=None, dest_uic=None)


def uic_of(stop_id):
    m = UIC_RE.search(stop_id or "")
    return m.group(1) if m else None


def apply_schema(con):
    for name in ("schema.sql", "schema_idfm.sql", "schema_waitlist.sql"):
        with open(os.path.join(HERE, name), encoding="utf-8") as f:
            con.execute(f.read())
    con.commit()


def bulk_upsert(cur, table, cols, rows, keys, updates):
    """Charge `rows` via COPY dans une table temporaire puis fait un seul INSERT ... ON CONFLICT.
    updates : dict colonne -> expression SQL (EXCLUDED.x par defaut si valeur None). Vide = DO NOTHING."""
    if not rows:
        return 0
    tmp = f"tmp_{table}"
    collist = ", ".join(cols)
    cur.execute(f"DROP TABLE IF EXISTS {tmp}")
    cur.execute(f"CREATE TEMP TABLE {tmp} AS SELECT {collist} FROM {table} WITH NO DATA")
    with cur.copy(f"COPY {tmp} ({collist}) FROM STDIN") as cp:
        for r in rows:
            cp.write_row(r)
    keylist = ", ".join(keys)
    if updates:
        sets = ", ".join(f"{c} = {e if e else 'EXCLUDED.' + c}" for c, e in updates.items())
        action = f"DO UPDATE SET {sets}"
    else:
        action = "DO NOTHING"
    cur.execute(f"INSERT INTO {table} ({collist}) SELECT DISTINCT ON ({keylist}) {collist} FROM {tmp} "
                f"ON CONFLICT ({keylist}) {action}")
    cur.execute(f"DROP TABLE {tmp}")
    return len(rows)
