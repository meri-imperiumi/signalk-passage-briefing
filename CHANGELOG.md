# Changelog

## Unreleased

### Added

- Plugin skeleton: Signal K lifecycle (`plugin/index.js`) with the SPEC
  §2.1 configuration schema, delta subscriptions for
  `network.internet.state`, `navigation.state` and house state of
  charge, and a one-minute cron ticker.
- Connection & navigation state machine (`plugin/state-machine.js`,
  SPEC §2.2): OFFLINE / TRIGGER_ONESHOT / STANDBY_OFFSHORE /
  PERSISTENT_CRON with edge-triggered oneshot fetches, the four UTC
  publication windows (02:15, 08:15, 14:15, 20:15) and the execution
  guard that disables cron fetching while sailing.
- SQLite engine (`plugin/sqlite-db.js`, SPEC §4.1): WAL-mode
  `node:sqlite` store with the logbook sail events, wind history cache
  and learned sail preference matrix tables, plus the SPEC §3.2/§4.2
  binning and EMA helpers. Extended beyond the SPEC schema with a
  `night` column on the sail events and matrix bins: the crew reefs
  deeper at the evening watch change than conditions alone require,
  and the day/night behaviors are learned separately.
- Sereno comfort & monohull motion physics
  (`public/sereno-physics.mjs`, SPEC §5.2): apparent wind and vertical
  acceleration comfort tiers, encounter period with the surf guard,
  heel and waterline-pitch resonance multipliers, steepness ratio and
  the learned-matrix sail suggestion lookup, plus dependency-free sun
  altitude for the day/night bucket. Shared between the browser worker
  and the server as a plain ES module.
- Logbook sail-change event source (`plugin/logbook-source.js`):
  reads `signalk-logbook`'s on-disk YAML day files, parses the
  `Sails set:` / `Sailing with` / `Motor stopped, sailing with` /
  `Sails down` entries (including manually edited ones) into
  REEF_INCREASE / REEF_DECREASE / SAIL_CHANGE events with per-entry
  wind and position, filtering free-text noise against the
  `@signalk/sailsconfiguration` inventory when available. This module
  is the swap point for the coming logbook Resource API.
- Sail preference backfill (`plugin/history-backfill.js`, SPEC §4.2):
  wind window statistics (TWS avg/peak, circular-mean TWA) from
  either the logbook's own wind snapshots (default, works ashore) or
  the Signal K History API (for the on-board run), cached and folded
  into the learned matrix with the α = 0.2 EMA; idempotent via the
  wind history cache. REST routes `GET /api/matrix`,
  `GET /api/events`, `GET /api/logbook-events` and
  `POST /api/backfill`.
- Backfill report CLI (`bin/backfill-report.js`): runs the backfill
  over a logbook store and reports the conditions per sail combination
  (day/night) next to the whole-sail wind limits from
  `@signalk/sailsconfiguration`, plus the learned matrix.
- Sail inventory reader (`plugin/sails-configuration.js`): reads the
  `@signalk/sailsconfiguration` store (m/s wind limits, reef
  configurations as remaining areas in m²) for priors and annotation.
- Fetch engine (`plugin/fetch-engine.js`, SPEC §3.1): builds the
  UnifiedWeatherPayload along route waypoints sampled evenly from the
  route geometry (great-circle interpolation). Surface wind, gusts,
  pressure, CAPE and pressure-layer fields come from the Open-Meteo
  forecast API (K-index computed from T850/T700/T500 + dewpoints),
  the combined sea and its wind sea/swell partitions from GFS-Wave,
  surface current from SMOC. Marine and current endpoints degrade
  gracefully; per-attempt timeouts and retry with backoff on 429/5xx.
- Payload cache: fetched briefings are persisted per route
  (`weather/latest-<route>.json` plus dated snapshots, pruned to the
  newest eight) so the boat can run ~23h offline on the last fetch
  window; REST routes `GET /api/routes`, `GET /api/briefing` (cached,
  works offline), `GET /api/cached` and `POST /api/briefing/refresh`
  (internet only, refuses while offline). Cron/oneshot triggers
  prefer the route currently being sailed
  (`navigation.course.activeRoute`, resolved the same way as in the
  dead-reckoning plugin) and fall back to the last briefed route.
- Step-forward isochrone simulation (`public/route-sim.mjs`, SPEC
  §5.1): hourly advance along the sampled route with the §5.1 speed
  decision tree (polar sailing / drift mode / motoring), current set
  and drift added to the boat vector, partial-hour arrivals, Sereno
  comfort per hour, learned sail-change suggestions anchored to the
  watch-change day/night buckets, steep-sea and convective anomaly
  detection, hazard-note alerts (polygon containment or 5 nm point
  radius) and a three-run TWS perturbation pseudo-ensemble producing
  ETA p10/p50/p90 plus the 24 h energy balance.
