"""Charge chaque nuit les referentiels SNCF (GTFS statique) : lignes, gares, trains prevus, calendrier.

Variable : DATABASE_URL (sans elle : telecharge et affiche un resume, sans rien ecrire).
"""
import csv, io, os, sys, time, zipfile
from sncf_common import http_get, parse_trip_id, uic_of, apply_schema, bulk_upsert

GTFS_URL = "https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip"


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def to_int(x):
    try: return int(x)
    except (TypeError, ValueError): return None


def to_float(x):
    try: return float(x)
    except (TypeError, ValueError): return None


def main():
    now = int(time.time())
    z = zipfile.ZipFile(io.BytesIO(http_get(GTFS_URL, timeout=300)))
    feed_version = next(rows(z, "feed_info.txt")).get("feed_version")

    routes = [(r["route_id"], r["agency_id"], r["route_short_name"], r["route_long_name"], to_int(r["route_type"]),
               r["route_color"], now) for r in rows(z, "routes.txt")]
    stops = [(r["stop_id"], uic_of(r["stop_id"]), r["stop_name"], to_float(r["stop_lat"]), to_float(r["stop_lon"]),
              to_int(r["location_type"]), r["parent_station"] or None, now) for r in rows(z, "stops.txt")]
    trips = []
    for r in rows(z, "trips.txt"):
        p = parse_trip_id(r["trip_id"])
        trips.append((r["trip_id"], p["num"] or r["trip_headsign"], r["route_id"], r["service_id"], r["trip_headsign"],
                      to_int(r["direction_id"]), p["mode"], p["origin_uic"], p["dest_uic"], now))
    calendar = [(r["service_id"], r["date"]) for r in rows(z, "calendar_dates.txt") if r["exception_type"] == "1"]
    print(f"GTFS {feed_version}: {len(routes)} lignes, {len(stops)} arrets, {len(trips)} trains, {len(calendar)} jours de service", flush=True)

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("[test a blanc, rien enregistre]"); return
    import psycopg
    with psycopg.connect(url) as con:
        apply_schema(con)
        cur = con.cursor()
        t0 = time.time()
        bulk_upsert(cur, "ref_routes", ["route_id", "agency_id", "short_name", "long_name", "route_type", "color", "updated_at"],
                    routes, ["route_id"], {c: None for c in ["agency_id", "short_name", "long_name", "route_type", "color", "updated_at"]})
        bulk_upsert(cur, "ref_stops", ["stop_id", "uic", "name", "lat", "lon", "location_type", "parent_station", "updated_at"],
                    stops, ["stop_id"], {c: None for c in ["uic", "name", "lat", "lon", "location_type", "parent_station", "updated_at"]})
        bulk_upsert(cur, "ref_trips", ["trip_id", "train_num", "route_id", "service_id", "headsign", "direction_id", "mode",
                                       "origin_uic", "dest_uic", "updated_at"],
                    trips, ["trip_id"], {c: None for c in ["train_num", "route_id", "service_id", "headsign", "direction_id",
                                                           "mode", "origin_uic", "dest_uic", "updated_at"]})
        bulk_upsert(cur, "ref_calendar", ["service_id", "service_date"], calendar, ["service_id", "service_date"], {})
        cur.execute("INSERT INTO ref_loads VALUES (%s,%s,%s,%s,%s,%s)", (now, feed_version, len(routes), len(stops), len(trips), len(calendar)))
        con.commit()
        print(f"Charge en {time.time() - t0:.1f} s", flush=True)


if __name__ == "__main__":
    sys.exit(main())
