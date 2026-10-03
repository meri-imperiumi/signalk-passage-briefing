# Changelog

## [Unreleased]

### Added
- Celestial ephemeris engine (work doc #3 Phase 2): the sky is computed, not fetched. A new `plugin/celestial-ephemeris.js` module built on `astronomy-engine` (MIT, zero transitive dependencies — the dependency decision is made) derives planetary conjunctions and oppositions during nautical night, and meteor shower peaks (static annual calendar) gated to dark, clear, visible nights: moon set or a crescent, radiant able to clear 20° from the vessel's latitude, forecast cloud cover under 30 %. Bright station passes (ISS, Tiangong) are propagated locally from CelesTrak two-line elements with `satellite.js` (MIT — the SGP4 propagator call resolved) in `plugin/satellite-source.js`, reported when the pass peaks over 15° in nautical night under a clear enough sky. Every event passes the full tactical visibility gate the work document specifies — nautical night, altitude over 15° to clear the marine boundary-layer haze, cloud cover, moonlight — and the Phase-1 aurora alert is upgraded onto the same gate (nautical night replaces the sunset-based check; moonlit or overcast nights no longer raise aurora banners). Briefing payloads gain `celestialNights` — per-night twilight times (civil, nautical, astronomical) and moon phase/illumination — and `TimeStepForecast` gains `surface.cloudCover` (Open-Meteo `cloud_cover`; the Weather API provider publishes none and maps null, which leaves the cloud gate open).
- The timeline's night stamps show the actual moon phase instead of a fixed crescent: `mergeTimeline` picks one of the eight moon glyphs (🌑🌒🌓🌔🌕🌖🌗🌘) for each night-flagged event from the payload's `celestialNights`, falling back to ☾ for payloads that predate the field. The strategic ETA table's night-arrival markers (P10/P50/P90) get the same treatment.
- **METAREA notes now carry provenance: who published, when.** Every note the bulletin pipeline serves in `resources/notes` is stamped in its `properties` with `publishedBy` — the issuing authority parsed from the bulletin header ("ISSUED BY FIJI METEOROLOGICAL SERVICE …" → `FIJI METEOROLOGICAL SERVICE`), falling back to `signalk-passage-briefing` when the bulletin names no service (structured UKHO warnings, some NWS products) — and `publishedAt`, the bulletin's issue time. Chart plotters can show the line "Published on 10-03 12:00Z by FIJI METEOROLOGICAL SERVICE" straight from the resource; the DR webapp's note detail surface does.

## [0.4.0] - 2026-10-03

### Added

- Sail changes are scheduled when the crew can act on them:
  recommendation-driven canvas changes anchor to the *previous watch
  handover* when a watch schedule is running (signalk-watch-schedule;
  boundaries are extrapolated across the forecast horizon from the
  rotation cycle, and the watch boundary wins over sunlight),
  otherwise to the next sunrise/sunset. Several detections between
  boundaries collapse into one change carrying the last suggested
  state, no-op re-rigs are dropped, and the timeline says which
  anchor applied ("watch change" / "at dusk" / "at dawn"). Tacks and
  gybes stay at their tactical times.
- Unified passage timeline: a new `<passage-timeline>` component and
  `mergeTimeline()` view model render every event source — sail
  changes, planned tacks and gybes, convective risk, macro sea state,
  territorial waters transitions, sky events and hazard notes — as
  one chronological list with a time gutter, kind glyph and severity
  colour. The tactical dashboard renders the 24 h slice, the
  strategic outlook the whole passage; the per-type blocks (Sail
  Work, Convective Risk, Macro Sea State, Sky Notes) and the tactical
  hazard banners are replaced by it. The exception view now carries
  the whole-route hazard list in `passageSummary.hazards` (the 24 h
  `next24h.sailChanges` and `next24h.hazards` slices are gone — the
  timeline slices itself).
- Sail-change events in the timeline carry the forecast conditions
  at the change point (nearest simulated hour): true wind, sea state
  and Sereno comfort tier — "Main 1 reef — 14.2 kn TWS · Hs 1.5 m ·
  coffee" — so the crew knows what they are rigging into. The
  simulation's hourly rows now include wave height and period.
- Ship's time display: the webapp reads the vessel's published
  timezone (`environment.time.timezoneOffset` / `.timezoneRegion`, as
  served by signalk-ships-time) over the REST API and the delta
  stream, and renders briefing stamps in ship's time (`MM-DD HH:MM
  +13`) instead of UTC, falling back to UTC `Z` when no offset is
  published. The offset rides on every stamp so a zone crossing
  mid-passage reads honestly; a header pill names the zone (IANA
  region when known, else the offset).
- Weather source selection (`weather_source`: `auto` / `weather-api` /
  `open-meteo`, default `auto`): when the server has the Weather API
  and a provider answers — signalk-weather-router-plus serving its
  decoded ECMWF run — waypoint forecasts for the here and route
  briefing windows are read from it in-process (`app.weatherApi`)
  instead of Open-Meteo, so the briefing reasons from the same
  forecast the router planned with and offshore fetches stay local.
  Provider responses (Signal K units) map onto the payload
  conventions (knots, degrees true, hPa); combined sea only — swell
  and wind-sea partitions and the upper-air fields behind the
  convective warnings degrade to absent. A failed Weather API fetch
  falls back to Open-Meteo for that window; the forced choices never
  fall back.

### Changed

- Convective warnings read as episodes, not hourly spam: consecutive
  anomalies (and steep-sea anomalies alike) merge into one timeline
  event with a time range and peak values — "CAPE 713 J/kg · K 28.6 ·
  until 10-05 05:38Z". Severity follows the peak: CAPE ≥ 400 J/kg (the
  bar where weather services start coloring the index) or K-index ≥ 30
  is a red alert, while the unstable-air band below it (K ≥ 28 with
  low CAPE) still shows as an orange warning with units and sane
  precision instead of being dropped or inflated.

### Fixed

- The webapp flags stale cached briefings: when a served payload was
  compiled more than a day ago, a banner above the briefing shows the
  compile stamp and age with a Fetch now affordance, instead of
  presenting a multi-day-old timeline's `+Xh` labels as upcoming.
- The plugin re-fetches stale briefings without waiting for an edge
  trigger: the oneshot fires only when the internet state changes and
  cron windows only run while moored and charged, so a server that
  stays up for days while the machine sits in STANDBY_OFFSHORE kept
  serving a briefing sliding into the past. The one-minute ticker now
  re-fetches (trigger `stale`) when online and the cached briefing
  (active route, else last briefed, else here) is older than the
  route TTL — at most once per six hours, and only when something is
  actually cached.

- Bulletin geography now resolves named synoptic features in area
  bounds: `SOUTH OF 09S AND WEST OF CF` and `SOUTH OF 10S, BETWEEN
  150W AND CF` compose a polygon from the cold front's defining
  chain (clipped to the stated latitude bounds, closed across the
  antimeridian with a margin so western-Pacific vessels stay in
  west-of-front areas) instead of falling back to a hemisphere-wide
  box that matched every vessel south of the bound.

- Coordinate chains accept the Fiji/NFFN bulletin conventions the
  strict parser dropped: the dateline written as bare `180` (`TROUGH
  T3 12S 175E 14S 180 15S 177W`) and the equator written as `EQT`
  (`EQT 177E`). Prose numbers (`280600 UTC`, `20 TO 30 KNOTS`) are
  still rejected, and a rejected span no longer swallows a following
  coordinate pair.

## [0.3.0] - 2026-09-28

### Added

- ETA percentile rows in the strategic outlook flag night arrivals
  with a moon marker: arrival day/night is computed at the
  destination for each of P10/P50/P90.

- "No sails" stretches now say why the canvas is down: `No sails -
  drifting` when the plan drifts below the motoring wind threshold,
  `Motoring` when the engine pushes — reconciling the sail-work
  queue with a zero engine-hours plan (drift mode).

### Changed

- Strategic outlook layout: motor hours and fuel use the shared
  stat styling, and the sail-work queue renders as cards (tack/gybe
  highlighted) like the tactical action queue.

- "Warnings On Your Waters" and the synoptic surface-analysis chart
  now also appear on the tactical dashboard, not just the strategic
  view; the chart's night palette follows the document mode via its
  own observation (it previously never inverted when embedded).
  Shared card/stat styles moved into the common shadow-DOM base
  stylesheet.

- Sail-change events no longer flap when the forecast sits on a
  matrix bin edge: a suggested state must hold through a full
  simulation step before it enters the sail-work queue.

- Fuel is handled in liters end to end (SI — no imperial units):
  the motor burn rate is configurable as `Motor Fuel Consumption
  (liters per hour)` with a 1.8 l/h default, and the strategic ETA
  table shows e.g. `72.0 l` instead of gallons.

- The tactical "Next 24 Hours" hero readout is labeled `AWS` and
  shows its unit: `AWS 17.0 kn` instead of a bare number. (Signal K
  carries wind in SI m/s internally; the briefing displays the
  nautical kn.)

- Sail-change cards in the tactical dashboard and the sail-work
  timeline in the strategic outlook render the canonical sail-state
  keys as human-readable labels: `GENOA_1_30_FURLED_MAIN_1_REEF`
  reads "Genoa 1 30% furled + Main 1 reef", `NO_SAILS` reads "No
  sails". Unparseable keys still fall back to the raw form.

### Fixed

- A scheduled (oneshot/cron) refresh no longer fails forever when
  the last briefed route has been deleted from resources: the stale
  `last-route` pointer is removed and the refresh falls back to
  keeping conditions-here fresh. Previously every cycle died with
  `Briefing refresh failed (oneshot): Resource not found!`.

- The scheduled (oneshot/cron) route refresh no longer pulls the
  bulletin stack twice per cycle: the briefing refresh already
  fetches bulletins and synoptics for the track, so the outer
  duplicate pass is gone.

- SWPC solar-weather timestamps are UTC but carry no offset, so
  they were parsed in the server's local timezone: on a boat far
  from Greenwich the entire Kp forecast window shifted and aurora
  alerts degraded. Offsetless timestamps are now read as UTC.

- Switching the route selector between "Conditions here" and a route
  now actually swaps the view: the tactical/strategic shell is
  rebuilt for the served mode (previously the tabbed views never
  came back after visiting conditions-here, so route selection
  appeared to do nothing). Stale model data from the previous
  selection is dropped instead of flashing.

- Selecting "Conditions here" in the route picker now actually
  serves conditions-here: the briefing API treated an empty `route`
  parameter as "serve the route being sailed", so the selection
  silently returned the same route view. An explicit `?route=`
  (even empty) now selects; only a fully omitted parameter falls
  back to the active route.

- The webapp shows a loading state while a briefing loads or
  refreshes (compiles can take tens of seconds on a slow link —
  silence read as a broken app), and timed-out requests say the
  server is busy and to retry instead of surfacing the cryptic
  engine abort text. Rapid mode switching can no longer apply a
  stale response after a newer one.

## [0.2.1] - 2026-09-28

## [0.2.0] - 2026-09-28

### Fixed

- The route simulation crashed with `startTime.getTime is not a
  function` when the caller passed the payload's ISO timestamp
  string instead of a Date — simulatePassage now accepts both.

- The plotter widget HTML and JS are cache-busted with the plugin
  version, so widget updates actually reach the host's iframe —
  a stale cached copy was showing a removed Open button.

- The plotter tile drops its tap-to-open attempts entirely: the host
  sandbox blocks pop-ups AND top-frame navigation (even
  user-activated — verified on board, `allow-top-navigation-by-user-
  activation` is not set), so the only "escape" was crushing the
  webapp into the 1×1 frame. The tile is a pure mini summary; the
  full briefing opens from the host app list or a host panel, and
  the v1 open-panel request remains the spec-level fix.

- Warning notes are placed at the point of the warning area nearest
  the vessel (clamped into the bounding box, nearest vertex for
  axis lines) instead of the box center — a quarter-ocean area's
  center sits a thousand miles from the crew, outside any useful
  near-me query radius on resources/notes.
- Notes are schema-conservative (title/description/position/url/
  mimeType/properties/timestamp only) — unknown top-level fields are
  the classic resources write rejection — and provenance rides in
  `properties.sourcePlugin`. Notes write failures are logged with
  the server's reason and retried against the signalk-resources
  provider id.

- The plotter tile is now a mini summary: prominent colored comfort
  tier, route, age with a STALE marker when the briefing is past its
  window, and an `Open ↗` link (`target="_top"`) to the full webapp —
  replacing tap handling that could only ever navigate the widget's
  own 1×1 frame inside the host sandbox (pop-ups and top navigation
  are both blocked there, verified on board).

- The plotter tile received no values when its iframe connected
  after the last compile: the tile paths are now re-emitted on every
  60s cron tick (delta cost is five small values), the widget
  subscribes to the new stale/ageHours paths too, and its tap tries
  pop-up, then the parent window, then takes over its own frame —
  whatever the host sandbox permits.

- The BoM radiofax hosts stall connections from the boat outright
  (no response, fetch abort): zones 10 and 14 are parked under an
  `_unverified` map section so refreshes no longer stall on doomed
  fetches — zone 14 rides chartless until a reachable South Pacific
  product is verified against
  [otherfax.txt](https://tgftp.nws.noaa.gov/fax/otherfax.txt).
- Synoptic fetch timeout capped at 8s per candidate mirror.

- A half-migrated synoptic-source candidate-list change shipped a
  `pick.urls is not iterable` error that failed every here refresh on
  board. Consistent again, with per-candidate mirrors and loud
  failure records (zone, url, error) instead of silent drops.
- The published tile comfort tier is computed with the webapp's own
  model (`models.mjs` hereHourly) and stored on the payload, which
  the conditions-here view also reads — one implementation, one
  cached value, no drift between tile and view.
- Tile tap: when the host sandbox blocks the pop-up entirely, the
  widget navigates its own frame to the brief webapp as the final
  fallback.

- Bulletin geography parsing, corrected against a live NFFN
  bulletin: two-coordinate trough axes now parse as open lines (the
  NFFN style omits `TO` separators, so `10S 160E 12S 166E` produced
  no geometry at all and the discard rule passed the block
  unfiltered); `WITHIN 100 NAUTICAL MILES` now matches the band
  regex (only `NM` did); `SOUTH OF 10S` built its box on the wrong
  side (lat −10..90 instead of −90..−10), dropping the area block
  that contained the vessel while keeping far-away bands. Wrapped
  chains unfold before band expansion. Regression test uses the live
  bulletin text.
- The SBDB comet query negotiates its field list against the live
  endpoint (the documented `r` field is rejected for `sb-kind=c`);
  when current distances are unavailable the parse falls back to a
  perihelion-brightness estimate, labelled as such in Sky Notes.

- The forecast request listed `precipitable_water`, which Open-Meteo
  rejects (`400 Cannot initialize ... Variable`) — every forecast
  fetch failed with it, so nothing ever cached on board. Removed;
  the upper-air fields (CAPE, K-index, RH/wind at pressure levels)
  are unaffected. Doc #3 Phase 2's precipitable-water sky gate needs
  a different source when Phase 2 lands.
- `GET /api/briefing` returns `200` with an empty payload
  (`{mode, payload: null, cached: false}`) when nothing is cached
  instead of a 404, so the webapp renders its refresh strip rather
  than logging a failed request.

- The webapp's "Fetch now" button sent a GET to the POST-only
  `/api/briefing/refresh` route (fetchJson had no method option), so
  the button 404ed against a real server; it now issues a POST.

- On-board first-run issues: the webapp now fetches its REST API from
  the absolute `/plugins/signalk-passage-briefing/api` mount (SK v2
  serves the webapp itself under `/@<scope>/<name>/`, where the old
  relative `api/…` base resolved against the wrong root and every
  route 404ed — same mount as the energy-predictor webapp on this
  server); refresh failures land in the plugin *error* state instead
  of the status line; and failed internet fetches now include the
  response body (e.g. Open-Meteo's `reason`) in the error so the
  status says why, not just which URL returned which code.

### Added

- `GET /api/brief-meta` serves the current tile view (comfort tier,
  route, generatedAt, staleness, age hours, hasNew) — the plotter
  widget pulls it on connect so the mini summary is populated right
  away instead of waiting for the next delta emission.

- The plugin registers as the server's `notes` resource provider
  (there is none by default on SK v2, so writes were failing and
  queries returned nothing). The provider is read-only and serves
  only the metarea warnings the bulletin pipeline publishes — other
  clients' notes belong to their own future providers — with
  position/distance/bbox/limit query filtering per the resources
  query docs, durable in the plugin data dir. The publisher writes
  into the store directly and prunes expired warnings.
- METAREA warnings as Signal K Notes (work doc #12): after each
  bulletin filter pass the placeable blocks are published as
  georeferenced `resources/notes` — title from the first sentence,
  verbatim description, representative position (antimeridian-safe),
  category/subject/zone/source properties, timestamp from the
  bulletin. Notes link the cached synoptic chart when one exists for
  the zone. Ids are content-addressed (republish updates in place),
  blocks that drop out of the filtered set have their notes deleted,
  start re-syncs manifest vs server, and a
  `publish_metarea_notes` toggle (default on) clears owned notes
  when disabled. Publishing is local-only, never internet-gated.

- Status Tiles integration (work doc #13): the tile paths gain
  `navigation.briefing.stale` (boolean freshness verdict — 3h here,
  26h for route briefings — recomputed on every emission) and
  `navigation.briefing.ageHours`; the ticker re-emits the tile paths
  every 5th tick so widgets connecting after the last compile still
  receive values. A read-only `statusTileExamples` resource provider
  ships a copyable Comfort tile (tier colors, amber on stale,
  Age/Route footer).
- The conditions-here view renders warnings, the synoptic chart and
  the celestial-events card as siblings instead of cards nested
  inside the conditions card.
- Plotter tile tap: pop-up first, then navigate the widget frame
  itself — the host sandbox blocks pop-ups, and the probe-then-open
  dance only added failure modes.

- Zone 14 synoptic chart repointed to the BoM difacs web host
  (www.bom.gov.au/difacs/IDX0032/IDX0532.gif) after the anon FTP
  hosts proved unreachable from the boat; GIF charts are cached and
  served as-is (browsers render them natively), so the omggif
  decoder is not needed and was removed again. TIFF charts still
  convert to grayscale PNG via the vendored UTIF.

- Styling pass per the house UI spec: shadow-DOM components carried
  no panel styling (document-level visuals.css cannot pierce a
  shadow root), so the webapp rendered as unstyled text. A shared
  `sk-base-css.js` subset — panels with 2px corner brackets, theme
  tints, tracked uppercase headings, hardware buttons/selects/inputs
  with 48px touch targets, data tables, consoles — now precedes every
  component's own styles. Palette custom properties still inherit
  from the host page for day/night reactivity.

- The plotter tile shows the current comfort tier:
  `navigation.briefing.comfort` is published alongside the other tile
  paths, computed at compile time from the payload's first forecast
  step through the Sereno comfort model at SOG 0 (same math as the
  conditions-here view), seeded from the cache after a restart.
- Bulletin blocks now carry the extracted `geometry` (bbox
  coordinates, polygon/axis-line rings with the WITHIN-nm buffer)
  alongside the geometry type, and `BETWEEN 165W AND 135W` longitude
  pairs parse as area bounds — the NFFN swell statement east of a
  vessel at 174W is now correctly discarded.
- The tile's tap opens the brief webapp by probing the SK v2 app
  mount (`/@<scope>/<name>/`) before the v1 `/plugins/` mount.

- Synoptic surface-analysis chart in the strategic screen (work doc
  #11): a bundled `synoptic-map.json` maps GMDSS zone integers to
  per-agency chart URLs (NOAA TGFTP backbone, BoM radiofax for the
  Tasman/South Pacific) with 00Z/12Z time-aware selection and static
  entries; charts download on the same online-transition gate as the
  weather, convert from TIFF to compact grayscale PNG via the
  vendored pure-JS UTIF decoder plus a hand-rolled zlib PNG encoder
  (no native image dependency), cache as `synoptic-<zone>.png` with
  metadata, and skip re-downloads for the already-cached valid hour.
  `GET /api/synoptic` serves the position-zone chart; the strategic
  screen renders it in a figure that inverts for the night palette
  and stays omitted when nothing is cached. Zones without a usable
  chart (e.g. the unverified Chile source) are absent from the map
  and a logged no-op. `biome.json` added to keep the vendored decoder
  out of formatting.

- An ℹ️ next to the comfort tier (tactical dashboard and
  conditions-here) expanding an explainer for the Sereno comfort
  scale — what each tier means and the apparent-wind / vertical-motion
  lines that drop it — with the current tier highlighted. The scale
  data (`COMFORT_SCALE_INFO`) lives in the shared physics module.

- Logbook backfill controls in the webapp root (collapsed by
  default, available in every mode including conditions-here): runs
  `POST /api/backfill` (optional from/to date range) from the
  browser session and shows the learned summary. The route is
  auth-gated server-side, so the webapp session is the interface;
  the backfill report stays available as `bin/backfill-report.js`.

- Zone-targeted bulletin sources wired end to end (work doc #9): the
  NOAA TGFTP fast path now activates through a configurable
  station→zone table (`bulletin_stations`, seeded with the doc's
  FQPS01/NFFN for NAVAREA XIV) fetched before the GMDSS portal
  fallback; the UKHO Admiralty MSI JSON is fetched per resolved zone
  (`msi.admiralty.co.uk/api/Warnings/Area/{zone}`), stored raw and
  parsed tolerantly (`parseUkhoWarnings` — canonical shape
  fixture-tested, response shape and `[lat, lon]` coordinate order
  need one on-board verification) into structured blocks that skip
  the regex pipeline entirely. `/api/bulletin` and the payload
  `metareaBulletin` now merge track-filtered blocks from the newest
  cached entries across ingestion paths (text and structured),
  deduped by text. `/api/bulletin/refresh` performs the zone-targeted
  pull against the vessel position before the configured extra feeds.

- Plotter-extension brief tile (work doc #8): the plugin registers a
  read-only `plotterExtensions` resource provider (API v1 manifest,
  1x1 iframe widget, `whileEnabled`) and serves the widget assets
  from a public, non-admin-gated `/plotterext/<id>/` prefix (minimal
  static handler, traversal-guarded). The plugin publishes
  `navigation.briefing.generatedAt` / `.route` / `.hasNew` flat
  paths over the Signal K stream — the tile is bus-only — seeded
  from the cache after a restart; a `signalk.put` to
  `navigation.briefing.acknowledgedAt` (persisted across restarts)
  clears the NEW badge. The widget state machine lives in the pure
  `brief-ext-model.js` (muted / available / new with age string);
  tap opens the brief webapp in a new browser context (documented
  fallback until the v1 widget→host open-panel request is settled);
  long-press asks the host for config/remove; night mode supported
  when offered. `signalk-plotterext-bus` 0.11.0 dist is vendored
  under `public/vendor/plotterext-bus/` (MIT), same policy as the
  dead-reckoning plugin. The webapp gains an `?embed=1` compact
  chrome (header hidden) for plotter dialogs.

- Celestial & space weather, Phase 1 (work doc #3):
  `plugin/celestial-source.js` fetches the NOAA SWPC planetary
  K-index forecast and the JPL Small-Body Database comet query during
  the internet window and attaches coarse-gated `spaceEvents` to both
  briefing payloads (route departure position and here). Aurora
  alerts require a predicted Kp ≥ 5, a magnetic latitude equatorward
  reach matching the Kp (dipole approximation, ~65° at Kp 5 down to
  ~45° at Kp 9), and local night at the vessel — "Aurora possible:
  Kp 7 predicted tonight. Look south." Naked-eye comets (apparent
  magnitude from M1/K1/r/Δ brighter than 6.0) surface as strategic
  sky notes. Each source degrades independently; blocked hosts cost
  nothing. Tactical banners and a strategic "Sky Notes" block render
  them; the conditions-here view lists them in its events block.

- Planned tacks & gybes (work doc #5): the simulation records per-step
  heading, wind direction and distance made good, and a pure
  `tack-gybe.js` module classifies signed-TWA crossings between
  established wind sides — through the bow as tacks, through the
  stern as gybes — with a 25° wobble guard and interpolated crossing
  position, distance and ETA. Maneuvers merge into the sail-event
  queue (time-sorted), ride the tactical sail-action cards ("Tack to
  starboard ~14:20, 12 kt"), and surface as a whole-route "Sail
  Work" timeline in the strategic outlook. Motoring and drift legs
  are never maneuvers.

- Empty-state conditions view (work doc #7): with no active or
  explicitly requested route, `/api/briefing` serves a **here
  payload** — the UnifiedWeatherPayload shape with a single waypoint
  at the vessel's position and 24 forward hourly steps, cached as
  `weather/here.json` with a 3 h staleness flag. The cron/oneshot
  fetch keeps it fresh while moored or anchored (`POST
  /api/briefing/refresh` without a route re-fetches it), and
  bulletin filtering runs against the position alone. The webapp
  derives the mode from the served payload: an explicit "Conditions
  here" entry in the route picker leads it whenever no route is
  being sailed, rendering the new `<conditions-here>` view (no
  tabs): position, conditions now (wind/gust/sea/current/pressure
  trend), the 24 h comfort sparkline evaluated at SOG 0 (Sereno
  apparent wind ≈ true wind at anchor), filtered warnings, and —
  once work doc #3 lands — celestial/space events.
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
