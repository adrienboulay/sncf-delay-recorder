import sys, collections, datetime
from google.transit import gtfs_realtime_pb2 as g

d = sys.argv[1]
tu = g.FeedMessage(); tu.ParseFromString(open(d + "/sncf-gtfs-rt-trip-updates.pb", "rb").read())
sa = g.FeedMessage(); sa.ParseFromString(open(d + "/sncf-gtfs-rt-service-alerts.pb", "rb").read())
ts = datetime.datetime.fromtimestamp(tu.header.timestamp)
print("feed timestamp:", ts, "entities:", len(tu.entity))

kinds = collections.Counter(); delays = []; cancelled = 0
for e in tu.entity:
    t = e.trip_update.trip
    if t.schedule_relationship == 3: cancelled += 1
    tid = t.trip_id
    # trip_id like OCESN860123F...; guess family from prefix
    kinds[tid[:6]] += 1
    stus = e.trip_update.stop_time_update
    if stus:
        last = stus[-1]
        d_arr = last.arrival.delay if last.HasField("arrival") else (last.departure.delay if last.HasField("departure") else None)
        maxd = max([(s.arrival.delay if s.HasField("arrival") else 0) for s in stus] + [0])
        delays.append((maxd, tid, t.start_date, len(stus), last.stop_id, d_arr))
print("cancelled trips:", cancelled)
print("trip_id prefixes:", kinds.most_common(10))
delays.sort(reverse=True)
print("trips with max delay >= 15 min:", sum(1 for x in delays if x[0] >= 900), "/", len(delays))
print("top delays (sec, trip_id, date, n_stops, last_stop, last_delay):")
for x in delays[:12]: print("  ", x)
print("sample entity:\n", tu.entity[0])
print("--- alerts:", len(sa.entity))
for e in sa.entity[:3]:
    a = e.alert
    txt = a.header_text.translation[0].text if a.header_text.translation else ""
    desc = a.description_text.translation[0].text[:200] if a.description_text.translation else ""
    print("  effect", a.effect, "cause", a.cause, "| informed:", [ (i.route_id, i.trip.trip_id, i.stop_id) for i in a.informed_entity[:2]], "|", txt, "|", desc)
