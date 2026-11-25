"""Diagnostic (lecture seule) : plan d'execution de la requete d'itineraire pour une paire de gares.
Usage (workflow explain-journey) : FROM=net|id TO=net|id python probes/explain_journey.py"""
import os, re, time
import psycopg

HERE = os.path.dirname(os.path.abspath(__file__))
sql = open(os.path.join(HERE, "..", "recorder", "schema_journey.sql"), encoding="utf-8").read()
body = sql.split("CREATE OR REPLACE FUNCTION public.public_journey", 1)[1]
q = body[body.index("  WITH"):body.index("    INTO r")] + body[body.index("    FROM top c"):body.index("  RETURN r;")]
fn, fi = os.environ["FROM"].split("|", 1)
tn, ti = os.environ["TO"].split("|", 1)
with psycopg.connect(os.environ["DATABASE_URL"]) as con:
    today, t0 = con.execute("SELECT to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD'), EXTRACT(EPOCH FROM now())::bigint").fetchone()
    for k, v in {"p_from_net": fn, "p_from_id": fi, "p_to_net": tn, "p_to_id": ti, "today": today}.items():
        q = re.sub(rf"\b{k}\b", "'" + v.replace("'", "''") + "'", q)
    q = re.sub(r"\bt0\b", str(t0), q)
    print("index idfm_stop_updates_stop :", con.execute("SELECT count(*) FROM pg_indexes WHERE indexname = 'idfm_stop_updates_stop'").fetchone()[0])
    print("lp_nodes / links :", con.execute("SELECT (SELECT count(*) FROM lp_nodes), (SELECT count(*) FROM lp_node_links)").fetchone())
    print("idfm_stop_updates rows ~", con.execute("SELECT reltuples::bigint FROM pg_class WHERE relname = 'idfm_stop_updates'").fetchone()[0])
    t = time.time()
    for (line,) in con.execute("EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) " + q):
        print(line)
    print(f"{time.time() - t:.2f} s")
