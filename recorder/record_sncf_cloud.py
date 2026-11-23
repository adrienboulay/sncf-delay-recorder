"""Enregistreur des retards SNCF, version cloud (GitHub Actions -> Postgres Supabase).

Tourne en boucle (un releve toutes les 2 min pendant ~5h45), puis GitHub Actions relance l'execution suivante.
A chaque releve :
  - trains        : dernier etat de chaque train (ligne, origine, destination, horaires prevus, retards depart/arrivee) ;
  - stop_updates  : retard GARE PAR GARE de chaque train, arrets supprimes ;
  - observations  : une ligne a chaque changement de retard ou de statut (historique fin) ;
  - alerts (+ alert_trains) : perturbations, cause, effet, trains / lignes / gares concernes.

Variables : DATABASE_URL, RUN_FOR (s, 0 = mode POLLS), POLLS (defaut 2), POLL_EVERY (defaut 120 s), LOCK_WAIT (s).
Sans DATABASE_URL : un releve a blanc avec resume (pour tester).
"""
import datetime, os, time
from google.transit import gtfs_realtime_pb2 as g
import idfm
from sncf_common import http_get, parse_trip_id, uic_of, apply_schema, bulk_upsert

TU_URL = "https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-trip-updates"
SA_URL = "https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-service-alerts"
STATUS = {0: "SCHEDULED", 1: "ADDED", 2: "UNSCHEDULED", 3: "CANCELED", 5: "REPLACEMENT", 6: "DUPLICATED", 7: "DELETED"}
CAUSE = {1: "UNKNOWN_CAUSE", 2: "OTHER_CAUSE", 3: "TECHNICAL_PROBLEM", 4: "STRIKE", 5: "DEMONSTRATION", 6: "ACCIDENT",
         7: "HOLIDAY", 8: "WEATHER", 9: "MAINTENANCE", 10: "CONSTRUCTION", 11: "POLICE_ACTIVITY", 12: "MEDICAL_EMERGENCY"}
EFFECT = {1: "NO_SERVICE", 2: "REDUCED_SERVICE", 3: "SIGNIFICANT_DELAYS", 4: "DETOUR", 5: "ADDITIONAL_SERVICE",
          6: "MODIFIED_SERVICE", 7: "OTHER_EFFECT", 8: "UNKNOWN_EFFECT", 9: "STOP_MOVED", 10: "NO_EFFECT",
          11: "ACCESSIBILITY_ISSUE"}


def feed(url):
    m = g.FeedMessage(); m.ParseFromString(http_get(url)); return m


def fr(ts):
    if not ts.translation: return ""
    for t in ts.translation:
        if t.language.lower().startswith("fr"): return t.text
    return ts.translation[0].text


def sched(ev):
    """heure prevue = heure estimee - retard (le flux donne les deux)."""
    return ev.time - ev.delay if ev.time else None


def parse():
    now = int(time.time())
    tu = feed(TU_URL)
    trains, stops = {}, []
    for e in tu.entity:
        u = e.trip_update; t = u.trip
        p = parse_trip_id(t.trip_id)
        if not p["num"]: continue
        key = (p["num"], t.start_date)
        sts = list(u.stop_time_update)
        arr = [s for s in sts if s.HasField("arrival")]
        dep = [s for s in sts if s.HasField("departure")]
        trains[key] = dict(
            mode=p["mode"], trip_id=t.trip_id, route_id=p["route_id"],
            origin_uic=p["origin_uic"] or (uic_of(sts[0].stop_id) if sts else None),
            dest_uic=p["dest_uic"] or (uic_of(sts[-1].stop_id) if sts else None),
            status=STATUS.get(t.schedule_relationship, str(t.schedule_relationship)),
            last_stop=sts[-1].stop_id if sts else None,
            arr=arr[-1].arrival.delay if arr else None,
            dep_delay=dep[0].departure.delay if dep else None,
            mx=max([s.arrival.delay for s in arr] + [0]),
            sched_dep=sched(dep[0].departure) if dep else None,
            sched_arr=sched(arr[-1].arrival) if arr else None,
            n_stops=len(sts), n_skipped=sum(1 for s in sts if s.schedule_relationship == 1))
        for i, s in enumerate(sts):
            stops.append((p["num"], t.start_date, i, s.stop_id, uic_of(s.stop_id),
                          sched(s.arrival) if s.HasField("arrival") else None,
                          sched(s.departure) if s.HasField("departure") else None,
                          s.arrival.delay if s.HasField("arrival") else None,
                          s.departure.delay if s.HasField("departure") else None,
                          s.schedule_relationship == 1, now))
    sa = feed(SA_URL)
    alerts, links = {}, set()
    for e in sa.entity:
        a = e.alert
        nums, routes, uics = set(), set(), set()
        for ie in a.informed_entity:
            if ie.trip.trip_id:
                p = parse_trip_id(ie.trip.trip_id)
                if p["num"]:
                    nums.add(p["num"]); links.add((e.id, p["num"], ie.trip.start_date or ""))
                if p["route_id"]: routes.add(p["route_id"])
            if ie.route_id: routes.add(ie.route_id)
            if ie.stop_id and uic_of(ie.stop_id): uics.add(uic_of(ie.stop_id))
        ap = a.active_period[0] if a.active_period else None
        alerts[e.id] = (e.id, a.cause, a.effect, fr(a.header_text), fr(a.description_text), ",".join(sorted(nums)),
                        ap.start if ap else None, ap.end if ap else None, now, now,
                        CAUSE.get(a.cause), EFFECT.get(a.effect), ",".join(sorted(routes)), ",".join(sorted(uics)))
    return now, tu.header.timestamp, trains, stops, list(alerts.values()), list(links)


