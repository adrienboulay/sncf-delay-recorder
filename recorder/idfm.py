"""Ile-de-France (PRIM) : temps reel des RER / Transilien / TER IDF / trams, attente metro-tram, perturbations.

Appele par record_sncf_cloud.py a chaque releve. Variable : PRIM_API_KEY.
- Courses AVEC horaire prevu (trains, certains trams) -> idfm_trains, idfm_stop_updates, idfm_observations.
- Courses SANS horaire prevu (metro, trams RATP) -> idfm_headways (attente entre deux rames, par ligne).
- Perturbations (un releve sur 5, soit toutes les 10 min) -> idfm_disruptions, idfm_disruption_lines.
Quota PRIM par defaut : 1 000 requetes/jour pour le temps reel ; un releve toutes les 2 min = 720.
"""
import datetime, gzip, json, os, re, statistics, time, urllib.request
from zoneinfo import ZoneInfo
from sncf_common import bulk_upsert

BASE = "https://prim.iledefrance-mobilites.fr/marketplace"
PARIS = ZoneInfo("Europe/Paris")
_lines = {"at": 0, "map": {}}


def fetch(path):
    req = urllib.request.Request(f"{BASE}/{path}", headers={"apikey": os.environ["PRIM_API_KEY"],
                                                            "Accept-Encoding": "gzip", "User-Agent": "delay-recorder"})
    with urllib.request.urlopen(req, timeout=90) as r:
        raw = r.read()
        return json.loads(gzip.decompress(raw) if r.headers.get("Content-Encoding") == "gzip" else raw)


def v(x):
    """SIRI Lite emballe souvent les valeurs : {"value": ...} ou [{"value": ...}]."""
    if isinstance(x, list): x = x[0] if x else None
    return x.get("value") if isinstance(x, dict) else x


def ts(s):
    return int(datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()) if s else None


def line_id(ref):
    m = re.search(r"(C\d{5})", ref or "")
    return m.group(1) if m else None


def stop_ref(ref):
    m = re.search(r"StopPoint:Q:(\d+)", ref or "")
    if m: return f"Q:{m.group(1)}"
    m = re.search(r"StopArea:SP:(\d+)", ref or "")
    return f"SP:{m.group(1)}" if m else (ref or None)


def tracked_lines(con):
    """Lignes suivies (train, metro, tram, funiculaire), relues toutes les heures depuis idfm_ref_lines."""
    if time.time() - _lines["at"] > 3600:
        _lines["map"] = dict(con.execute("SELECT line_id, mode FROM idfm_ref_lines").fetchall())
        con.commit(); _lines["at"] = time.time()
    return _lines["map"]


def parse_et(d, lines, now):
    frames = d["Siri"]["ServiceDelivery"]["EstimatedTimetableDelivery"][0].get("EstimatedJourneyVersionFrame", [])
    trains, stops, gaps_in, n = {}, [], {}, 0
    for f in frames:
        for j in f.get("EstimatedVehicleJourney", []):
            n += 1
            lid = line_id(v(j.get("LineRef")))
            if lid not in lines: continue  # bus et autres : non suivis
            calls = (j.get("EstimatedCalls") or {}).get("EstimatedCall", [])
            if not calls: continue
            ref = v(j.get("DatedVehicleJourneyRef"))
            aimed = [ts(c.get("AimedDepartureTime") or c.get("AimedArrivalTime")) for c in calls
                     if c.get("AimedDepartureTime") or c.get("AimedArrivalTime")]
            if aimed:
                sdate = datetime.datetime.fromtimestamp(min(aimed), PARIS).strftime("%Y%m%d")
                mx, last_delay, last_stop, sched_arr, ncanc = 0, None, None, None, 0
                for c in calls:
                    aa, ad = ts(c.get("AimedArrivalTime")), ts(c.get("AimedDepartureTime"))
                    ea, ed = ts(c.get("ExpectedArrivalTime")), ts(c.get("ExpectedDepartureTime"))
                    da = ea - aa if ea and aa else None
                    dd = ed - ad if ed and ad else None
                    st = c.get("ArrivalStatus") or c.get("DepartureStatus")
                    if st == "CANCELLED": ncanc += 1
                    sr = stop_ref(v(c.get("StopPointRef")))
                    stops.append((ref, sr, sdate, lid, aa, ad, da, dd, st,
                                  v(c.get("ArrivalPlatformName") or c.get("DeparturePlatformName")), now))
                    mx = max(mx, da or 0, dd or 0)
                    if da is not None or dd is not None: last_delay = da if da is not None else dd
                    last_stop, sched_arr = sr, aa or ad
                status = "CANCELED" if ncanc == len(calls) else ("PARTIALLY_CANCELED" if ncanc else "SCHEDULED")
                trains[ref] = (ref, sdate, lid, lines[lid], v(j.get("VehicleJourneyName")), v(j.get("OperatorRef")),
                               v(j.get("DestinationName")), v(j.get("DestinationRef")), status, last_stop,
                               last_delay, mx, len(calls), ncanc, sched_arr, now, now)
            else:  # pas d'horaire prevu (metro, trams RATP) : temps d'attente
                g = gaps_in.setdefault(lid, {"veh": set(), "stops": {}})
                g["veh"].add(ref)
                for c in calls:
                    e = ts(c.get("ExpectedArrivalTime") or c.get("ExpectedDepartureTime"))
                    if e and (c.get("DepartureStatus") or c.get("ArrivalStatus")) != "CANCELLED":
                        key = (stop_ref(v(c.get("StopPointRef"))), v(j.get("DirectionRef")))
                        g["stops"].setdefault(key, []).append(e)
    headways = []
    for lid, g in gaps_in.items():
        gaps, waits = [], []
        for times in g["stops"].values():
            times.sort(); waits.append(times[0] - now)
            gaps += [b - a for a, b in zip(times, times[1:])]
        headways.append((lid, now, len(g["veh"]), len(g["stops"]),
                         int(statistics.median(gaps)) if gaps else None, max(gaps) if gaps else None,
                         max(waits) if waits else None))
    stops = list({(s[0], s[1]): s for s in stops}.values())  # une ligne par (course, arret)
    return n, trains, stops, headways


