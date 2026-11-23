"""Ile-de-France (PRIM) : temps reel des RER / Transilien / TER IDF / trams, passages metro, perturbations.

Appele par record_sncf_cloud.py a chaque releve. Variable : PRIM_API_KEY.
- Courses AVEC horaire prevu (trains, certains trams) -> idfm_trains, idfm_stop_updates, idfm_observations.
- Courses SANS horaire prevu (metro, trams RATP) -> passages reels reconstitues (derniere heure estimee avant que la
  rame disparaisse du flux pour cet arret), agreges par heure, arret et sens -> idfm_metro_hourly.
- Perturbations (un releve sur 5, soit toutes les 10 min) -> idfm_disruptions, idfm_disruption_lines.
Quota PRIM par defaut : 1 000 requetes/jour pour le temps reel ; un releve toutes les 2 min = 720.
"""
import datetime, gzip, hashlib, json, os, re, time, urllib.request
from zoneinfo import ZoneInfo
from sncf_common import bulk_upsert

BASE = "https://prim.iledefrance-mobilites.fr/marketplace"
PARIS = ZoneInfo("Europe/Paris")
_lines = {"at": 0, "map": {}}
# Etat en memoire (le processus tourne ~5h45) pour reconstituer les passages metro/tram :
_pending = {}    # (ligne, arret, sens, course) -> derniere heure estimee de passage
_last_pass = {}  # (ligne, arret, sens) -> heure du passage precedent (pour l'ecart entre rames)
_buckets = {}    # (ligne, arret, sens, debut d'heure) -> [n_passages, n_ecarts, somme_ecarts, ecart_max]


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


def jkey(ref):
    """Cle courte (8 octets) a partir de l'identifiant texte de la course : divise la taille des tables par ~2."""
    return int.from_bytes(hashlib.md5(ref.encode()).digest()[:8], "big", signed=True)


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
    trains, stops, seen, n = {}, [], {}, 0
    for f in frames:
        for j in f.get("EstimatedVehicleJourney", []):
            n += 1
            lid = line_id(v(j.get("LineRef")))
            if lid not in lines: continue  # bus et autres : non suivis
            calls = (j.get("EstimatedCalls") or {}).get("EstimatedCall", [])
            ref = v(j.get("DatedVehicleJourneyRef"))
            if not calls or not ref: continue
            aimed = [ts(c.get("AimedDepartureTime") or c.get("AimedArrivalTime")) for c in calls
                     if c.get("AimedDepartureTime") or c.get("AimedArrivalTime")]
            if aimed:
                sdate = datetime.datetime.fromtimestamp(min(aimed), PARIS).strftime("%Y%m%d")
                k = jkey(ref)
                mx, last_delay, last_stop, sched_arr, ncanc = 0, None, None, None, 0
                for c in calls:
                    aa, ad = ts(c.get("AimedArrivalTime")), ts(c.get("AimedDepartureTime"))
                    ea, ed = ts(c.get("ExpectedArrivalTime")), ts(c.get("ExpectedDepartureTime"))
                    da = ea - aa if ea and aa else None
                    dd = ed - ad if ed and ad else None
                    st = c.get("ArrivalStatus") or c.get("DepartureStatus")
                    if st == "CANCELLED": ncanc += 1
                    sr = stop_ref(v(c.get("StopPointRef")))
                    stops.append((k, sr, aa, ad, da, dd, st,
                                  v(c.get("ArrivalPlatformName") or c.get("DeparturePlatformName")), now))
                    mx = max(mx, da or 0, dd or 0)
                    if da is not None or dd is not None: last_delay = da if da is not None else dd
                    last_stop, sched_arr = sr, aa or ad
                status = "CANCELED" if ncanc == len(calls) else ("PARTIALLY_CANCELED" if ncanc else "SCHEDULED")
                trains[k] = (k, ref, sdate, lid, lines[lid], v(j.get("VehicleJourneyName")), v(j.get("OperatorRef")),
                             v(j.get("DestinationName")), status, last_stop,
                             last_delay, mx, len(calls), ncanc, sched_arr, now, now)
            else:  # pas d'horaire prevu (metro, trams RATP) : on suit l'heure estimee de chaque rame a chaque arret
                dref = v(j.get("DirectionRef")) or "?"
                for c in calls:
                    e = ts(c.get("ExpectedArrivalTime") or c.get("ExpectedDepartureTime"))
                    if e and (c.get("DepartureStatus") or c.get("ArrivalStatus")) != "CANCELLED":
                        seen[(lid, stop_ref(v(c.get("StopPointRef"))), dref, ref)] = e
    metro_passages(seen, now)
    stops = list({(s[0], s[1]): s for s in stops}.values())  # une ligne par (course, arret)
    return n, trains, stops, len({k[0] for k in seen})