def store(con, now, feed_ts, trains, stops, alerts, links):
    cur = con.cursor()
    cur.execute("SELECT train_num, service_date, status, arrival_delay_s FROM trains WHERE service_date = ANY(%s)",
                (list({k[1] for k in trains}),))
    prev = {(r[0], r[1]): (r[2], r[3]) for r in cur.fetchall()}
    tcols = ["train_num", "service_date", "mode", "trip_id", "status", "last_stop", "arrival_delay_s", "max_delay_s",
             "first_seen", "last_seen", "route_id", "origin_uic", "dest_uic", "sched_departure_ts", "sched_arrival_ts",
             "departure_delay_s", "n_stops", "n_skipped_stops"]
    bulk_upsert(cur, "trains", tcols,
                [(n, d, v["mode"], v["trip_id"], v["status"], v["last_stop"], v["arr"], v["mx"], now, now, v["route_id"],
                  v["origin_uic"], v["dest_uic"], v["sched_dep"], v["sched_arr"], v["dep_delay"], v["n_stops"], v["n_skipped"])
                 for (n, d), v in trains.items()],
                ["train_num", "service_date"],
                {"status": None, "last_stop": None, "arrival_delay_s": None, "last_seen": None,
                 "max_delay_s": "GREATEST(trains.max_delay_s, EXCLUDED.max_delay_s)",
                 "mode": "COALESCE(EXCLUDED.mode, trains.mode)", "trip_id": None,
                 "route_id": "COALESCE(EXCLUDED.route_id, trains.route_id)",
                 "origin_uic": "COALESCE(trains.origin_uic, EXCLUDED.origin_uic)",
                 "dest_uic": "COALESCE(trains.dest_uic, EXCLUDED.dest_uic)",
                 "sched_departure_ts": "COALESCE(trains.sched_departure_ts, EXCLUDED.sched_departure_ts)",
                 "sched_arrival_ts": "COALESCE(trains.sched_arrival_ts, EXCLUDED.sched_arrival_ts)",
                 "departure_delay_s": None, "n_stops": None, "n_skipped_stops": None})
    bulk_upsert(cur, "stop_updates",
                ["train_num", "service_date", "stop_index", "stop_id", "uic", "sched_arrival_ts", "sched_departure_ts",
                 "arrival_delay_s", "departure_delay_s", "skipped", "last_seen"],
                stops, ["train_num", "service_date", "stop_id"],
                {"stop_index": None, "arrival_delay_s": None, "departure_delay_s": None, "skipped": None, "last_seen": None,
                 "sched_arrival_ts": "COALESCE(stop_updates.sched_arrival_ts, EXCLUDED.sched_arrival_ts)",
                 "sched_departure_ts": "COALESCE(stop_updates.sched_departure_ts, EXCLUDED.sched_departure_ts)"})
    changed = [(n, d, now, feed_ts, v["status"], v["arr"], v["mx"])
               for (n, d), v in trains.items() if prev.get((n, d)) != (v["status"], v["arr"])]
    if changed:
        cur.executemany("INSERT INTO observations VALUES (%s,%s,%s,%s,%s,%s,%s)", changed)
    bulk_upsert(cur, "alerts", ["alert_id", "cause", "effect", "header_fr", "description_fr", "trains", "active_start",
                                "active_end", "first_seen", "last_seen", "cause_label", "effect_label", "route_ids", "stop_uics"],
                alerts, ["alert_id"],
                {"last_seen": None, "trains": None, "header_fr": None, "description_fr": None, "active_end": None,
                 "cause_label": None, "effect_label": None, "route_ids": None, "stop_uics": None})
    bulk_upsert(cur, "alert_trains", ["alert_id", "train_num", "service_date"], links,
                ["alert_id", "train_num", "service_date"], {})
    cur.execute("INSERT INTO polls VALUES (%s,%s,%s,%s,NULL)", (now, feed_ts, len(trains), len(alerts)))
    con.commit()


