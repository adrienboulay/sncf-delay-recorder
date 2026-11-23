# French rail delay recorder

Records real-time train data for France into Postgres every 2 minutes, so a train-by-train history of delays, cancellations and disruptions is kept. No public source publishes this history: the real-time feeds are snapshots, and only monthly averages are released.

## Sources
| Network | Source | What we get |
|---|---|---|
| SNCF national: TER, TGV INOUI, OUIGO, Intercités, Lyria, international trains | GTFS-RT trip updates and service alerts (transport.data.gouv.fr), SNCF static GTFS | Delay per train and per station, cancellations, alerts with cause and effect |
| Île-de-France: RER A–E, Transilien H–V, TER inside the region, timetabled trams (T4, T9–T14) | PRIM (Île-de-France Mobilités): "Prochains passages – requête globale" (SIRI Lite estimated timetable), IDFM GTFS | Planned and expected time at each stop, so delay per train and per station, cancellations, train number |
| Île-de-France: metro lines 1–14 and RATP trams (T1–T3, T5–T8) | Same PRIM feed | Expected times only, see below |
| Île-de-France: all modes | PRIM "Messages Info Trafic – requête globale" | Every current and planned disruption (works, incidents, closures) with severity and affected lines, every 10 minutes |

## Coverage and known limitations
- **Metro and RATP trams have no published timetable in real time, so exact delays cannot be measured.**
  - The feed gives the expected time of the next vehicles at each stop, but no planned time and no train number.
  - No open data source publishes actual metro passage times. We checked PRIM, the RATP open data portal and data.gouv.fr.
  - **Our method:** we follow each vehicle's expected time at each stop. The last expected time before the vehicle leaves the feed is recorded as its **actual passage**, accurate to the 2-minute polling interval. Passages are then aggregated per line, stop, direction and hour (`idfm_metro_hourly`: number of passages, mean and maximum gap between vehicles). This measures **regularity**, the way metro operators do, rather than delay.
  - **Inference from disruptions:** a metro or tram line with **no disruption** in the Info Trafic feed is assumed to run normally, on its planned frequency (IDFM GTFS). A line with a disruption carries its severity (`PERTURBEE`, `BLOQUANTE`) and time window. The **extra waiting time** is the measured gap minus the planned interval. This gives the same answer an application needs: was this line disrupted at this time, and by how much.
  - In short: exact delays for every train (SNCF, RER, Transilien, timetabled trams). Disruptions plus measured gaps for the metro and RATP trams.
- **On-time trains do not always appear** in the SNCF feed, which mostly reports trains about to run or delayed. Planned trains are counted from the static timetables (`ref_trips`, `ref_calendar`).
- **Foreign stations** (Switzerland, Germany, Belgium, Luxembourg, Italy, Spain) are present because they are served by SNCF international trains. This is expected.
- **Other operators** are not covered yet: for example the Marseille – Toulon – Nice regional trains run by Transdev, Trenitalia France and Eurostar.
- Polling every 2 minutes means a delay is known to within about 2 minutes.

## Storage
The free Postgres tier is limited to 500 MB, and the raw detail grows by several tens of MB per day. So:
- the database keeps the **last 2 full days in full detail** (plus the current day), plus a **permanent daily summary** per line (`daily_line_stats`: trains, cancellations, trains late by 5, 15, 30 and 60 minutes);
- every night, each finished day is exported as **compressed CSV** (about 15 to 25 times smaller) to object storage (`archive/YYYY/MM/DD/<table>.csv.gz`), and its detail is removed from the database only once the archive is confirmed (`archive_log`).

## Layout
- `recorder/record_sncf_cloud.py`: long-running recorder (one poll every 2 minutes for about 5h45, then the next run is started), SNCF and Île-de-France.
- `recorder/idfm.py`: Île-de-France module (trains, metro passage reconstruction, disruptions).
- `recorder/load_reference.py`, `recorder/load_reference_idfm.py`: nightly reference data (lines, stations, planned trains).
- `recorder/archive_prune.py`: nightly summary, archive and purge.
- `recorder/schema.sql`, `recorder/schema_idfm.sql`: tables and views.
- `recorder/report.py`: row counts and table sizes only, because Actions logs are public.
- `recorder/record_sncf.py`: local variant writing to SQLite.
- `tests_phase0/`: feasibility scripts (feed decoding, station check-in from GPS coordinates).

Required secrets: `DATABASE_URL`, `PRIM_API_KEY`, and for archiving `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

Data sources: SNCF open data (GTFS / GTFS-RT, via transport.data.gouv.fr) and Île-de-France Mobilités (PRIM), under the Licence Mobilités / ODbL.
