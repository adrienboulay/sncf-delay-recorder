# SNCF delay recorder

Records the SNCF real-time feed (GTFS-RT trip updates and service alerts from transport.data.gouv.fr) every few minutes into Postgres, so a train-by-train history of delays, cancellations and alerts is kept.

- `recorder/record_sncf_cloud.py`: one run makes N polls, then writes to Postgres (`DATABASE_URL`).
- `recorder/record_sncf.py`: a local variant that writes to SQLite in a loop.
- `.github/workflows/record-sncf.yml`: runs the cloud recorder about every 5 minutes on GitHub Actions.
- `tests_phase0/`: feasibility scripts that decode the feed and simulate a station check-in from GPS coordinates.

Data source: SNCF open data (GTFS / GTFS-RT), via transport.data.gouv.fr.
