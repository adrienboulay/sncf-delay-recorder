"""Sonde 2 : couverture du temps reel PRIM pour RER / Transilien / metro / tram (compteurs seulement)."""
import collections, csv, io, json, os, re, statistics, datetime, zipfile
import gzip, time, urllib.request
KEY = os.environ["PRIM_API_KEY"]
BASE = "https://prim.iledefrance-mobilites.fr/marketplace"


def get(url, auth=True):
    req = urllib.request.Request(url, headers={"Accept-Encoding": "gzip", "User-Agent": "delay-recorder",
                                               **({"apikey": KEY} if auth else {})})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            raw = r.read(); status = r.status
            if r.headers.get("Content-Encoding") == "gzip": raw = gzip.decompress(raw)
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code} sur {url.split('?')[0]}"); return None
    print(f"  HTTP {status}, {len(raw)/1e6:.1f} Mo, {time.time()-t0:.1f} s  ({url.split('?')[0]})")
    return raw


def val(x):
    return x.get("value") if isinstance(x, dict) else x



GTFS = "https://data.iledefrance-mobilites.fr/explore/dataset/offre-horaires-tc-gtfs-idfm/files/a925e164271e4bca93433756d6a340d1/download/"
z = zipfile.ZipFile(io.BytesIO(get(GTFS, auth=False)))
rd = lambda n: csv.DictReader(io.TextIOWrapper(z.open(n), "utf-8-sig"))
routes = {r["route_id"].split(":")[1]: r for r in rd("routes.txt") if r["route_type"] in ("0", "1", "2", "7")}
MODE = {"0": "TRAM", "1": "METRO", "2": "TRAIN", "7": "FUNI"}
print("colonnes routes :", list(next(iter(routes.values())).keys()))
stops = list(rd("stops.txt")); print("colonnes stops :", list(stops[0].keys()), "| exemple stop_id :", stops[0]["stop_id"])
tr = list(rd("trips.txt")); print("colonnes trips :", list(tr[0].keys()))
rail = [t for t in tr if t["route_id"].split(":")[1] in routes]
print("trips ferres/tram/metro (30 jours) :", len(rail), "| exemple trip_short_name :",
      [t.get("trip_short_name") for t in rail if routes[t["route_id"].split(":")[1]]["route_type"] == "2"][:8])

d = json.loads(get(f"{BASE}/estimated-timetable?LineRef=ALL"))
jrs = [j for f in d["Siri"]["ServiceDelivery"]["EstimatedTimetableDelivery"][0]["EstimatedJourneyVersionFrame"]
       for j in f.get("EstimatedVehicleJourney", [])]
P = lambda s: datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
per = collections.defaultdict(lambda: collections.Counter()); delays = collections.defaultdict(list)
status = collections.Counter(); ex = {}
for j in jrs:
    m = re.search(r"(C\d+)", val(j["LineRef"]) or "")
    if not m or m.group(1) not in routes: continue
    r = routes[m.group(1)]; key = (MODE[r["route_type"]], r["route_short_name"])
    c = per[key]; c["courses"] += 1
    if j.get("VehicleJourneyName"): c["avec_num_train"] += 1; ex.setdefault(key, val(j["VehicleJourneyName"][0]))
    ex.setdefault(("ref",) + key, val(j["DatedVehicleJourneyRef"]))
    for call in j["EstimatedCalls"]["EstimatedCall"]:
        c["passages"] += 1
        a, e = call.get("AimedArrivalTime") or call.get("AimedDepartureTime"), call.get("ExpectedArrivalTime") or call.get("ExpectedDepartureTime")
        if a: c["avec_heure_prevue"] += 1
        if a and e: delays[key].append((P(e) - P(a)).total_seconds() / 60)
        status[call.get("DepartureStatus") or call.get("ArrivalStatus")] += 1
        ex.setdefault(("stop",) + key, val(call["StopPointRef"]))
print("statuts :", status.most_common())
print(f"{'mode':6} {'ligne':6} {'courses':>7} {'num_train':>9} {'passages':>8} {'%prevu':>6} {'ret>=5':>6} {'ret>=15':>7}  exemples")
for key in sorted(per):
    c = per[key]; dl = delays[key]
    print(f"{key[0]:6} {key[1]:6} {c['courses']:7} {c['avec_num_train']:9} {c['passages']:8} "
          f"{100*c['avec_heure_prevue']/max(1,c['passages']):5.0f}% {sum(x>=5 for x in dl):6} {sum(x>=15 for x in dl):7}  "
          f"{ex.get(key,'-')} | {ex.get(('ref',)+key,'')[:60]} | {ex.get(('stop',)+key,'')}")
missing = sorted({(MODE[r['route_type']], r['route_short_name']) for r in routes.values()} - set(per))
print("lignes ferrees/metro/tram SANS temps reel :", missing)
