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
    for name in ("schema.sql", "schema_idfm.sql", "schema_waitlist.sql", "schema_cache.sql", "schema_public.sql", "schema_public_search.sql", "schema_public_station.sql", "schema_proofs.sql", "schema_assistant.sql", "schema_journey.sql", "schema_app.sql"):
        with open(os.path.join(HERE, name), encoding="utf-8") as f:
            con.execute(f.read())
    con.commit()


def bulk_upsert(cur, table, cols, rows, keys, updates, touch=True):
    """Charge `rows` via COPY dans une table temporaire puis fait un seul INSERT ... ON CONFLICT.
    updates : dict colonne -> expression SQL (EXCLUDED.x par defaut si valeur None). Vide = DO NOTHING.
    touch=False : last_seen / updated_at ne bougent que si une autre valeur change (grosses tables du releve)."""
    if not rows:
        return 0
    # Une ligne par cle, dedoublonnee ici (la derniere gagne) : plus de tri DISTINCT ON cote base, donc rien
    # qui deborde sur disque quand la memoire de tri est petite.
    kidx = [cols.index(k) for k in keys]
    rows = list({tuple(r[i] for i in kidx): r for r in rows}.values())
    tmp = f"tmp_{table}"
    collist = ", ".join(cols)
    # Table temporaire creee une seule fois par session puis videe : la recreer a chaque releve ecrivait
    # dans le catalogue (et donc dans le journal) a chaque appel. Les tables temporaires ne sont pas journalisees.
    cur.execute(f"CREATE TEMP TABLE IF NOT EXISTS {tmp} AS SELECT {collist} FROM {table} WITH NO DATA")
    cur.execute(f"DELETE FROM {tmp}")
    with cur.copy(f"COPY {tmp} ({collist}) FROM STDIN") as cp:
        for r in rows:
            cp.write_row(r)
    keylist = ", ".join(keys)
    if updates:
        exprs = {c: (e if e else "EXCLUDED." + c) for c, e in updates.items()}
        sets = ", ".join(f"{c} = {x}" for c, x in exprs.items())
        # Economie d'ecritures disque : on ne reecrit la ligne que si une valeur change vraiment.
        # « last_seen » seul ne suffit pas : on le rafraichit au plus toutes les 10 min.
        watch = [c for c in exprs if c not in ("last_seen", "updated_at")]
        cond = []
        if watch:
            cond.append(f"({', '.join(exprs[c] for c in watch)}) IS DISTINCT FROM ({', '.join(f'{table}.{c}' for c in watch)})"
                        if len(watch) > 1 else f"{exprs[watch[0]]} IS DISTINCT FROM {table}.{watch[0]}")
        for c in ("last_seen", "updated_at"):
            if c in exprs and touch:
                cond.append(f"{table}.{c} IS NULL OR {table}.{c} < EXCLUDED.{c} - 600")
        action = f"DO UPDATE SET {sets}" + (f" WHERE {' OR '.join(f'({x})' for x in cond)}" if cond else "")
    else:
        action = "DO NOTHING"
    cur.execute(f"INSERT INTO {table} ({collist}) SELECT {collist} FROM {tmp} ON CONFLICT ({keylist}) {action}")
    cur.execute(f"DELETE FROM {tmp}")
    return len(rows)
