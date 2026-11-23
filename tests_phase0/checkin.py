"""Simulate a GPS check-in: position + time -> nearest station -> departing trains -> real-time delay."""
import sys, csv, math, re, datetime
from google.transit import gtfs_realtime_pb2 as g

d = sys.argv[1]; lat = float(sys.argv[2]); lon = float(sys.argv[3]); hhmm = sys.argv[4]; date = sys.argv[5]
G = d + "/gtfs/"

def dist(a, b, c, e):
    R = 6371000; p1, p2 = math.radians(a), math.radians(c)
    dp, dl = p2 - p1, math.radians(e - b)
    return 2 * R * math.asin(math.sqrt(math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2))

areas = []; points = {}
for r in csv.DictReader(open(G + "stops.txt", encoding="utf-8")):
    if r["location_type"] == "1": areas.append(r)
    else: points[r["stop_id"]] = r["parent_station"]
best = min(areas, key=lambda r: dist(lat, lon, float(r["stop_lat"]), float(r["stop_lon"])))
dm = dist(lat, lon, float(best["stop_lat"]), float(best["stop_lon"]))
print(f"Gare la plus proche: {best['stop_name']} ({best['stop_id']}) a {dm:.0f} m")
my_points = {p for p, par in points.items() if par == best["stop_id"]}

services = {r["service_id"] for r in csv.DictReader(open(G + "calendar_dates.txt")) if r["date"] == date and r["exception_type"] == "1"}
trips = {}
for r in csv.DictReader(open(G + "trips.txt", encoding="utf-8")):
    if r["service_id"] in services: trips[r["trip_id"]] = r
routes = {r["route_id"]: r for r in csv.DictReader(open(G + "routes.txt", encoding="utf-8"))}

h, m = map(int, hhmm.split(":")); now = h*60 + m
deps = []
for r in csv.DictReader(open(G + "stop_times.txt", encoding="utf-8")):
    if r["stop_id"] in my_points and r["trip_id"] in trips and r["departure_time"]:
        hh, mm, _ = map(int, r["departure_time"].split(":")); t = hh*60 + mm
        if now - 20 <= t <= now + 60: deps.append((t, r["trip_id"], r["departure_time"]))
deps.sort()

rt = g.FeedMessage(); rt.ParseFromString(open(d + "/sncf-gtfs-rt-trip-updates.pb", "rb").read())
rtmap = {}
for e in rt.entity:
    tu = e.trip_update
    num = re.match(r"OCESN(\d+)", tu.trip.trip_id)
    key = (num.group(1) if num else None, tu.trip.start_date)
    rtmap[key] = tu
print(f"Departs entre {hhmm}-20min et +60min le {date}: {len(deps)}")
for t, tid, dep in deps[:15]:
    num = re.match(r"OCESN(\d+)", tid).group(1)
    mode = re.search(r"_F:([A-Z]+):", tid); mode = mode.group(1) if mode else "?"
    route = routes.get(trips[tid]["route_id"], {})
    tu = rtmap.get((num, date)); info = "pas de donnee temps reel (a l'heure ou hors flux)"
    if tu:
        if tu.trip.schedule_relationship == 3: info = "SUPPRIME"
        else:
            dl = [s.arrival.delay for s in tu.stop_time_update if s.HasField("arrival")]
            info = f"retard a l'arrivee: {(dl[-1] if dl else 0)//60} min"
    print(f"  {dep}  {mode:4} n°{num:7} {route.get('route_long_name','')[:40]:40} -> {trips[tid]['trip_headsign']}  | {info}")