def store_et(con, now, trains, stops, headways):
    cur = con.cursor()
    cur.execute("SELECT journey_ref, status, arrival_delay_s FROM idfm_trains WHERE journey_ref = ANY(%s)", (list(trains),))
    prev = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
    cols = ["journey_ref", "service_date", "line_id", "mode", "train_num", "operator", "dest_name", "dest_ref", "status",
            "last_stop_ref", "arrival_delay_s", "max_delay_s", "n_calls", "n_cancelled", "sched_arrival_ts",
            "first_seen", "last_seen"]
    bulk_upsert(cur, "idfm_trains", cols, list(trains.values()), ["journey_ref"],
                {"status": None, "last_stop_ref": None, "arrival_delay_s": None, "n_calls": None, "n_cancelled": None,
                 "last_seen": None, "sched_arrival_ts": None,
                 "max_delay_s": "GREATEST(idfm_trains.max_delay_s, EXCLUDED.max_delay_s)",
                 "train_num": "COALESCE(EXCLUDED.train_num, idfm_trains.train_num)"})
    bulk_upsert(cur, "idfm_stop_updates",
                ["journey_ref", "stop_ref", "service_date", "line_id", "aimed_arrival_ts", "aimed_departure_ts",
                 "arrival_delay_s", "departure_delay_s", "status", "platform", "last_seen"],
                stops, ["journey_ref", "stop_ref"],
                {"aimed_arrival_ts": None, "aimed_departure_ts": None, "arrival_delay_s": None,
                 "departure_delay_s": None, "status": None, "last_seen": None,
                 "platform": "COALESCE(EXCLUDED.platform, idfm_stop_updates.platform)"})
    changed = [(r, now, t[8], t[10], t[11]) for r, t in trains.items() if prev.get(r) != (t[8], t[10])]
    if changed:
        cur.executemany("INSERT INTO idfm_observations VALUES (%s,%s,%s,%s,%s)", changed)
    bulk_upsert(cur, "idfm_headways",
                ["line_id", "polled_at", "n_vehicles", "n_stops", "median_gap_s", "max_gap_s", "max_wait_s"],
                headways, ["line_id", "polled_at"], {})


def store_disruptions(con, now, d):
    rows, links = [], set()
    for x in d.get("disruptions", []):
        rows.append((x.get("id"), x.get("cause"), x.get("severity"), x.get("title"), x.get("shortMessage"),
                     x.get("message"), json.dumps(x.get("applicationPeriods") or []), x.get("lastUpdate"), now, now))
    for ln in d.get("lines", []):
        lid = line_id(ln.get("id")) or ln.get("id")
        for o in ln.get("impactedObjects") or []:
            for did in o.get("disruptionIds") or []:
                links.add((did, lid))
    cur = con.cursor()
    bulk_upsert(cur, "idfm_disruptions", ["disruption_id", "cause", "severity", "title", "short_message", "message",
                                          "periods", "last_update", "first_seen", "last_seen"], rows, ["disruption_id"],
                {c: None for c in ["cause", "severity", "title", "short_message", "message", "periods",
                                   "last_update", "last_seen"]})
    bulk_upsert(cur, "idfm_disruption_lines", ["disruption_id", "line_id"], list(links),
                ["disruption_id", "line_id"], {})
    return len(rows), len(links)


def poll(con, i):
    """Un releve IDFM. Renvoie une ligne de resume (compteurs seulement), ou None sans cle PRIM."""
    if not os.environ.get("PRIM_API_KEY"): return None
    now = int(time.time()); t0 = time.time()
    try:
        lines = tracked_lines(con)
        if not lines: return "IDF : referentiel des lignes vide (lancer load-reference)"
        n, trains, stops, headways = parse_et(fetch("estimated-timetable?LineRef=ALL"), lines, now)
        store_et(con, now, trains, stops, headways)
        nd = store_disruptions(con, now, fetch("disruptions_bulk/disruptions/v2")) if i % 5 == 0 else None
        con.execute("INSERT INTO idfm_polls VALUES (%s,%s,%s,%s,%s,NULL)",
                    (now, n, len(trains), len(headways), nd[0] if nd else None))
        con.commit()
        late = sum(1 for t in trains.values() if (t[11] or 0) >= 900)
        return (f"IDF : {len(trains)} trains/trams ({late} >= 15 min), {len(stops)} passages, "
                f"{len(headways)} lignes metro/tram, perturbations {f'{nd[0]} ({nd[1]} liens ligne)' if nd else '-'}, "
                f"{time.time() - t0:.1f} s")
    except Exception as ex:
        con.rollback()
        con.execute("INSERT INTO idfm_polls VALUES (%s,NULL,NULL,NULL,NULL,%s)", (now, repr(ex)[:500])); con.commit()
        return f"IDF erreur: {repr(ex)[:200]}"
