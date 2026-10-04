# signalk-passage-briefing

Offshore passage daily briefing webapp for Signal K: a plugin that plans and reviews passages for a cruising sailing vessel.

## What it does

- Simulates the passage hourly from the boat's actual position: speed from the vessel's polar, current added, ETA percentiles for the remaining route
- Recommends sail changes hour by hour from what the crew actually did, learned from the electronic logbook
- Rates every hour on the Sereno comfort scale and flags when light air in a residual swell will be worse than a gale
- Renders one unified timeline: sail work, tacks and gybes, clock changes, territorial waters, official alerts, sky events and hazards in order
- Fetches bulletins, official structured alerts, global disaster events and synoptic charts for the waters the route actually crosses
- Keeps working offline: everything fetches in the online window and survives the other 23 hours from the cache
- Shows a mini summary on the chart plotter and learns from every logbook entry the crew writes

The plugin fetches weather along the planned route — from the server's Weather API when a provider answers, Open-Meteo otherwise; fetched online, or via a GRIB/text spool when offline offshore. It runs a step-forward isochrone simulation with a monohull comfort model, learns the crew's sail preferences from the electronic logbook, and serves a two-screen webapp: a 24-hour tactical dashboard and a strategic passage summary. See [SPEC.md](SPEC.md) for the full design.

