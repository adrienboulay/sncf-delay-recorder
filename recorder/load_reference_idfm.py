"""Charge chaque nuit le referentiel Ile-de-France (GTFS IDFM, ~130 Mo) : lignes train/RER, metro, tram, funiculaire
et les arrets qu'elles desservent. Les bus ne sont pas charges (trop volumineux, hors perimetre).

Variable : DATABASE_URL (sans elle : affiche un resume sans rien ecrire).
"""
import csv, datetime, io, os, re, tempfile, time, urllib.request, zipfile
from zoneinfo import ZoneInfo
from sncf_common import apply_schema, bulk_upsert

GTFS_URL = ("https://data.iledefrance-mobilites.fr/explore/dataset/offre-horaires-tc-gtfs-idfm/files/"
            "a925e164271e4bca93433756d6a340d1/download/")
PARIS = ZoneInfo("Europe/Paris")
TYPES = {"0": "TRAM", "1": "METRO", "2": "TRAIN", "7": "FUNI"}
RER = {"A", "B", "C", "D", "E"}


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def ref_of(stop_id):
    """IDFM:22088 -> Q:22088 (quai) ; IDFM:monomodalStopPlace:43104 -> SP:43104 (zone d'arret, ex. une gare)."""
    m = re.match(r"IDFM:monomodalStopPlace:(\d+)$", stop_id or "")
    if m: return f"SP:{m.group(1)}"
    m = re.match(r"IDFM:(\d+)$", stop_id or "")
    return f"Q:{m.group(1)}" if m else None


def to_float(x):
    try: return float(x)
    except (TypeError, ValueError): return None


def main():
    now = int(time.time())
    with tempfile.TemporaryFile() as tmp:  # sur disque : le zip est gros
        req = urllib.request.Request(GTFS_URL, headers={"User-Agent": "delay-recorder/0.2"})
        with urllib.request.urlopen(req, timeout=300) as r:
            while chunk := r.read(1 << 20): tmp.write(chunk)
        z = zipfile.ZipFile(tmp)
        routes = {}
        for r in rows(z, "routes.txt"):
            if r["route_type"] not in TYPES: continue
            mode = TYPES[r["route_type"]]
            if mode == "TRAIN":
                mode = "RER" if r["route_short_name"] in RER else ("TER" if r["route_short_name"] == "TER" else "TRANSILIEN")
            lid = r["route_id"].split(":")[-1]
            routes[r["route_id"]] = (lid, r["route_short_name"], r["route_long_name"], mode, int(r["route_type"]),
                                     r["agency_id"], r["route_color"], now)
        trip_rows = {r["trip_id"]: r for r in rows(z, "trips.txt") if r["route_id"] in routes}
        trips = set(trip_rows)
        freq_trips = {t for t, r in trip_rows.items() if routes[r["route_id"]][4] in (0, 1)}  # metro et tram
        used, first_dep = set(), {}
        for r in rows(z, "stop_times.txt"):  # plusieurs millions de lignes, lues en flux
            t = r["trip_id"]
            if t in trips: used.add(r["stop_id"])
            if t in freq_trips and r["departure_time"]:
                h, m, _ = r["departure_time"].split(":")
                sec = int(h) * 3600 + int(m) * 60
                if sec < first_dep.get(t, 10 ** 9): first_dep[t] = sec
        allstops = {r["stop_id"]: r for r in rows(z, "stops.txt")}
        # Jours de circulation de chaque service, pour les 8 prochains jours.
        today = datetime.datetime.now(PARIS).date()
        days = [today + datetime.timedelta(days=k) for k in range(8)]
        active = {}  # service_id -> set de dates AAAAMMJJ
        if "calendar.txt" in z.namelist():
            for r in rows(z, "calendar.txt"):
                for dd in days:
                    ds = dd.strftime("%Y%m%d")
                    if r["start_date"] <= ds <= r["end_date"] and r[dd.strftime("%A").lower()] == "1":
                        active.setdefault(r["service_id"], set()).add(ds)
        wanted = {dd.strftime("%Y%m%d") for dd in days}
        for r in rows(z, "calendar_dates.txt"):
            if r["date"] in wanted:
                s = active.setdefault(r["service_id"], set())
                (s.add if r["exception_type"] == "1" else s.discard)(r["date"])
        freq = {}
        for t, sec in first_dep.items():
            r = trip_rows[t]
            for ds in active.get(r["service_id"], ()):
                d0 = datetime.datetime.strptime(ds, "%Y%m%d").date() + datetime.timedelta(days=sec // 86400)
                key = (routes[r["route_id"]][0], d0.strftime("%Y%m%d"), (sec % 86400) // 3600)
                freq[key] = freq.get(key, 0) + 1
    keep = set(used) | {allstops[s]["parent_station"] for s in used if s in allstops and allstops[s]["parent_station"]}
    stops = {}
    for sid in keep:
        s = allstops.get(sid); ref = ref_of(sid)
        if not s or not ref: continue
        stops[ref] = (ref, sid, s["stop_name"], to_float(s["stop_lat"]), to_float(s["stop_lon"]),
                      ref_of(s["parent_station"]) if s["parent_station"] else None, now)
    lines = list(routes.values())
    print(f"GTFS IDFM : {len(lines)} lignes (train/metro/tram/funi), {len(trips)} courses sur 30 jours, "
          f"{len(stops)} arrets, {len(freq)} creneaux de frequence metro/tram (8 jours) ; modes : " + ", ".join(f"{m}={sum(1 for l in lines if l[3] == m)}"
                                                       for m in sorted({l[3] for l in lines})), flush=True)
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("[test a blanc, rien enregistre]"); return
    import psycopg
    with psycopg.connect(url) as con:
        apply_schema(con)
        cur = con.cursor()
        bulk_upsert(cur, "idfm_ref_lines", ["line_id", "short_name", "long_name", "mode", "route_type", "agency", "color",
                                            "updated_at"], lines, ["line_id"],
                    {c: None for c in ["short_name", "long_name", "mode", "route_type", "agency", "color", "updated_at"]})
        bulk_upsert(cur, "idfm_ref_stops", ["stop_ref", "gtfs_stop_id", "name", "lat", "lon", "parent_ref", "updated_at"],
                    list(stops.values()), ["stop_ref"],
                    {c: None for c in ["gtfs_stop_id", "name", "lat", "lon", "parent_ref", "updated_at"]})
        bulk_upsert(cur, "idfm_planned_frequency", ["line_id", "service_date", "hour", "n_trips"],
                    [(*k, n) for k, n in freq.items()], ["line_id", "service_date", "hour"], {"n_trips": None})
        cur.execute("DELETE FROM idfm_planned_frequency WHERE service_date < %s",
                    ((today - datetime.timedelta(days=30)).strftime("%Y%m%d"),))  # 30 jours d'historique suffisent
        con.commit()
    print("referentiel IDFM charge", flush=True)


if __name__ == "__main__":
    main()
