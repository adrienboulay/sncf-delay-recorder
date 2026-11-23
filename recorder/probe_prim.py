"""Sonde PRIM (Ile-de-France Mobilites) : verifie l'acces et decrit les donnees, sans rien enregistrer.
N'affiche que des compteurs et des noms de champs (les journaux GitHub Actions sont publics). Variable : PRIM_API_KEY."""
import collections, csv, gzip, io, json, os, time, urllib.request, zipfile

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


def keys_tree(o, depth=0, maxd=3):
    if depth > maxd: return
    if isinstance(o, list) and o: keys_tree(o[0], depth, maxd)
    elif isinstance(o, dict):
        for k, v in o.items():
            print("    " + "  " * depth + k + (" []" if isinstance(v, list) else ""))
            keys_tree(v, depth + 1, maxd)


def val(x):
    return x.get("value") if isinstance(x, dict) else x


print("== 1. Prochains passages, requete globale (estimated-timetable)")
raw = get(f"{BASE}/estimated-timetable?LineRef=ALL")
if raw:
    d = json.loads(raw)
    frames = d["Siri"]["ServiceDelivery"]["EstimatedTimetableDelivery"][0].get("EstimatedJourneyVersionFrame", [])
    jrs = [j for f in frames for j in f.get("EstimatedVehicleJourney", [])]
    print(f"  {len(jrs)} courses")
    print("  structure d'une course :"); keys_tree(jrs[0] if jrs else {}, maxd=2)
    lines = collections.Counter(val(j.get("LineRef")) for j in jrs)
    print(f"  {len(lines)} lignes ; les 15 plus presentes :", lines.most_common(15))
    calls = [c for j in jrs for c in (j.get("EstimatedCalls") or {}).get("EstimatedCall", [])]
    print(f"  {len(calls)} passages ; champs :", collections.Counter(k for c in calls[:20000] for k in c).most_common(25))
    has = lambda k: sum(1 for c in calls if c.get(k))
    print(f"  avec heure prevue depart/arrivee : {has('AimedDepartureTime')}/{has('AimedArrivalTime')} ; "
          f"avec heure estimee : {has('ExpectedDepartureTime')}/{has('ExpectedArrivalTime')}")
    print("  champs de numero de train presents :",
          {k: sum(1 for j in jrs if j.get(k)) for k in ("VehicleJourneyName", "TrainNumbers", "DatedVehicleJourneyRef",
                                                         "FramedVehicleJourneyRef", "OperatorRef", "DirectionName")})
    open("/tmp/et.json", "wb").write(raw)

print("== 2. Messages Info Trafic, requete globale")
for path in ("disruptions_bulk/disruptions/v2", "general-message?LineRef=ALL"):
    raw = get(f"{BASE}/{path}")
    if raw:
        d = json.loads(raw); print("  cles :", list(d)[:10] if isinstance(d, dict) else type(d))
        if isinstance(d, dict) and "disruptions" in d:
            ds = d["disruptions"]; print(f"  {len(ds)} perturbations, {len(d.get('lines', []))} lignes touchees")
            print("  structure :"); keys_tree(ds[:1], maxd=1)
            print("  causes :", collections.Counter(x.get("cause") for x in ds).most_common(8))
            print("  severites :", collections.Counter(x.get("severity") for x in ds).most_common(8))

print("== 3. Horaires prevus (GTFS IDFM)")
for url in ("https://data.iledefrance-mobilites.fr/explore/dataset/offre-horaires-tc-gtfs-idfm/files/a925e164271e4bca93433756d6a340d1/download/",
            f"{BASE}/gtfs"):
    raw = get(url, auth="marketplace" in url)
    if raw and raw[:2] == b"PK":
        z = zipfile.ZipFile(io.BytesIO(raw)); print("  fichiers :", z.namelist())
        routes = list(csv.DictReader(io.TextIOWrapper(z.open("routes.txt"), "utf-8-sig")))
        print("  lignes par type (0 tram, 1 metro, 2 train/RER, 3 bus, 7 funiculaire) :",
              collections.Counter(r["route_type"] for r in routes))
        print("  exemples train/RER :", [(r["route_id"], r["route_short_name"]) for r in routes if r["route_type"] == "2"][:20])
        break
