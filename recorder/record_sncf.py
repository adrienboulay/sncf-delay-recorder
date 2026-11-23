"""Enregistreur des retards SNCF (GTFS-RT) -> base SQLite.

Toutes les 2 minutes :
  - telecharge le flux temps reel des retards et celui des alertes ;
  - garde pour chaque train (numero + date) son DERNIER etat connu (table trains) ;
  - ajoute une ligne d'historique seulement quand le retard ou le statut change (table observations) ;
  - garde chaque alerte (table alerts).
Stockage compact : quelques dizaines de Mo par jour au maximum.

Usage : python record_sncf.py [chemin_base.db] [intervalle_secondes]
Arret : Ctrl+C
"""
import re, sqlite3, sys, time, datetime, urllib.request
from google.transit import gtfs_realtime_pb2 as g

TU_URL = "https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-trip-updates"
SA_URL = "https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-service-alerts"
DB = sys.argv[1] if len(sys.argv) > 1 else "retards_sncf.db"
EVERY = int(sys.argv[2]) if len(sys.argv) > 2 else 120

SCHEMA = """
CREATE TABLE IF NOT EXISTS trains (
  train_num TEXT, service_date TEXT, mode TEXT, trip_id TEXT,
  status TEXT, last_stop TEXT, arrival_delay_s INTEGER, max_delay_s INTEGER,
  first_seen INTEGER, last_seen INTEGER,
  PRIMARY KEY (train_num, service_date));
CREATE TABLE IF NOT EXISTS observations (
  train_num TEXT, service_date TEXT, observed_at INTEGER, feed_ts INTEGER,
  status TEXT, arrival_delay_s INTEGER, max_delay_s INTEGER);
CREATE INDEX IF NOT EXISTS obs_idx ON observations(train_num, service_date);
CREATE TABLE IF NOT EXISTS alerts (
  alert_id TEXT PRIMARY KEY, cause INTEGER, effect INTEGER, header_fr TEXT, description_fr TEXT,
  trains TEXT, active_start INTEGER, active_end INTEGER, first_seen INTEGER, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS polls (polled_at INTEGER, feed_ts INTEGER, n_trains INTEGER, n_alerts INTEGER, error TEXT);
"""
STATUS = {0: "SCHEDULED", 1: "ADDED", 2: "UNSCHEDULED", 3: "CANCELED", 5: "REPLACEMENT", 6: "DUPLICATED", 7: "DELETED"}


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "delay-recorder/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        m = g.FeedMessage(); m.ParseFromString(r.read()); return m


def fr(ts):
    if not ts.translation: return ""
    for t in ts.translation:
        if t.language.lower().startswith("fr"): return t.text
    return ts.translation[0].text


def poll(con):
    now = int(time.time())
    tu = fetch(TU_URL)
    n = 0
    for e in tu.entity:
        u = e.trip_update; t = u.trip
        m = re.match(r"OCESN(\d+)", t.trip_id)
        if not m: continue
        num, date = m.group(1), t.start_date
        mode = re.search(r"_F:([A-Z]+):", t.trip_id); mode = mode.group(1) if mode else None
        status = STATUS.get(t.schedule_relationship, str(t.schedule_relationship))
        arr = [s for s in u.stop_time_update if s.HasField("arrival")]
        last = u.stop_time_update[-1] if u.stop_time_update else None
        arr_delay = arr[-1].arrival.delay if arr else None
        max_delay = max([s.arrival.delay for s in arr] + [0])
        prev = con.execute("SELECT status, arrival_delay_s FROM trains WHERE train_num=? AND service_date=?", (num, date)).fetchone()
        if prev is None:
            con.execute("INSERT INTO trains VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (num, date, mode, t.trip_id, status, last.stop_id if last else None, arr_delay, max_delay, now, now))
        else:
            con.execute("""UPDATE trains SET status=?, last_stop=?, arrival_delay_s=?, max_delay_s=MAX(max_delay_s, ?), last_seen=?
                           WHERE train_num=? AND service_date=?""",
                        (status, last.stop_id if last else None, arr_delay, max_delay, now, num, date))
        if prev is None or prev != (status, arr_delay):
            con.execute("INSERT INTO observations VALUES (?,?,?,?,?,?,?)", (num, date, now, tu.header.timestamp, status, arr_delay, max_delay))
        n += 1
    sa = fetch(SA_URL)
    for e in sa.entity:
        a = e.alert
        trains = ",".join(sorted({re.match(r"OCESN(\d+)", i.trip.trip_id).group(1) for i in a.informed_entity
                                  if re.match(r"OCESN(\d+)", i.trip.trip_id)}))
        ap = a.active_period[0] if a.active_period else None
        con.execute("""INSERT INTO alerts VALUES (?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(alert_id) DO UPDATE SET last_seen=excluded.last_seen, trains=excluded.trains""",
                    (e.id, a.cause, a.effect, fr(a.header_text), fr(a.description_text), trains,
                     ap.start if ap else None, ap.end if ap else None, now, now))
    con.execute("INSERT INTO polls VALUES (?,?,?,?,NULL)", (now, tu.header.timestamp, n, len(sa.entity)))
    con.commit()
    return n, len(sa.entity)


def main():
    con = sqlite3.connect(DB); con.executescript(SCHEMA)
    print(f"Enregistrement dans {DB} toutes les {EVERY} s. Ctrl+C pour arreter.", flush=True)
    while True:
        try:
            n, a = poll(con)
            print(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S}  {n} trains, {a} alertes", flush=True)
        except Exception as ex:  # reseau coupe, flux indisponible... on reessaie au prochain tour
            con.execute("INSERT INTO polls VALUES (?,?,?,?,?)", (int(time.time()), None, 0, 0, repr(ex)[:500])); con.commit()
            print(f"{datetime.datetime.now():%H:%M:%S}  erreur: {ex}", flush=True)
        time.sleep(EVERY)


if __name__ == "__main__":
    main()
