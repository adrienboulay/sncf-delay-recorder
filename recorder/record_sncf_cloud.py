"""Enregistreur des retards SNCF, version cloud (GitHub Actions -> Postgres Supabase).

Fait N releves espaces de X secondes puis s'arrete (GitHub Actions le relance toutes les 5 min).
Variables d'environnement :
  DATABASE_URL   chaine de connexion Postgres (Supabase > Project Settings > Database > Connection string, mode "Session pooler")
  POLLS          nombre de releves par execution (defaut 2)
  POLL_EVERY     secondes entre deux releves (defaut 120)
Sans DATABASE_URL : fait un releve "a blanc" et affiche le resume (pour tester).
"""
import os, re, time, datetime, urllib.request
from google.transit import gtfs_realtime_pb2 as g

TU_URL = "https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-trip-updates"
SA_URL = "https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-service-alerts"
STATUS = {0: "SCHEDULED", 1: "ADDED", 2: "UNSCHEDULED", 3: "CANCELED", 5: "REPLACEMENT", 6: "DUPLICATED", 7: "DELETED"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS trains (
  train_num TEXT, service_date TEXT, mode TEXT, trip_id TEXT,
  status TEXT, last_stop TEXT, arrival_delay_s INTEGER, max_delay_s INTEGER,
  first_seen BIGINT, last_seen BIGINT,
  PRIMARY KEY (train_num, service_date));
CREATE TABLE IF NOT EXISTS observations (
  train_num TEXT, service_date TEXT, observed_at BIGINT, feed_ts BIGINT,
  status TEXT, arrival_delay_s INTEGER, max_delay_s INTEGER);
CREATE INDEX IF NOT EXISTS obs_idx ON observations(train_num, service_date);
CREATE TABLE IF NOT EXISTS alerts (
  alert_id TEXT PRIMARY KEY, cause INTEGER, effect INTEGER, header_fr TEXT, description_fr TEXT,
  trains TEXT, active_start BIGINT, active_end BIGINT, first_seen BIGINT, last_seen BIGINT);
CREATE TABLE IF NOT EXISTS polls (polled_at BIGINT, feed_ts BIGINT, n_trains INTEGER, n_alerts INTEGER, error TEXT);
"""


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "delay-recorder/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        m = g.FeedMessage(); m.ParseFromString(r.read()); return m


def fr(ts):
    if not ts.translation: return ""
    for t in ts.translation:
        if t.language.lower().startswith("fr"): return t.text
    return ts.translation[0].text


def parse():
    now = int(time.time())
    tu = fetch(TU_URL); trains = {}
    for e in tu.entity:
        u = e.trip_update; t = u.trip
        m = re.match(r"OCESN(\d+)", t.trip_id)
        if not m: continue
        mode = re.search(r"_F:([A-Z]+):", t.trip_id)
        arr = [s for s in u.stop_time_update if s.HasField("arrival")]
        last = u.stop_time_update[-1] if u.stop_time_update else None
        trains[(m.group(1), t.start_date)] = dict(
            mode=mode.group(1) if mode else None, trip_id=t.trip_id,
            status=STATUS.get(t.schedule_relationship, str(t.schedule_relationship)),
            last_stop=last.stop_id if last else None,
            arr=arr[-1].arrival.delay if arr else None,
            mx=max([s.arrival.delay for s in arr] + [0]))
    sa = fetch(SA_URL); alerts = []
    for e in sa.entity:
        a = e.alert
        nums = sorted({re.match(r"OCESN(\d+)", i.trip.trip_id).group(1) for i in a.informed_entity
                       if re.match(r"OCESN(\d+)", i.trip.trip_id)})
        ap = a.active_period[0] if a.active_period else None
        alerts.append((e.id, a.cause, a.effect, fr(a.header_text), fr(a.description_text), ",".join(nums),
                       ap.start if ap else None, ap.end if ap else None, now, now))
    return now, tu.header.timestamp, trains, alerts


def store(con, now, feed_ts, trains, alerts):
    cur = con.cursor()
    cur.execute("SELECT train_num, service_date, status, arrival_delay_s FROM trains WHERE service_date = ANY(%s)",
                (list({k[1] for k in trains}),))
    prev = {(r[0], r[1]): (r[2], r[3]) for r in cur.fetchall()}
    for (num, date), v in trains.items():
        cur.execute("""INSERT INTO trains VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (train_num, service_date) DO UPDATE SET status=EXCLUDED.status, last_stop=EXCLUDED.last_stop,
              arrival_delay_s=EXCLUDED.arrival_delay_s, max_delay_s=GREATEST(trains.max_delay_s, EXCLUDED.max_delay_s),
              last_seen=EXCLUDED.last_seen""",
            (num, date, v["mode"], v["trip_id"], v["status"], v["last_stop"], v["arr"], v["mx"], now, now))
        if prev.get((num, date)) != (v["status"], v["arr"]):
            cur.execute("INSERT INTO observations VALUES (%s,%s,%s,%s,%s,%s,%s)",
                        (num, date, now, feed_ts, v["status"], v["arr"], v["mx"]))
    for a in alerts:
        cur.execute("""INSERT INTO alerts VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (alert_id) DO UPDATE SET last_seen=EXCLUDED.last_seen, trains=EXCLUDED.trains""", a)
    cur.execute("INSERT INTO polls VALUES (%s,%s,%s,%s,NULL)", (now, feed_ts, len(trains), len(alerts)))
    con.commit()


def main():
    url = os.environ.get("DATABASE_URL")
    polls = int(os.environ.get("POLLS", "2")); every = int(os.environ.get("POLL_EVERY", "120"))
    con = None
    if url:
        import psycopg
        con = psycopg.connect(url)
        con.execute(SCHEMA); con.commit()
    for i in range(polls if url else 1):
        try:
            now, feed_ts, trains, alerts = parse()
            if con: store(con, now, feed_ts, trains, alerts)
            late = sum(1 for v in trains.values() if v["mx"] >= 900)
            print(f"{datetime.datetime.now(datetime.timezone.utc):%Y-%m-%d %H:%M:%S} UTC  {len(trains)} trains ({late} >= 15 min), {len(alerts)} alertes"
                  + ("" if con else "  [test a blanc, rien enregistre]"), flush=True)
        except Exception as ex:
            print("erreur:", repr(ex), flush=True)
            if con:
                con.rollback()
                con.execute("INSERT INTO polls VALUES (%s,NULL,0,0,%s)", (int(time.time()), repr(ex)[:500])); con.commit()
        if url and i < polls - 1: time.sleep(every)


if __name__ == "__main__":
    main()