def metro_passages(seen, now):
    """Une rame qui disparait du flux pour un arret alors qu'elle y etait imminente est passee a sa derniere heure
    estimee (precision : l'intervalle entre deux releves, 2 min)."""
    for key, e in list(_pending.items()):
        if key in seen: continue
        del _pending[key]
        if e > now + 120: continue  # disparue sans etre imminente : course modifiee ou perdue de vue
        line, stop, d, _ = key
        prev = _last_pass.get((line, stop, d)); _last_pass[(line, stop, d)] = e
        b = _buckets.setdefault((line, stop, d, e - e % 3600), [0, 0, 0, 0])
        b[0] += 1
        if prev and 0 < e - prev < 3 * 3600:
            b[1] += 1; b[2] += e - prev; b[3] = max(b[3], e - prev)
    _pending.update(seen)


def flush_metro(con, now, final=False):
    """Ecrit les compteurs accumules (appele toutes les 10 min) : ils s'ADDITIONNENT a ce qui est deja en base pour la
    meme heure, puis sont remis a zero en memoire. Les donnees apparaissent donc en base au bout de 10 min."""
    done = dict(_buckets)
    if not done: return 0
    bulk_upsert(con.cursor(), "idfm_metro_hourly",
                ["line_id", "stop_ref", "direction", "hour_ts", "n_passages", "n_gaps", "sum_gap_s", "max_gap_s"],
                [(*k, *b) for k, b in done.items()], ["line_id", "stop_ref", "direction", "hour_ts"],
                {"n_passages": "idfm_metro_hourly.n_passages + EXCLUDED.n_passages",
                 "n_gaps": "idfm_metro_hourly.n_gaps + EXCLUDED.n_gaps",
                 "sum_gap_s": "idfm_metro_hourly.sum_gap_s + EXCLUDED.sum_gap_s",
                 "max_gap_s": "GREATEST(idfm_metro_hourly.max_gap_s, EXCLUDED.max_gap_s)"})
    con.commit()
    for k in done: del _buckets[k]
    return len(done)


def store_et(con, now, trains, stops):
    cur = con.cursor()
    cur.execute("SELECT journey_key, status, arrival_delay_s FROM idfm_trains WHERE journey_key = ANY(%s)", (list(trains),))
    prev = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
    cols = ["journey_key", "journey_ref", "service_date", "line_id", "mode", "train_num", "operator", "dest_name",
            "status", "last_stop_ref", "arrival_delay_s", "max_delay_s", "n_calls", "n_cancelled", "sched_arrival_ts",
            "first_seen", "last_seen"]
    bulk_upsert(cur, "idfm_trains", cols, list(trains.values()), ["journey_key"],
                {"status": None, "last_stop_ref": None, "arrival_delay_s": None, "n_calls": None, "n_cancelled": None,
                 "last_seen": None, "sched_arrival_ts": None,
                 "max_delay_s": "GREATEST(idfm_trains.max_delay_s, EXCLUDED.max_delay_s)",
                 "train_num": "COALESCE(EXCLUDED.train_num, idfm_trains.train_num)"})
    bulk_upsert(cur, "idfm_stop_updates",
                ["journey_key", "stop_ref", "aimed_arrival_ts", "aimed_departure_ts", "arrival_delay_s",
                 "departure_delay_s", "status", "platform", "last_seen"],
                stops, ["journey_key", "stop_ref"],
                {"aimed_arrival_ts": None, "aimed_departure_ts": None, "arrival_delay_s": None,
                 "departure_delay_s": None, "status": None, "last_seen": None,
                 "platform": "COALESCE(EXCLUDED.platform, idfm_stop_updates.platform)"})
    changed = [(k, now, t[8], t[10], t[11]) for k, t in trains.items() if prev.get(k) != (t[8], t[10])]
    if changed:
        cur.executemany("INSERT INTO idfm_observations VALUES (%s,%s,%s,%s,%s)", changed)


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
        n, trains, stops, n_metro = parse_et(fetch("estimated-timetable?LineRef=ALL"), lines, now)
        store_et(con, now, trains, stops)
        nh = flush_metro(con, now) if i % 5 == 4 else 0
        nd = store_disruptions(con, now, fetch("disruptions_bulk/disruptions/v2")) if i % 5 == 0 else None
        con.execute("INSERT INTO idfm_polls VALUES (%s,%s,%s,%s,%s,NULL)",
                    (now, n, len(trains), n_metro, nd[0] if nd else None))
        con.commit()
        late = sum(1 for t in trains.values() if (t[11] or 0) >= 900)
        return (f"IDF : {len(trains)} trains/trams ({late} >= 15 min), {len(stops)} passages, "
                f"{n_metro} lignes metro/tram ({len(_pending)} rames-arrets suivis, {nh} heures ecrites), "
                f"perturbations {f'{nd[0]} ({nd[1]} liens ligne)' if nd else '-'}, {time.time() - t0:.1f} s")
    except Exception as ex:
        con.rollback()
        con.execute("INSERT INTO idfm_polls VALUES (%s,NULL,NULL,NULL,NULL,%s)", (now, repr(ex)[:500])); con.commit()
        return f"IDF erreur: {repr(ex)[:200]}"


def finish(con):
    """Fin de processus : ecrit les heures metro encore en memoire (elles s'additionneront avec l'execution suivante)."""
    try: return flush_metro(con, int(time.time()), final=True)
    except Exception as ex:
        con.rollback(); print("IDF flush erreur:", repr(ex)[:200], flush=True)