LOCK_ID = 87_000_001  # verrou Postgres : un seul enregistreur actif a la fois


def connect(url):
    import psycopg
    con = psycopg.connect(url, keepalives=1, keepalives_idle=30)
    apply_schema(con)
    return con


def take_lock(con, wait):
    """Prend le verrou (attend jusqu'a `wait` s, le temps que l'execution precedente se termine)."""
    deadline = time.time() + wait
    while True:
        if con.execute("SELECT pg_try_advisory_lock(%s)", (LOCK_ID,)).fetchone()[0]:
            con.commit(); return True
        con.commit()
        if time.time() >= deadline: return False
        time.sleep(15)


def poll_once(con):
    t0 = time.time()
    now, feed_ts, trains, stops, alerts, links = parse()
    if con: store(con, now, feed_ts, trains, stops, alerts, links)
    late = sum(1 for v in trains.values() if v["mx"] >= 900)
    print(f"{datetime.datetime.now(datetime.timezone.utc):%Y-%m-%d %H:%M:%S} UTC  {len(trains)} trains ({late} >= 15 min), "
          f"{len(stops)} passages en gare, {len(alerts)} alertes, {time.time() - t0:.1f} s"
          + ("" if con else "  [test a blanc, rien enregistre]"), flush=True)


def main():
    """RUN_FOR > 0 : releves en boucle toutes les POLL_EVERY s pendant RUN_FOR s (mode GitHub Actions longue duree).
    Sinon : POLLS releves. LOCK_WAIT : combien de temps attendre le verrou (0 = abandonner tout de suite)."""
    url = os.environ.get("DATABASE_URL")
    every = int(os.environ.get("POLL_EVERY", "120"))
    run_for = int(os.environ.get("RUN_FOR", "0"))
    polls = int(os.environ.get("POLLS", "2"))
    if not url:
        poll_once(None); return
    con = connect(url)
    if not take_lock(con, int(os.environ.get("LOCK_WAIT", "0"))):
        print("un autre enregistreur tourne deja : rien a faire", flush=True); return
    stop_at = time.time() + run_for if run_for > 0 else None
    i, next_at = 0, time.time()
    while True:
        try:
            poll_once(con)
        except Exception as ex:
            print("erreur:", repr(ex)[:300], flush=True)
            try:
                con.rollback()
                con.execute("INSERT INTO polls VALUES (%s,NULL,0,0,%s)", (int(time.time()), repr(ex)[:500])); con.commit()
            except Exception:  # connexion perdue : on se reconnecte et on reprend le verrou
                try: con.close()
                except Exception: pass
                try:
                    con = connect(url)
                    if not take_lock(con, 300):
                        print("verrou repris par un autre enregistreur : arret", flush=True); return
                except Exception as ex2:
                    print("reconnexion impossible:", repr(ex2)[:300], flush=True)
        try:
            msg = idfm.poll(con, i)
            if msg: print("    " + msg, flush=True)
        except Exception as ex:  # l'Ile-de-France ne doit jamais bloquer le releve SNCF
            print("    IDF erreur:", repr(ex)[:300], flush=True)
            try: con.rollback()
            except Exception: pass
        i += 1
        next_at += every
        if stop_at is None and i >= polls: break
        if stop_at is not None and next_at >= stop_at: break
        time.sleep(max(0, next_at - time.time()))
    con.close()


if __name__ == "__main__":
    main()