Part of the Lille Ø offshore suite, alongside [@meri-imperiumi/signalk-energy-predictor](https://github.com/meri-imperiumi/signalk-energy-predictator) and [@meri-imperiumi/signalk-logbook](https://github.com/meri-imperiumi/signalk-logbook).

## Data sources

### Signal K

- `navigation.course.activeRoute` — the route being sailed; wins over the last briefed route when the cron/oneshot fetch window opens
- `navigation.position` — vessel position for the conditions-here empty state and position-only bulletin filtering
- `network.internet.state` — connectivity gating (weather, bulletins and backfill only fetch while `online` or `metered`)
- `navigation.state`, `electrical.batteries.house.capacity.stateOfCharge` — state machine inputs (moored/anchored/sailing, publication windows)
- `polars.activePolar`, `polars.performanceFactor` — the canonical polar resource consumed for boat speed (falls back to a bundled default table)
- Resources API — route geometries and polar tables
- History API (on board) — wind/attempt snapshots for the sail-event backfill
- Published tile paths — `navigation.briefing.generatedAt` / `.route` / `.hasNew` / `.comfort` drive the plotter-extension tile (`.acknowledgedAt` is writable to clear the NEW badge)
- [signalk-logbook](https://github.com/meri-imperiumi/signalk-logbook) store — crewed sail events (reefs, sail changes) that train the preference matrix
- [signalk-ships-time](https://github.com/meri-imperiumi/signalk-ships-time) — `environment.time.timezoneOffset` / `.timezoneRegion`, the vessel's published timezone: briefing stamps render in ship's time when available (the offset rides on every stamp), falling back to UTC `Z` when nothing is published
- [signalk-watch-schedule](https://github.com/hoeken/signalk-watch-schedule) — `watch.state.onWatch`, `watch.state.startedAt`, `watch.system` and `watch.schedule`: the running watch rotation. While a watch is running, planned sail changes anchor to the previous watch handover (both teams awake) instead of sunrise/sunset; boundaries are extrapolated across the forecast horizon from the rotation cycle
- [@signalk/sailsconfiguration](https://www.npmjs.com/package/@signalk/sailsconfiguration) — sail inventory used to filter free-text noise out of log entries
- Weather API (`app.weatherApi`) — waypoint forecasts from the registered provider, the preferred source (`weather_source: auto`) whenever one answers; [signalk-weather-router-plus](https://github.com/motamman/signalk-weather-router-plus) serves it from its decoded ECMWF run, so briefing numbers match what the router planned with. That source carries combined sea only: swell/wind-sea partitions and the upper-air fields behind the convective warnings degrade to absent rather than being invented

### External

The Open-Meteo entries below are the fallback weather source: used when no Weather API provider answers (or `weather_source` is `open-meteo`), and the only source of the partition and upper-air fields the Weather API providers don't publish.

- [Open-Meteo Forecast API](https://open-meteo.com/en/docs) — surface wind, gusts, MSL pressure, CAPE and the pressure-layer fields behind the K-index (best-match model)
- [NOAA SWPC planetary K-index forecast](https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json) — geomagnetic activity behind the aurora advisories
- [JPL SBDB query API](https://ssd-api.jpl.nasa.gov/doc/sbdb_query.html) — comet brightness parameters (M1/K1) behind the Sky Notes comets
- [CelesTrak](https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle) — two-line elements for the crewed stations (ISS, Tiangong); bright satellite passes are propagated locally from the fetched TLEs with SGP4, gated to nautical night, clear sky and a 15° haze line
- [NOAA TGFTP radiofax tree](https://tgftp.nws.noaa.gov/fax/) and the [BoM difacs charts](http://www.bom.gov.au/difacs/) — synoptic surface-analysis charts per METAREA zone (work doc #11), per the schedule in [otherfax.txt](https://tgftp.nws.noaa.gov/fax/otherfax.txt)
- [UKHO Admiralty MSI API](https://msi.admiralty.co.uk/) — structured NAVAREA navigational warnings for the resolved zone; the third rung of the GMDSS bulletin fetch ladder (TGFTP raw text, WMO GMDSS portal, then UKHO MSI JSON) and also accepted verbatim as a `bulletin_urls` source
- [GDACS RSS](https://www.gdacs.org/xml/rss.xml) — EU JRC global disaster alerts (earthquakes, tropical cyclones, floods, volcanic activity), filtered route-relative by alert level and corridor distance: they ride the unified passage timeline and publish as georeferenced chart notes (work doc #22)
- [Open-Meteo Marine API](https://open-meteo.com/en/docs) — NOAA GFS-Wave 0.25° combined sea/wind sea/swell partitions, and Météo-France SMOC surface currents
- NOAA TGFTP (`tgftp.nws.noaa.gov`) — raw METAREA bulletin text for the resolved GMDSS zone's station (e.g. `FQPS01 NFFN` for XIV)
- WMO GMDSS portal (`weather.gmdss.org`) — per-zone bulletin pages, fallback when the TGFTP station is not configured
- api.weather.gov product API — US High Seas Forecast texts (default `bulletin_urls`: HSF NP/EP1/EP2); extra sources can be added via the `bulletin_urls` configuration (plain text or api.weather.gov product URLs; UKHO MSI JSON works too)

All external fetches are online-gated and cached to the plugin data directory, so the last payloads survive the offline hours.

## Pairing with Weather Router Plus

[signalk-weather-router-plus](https://github.com/motamman/signalk-weather-router-plus) plans the passage: isochrone routing against the vessel's polar on the ECMWF open-data run it keeps decoded on disk, with map overlays, tides and currents. Activate the route it publishes to the Resources API, and this plugin briefs it — `navigation.course.activeRoute` wins over the last briefed route at the next fetch window, and with `weather_source: auto` (the default) the briefing reads its forecasts from the router's Weather API provider. One forecast on board, planner and briefing in agreement: the router for planning and visualization, the briefing for the underway daily routine (comfort, sail changes, bulletins, energy).

## Pairing with Watch Schedule

[signalk-watch-schedule](https://github.com/hoeken/signalk-watch-schedule) runs the crew's watch rotation and publishes it under `watch.*`. When a watch is running, this plugin reads the schedule at app load and moves planned sail changes (reefs, canvas work) to the *previous* watch handover — the moment both teams are awake on deck — rather than sunrise/sunset; tacks and gybes stay at their tactical times, since course work can't wait for a handover. The watch boundary wins over sunlight. Without a running watch, canvas work anchors to the next sunrise/sunset. Webapp-side only: no configuration, and the briefing works unchanged when the plugin is absent.

## Acknowledgments

The comfort model and the whole idea of "what will each departure actually feel like" come from SV Sabado's [passage-weather](https://github.com/sailing12388/passage-weather) ensemble departure planner by Ray Hendricks. The Sereno comfort scale (Champagne, Easy, Coffee, Rough, Sick), the encounter-period motion math, and the ISO 2631-1 comfort bands are adapted from it for a monohull (heel and waterline-pitch resonance instead of catamaran beam-roll and bridgedeck slam).

## License

EUPL-1.2