- Polar performance lookup (`public/polar.mjs`): consumes the
  vessel's canonical `polars` resource table (SI axes, bilinear with
  the pinch/hull-speed edge semantics shared with signalk-polar-tools)
  and the `polars.performanceFactor` derating, falling back to a
  built-in conservative monohull polar when no polar is active. REST
  route `GET /api/polar` resolves the active polar server-side.
- Simulation web worker (`public/worker.js`): runs the passage
  simulation off the main thread and replies with the result plus its
  pre-filtered exception views (next-24h blocks, passage summary).
- Two-screen webapp (SPEC §6): root `<passage-outlook>` shell with
  hash-based tabs (tactical 24h / strategic passage), route picker
  preselecting the active route, offline pill from the Signal K
  stream, and a stale-briefing strip offering a refresh when the
  link is up. `<tactical-dashboard>` shows the current comfort tier,
  the 24h `<horizon-sparkline>` (comfort-tier colors, AWS heights)
  and exception-only sail/energy/hazard alerts;
  `<strategic-outlook>` the ETA percentile table, motor plan,
  macro sea-state and convective warnings plus the METAREA bulletin
  console. Day/night reactive per `environment.mode` (throttled
  delta subscription), exponential-backoff reconnects, granular DOM
  updates only, zero dependencies. Pure view models
  (`public/components/models.mjs`) are Node-tested; `GET /api/config`
  serves the simulation-relevant plugin settings to the worker.
- Backtest & calibration CLI (`bin/backtest-cli.js` +
  `plugin/backtest.js`, SPEC §7): replays the vessel's history
  through the Sereno motion model — attitude component paths from
  the History API (`/signalk/v2/api/history/values`, same contract
  as the signalk-polar-tools replays) are reconstructed into
  measured RMS vertical acceleration per 15-minute sliding window,
  Nelder-Mead tunes (k_heel, k_pitch) on the MAE loss, and a 5×5
  predicted-vs-measured comfort confusion matrix reports the fit.
  Sea state falls back to a Pierson-Moskowitz wind-sea
  approximation when no wave history is recorded; the report JSON
  records resolution, sample and window counts.
- GMDSS bulletin filtering engine (`plugin/bulletin-engine.js`,
  work doc #4): strips ZCZC/NNNN and routing headers, filters on the
  NAVTEX B_2 subject indicator (B_1 station letter vs B_2 subject
  distinguished - `ZCZC GA14` is subject A), segments on GMDSS
  section anchors including NWS `.WARNINGS.` style, extracts
  coordinate chains and cardinal bounds into geometry (antimeridian-
  safe: seam-spanning polygons and unwrapped cardinal boxes), and
  drops blocks whose warning area does not intersect the route
  track. Axis-line warnings ("WITHIN 120NM EAST OF AXIS") expand by
  the declared band before the test.
- Zone resolution & sources (`plugin/zone-source.js` +
  `public/gmdss-zones-min.json`, work doc #9): bundled low-res
  GeoJSON zone polygons resolve the active NAVAREA/METAREA zones
  from the route (smallest-containing-polygon wins on overlap,
  routes straddling a boundary activate both zones), and only those
  zones are fetched - NOAA TGFTP raw text when the station is
  configured (NFFN for XIV), WMO GMDSS portal as fallback, UKHO MSI
  JSON URL available for NAVAREA warnings. Antimeridian routes
  (Tonga to Opua) verified end to end in tests.
- Bulletin ingestion & cache (`plugin/bulletin-source.js`): online-
  gated like the weather fetches, raw texts cached on disk
  (`weather/bulletins.json`, newest 20 kept) so warnings stay
  available through the offline hours; per-source failures skip
  without losing the rest. Extra custom feeds configurable via
  `bulletin_urls`.
- Briefing integration: the freshest cached bulletin is filtered
  against the route track and attached to the payload as
  `metareaBulletin` (with segmented `blocks`), spliced into older
  cached briefings at serve time; REST routes `GET /api/bulletin`
  and `POST /api/bulletin/refresh`.
- Strategic screen rendering: filtered warning blocks in a
  scrolling console with severe-keyword highlighting (GALE, STORM,
  SQUALL, ROUGH SEAS, ...), raw bulletin text as fallback.
- README with credits; the `yaml` runtime dependency for reading the
  logbook store.
- Smoketests for the physics, the logbook source, the backfill, the
  state machine, the SQLite store and the plugin lifecycle.
