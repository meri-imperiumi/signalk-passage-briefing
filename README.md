# signalk-passage-briefing

Offshore passage daily briefing webapp for Signal K: a plugin that plans
and reviews passages for a cruising sailing vessel.

The plugin fetches multi-model weather along the planned route (online,
or via a GRIB/text spool when offline offshore), runs a step-forward
isochrone simulation with a monohull comfort model, learns the crew's
sail preferences from the electronic logbook, and serves a two-screen
webapp: a 24-hour tactical dashboard and a strategic passage summary.
See [SPEC.md](SPEC.md) for the full design.

Part of the Lille Ø offshore suite, alongside
[@meri-imperiumi/signalk-energy-predictor](https://github.com/meri-imperiumi/signalk-energy-predictator)
and [@meri-imperiumi/signalk-logbook](https://github.com/meri-imperiumi/signalk-logbook).

## Data sources

### Signal K

- `navigation.course.activeRoute` — the route being sailed; wins over
  the last briefed route when the cron/oneshot fetch window opens
- `navigation.position` — vessel position for the conditions-here
  empty state and position-only bulletin filtering
- `network.internet.state` — connectivity gating (weather, bulletins
  and backfill only fetch while `online` or `metered`)
- `navigation.state`, `electrical.batteries.house.capacity.stateOfCharge`
  — state machine inputs (moored/anchored/sailing, publication windows)
- `polars.activePolar`, `polars.performanceFactor` — the canonical
  polar resource consumed for boat speed (falls back to a bundled
  default table)
- Resources API — route geometries and polar tables
- History API (on board) — wind/attempt snapshots for the sail-event
  backfill
- Published tile paths — `navigation.briefing.generatedAt` / `.route` /
  `.hasNew` / `.comfort` drive the plotter-extension tile
  (`.acknowledgedAt` is writable to clear the NEW badge)
- [signalk-logbook](https://github.com/meri-imperiumi/signalk-logbook)
  store — crewed sail events (reefs, sail changes) that train the
  preference matrix
- [@signalk/sailsconfiguration](https://www.npmjs.com/package/@signalk/sailsconfiguration)
  — sail inventory used to filter free-text noise out of log entries

### External

- [Open-Meteo Forecast API](https://open-meteo.com/en/docs) — surface
  wind, gusts, MSL pressure, CAPE and the pressure-layer fields behind
  the K-index (best-match model)
- [NOAA SWPC planetary K-index forecast](https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json)
  — geomagnetic activity behind the aurora advisories
- [JPL SBDB query API](https://ssd-api.jpl.nasa.gov/doc/sbdb_query.html)
  — comet brightness parameters (M1/K1) behind the Sky Notes comets
- [NOAA TGFTP radiofax tree](https://tgftp.nws.noaa.gov/fax/) and the
  [BoM radiofax service](http://ftp2.bom.gov.au/anon/gen/radio_fax/) —
  synoptic surface-analysis charts per METAREA zone (work doc #11),
  per the schedule in
  [otherfax.txt](https://tgftp.nws.noaa.gov/fax/otherfax.txt)
- [Open-Meteo Marine API](https://open-meteo.com/en/docs) —
  NOAA GFS-Wave 0.25° combined sea/wind sea/swell partitions, and
  Météo-France SMOC surface currents
- NOAA TGFTP (`tgftp.nws.noaa.gov`) — raw METAREA bulletin text for
  the resolved GMDSS zone's station (e.g. `FQPS01 NFFN` for XIV)
- WMO GMDSS portal (`weather.gmdss.org`) — per-zone bulletin pages,
  fallback when the TGFTP station is not configured
- api.weather.gov product API — US High Seas Forecast texts (default
  `bulletin_urls`: HSF NP/EP1/EP2); extra sources can be added via the
  `bulletin_urls` configuration (plain text or api.weather.gov
  product URLs; UKHO MSI JSON works too)

All external fetches are online-gated and cached to the plugin data
directory, so the last payloads survive the offline hours.

## Acknowledgments

The comfort model and the whole idea of "what will each departure
actually feel like" come from SV Sabado's
[passage-weather](https://github.com/sailing12388/passage-weather)
ensemble departure planner by Ray Hendricks. The Sereno comfort scale
(Champagne, Easy, Coffee, Rough, Sick), the encounter-period motion
math, and the ISO 2631-1 comfort bands are adapted from it for a
monohull (heel and waterline-pitch resonance instead of catamaran
beam-roll and bridgedeck slam).

## License

EUPL-1.2
