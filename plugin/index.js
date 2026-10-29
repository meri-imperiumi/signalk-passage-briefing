/**
 * Signal K Passage Briefing plugin.
 *
 * Offshore passage daily briefing: fetches multi-model weather for the
 * planned route (online or via the GRIB spool), learns sail preferences
 * from logbook history, and serves a tactical webapp with a 24h comfort
 * dashboard and a strategic passage summary.
 *
 * This module is the lifecycle manager: it owns the configuration schema,
 * the Signal K subscriptions feeding the state machine (SPEC §2.2), the
 * cron timer for the UTC publication windows, and the plugin data
 * directory wiring for the SQLite store. Fetching, backfill and the
 * webapp live in their own modules.
 *
 * @file index.js
 */

/** @typedef {import("@signalk/server-api").ServerAPI} ServerAPI */
/** @typedef {import("@signalk/server-api").Plugin} Plugin */

const { join } = require("node:path");
const { homedir } = require("node:os");
const { mkdir, readFile, unlink, writeFile } = require("node:fs/promises");
const { writeFileAtomic } = require("./fs-atomic.js");

const { PassageStateMachine } = require("./state-machine.js");
const { PassageDatabase } = require("./sqlite-db.js");
const {
  readLogbookEntries,
  readLogbookSailEvents,
} = require("./logbook-source.js");
const {
  downwindAdvisorSails,
  readSailsConfiguration,
} = require("./sails-configuration.js");
const {
  filterBulletin,
  hasSevereKeyword,
  resolveBulletinSource,
  textNearTrack,
  ukhoBlocksFromWarnings,
} = require("./bulletin-engine.js");
const {
  loadBulletinCache,
  refreshBulletins,
  ingestSpoolBulletins,
} = require("./bulletin-source.js");
const { createSpoolWatcher } = require("./spool-watcher.js");
const {
  loadSynoptic,
  loadSynopticFailure,
  refreshSynoptics,
  loadSynopticMap,
  chartUrlForZone,
} = require("./synoptic-source.js");
const {
  fetchZoneBulletins,
  parseUkhoWarnings,
  resolveZones,
  ukhoWarningsUrl,
  parseRnwHtml,
} = require("./zone-source.js");
const { fetchSpaceEvents } = require("./celestial-source.js");
const ephemeris = require("./celestial-ephemeris.js");
const { registerPlotterExtension } = require("./brief-ext.js");
const { registerStatusTileExamples } = require("./statustilesexamples.js");
const { createNotesStore, registerNotesProvider } = require("./notes-store.js");
const {
  createRegionsStore,
  registerRegionsProvider,
} = require("./regions-store.js");
const {
  clearNotes,
  clearRegions,
  publishNotes,
  publishHazardNotes,
  publishCapAlertNotes,
} = require("./notes-publisher.js");
const hazardSource = require("./hazard-source.js");
const hazardAlerts = require("./hazard-alerts.js");
const { loadHazardState, saveHazardState } = require("./hazard-state.js");
const maritimeZones = require("./maritime-zones-source.js");
const capSource = require("./cap-source.js");
const frontsSource = require("./fronts-source.js");
const landfallSource = require("./landfall-source.js");
const {
  adaptEnergyForecast,
  energyEventsFromState,
  ENERGY_FORECAST_PATH,
  ENERGY_OUTLOOK_PATHS,
} = require("./energy-source.js");
const {
  backfillSailEvents,
  createHistoryWindStats,
  createLogbookWindStats,
} = require("./history-backfill.js");
const { seaLegs } = require("./sea-legs.js");
const {
  DEFAULT_FORECAST_DAYS,
  distanceNm: distanceNmLatLon,
  listCachedRoutes,
  loadPayload,
  routeDistanceNm,
  sampleRoutePoints,
  savePayload,
} = require("./fetch-engine.js");
const { createWeatherFetcher } = require("./weather-source.js");
const { createSourceStatus } = require("./source-status.js");

/**
 * Plugin identifier (matches package name without the scope).
 */
const PLUGIN_ID = "signalk-passage-briefing";

/**
 * Signal K paths the state machine consumes.
 */
const INTERNET_STATE_PATH = "network.internet.state";
const NAVIGATION_STATE_PATH = "navigation.state";
const HOUSE_SOC_PATH = "electrical.batteries.house.capacity.stateOfCharge";

/** Live depth sounding presence gates the tsunami escalation (work
 * doc #30): a reading means the bottom is within transducer range,
 * i.e. shallow. */
const DEPTH_PATH = "environment.depth.belowSurface";

/**
 * Self path of the vessel's active route, as published by autopilot /
 * navigation apps (same source the dead-reckoning webapp consumes).
 */
const ACTIVE_ROUTE_PATH = "navigation.course.activeRoute";

/**
 * Self path of the vessel's position (here mode consumes it, and the
 * position-arrival retry below watches its deltas).
 */
const POSITION_PATH = "navigation.position";

const WATCHED_PATHS = [
  INTERNET_STATE_PATH,
  NAVIGATION_STATE_PATH,
  HOUSE_SOC_PATH,
  ACTIVE_ROUTE_PATH,
  ENERGY_FORECAST_PATH,
  DEPTH_PATH,
  ...Object.values(ENERGY_OUTLOOK_PATHS),
  POSITION_PATH,
];

/** Flat paths the plotter tile consumes (work doc #8). */
const BRIEF_GENERATED_AT_PATH = "navigation.briefing.generatedAt";
const BRIEF_ROUTE_PATH = "navigation.briefing.route";
const BRIEF_HAS_NEW_PATH = "navigation.briefing.hasNew";
const BRIEF_ACK_PATH = "navigation.briefing.acknowledgedAt";
const BRIEF_COMFORT_PATH = "navigation.briefing.comfort";
const BRIEF_STALE_PATH = "navigation.briefing.stale";
const BRIEF_AGE_HOURS_PATH = "navigation.briefing.ageHours";
/** A route briefing is overdue when the next daily edition misses
 * this line (work doc #13); here mode keeps its 3h TTL. */
const ROUTE_TTL_MS = 26 * 60 * 60 * 1000;

/**
 * Minimum spacing between automatic (edge-triggered) payload fetches
 * (work doc #34 session): every online↔metered transition fires a
 * full route+here refresh, and a satellite link that hands over a few
 * times in a window would otherwise re-pull the whole track each
 * time, on metered data. The staleness backstop covers any skipped
 * edge; the crew's explicit refreshes bypass the guard entirely.
 */
const AUTO_FETCH_DEBOUNCE_MS = 30 * 60 * 1000;

/**
 * Per-source expected refresh intervals for the source status
 * registry (work doc #23): the client flags a source as stale when
 * its last success is older than this. Weather models refresh
 * roughly twice a day, bulletin and synoptic sources publish on the
 * 00Z/12Z synoptic hours; the ephemeris is recomputed on every
 * compile.
 */
const SOURCE_REFRESH_MS = {
  weather: 6 * 60 * 60 * 1000,
  bulletin: 12 * 60 * 60 * 1000,
  chart: 12 * 60 * 60 * 1000,
  hazard: 12 * 60 * 60 * 1000,
  ephemeris: 24 * 60 * 60 * 1000,
  reentry: 12 * 60 * 60 * 1000,
  launch: 6 * 60 * 60 * 1000,
};

/**
 * How often the cron ticker checks whether a publication window is due.
 */
const CRON_TICK_INTERVAL_MS = 60 * 1000;

/**
 * Minimum spacing between staleness-backstop fetches: a failing or
 * captive-portal "online" link must not turn the ticker into a
 * retry storm.
 */
const STALE_RETRY_MS = 6 * 60 * 60 * 1000;

/**
 * Age at which a here payload is flagged stale to the webapp
 * (work doc #7): the vessel position moves, so conditions at "here"
 * go stale faster than a route briefing.
 */
const HERE_TTL_MS = 3 * 60 * 60 * 1000;

/**
 * Plugin configuration defaults (SPEC §2.1). The spool directory
 * resolves against the server user's home so no absolute path is
 * hardcoded (on the standard install this is
 * `~/.signalk/spool/passage-outlook`).
 */
const DEFAULTS = {
  motoring_tws_threshold: 3.5,
  // The engine's fallback bar: achieved speed (polar on course, or
  // VMG while beating in irons) below this and the motor comes on
  // (work doc #49)
  motoring_speed_threshold: 2,
  // Downwind-sail night policy (work doc #47 session): "break" is
  // the default — no downwind sail at night; dusk strikes the sail
  // and reefable white sails (poled out) carry the dark period, dawn
  // may re-open. "continue" — night hours keep an open deployment:
  // night flying when squall risk is low (this crew's logged
  // practice: 23–40% of their downwind hours ran after dark)
  downwind_night_policy: "break",
  drift_mode_enabled: true,
  motor_fuel_l_per_hour: 1.8,
  // 0 = follow the boat's published design.* waterline (or its LOA
  // as the coarsest stand-in) — a number here gap-fills for boats
  // that publish neither
  waterline_length_m: 0,
  // Hull description gap-fillers (work doc #56): the vessel's own
  // published design.* values win; these fill what the boat does not
  // publish (usually displacement and GM), and a number neither
  // source provides keeps the hour on the legacy motion kernel —
  // nothing is guessed.
  hull_lwl_m: 0,
  hull_beam_m: 0,
  hull_canoe_draft_m: 0,
  hull_displacement_kg: 0,
  hull_gm_m: 0,
  hull_roll_period_s: 0,
  hull_accel_point_m: 0,
  hull_type: "",
  spool_directory: join(homedir(), ".signalk", "spool", "passage-outlook"),
  k_heel: 0.35,
  k_pitch: 0.4,
  lines_of_interest_enabled: true,
  /** Departure-day variants (work doc #34): how many candidate days
   * the route switcher offers — today, +24 h, +48 h, +72 h at 4. */
  departure_days: 4,
  /** Forecast horizon for route briefings (days). The departure-day
   * variants need the horizon to reach past the *latest* candidate's
   * arrival — a +72 h variant of a week-long passage wants ~11 days.
   * Each extra day is fetched for every waypoint on every refresh. */
  forecast_days: DEFAULT_FORECAST_DAYS,
  /** Landfall estimator (work doc #6): where and when topography
   * first breaks the visual horizon along the planned course. */
  landfall_enabled: true,
  height_of_eye_m: 3,
  landfall_max_range_nm: 120,
  landfall_min_offshore_hours: 12,
  hazard_events_enabled: true,
  hazard_min_alert_level: "orange",
  hazard_radius_offroute_nm: 500,
  hazard_radius_ahead_nm: 1000,
  hazard_max_age_hours: 72,
  cap_enabled: true,
  cap_urls: [capSource.CAP_DEFAULT_URL],
  cap_min_severity: "Severe",
  departure_daylight_auto: true,
  departure_prep_hours: 1.5,
  departure_dawn_altitude_deg: -6,
  /** Eye height above the water (work doc #35): rise/set stamps in
   * the briefing's night context correct for the vessel's raised
   * horizon when set. */
  celestial_eye_height_m: 0,
  /** Reentry watch (work doc #36): Space-Track account for the TIP
   * decay predictions; the feature degrades to off without it. */
  reentry_watch_enabled: true,
  space_track_identity: "",
  space_track_password: "",
  /** Visible-launch notes (work doc #36): Launch Library 2, no
   * account needed. */
  launch_watch_enabled: true,
  /** Verified NWS High Seas Forecast feeds (METAREA XII/XV). The
   * METAREA XIV issuer (MetService) gets added as a URL once a
   * working endpoint is confirmed on board. */
  bulletin_urls: [
    "https://api.weather.gov/products/types/HSF/locations/NP",
    "https://api.weather.gov/products/types/HSF/locations/EP1",
    "https://api.weather.gov/products/types/HSF/locations/EP2",
  ],
  /** TGFTP station→zone fast path (work doc #9 §sources 3): the
   * doc's XIV example (Fiji radio re-broadcasting NAVAREA XIV) as the
   * seed; extend via configuration. */
  bulletin_stations: [{ zone: 14, header: "FQPS01", station: "NFFN" }],
  publish_metarea_notes: true,
  /** Automatic synoptic front passages from the weather provider's
   * grid caches (work doc #50). Reads local caches — no downloads —
   * and degrades to absent when the provider has nothing usable. */
  fronts_enabled: true,
  /** Override for the provider's cache root; empty uses the
   * default location beside this plugin's data directory. */
  fronts_cache_root: "",
  /** Weather source selection (work doc #16): the server's Weather
   * API when a provider answers (signalk-weather-router-plus),
   * Open-Meteo otherwise. */
  weather_source: "auto",
};

/**
 * @param {ServerAPI} app - Signal K server API
 * @returns {Plugin}
 */
module.exports = (app) => {
  const setStatus = (app.setPluginStatus || app.setProviderStatus)?.bind(app);
  // Failures belong in the plugin error state (SK surfaces it
  // distinctly), not the status line
  const setError = (app.setPluginError || app.error)?.bind(app);
  const unsubscribes = [];

  /** @type {PassageStateMachine|null} */
  let stateMachine = null;
  /** @type {PassageDatabase|null} */
  let db = null;
  /** Bulletin source URLs (from configuration). */
  let bulletinUrls = DEFAULTS.bulletin_urls;
  /** TGFTP station→zone table (from configuration). */
  let bulletinStations = DEFAULTS.bulletin_stations;
  /** Spool directory (from configuration): where the on-board HF
   * gateway drops bulletin text files for offline ingestion. */
  let spoolDirectory = DEFAULTS.spool_directory;
  /** GDACS hazard event config (work doc #22). */
  let hazardEventsEnabled = DEFAULTS.hazard_events_enabled;
  /** CAP source config (work doc #24). */
  let capEnabled = DEFAULTS.cap_enabled;
  let capUrls = DEFAULTS.cap_urls;
  let capMinSeverity = DEFAULTS.cap_min_severity;
  /** Automatic front passages (work doc #50). */
  let frontsEnabled = DEFAULTS.fronts_enabled;
  let frontsCacheRoot = DEFAULTS.fronts_cache_root;
  /** Departure anchor config (work doc #15). */
  let departureConfig = {
    daylightAuto: DEFAULTS.departure_daylight_auto,
    prepHours: DEFAULTS.departure_prep_hours,
    dawnAltitudeDeg: DEFAULTS.departure_dawn_altitude_deg,
  };
  /** Vessel eye height above the water (work doc #35): the dip of
   * the apparent horizon that the rise/set stamps correct for. */
  let celestialEyeHeightM = DEFAULTS.celestial_eye_height_m;
  /** Reentry + launch watch config (work doc #36). */
  let reentryWatchEnabled = DEFAULTS.reentry_watch_enabled;
  let spaceTrackConfig = {
    identity: DEFAULTS.space_track_identity,
    password: DEFAULTS.space_track_password,
  };
  let launchWatchEnabled = DEFAULTS.launch_watch_enabled;
  let hazardFilterConfig = {
    minAlertLevel: DEFAULTS.hazard_min_alert_level,
    offRouteRadiusNm: DEFAULTS.hazard_radius_offroute_nm,
    aheadRadiusNm: DEFAULTS.hazard_radius_ahead_nm,
    maxAgeHours: DEFAULTS.hazard_max_age_hours,
  };

  /** Simulation-relevant config subset served to the webapp worker. */
  let simulationConfig = {
    motoring_tws_threshold: DEFAULTS.motoring_tws_threshold,
    drift_mode_enabled: DEFAULTS.drift_mode_enabled,
    motor_fuel_l_per_hour: DEFAULTS.motor_fuel_l_per_hour,
    waterline_length_m: DEFAULTS.waterline_length_m,
    k_heel: DEFAULTS.k_heel,
    k_pitch: DEFAULTS.k_pitch,
    hull_lwl_m: DEFAULTS.hull_lwl_m,
    hull_beam_m: DEFAULTS.hull_beam_m,
    hull_canoe_draft_m: DEFAULTS.hull_canoe_draft_m,
    hull_displacement_kg: DEFAULTS.hull_displacement_kg,
    hull_gm_m: DEFAULTS.hull_gm_m,
    hull_roll_period_s: DEFAULTS.hull_roll_period_s,
    hull_accel_point_m: DEFAULTS.hull_accel_point_m,
    hull_type: DEFAULTS.hull_type,
    /** The vessel's published Signal K design.* snapshot (work doc
     * #56): the boat's own values win over the config gap-fillers;
     * refreshed whenever the config is (re)applied and whenever
     * /api/config answers. */
    hull_design: null,
  };

  /**
   * Reads the vessel's published hull description (work doc #56):
   * the design.* paths the motion kernel consumes, tolerant of both
   * the schema's `value` subgroup and bare legacy paths. Numbers
   * only — anything absent or non-positive stays absent, and the
   * caller's resolution falls to the config gap-filler.
   *
   * @returns {object|null} design snapshot or null when nothing
   *   publishes design data at all
   */
  function readHullDesign() {
    if (typeof app.getSelfPath !== "function") {
      return null;
    }
    const path = (selfPath) => {
      try {
        const value = app.getSelfPath(selfPath);
        const v =
          typeof value === "object" && value !== null
            ? (value.value ?? value)
            : value;
        return typeof v === "number" && v > 0 ? v : null;
      } catch (_error) {
        return null;
      }
    };
    const snapshot = {
      lengthWaterlineM: path("design.length.value.waterline"),
      lengthOverallM: path("design.length.value.overall"),
      beamM: path("design.beam"),
      canoeDraughtM: path("design.draft.value.canoe"),
      maxDraughtM: path("design.draft.value.maximum"),
      displacementKg: path("design.displacement"),
    };
    return Object.values(snapshot).some((v) => v != null) ? snapshot : null;
  }
  /** Configured route-briefing fetch horizon in days (the default
   * `forecastDays` every refresh path falls back to). */
  let simulationForecastDays = DEFAULT_FORECAST_DAYS;
  /** Last automatic (edge-triggered) fetch instant — the oneshot
   * debounce anchor. Explicit crew refreshes do not consult it. */
  let lastAutoFetchAt = null;
  /** Set when a fetch died on a missing vessel position (issue #3):
   * at power-on the internet link is up before the GPS receivers have
   * a fix, so the oneshot fires into a position-less server — and
   * being edge-triggered on the internet state alone, never retries.
   * The first position delta after the failure re-runs the fetch
   * (trigger "position"). */
  let positionFetchPending = false;
  /** @type {NodeJS.Timeout|null} */
  let cronTimer = null;
  /** Spool watcher (SPEC §2.2): bulletins dropped into the configured
   * spool directory by the on-board HF gateway ingest into the same
   * bulletin cache the online fetches use, so the offline briefing
   * carries them. Created in start(), closed in stop(). */
  let spoolWatcher = null;
  /** Last known values of the watched paths. */
  const observations = {
    [INTERNET_STATE_PATH]: null,
    [NAVIGATION_STATE_PATH]: null,
    [HOUSE_SOC_PATH]: null,
  };
  /** Latest compiled-brief metadata for the plotter tile (doc #8). */
  const briefMeta = { generatedAt: null, route: null };
  /** Last acknowledged `generatedAt` (tile NEW badge reset point). */
  let lastAckAt = null;
  /** The downwind sail inventory for the deployment advisor (work
   * doc #41), read once at start and refreshed with the config. */
  let downwindSailCache = [];
  /** Plotter-extension provider teardown (registered at start). */
  let teardownPlotterExt = null;
  let teardownStatusTiles = null;
  let teardownNotesProvider = null;
  let regionsStore = null;
  let teardownRegionsProvider = null;
  let notesStore = null;
  /** Route-list cache (bergie session perf pass): the resources
   * listing is seconds-slow per call and the list changes rarely —
   * stale-while-revalidate keeps the picker instant. */
  const routeListCache = {
    at: 0,
    list: [],
    distances: {},
    inFlight: null,
    error: null,
  };
  /** Route-list TTL before a background refresh fires. */
  const ROUTES_CACHE_TTL_MS = 120000;
  /** Publish METAREA blocks as resources/notes (doc #12). */
  let publishNotesEnabled = true;
  /** Track-weather fetch the briefing windows call (work doc #16):
   * Weather API when selected/available, Open-Meteo otherwise. */
  let trackWeatherFetcher = null;
  /** Last staleness-backstop fetch (rate limit anchor). */
  let lastStaleRefreshAt = 0;
  /** Per-source status registry (work doc #23). */
  let sourceStatus = null;

  /** Registry metadata for the sources recorded from here. */
  const WEATHER_SOURCE = {
    id: "weather-track",
    label: "Weather forecast",
    kind: "weather",
    expectedRefreshMs: SOURCE_REFRESH_MS.weather,
  };
  const EPHEMERIS_SOURCE = {
    id: "celestial-ephemeris",
    label: "Celestial ephemeris",
    kind: "ephemeris",
    expectedRefreshMs: SOURCE_REFRESH_MS.ephemeris,
  };
  const REENTRY_SOURCE = {
    id: "reentry-watch",
    label: "Reentry watch (Space-Track TIP)",
    kind: "reentry",
    expectedRefreshMs: SOURCE_REFRESH_MS.reentry,
  };
  const LAUNCH_SOURCE = {
    id: "launch-watch",
    label: "Visible launches (Launch Library 2)",
    kind: "launch",
    expectedRefreshMs: SOURCE_REFRESH_MS.launch,
  };
  const HAZARD_SOURCE = {
    id: "hazard-gdacs",
    label: "GDACS hazard feed",
    kind: "hazard",
    url: hazardSource.GDACS_RSS_URL,
    expectedRefreshMs: SOURCE_REFRESH_MS.hazard,
  };

  /** Checklist metadata for a zone's bulletin sources. */
  const bulletinZoneSource = (zone) => ({
    id: `bulletin-zone-${zone}`,
    label: `GMDSS zone ${zone} bulletins`,
    kind: "bulletin",
    expectedRefreshMs: SOURCE_REFRESH_MS.bulletin,
  });
  /** Checklist metadata for a zone's UKHO structured warnings. */
  const ukhoZoneSource = (zone) => ({
    id: `ukho-zone-${zone}`,
    label: `UKHO warnings (zone ${zone})`,
    kind: "bulletin",
    expectedRefreshMs: SOURCE_REFRESH_MS.bulletin,
  });
  /** Checklist metadata for a zone's synoptic chart. */
  const synopticZoneSource = (zone) => ({
    id: `synoptic-zone-${zone}`,
    label: `Synoptic chart (zone ${zone})`,
    kind: "chart",
    expectedRefreshMs: SOURCE_REFRESH_MS.chart,
  });
  /** Checklist metadata for one configured extra bulletin feed; the
   * id anchors to the configuration position so a renamed URL keeps
   * its history slot. */
  const customBulletinSource = (index) => ({
    id: `bulletin-custom-${index}`,
    label: `Bulletin feed ${index + 1}`,
    kind: "bulletin",
    expectedRefreshMs: SOURCE_REFRESH_MS.bulletin,
  });

  /**
   * Runs one ingest step and records its outcome in the source
   * status registry (work doc #23). Errors propagate unchanged after
   * being recorded.
   *
   * @param {object} meta - Source metadata (id, label, kind, url,
   *   expectedRefreshMs)
   * @param {Function} task - The ingest step
   * @returns {Promise<object>} The task's result
   */
  async function withSourceStatus(meta, task) {
    try {
      const result = await task();
      sourceStatus?.record(meta);
      return result;
    } catch (error) {
      sourceStatus?.record({ ...meta, error });
      throw error;
    }
  }

  /**
   * Records the checklist outcome of the configured extra bulletin
   * feeds: one entry per URL, success and failure alike (work doc
   * #23).
   *
   * @param {object} result - refreshBulletins result
   * @param {Map<string, Error>} errors - URL → error from onFailure
   * @returns {void}
   */
  function recordCustomBulletinStatuses(result, errors) {
    for (const url of [...result.fetched, ...result.failed]) {
      const index = bulletinUrls.indexOf(url);
      if (index === -1) {
        continue;
      }
      sourceStatus?.record({
        ...customBulletinSource(index),
        url,
        ...(errors.has(url) ? { error: errors.get(url) } : {}),
      });
    }
  }

  /**
   * Ingests the spool directory's bulletins into the bulletin cache
   * (SPEC §3.1): each file becomes a cache entry keyed by its spool
   * path, so a re-dropped file updates in place and the crew's
   * fetched bulletins keep their own entries. On change the warnings
   * republish against the publication track — a spooled gale warning
   * reaches the plotter without any online window.
   *
   * @param {string} trigger - for the debug line
   * @returns {Promise<void>}
   */
  async function ingestSpool(trigger) {
    if (!spoolWatcher) {
      return;
    }
    try {
      await spoolWatcher.refresh();
      const { changed, count } = await ingestSpoolBulletins({
        dataDir: app.getDataDirPath(),
        bulletins: spoolWatcher.all(),
      });
      sourceStatus?.record({
        id: "bulletin-spool",
        label: "Spool bulletins",
        kind: "bulletin",
        url: spoolDirectory,
        ...(count > 0
          ? { note: `${count} file(s) on the spool` }
          : { absent: true }),
      });
      if (changed) {
        app.debug?.(
          `Spool bulletins ingested (${trigger}): ${spoolWatcher.all().length} file(s)`,
        );
        await publishWarningsFor(`spool-${trigger}`);
      }
    } catch (error) {
      app.debug?.(`Spool ingest failed: ${error.message}`);
    }
  }

  /**
   * Pulls the configured extra bulletin feeds with their source
   * status recorded.
   *
   * @returns {Promise<object>} refreshBulletins result
   */
  async function refreshCustomBulletins() {
    const errors = new Map();
    const result = await refreshBulletins({
      dataDir: app.getDataDirPath(),
      urls: bulletinUrls,
      onFailure: (url, error) => errors.set(url, error),
    });
    recordCustomBulletinStatuses(result, errors);
    return result;
  }

  /**
   * Whether the internet link currently allows fetching.
   *
   * @returns {boolean}
   */
  function isOnline() {
    const state = observations[INTERNET_STATE_PATH];
    return state === "online" || state === "metered";
  }

  /**
   * Resolves the id of the vessel's active route from
   * `navigation.course.activeRoute`. Both REST shapes occur — the
   * whole node wrapped (`{value: {href…}}`) and individual leaves
   * wrapped (`{href: {value…}}`) — so both are unwrapped, matching
   * the dead-reckoning plugin's reading of the same path.
   *
   * @param {unknown} [cached] - Pre-read value (delta cache) tried first
   * @returns {string|null} Route resource id, or null when not navigating a route
   */
  function activeRouteId(cached) {
    const raw =
      cached !== undefined
        ? cached
        : typeof app.getSelfPath === "function"
          ? app.getSelfPath(ACTIVE_ROUTE_PATH)
          : null;
    const unwrap = (v) =>
      v && typeof v === "object" && v.value !== undefined ? v.value : v;
    const active = unwrap(raw);
    const href = unwrap(active?.href);
    if (typeof href !== "string") {
      return null;
    }
    const match = href.match(/\/resources\/routes\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  /** Cache entries merged into one serve-time console (work doc #9:
   * UKHO structured warnings and portal text from several zones ride
   * the same cache). */
  const MERGE_BULLETINS = 4;
  /**
   * Trims a route plan to the actual progress (work doc #28): the
   * briefing is forward-looking, so when the course provider reports
   * the vessel navigating THIS route, the plan starts where the boat
   * is — sailing from here to the waypoint it is heading for
   * (`activeRoute.pointIndex` into the route's own geometry) and then
   * the remaining points. Everything behind drops out.
   *
   * No course-provider progress, no point index, or a briefing for a
   * different route than the active one: no trim — the full plan is
   * the right answer for a hypothetical passage. The start point is
   * the vessel's actual position when available, else the last passed
   * waypoint.
   *
   * @param {string} routeId - Route being briefed
   * @param {Array<[number, number]>} raw - Route geometry ([lon, lat])
   * @returns {{coordinates: Array<[number, number]>, trimmedFromNm:
   *   number}|null} Trimmed geometry and the trim point's distance
   *   along the original route (null = no trim, full plan)
   */
  function routeTrimFor(routeId, raw) {
    if (!Array.isArray(raw) || raw.length < 3) {
      return null;
    }
    const unwrap = (v) =>
      v && typeof v === "object" && v.value !== undefined ? v.value : v;
    const active = unwrap(
      observations[ACTIVE_ROUTE_PATH] !== undefined
        ? observations[ACTIVE_ROUTE_PATH]
        : typeof app.getSelfPath === "function"
          ? app.getSelfPath(ACTIVE_ROUTE_PATH)
          : null,
    );
    const href = unwrap(active?.href);
    const match =
      typeof href === "string"
        ? href.match(/\/resources\/routes\/([^/?#]+)/)
        : null;
    if (!match || decodeURIComponent(match[1]) !== routeId) {
      return null; // Briefing for a route the boat is not navigating
    }
    const pointIndex = active?.pointIndex;
    const reverse = active?.reverse === true;
    if (
      !Number.isInteger(pointIndex) ||
      pointIndex < 0 ||
      pointIndex >= raw.length ||
      (reverse && pointIndex >= raw.length - 1)
    ) {
      return null; // Not past the first point, or an index we cannot use
    }
    const target = raw[pointIndex];
    const vessel = vesselPosition();
    // Heading to the first waypoint (forward pointIndex 0): no leg of
    // the plan is behind the boat, so there is no last passed waypoint
    // to anchor the trim distance on. The plan starts at the vessel
    // when known (nothing trimmed off, 0 nm in), else serves in full.
    if (!reverse && pointIndex === 0) {
      if (!vessel) {
        return null;
      }
      return {
        coordinates: [[vessel.lon, vessel.lat], ...raw],
        trimmedFromNm: 0,
      };
    }
    // Travel order decides what remains: forward navigates toward
    // higher indices, reverse toward lower ones (the course provider's
    // `reverse` flag). The start point is the vessel's actual position
    // when available, else the last passed waypoint.
    const start = vessel
      ? [vessel.lon, vessel.lat]
      : reverse
        ? raw[pointIndex + 1]
        : raw[pointIndex - 1];
    const remaining = reverse
      ? raw.slice(0, pointIndex + 1).reverse()
      : raw.slice(pointIndex);
    // Distance along the stored plan from its start to the trim point:
    // the boat sits between the target and the last passed point (the
    // forward pointIndex 0 case returned above, so this is defined)
    const reference = reverse ? target : raw[pointIndex - 1];
    const anchorSlice = reverse
      ? raw.slice(0, pointIndex + 1)
      : raw.slice(0, pointIndex);
    const trimmedFromNm =
      Math.round(
        (routeDistanceNm(anchorSlice) +
          distanceNmLatLon(reference[1], reference[0], start[1], start[0])) *
          10,
      ) / 10;
    return {
      coordinates: [start, ...remaining],
      trimmedFromNm,
    };
  }

  /** Filtered blocks for one cache entry against a track: structured
   * UKHO JSON entries skip the text pipeline entirely. */
  function blocksForEntry(entry, track) {
    if (entry.format === "ukho-json") {
      try {
        return withEntryProvenance(
          entry,
          ukhoBlocksFromWarnings(
            parseUkhoWarnings(JSON.parse(entry.text)),
            track,
          ),
        );
      } catch {
        return []; // Corrupted entry: skip, other entries still serve
      }
    }
    const bulletin = filterBulletin({
      rawText: entry.text,
      source: entry.source ?? "api",
      track,
      issuedAt: entry.fetchedAt,
    });
    return withEntryProvenance(entry, bulletin?.blocks ?? []);
  }

  /** Bulletin-level metadata (header/issuedAt/source/raw text) for
   * one cache entry, shape-compatible across both ingestion paths. */
  function bulletinMetaForEntry(entry) {
    if (entry.format === "ukho-json") {
      let warnings = [];
      try {
        warnings = parseUkhoWarnings(JSON.parse(entry.text));
      } catch {
        warnings = [];
      }
      return {
        header:
          warnings[0]?.text.split(/\r?\n/, 1)[0]?.trim() ?? "UKHO warnings",
        issuedAt:
          warnings.find((warning) => warning.issuedAt)?.issuedAt ??
          entry.fetchedAt ??
          new Date(0).toISOString(),
        bulletinText: entry.text,
        source: entry.source ?? "ukho",
      };
    }
    const bulletin = filterBulletin({
      rawText: entry.text,
      source: entry.source ?? "api",
      track: [],
      issuedAt: entry.fetchedAt,
    });
    return bulletin
      ? {
          header: bulletin.header,
          issuedAt: bulletin.issuedAt,
          bulletinText: bulletin.bulletinText,
          source: bulletin.source,
        }
      : null;
  }

  /**
   * Filters the newest cached bulletins against a track (work docs
   * #4 and #9). Blocks from the newest few entries — text pipeline
   * and structured UKHO JSON alike — merge into one console, deduped
   * by text. Returns null when nothing is cached.
   *
   * @param {Array<{lat: number, lon: number}>} waypoints - Sampled
   *   route waypoints
   * @returns {Promise<object|null>} `metareaBulletin` shape with `blocks`
   */
  /** How many wider-area warning blocks ride the payload for the
   * map (work doc #47): the crew zooms and pans to them; the cap
   * bounds the payload without losing a gale. */
  const WIDER_BLOCK_LIMIT = 24;

  /** Stamps one cache entry's feed provenance onto blocks (the spool
   * path has a file path, not a URL, and carries no provenance). */
  function withEntryProvenance(entry, blocks) {
    const sourceUrl = /^https?:\/\//.test(entry.url ?? "") ? entry.url : null;
    return sourceUrl
      ? blocks.map((block) => ({ ...block, sourceUrl }))
      : blocks;
  }

  /**
   * Wider-area context for the map (work doc #47): severe, geometric
   * blocks from the SAME cached bulletins that the track filter
   * discarded. The console stays filtered — text noise offshore is
   * noise — but a gale two hundred miles off the route belongs on a
   * map the crew can zoom and pan. Nothing here reaches the console
   * or the fit; the map draws them muted.
   *
   * @param {object} entry - Bulletin cache entry
   * @param {Set<string>} excludeTexts - The track-filtered blocks'
   *   texts (already on the console)
   * @returns {Array<object>} Severe geometric blocks not on the track
   */
  function widerBlocksForEntry(entry, excludeTexts) {
    if (entry.format === "ukho-json") {
      return []; // UKHO warnings are already track-filtered directly
    }
    const bulletin = filterBulletin({
      rawText: entry.text,
      source: entry.source ?? "api",
      track: [], // Unfiltered: every block the parse found
      issuedAt: entry.fetchedAt,
    });
    return withEntryProvenance(
      entry,
      (bulletin?.blocks ?? []).filter(
        (block) =>
          block.geometry != null &&
          !excludeTexts.has(block.text) &&
          hasSevereKeyword(block.text),
      ),
    );
  }

  async function bulletinForTrack(waypoints) {
    const cached = await loadBulletinCache(app.getDataDirPath());
    if (cached.length === 0) {
      return null;
    }
    const track = waypoints.map((w) => [w.lon, w.lat]);
    // Area gate (bergie session, Tonga fix): an entry whose own
    // coordinates all sit in another ocean is that ocean's bulletin —
    // it must not reach the console, neither as severe-but-ungeometric
    // synopsis blocks nor as the headline. Zone-fetched entries (the
    // TGFTP stations) were pulled for our zones and are trusted; the
    // unplaced case (storm named without coordinates) keeps, never
    // loses.
    const merged = [];
    const widerSeen = new Set();
    const wider = [];
    for (const entry of cached.slice(0, MERGE_BULLETINS)) {
      if (
        entry.zone == null &&
        entry.format !== "ukho-json" &&
        textNearTrack(entry.text, track) === false
      ) {
        continue;
      }
      const blocks = blocksForEntry(entry, track);
      // Wider-area severe warnings from the same bulletins: the map
      // draws them muted, the console never sees them
      for (const block of widerBlocksForEntry(
        entry,
        new Set(blocks.map((b) => b.text)),
      )) {
        if (wider.length >= WIDER_BLOCK_LIMIT || widerSeen.has(block.text)) {
          continue;
        }
        widerSeen.add(block.text);
        wider.push(block);
      }
      if (blocks.length > 0) {
        merged.push({ entry, blocks });
      }
    }
    if (merged.length === 0) {
      // Nothing on our waters: an empty console is the honest answer,
      // not the newest cache entry's foreign text
      return null;
    }
    const blocks = [];
    const seen = new Set();
    for (const { blocks: entryBlocks } of merged) {
      for (const block of entryBlocks) {
        if (seen.has(block.text)) {
          continue;
        }
        seen.add(block.text);
        blocks.push(block);
      }
    }
    // The headline belongs to the bulletin that actually matched: the
    // newest entry *with retained blocks*, never the cache's newest
    // entry whatever ocean it came from
    const meta = bulletinMetaForEntry(merged[0].entry) ?? {
      header: "",
      issuedAt: merged[0].entry.fetchedAt ?? new Date(0).toISOString(),
      bulletinText: merged[0].entry.text,
      source: merged[0].entry.source ?? "api",
    };
    return { ...meta, blocks, wider };
  }

  /**
   * Pulls bulletins while online (work doc #9): resolves the active
   * GMDSS zones from the route track and fetches only those, then
   * any configured extra feeds. Merges into the disk cache.
   *
   * @param {"oneshot"|"cron"|"briefing"|"manual"} trigger
   * @param {Array<{lat: number, lon: number}>} [waypoints] - Track
   *   for zone resolution (position-only when omitted)
   */
  async function refreshBulletinsOnline(trigger, waypoints = []) {
    const track = waypoints.map((w) => [w.lon, w.lat]);
    const zones = resolveZones(track);
    if (!isOnline()) {
      // Skipped cycles are recorded, not hidden (work doc #23): the
      // checklist must distinguish "not attempted, boat offline"
      // from an attempted-and-failed cycle
      for (const zone of zones) {
        sourceStatus?.record({ ...bulletinZoneSource(zone), skip: true });
        // Only zones the UKHO coordinates have a UKHO rung to skip
        if (ukhoWarningsUrl(zone)) {
          sourceStatus?.record({ ...ukhoZoneSource(zone), skip: true });
        }
      }
      for (const [index, url] of bulletinUrls.entries()) {
        sourceStatus?.record({
          ...customBulletinSource(index),
          url,
          skip: true,
        });
      }
      return;
    }
    // Zone-targeted pulls (work doc #9 fetch strategy): TGFTP fast
    // path for configured stations, GMDSS portal fallback, then the
    // UKHO MSI JSON for the same zones (structured navigational
    // warnings stored raw and filtered at serve time)
    const zoneBulletins = await fetchZoneBulletins({
      zones,
      tgftpStations: bulletinStations,
      onFailure: (zone, url, error) =>
        sourceStatus?.record({ ...bulletinZoneSource(zone), url, error }),
    });
    for (const zone of zones) {
      // The ladder records failures via onFailure; the zones whose
      // ladder produced text record their success here
      const entry = zoneBulletins.find((b) => b.zone === zone);
      if (entry) {
        sourceStatus?.record({ ...bulletinZoneSource(zone), url: entry.url });
      }
    }
    for (const zone of zones) {
      // The UKHO coordinates NAVAREA I only: other zones have no
      // source here and are skipped, not fetched into 404s
      const url = ukhoWarningsUrl(zone);
      if (!url) {
        continue;
      }
      try {
        const { text } = await resolveBulletinSource(url, {});
        // The RNW page HTML parses into the same structured warning
        // shape the old UKHO JSON API fed; the cache entry stays a
        // "ukho-json" blob, filtered at serve time as before
        const warnings = parseRnwHtml(text);
        zoneBulletins.push({
          url,
          text: JSON.stringify(warnings),
          source: "ukho",
          zone,
          format: "ukho-json",
        });
        sourceStatus?.record({ ...ukhoZoneSource(zone), url });
      } catch (error) {
        // UKHO unavailable this cycle: portal text still covers the zone
        sourceStatus?.record({ ...ukhoZoneSource(zone), url, error });
      }
    }
    const result = await refreshBulletins({
      dataDir: app.getDataDirPath(),
      urls: [],
      zoneBulletins,
    });
    // Custom extra feeds (source-agnostic escape hatch)
    if (bulletinUrls.length > 0) {
      const extra = await refreshCustomBulletins();
      result.fetched.push(...extra.fetched);
      result.failed.push(...extra.failed);
    }
    if (result.fetched.length > 0) {
      app.debug?.(
        `Bulletins refreshed (${trigger}) zones ${zones.join(",") || "none"}: ` +
          `${result.fetched.length} fetched` +
          (result.failed.length ? `, ${result.failed.length} failed` : ""),
      );
    }
  }

  /**
   * Pulls the resolved zones' synoptic surface-analysis charts while
   * online (work doc #11), sharing the online gate and the zone
   * resolution with the bulletin pull.
   *
   * @param {"oneshot"|"cron"|"briefing"|"manual"|"here"} trigger
   * @param {Array<{lat: number, lon: number}>} [waypoints]
   */
  async function refreshSynopticsOnline(trigger, waypoints = []) {
    const zones = resolveZones(waypoints.map((w) => [w.lon, w.lat]));
    if (!isOnline()) {
      for (const zone of zones) {
        sourceStatus?.record({ ...synopticZoneSource(zone), skip: true });
      }
      return;
    }
    if (zones.length === 0) {
      return;
    }
    const result = await refreshSynoptics({
      dataDir: app.getDataDirPath(),
      zones,
      // Short on purpose: a hanging agency host must not stall the
      // whole briefing window (candidates are tried in order)
      timeoutMs: 8000,
    });
    // Checklist outcome per zone (work doc #23): fetched and "same
    // chart already cached" are both healthy cycles, failures carry
    // the classified error
    const map = loadSynopticMap();
    for (const zone of [...result.fetched, ...result.skipped]) {
      sourceStatus?.record({
        ...synopticZoneSource(zone),
        url: chartUrlForZone(map, zone)?.urls?.[0] ?? null,
      });
    }
    for (const failure of result.failed) {
      sourceStatus?.record({
        ...synopticZoneSource(failure.zone),
        url: failure.url,
        error: failure.error,
      });
      app.error?.(
        `Synoptic chart fetch failed (zone ${failure.zone}): ` +
          `${failure.url} — ${failure.error}`,
      );
    }
    if (result.fetched.length > 0) {
      app.debug?.(
        `Synoptic charts refreshed (${trigger}): zones ` +
          `${result.fetched.join(",")}` +
          (result.failed.length ? `, failed ${result.failed.join(",")}` : ""),
      );
    }
  }

  /**
   * Publishes the filtered bulletin blocks as georeferenced server
   * notes (work doc #12). Local-only: not gated on the internet
   * state, so spool-sourced warnings publish the same way. Also runs
   * at serve time (trigger "serve", work doc #48): the refiltered
   * bulletin the console renders is what the resources must carry.
   *
   * @param {"here"|"route"|"serve"} trigger
   * @param {object|null} bulletin - metareaBulletin with blocks
   * @param {Array<{lat: number, lon: number}>} waypoints
   */
  /**
   * The publication track (work doc #48): the vessel's position first
   * (it anchors the nearest-point note placement), then the route
   * waters — the caller's track hint (the served briefing's own
   * waypoints) when one exists, else the most recent route compile's.
   * The union of the two is the set of waters the passage touches —
   * the notes and regions the plotter sees must not depend on which
   * view triggered the last publish, nor on whether a compile ran in
   * this process at all (a cached-briefing page load never compiles).
   *
   * @param {Array<{lat: number, lon: number}>|null} [hint] - The
   *   served briefing's waypoints when available
   * @returns {Array<{lat: number, lon: number}>}
   */
  function publicationTrack(hint = null) {
    const track = [];
    const seen = new Set();
    const push = (lat, lon) => {
      const key = `${lat},${lon}`;
      if (Number.isFinite(lat) && Number.isFinite(lon) && !seen.has(key)) {
        seen.add(key);
        track.push({ lat, lon });
      }
    };
    const position = vesselPosition();
    if (position) {
      push(position.lat, position.lon);
    }
    for (const waypoint of hint ?? lastRouteWaypoints ?? []) {
      push(waypoint.lat, waypoint.lon);
    }
    return track;
  }

  /**
   * The canonical publication pass (work doc #48): one set of notes
   * and regions for the plotter, filtered against the publication
   * track — the vessel's position plus the active route — regardless
   * of which view or fetch window triggered it. A per-trigger filter
   * (here: position-only, route: route-only) would have each pass
   * prune the other's warnings; the union track ends the fight. An
   * empty result clears this feed's resources: expiry is part of the
   * feature.
   *
   * @param {string} trigger - for the debug line
   * @param {Array<{lat: number, lon: number}>|null} [hint] - The
   *   served briefing's waypoints when available
   */
  async function publishWarningsFor(trigger, hint = null) {
    if (!publishNotesEnabled) {
      return;
    }
    const track = publicationTrack(hint);
    if (track.length === 0) {
      return;
    }
    const bulletin = await bulletinForTrack(track);
    await publishNotesFor(
      trigger,
      // Null bulletin (nothing on our waters) publishes an empty set:
      // the scoped prune drops this feed's stale warnings
      bulletin ?? { blocks: [], wider: [] },
      track,
    );
  }

  async function publishNotesFor(trigger, bulletin, waypoints) {
    if (!publishNotesEnabled || !bulletin) {
      return;
    }
    const zone = resolveZones(waypoints.map((w) => [w.lon, w.lat]))[0] ?? null;
    let chart = null;
    if (zone != null) {
      const cached = await loadSynoptic(app.getDataDirPath(), zone);
      if (cached) {
        chart = {
          url: `/plugins/signalk-passage-briefing/api/synoptic?zone=${zone}`,
          mimeType: cached.format === "gif" ? "image/gif" : "image/png",
        };
      }
    }
    const result = await publishNotes({
      store: notesStore,
      regionsStore,
      bulletin,
      zone,
      synopticChartFor: () => chart,
      ref: waypoints.length > 0 ? [waypoints[0].lon, waypoints[0].lat] : null,
    });
    if (
      result.published.length > 0 ||
      result.pruned.length > 0 ||
      result.regionsPublished.length > 0 ||
      result.regionsPruned.length > 0
    ) {
      app.debug?.(
        `Notes ${trigger}: ${result.published.length} published, ` +
          `${result.pruned.length} expired, ` +
          `${result.regionsPublished.length} regions published, ` +
          `${result.regionsPruned.length} regions expired, ` +
          `${result.widerPublished.length} wider regions`,
      );
    }
  }

  /**
   * Refreshes the GDACS hazard cache during the online window and
   * attaches the route-filtered events to a briefing payload (work
   * doc #22), then publishes the surviving placeable events as chart
   * notes like the METAREA warnings. Degrades to the cached events
   * on fetch failure; a disabled switch attaches nothing.
   *
   * @param {object} payload - Briefing payload to attach to
   * @param {{lat: number, lon: number}|null} vessel - Vessel position
   * @param {Array<{lat: number, lon: number}>} waypoints - Route
   *   samples (route mode) or the position waypoint (here mode)
   * @returns {Promise<void>}
   */
  /**
   * On-board viewer base for weather provenance (work doc #31): the
   * weather-map sibling webapp renders the same fields the briefing
   * derives from, reachable over the LAN underway. The server knows
   * its registered webapps; a link to an absent sibling is dropped
   * rather than served dead. Deep-link parameters (lat/lon/time/
   * layer) are appended per item by the webapp.
   *
   * @returns {string|null} Viewer base path when installed
   */
  function weatherViewerBase() {
    const webapps = app.webapps;
    if (!Array.isArray(webapps)) {
      return null;
    }
    return webapps.some((webapp) => webapp?.name === "signalk-weather-map")
      ? "/signalk-weather-map/"
      : null;
  }

  /**
   * Stamps the on-board viewer link onto a payload's weather
   * provenance record (work doc #31). Payloads whose cache predates
   * the provenance field keep no record — the UI degrades to no
   * glyph, never a dead link.
   *
   * @param {object} payload - Briefing payload, mutated in place
   * @returns {void}
   */
  function attachWeatherViewer(payload) {
    const base = weatherViewerBase();
    if (base && payload?.metadata?.provenance) {
      payload.metadata.provenance.viewerBase = base;
    }
  }

  async function attachHazardEvents(
    payload,
    vessel,
    waypoints,
    { online = true } = {},
  ) {
    if (!hazardEventsEnabled) {
      return;
    }
    // Offline the feed is not polled (work doc #55): the cached
    // events still attach — the fetch would only burn its timeout
    // against a dead link and clutter the checklist with network
    // errors for a situation it already knows about.
    if (online) {
      try {
        const result = await hazardSource.refreshHazards({
          dataDir: app.getDataDirPath(),
          timeoutMs: 15000,
          onFailure: (error) =>
            sourceStatus?.record({ ...HAZARD_SOURCE, error }),
        });
        // A cycle without a recorded failure means the feed answered
        if (result.fetched) {
          sourceStatus?.record(HAZARD_SOURCE);
        }
      } catch (error) {
        app.debug?.(`Hazard refresh failed: ${error.message}`);
      }
    }
    const events = hazardSource.filterHazards({
      events: await hazardSource.loadHazards(app.getDataDirPath()),
      vessel,
      waypoints,
      ...hazardFilterConfig,
      now: new Date(),
    });
    // Provenance (work doc #31): the GDACS event page rides each
    // surviving event — one tap from timeline row to origin
    payload.hazardEvents = events.map((event) =>
      event.link
        ? {
            ...event,
            provenance: {
              kind: "warning",
              label: "GDACS",
              url: event.link,
              viewerUrl: null,
              at: event.timestamp ?? null,
            },
          }
        : event,
    );
    if (notesStore) {
      const result = await publishHazardNotes({ store: notesStore, events });
      if (result.published.length > 0 || result.pruned.length > 0) {
        app.debug?.(
          `Hazard notes: ${result.published.length} published, ` +
            `${result.pruned.length} expired`,
        );
      }
    }
  }

  /**
   * Attaches the energy outlook to a briefing payload (work doc #10):
   * the adapted hourly series plus the predictor's own surplus and
   * deficit terms, derived from its subscribed outlook paths.
   *
   * @param {object} payload - Briefing payload to attach to
   */
  function attachEnergyToPayload(payload) {
    payload.energyEvents = energyEventsFromState({
      status: observations[ENERGY_OUTLOOK_PATHS.status],
      net: observations[ENERGY_OUTLOOK_PATHS.net],
      surplus: observations[ENERGY_OUTLOOK_PATHS.surplus],
      surplusFrom: observations[ENERGY_OUTLOOK_PATHS.surplusFrom],
      surplusTo: observations[ENERGY_OUTLOOK_PATHS.surplusTo],
      timeToEmpty: observations[ENERGY_OUTLOOK_PATHS.timeToEmpty],
    });
  }

  /**
   * Recomputes a briefing payload's bulletin console from the
   * bulletin cache at serve time: the cached payload carries blocks
   * computed at compile, and parsing or filtering improvements must
   * reach cached briefings on the next page load, not wait for a
   * re-fetch (the crew is offline when they notice). A payload whose
   * cache is gone keeps its own compile-time console.
   *
   * @param {object} payload - Briefing payload, mutated in place
   * @returns {Promise<void>}
   */
  /**
   * Re-publishes the metarea warnings from the canonical publication
   * track (work doc #48): the fetch-time publish ran against the
   * track as it was when the bulletin arrived — the crew has moved
   * since, and a page load must not wait for the next fetch window.
   * Content-addressed ids make the re-publish idempotent, and
   * unchanged sets write nothing.
   *
   * @param {{waypoints?: Array<{lat: number, lon: number}>}} payload
   */
  async function refilterPayloadBulletin(payload) {
    if (!payload?.waypoints?.length) {
      return;
    }
    const fresh = await bulletinForTrack(payload.waypoints);
    if (fresh) {
      payload.metareaBulletin = fresh;
    }
    // The publication track is view-independent — the payload's own
    // refiltered bulletin stays per-view for the console. The served
    // briefing's waypoints ARE the route waters: a cached-payload page
    // load publishes from them even when no compile ran in this
    // process
    await publishWarningsFor("serve", payload.waypoints);
  }

  /**
   * Refreshes the CAP feeds during the online window and attaches the
   * track-filtered official alerts to a briefing payload (work doc
   * #24), publishing the surviving placeable alerts as chart notes,
   * and records one status row per feed (work doc #23). Degrades to
   * the cached events on fetch failure.
   *
   * @param {object} payload - Briefing payload to attach to
   * @param {Array<{lat: number, lon: number}>} waypoints - Route
   *   samples or the position waypoint
   * @returns {Promise<void>}
   */
  async function attachCapAlerts(payload, waypoints, { online = true } = {}) {
    if (!capEnabled || capUrls.length === 0) {
      return;
    }
    let result = null;
    let refreshError = null;
    // Offline the feeds are not polled (work doc #55): the cached
    // alerts still attach and publish, exactly like a failed fetch
    // degrades to the cache while online.
    if (online) {
      try {
        result = await capSource.refreshCapAlerts({
          dataDir: app.getDataDirPath(),
          urls: capUrls,
          timeoutMs: 15000,
        });
      } catch (error) {
        refreshError = error;
        app.debug?.(`CAP refresh failed: ${error.message}`);
      }
    }
    // One status row per feed (work doc #23): success and failure
    // alike, so the checklist can tell a moved URL from a dead host
    for (const url of [...(result?.fetched ?? []), ...(result?.failed ?? [])]) {
      const index = capUrls.indexOf(url);
      if (index === -1) {
        continue;
      }
      sourceStatus?.record({
        id: `cap-feed-${index + 1}`,
        label: `CAP feed ${index + 1}`,
        kind: "bulletin",
        url,
        expectedRefreshMs: SOURCE_REFRESH_MS.bulletin,
        ...(refreshError || (result?.failed ?? []).includes(url)
          ? { error: refreshError ?? new Error("unavailable") }
          : {}),
        now: new Date(),
      });
    }
    const events =
      result?.events ?? (await capSource.loadCapAlerts(app.getDataDirPath()));
    // Provenance (work doc #31): the sender's info page when
    // published, else the feed the document arrived from. Stamped on
    // the FILTERED survivors — stamping the raw cache instead would
    // bypass the severity, expiry and geography gates (a Puerto Rico
    // information statement reached a Tonga vessel that way once).
    payload.capAlerts = capSource
      .filterCapAlerts({
        events,
        track: waypoints.map((w) => [w.lon, w.lat]),
        minSeverity: capMinSeverity,
        now: new Date(),
      })
      .map((alert) => {
        const url = alert.web ?? alert.sourceUrl ?? null;
        return url
          ? {
              ...alert,
              provenance: {
                kind: "warning",
                label: alert.web ? "Official alert page" : "CAP feed",
                url,
                viewerUrl: null,
                at: alert.sent ?? null,
              },
            }
          : alert;
      });
    if (notesStore) {
      const result = await publishCapAlertNotes({
        store: notesStore,
        regionsStore,
        alerts: payload.capAlerts,
      });
      if (
        result.published.length > 0 ||
        result.pruned.length > 0 ||
        result.regionsPublished.length > 0 ||
        result.regionsPruned.length > 0
      ) {
        app.debug?.(
          `CAP notes: ${result.published.length} published, ` +
            `${result.pruned.length} expired, ` +
            `${result.regionsPublished.length} regions published, ` +
            `${result.regionsPruned.length} regions expired`,
        );
      }
    }
  }

  /**
   * Vessel position from the Signal K self path (work doc #7 here
   * mode). Both wrapped and plain value shapes are unwrapped.
   *
   * @returns {{lat: number, lon: number}|null}
   */
  function vesselPosition() {
    if (typeof app.getSelfPath !== "function") {
      return null;
    }
    const raw = app.getSelfPath("navigation.position");
    const unwrap = (v) =>
      v && typeof v === "object" && v.value !== undefined ? v.value : v;
    const position = unwrap(raw);
    const lat = position?.latitude;
    const lon = position?.longitude;
    return typeof lat === "number" && typeof lon === "number"
      ? { lat, lon }
      : null;
  }

  /**
   * The route the webapp asked for and the plugin could not serve:
   * a route created/selected while offline has no cache yet, and this
   * marker makes it the next online window's briefing target (work
   * doc #55). Plain marker file, same convention as `last-route`.
   *
   * @returns {string} Marker file path
   */
  function requestedRoutePath() {
    return join(app.getDataDirPath(), "weather", "requested-route");
  }

  /**
   * Reads the requested-route marker, null when absent or empty.
   *
   * @returns {Promise<string|null>}
   */
  async function readRequestedRoute() {
    try {
      const id = (await readFile(requestedRoutePath(), "utf8")).trim();
      return id || null;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Loads a cached payload without throwing (missing or unreadable
   * cache reads as none).
   *
   * @param {string} routeId
   * @returns {Promise<{payload: object, cachedAt: string|null}|null>}
   */
  async function loadCachedPayload(routeId) {
    try {
      return await loadPayload(app.getDataDirPath(), routeId);
    } catch (_error) {
      return null;
    }
  }

  /**
   * Loads the cached here payload (`weather/here.json`), null when
   * nothing is cached.
   *
   * @returns {Promise<{payload: object, cachedAt: string|null, stale: boolean}|null>}
   */
  async function loadHere() {
    try {
      const file = join(app.getDataDirPath(), "weather", "here.json");
      const payload = JSON.parse(await readFile(file, "utf8"));
      const cachedAt = payload?.metadata?.fetchedAt ?? null;
      const age = cachedAt
        ? Date.now() - new Date(cachedAt).getTime()
        : Infinity;
      return { payload, cachedAt, stale: age > HERE_TTL_MS };
    } catch (_error) {
      return null;
    }
  }

  /**
   * Fetches the here payload: conditions at the vessel's current
   * position for the next 24 hours (work doc #7). Same Unified
   * Weather Payload shape with a single waypoint, so the webapp's
   * rendering machinery works unchanged; bulletin filtering runs
   * against the position alone.
   *
   * @returns {Promise<{cachedAt: string}>}
   */
  async function refreshHereQueued() {
    const position = vesselPosition();
    if (!position) {
      // Arm the position-arrival retry (issue #3): a missing fix is a
      // transient condition, not a terminal one.
      positionFetchPending = true;
      throw new Error("No vessel position available");
    }
    const waypoints = [
      { lat: position.lat, lon: position.lon, distanceFromStartNm: 0 },
    ];
    lastCompiledWaypoints = waypoints;
    // Bulletins ride the same online window, filtered to the position
    await refreshBulletinsOnline("here", waypoints);
    await refreshSynopticsOnline("here", waypoints);
    // forecast_days=2: Open-Meteo's first day starts at 00Z, so two
    // days guarantee 24 forward hours from any fetch time
    const payload = await withSourceStatus(WEATHER_SOURCE, () =>
      trackWeatherFetcher({
        waypoints,
        forecastDays: 2,
      }),
    );
    if (payload?.metadata?.weatherApiFallback != null) {
      sourceStatus?.record({
        ...WEATHER_SOURCE,
        note: `Answered by Open-Meteo — Weather API: ${payload.metadata.weatherApiFallback}`,
      });
    }
    payload.metadata.mode = "here";
    attachWeatherViewer(payload);
    const bulletin = await bulletinForTrack(waypoints);
    if (bulletin) {
      payload.metareaBulletin = bulletin;
    }
    await publishWarningsFor("here");
    // Space weather rides the same online window (work doc #3);
    // degrades to an absent field when the endpoints fail. Phase-2
    // ephemeris events are local computation; the visibility gate
    // reads cloud cover from the payload just fetched.
    payload.spaceEvents = await fetchSpaceEvents({
      lat: position.lat,
      lon: position.lon,
      cloudCoverAt: ephemeris.cloudCoverLookup(payload),
      dataDir: app.getDataDirPath(),
      spaceTrack: spaceTrackConfig,
      reentryEnabled: reentryWatchEnabled,
      launchEnabled: launchWatchEnabled,
      recordSource: (source, error, { absent = false } = {}) => {
        // The reentry source answers silently when unconfigured; the
        // registry marks it absent (information, not a failure)
        if (source === "reentry") {
          if (absent) {
            sourceStatus?.record({ ...REENTRY_SOURCE, absent: true });
          } else {
            sourceStatus?.record(
              error ? { ...REENTRY_SOURCE, error } : REENTRY_SOURCE,
            );
          }
        } else if (source === "launch") {
          sourceStatus?.record(
            error ? { ...LAUNCH_SOURCE, error } : LAUNCH_SOURCE,
          );
        }
      },
    });
    payload.celestialNights = await withSourceStatus(EPHEMERIS_SOURCE, () =>
      ephemeris.celestialNights({
        from: new Date(payload.metadata.fetchedAt),
        days: 2,
        lat: position.lat,
        lon: position.lon,
        eyeHeightM: celestialEyeHeightM,
      }),
    );
    await attachHazardEvents(payload, position, waypoints);
    // Energy forecast (work doc #10): the predictor's subscribed
    // hourly series adapts into the consumer contract and rides the
    // payload, so the offline hours re-derive from the cache; the
    // energy events are the predictor's own surplus/deficit terms
    payload.energyHourly = adaptEnergyForecast(
      observations[ENERGY_FORECAST_PATH],
    );
    attachEnergyToPayload(payload);
    await attachCapAlerts(payload, waypoints);
    // Here mode reports the waters the vessel is in right now instead
    // of transitions (work doc #17); the disclaimer rides along and
    // everything caches together
    try {
      const zones = await maritimeZones.positionZones({
        dataDir: app.getDataDirPath(),
        lat: position.lat,
        lon: position.lon,
      });
      if (zones) {
        payload.zonesHere = zones;
        payload.zoneDisclaimer = maritimeZones.ZONE_DISCLAIMER;
      }
    } catch (error) {
      app.debug?.(`Zones-here failed: ${error.message}`);
    }
    const dir = join(app.getDataDirPath(), "weather");
    await mkdir(dir, { recursive: true });
    // The here payload is the one file offline here-mode reads:
    // persisted through the atomic store so a crash mid-write cannot
    // tear it into "no cache" (same reason the route payloads use it)
    await writeFileAtomic(join(dir, "here.json"), JSON.stringify(payload));
    // Tile freshness; the route field stays empty in here mode
    payload.comfortTier = await currentComfortTier(payload);
    recordBriefCompile(
      payload.metadata.fetchedAt,
      "",
      payload.comfortTier,
      "here",
    );
    // A newer GRIB cycle may publish after this compile: schedule the
    // catch-up refresh (work doc #47 session)
    scheduleRunRefresh({ kind: "here" }, payload.metadata.cycleTime);
    return { cachedAt: payload.metadata.fetchedAt };
  }

  let modelsPromise = null;

  // Run-refresh scheduling (work doc #47 session): GRIB-based weather
  // providers publish on a cycle cadence — ECMWF IFS open data lands
  // four runs a day, each roughly six hours after its cycle time. A
  // briefing compiled minutes before the next run decoded (the
  // Tonga→Opua outlook of 2026-10-17: compiled 21:16 UTC, the 12z run
  // decoded shortly after, and the served outlook stayed a full cycle
  // behind Windy) should say so and recompile when the newer run is
  // available. The delay anchors to the decoded run's cycle instant:
  // the next cycle publishes ≈ cycle + 12 h 15 m (the 6 h cadence
  // plus the ≈6 h publication lag). Open-Meteo-style continuous
  // sources carry no cycle time and never schedule.
  const RUN_REFRESH_DELAY_MS = 12.25 * 3600000;
  let runRefreshTimer = null;
  /**
   * Schedules one catch-up refresh for the scope whose payload was
   * just compiled, when that payload carries a GRIB cycle time and
   * the next run's publication is still ahead. Offline at fire time
   * skids to the next cron window — the online gating stays with the
   * state machine.
   *
   * @param {{kind: "here"}|{kind: "route", routeId: string,
   *   days: number}} scope - What to recompile
   * @param {string|null} cycleTime - The payload's cycle instant
   * @returns {void}
   */
  function scheduleRunRefresh(scope, cycleTime) {
    if (runRefreshTimer) {
      clearTimeout(runRefreshTimer);
      runRefreshTimer = null;
    }
    const cycleMs = Date.parse(cycleTime ?? "");
    if (!Number.isFinite(cycleMs)) {
      return;
    }
    const delay = cycleMs + RUN_REFRESH_DELAY_MS - Date.now();
    if (delay <= 0) {
      return; // The next cycle should already be on disk
    }
    runRefreshTimer = setTimeout(async () => {
      runRefreshTimer = null;
      if (observations[INTERNET_STATE_PATH] === "offline") {
        return;
      }
      try {
        if (scope.kind === "route") {
          await refreshBriefing(scope.routeId, scope.days);
        } else {
          await refreshHereQueued();
        }
      } catch (error) {
        app.error(`Run refresh failed (${scope.kind}): ${error.message}`);
      }
    }, delay);
  }

  /**
   * Current comfort tier for the tile (work doc #8): computed with
   * the webapp's own model (models.mjs hereHourly at SOG 0) so the
   * published value and the conditions-here view can never drift
   * apart — one implementation, two consumers.
   *
   * @param {object} payload
   * @returns {Promise<string|null>}
   */
  async function currentComfortTier(payload) {
    try {
      if (!payload?.waypoints?.[0]?.forecasts?.length) {
        return null;
      }
      modelsPromise ??= import("../public/components/models.mjs");
      const { hereHourly } = await modelsPromise;
      const rows = hereHourly(payload, {
        waterline_length_m: simulationConfig.waterline_length_m,
        k_heel: simulationConfig.k_heel,
        k_pitch: simulationConfig.k_pitch,
        hull_lwl_m: simulationConfig.hull_lwl_m,
        hull_beam_m: simulationConfig.hull_beam_m,
        hull_canoe_draft_m: simulationConfig.hull_canoe_draft_m,
        hull_displacement_kg: simulationConfig.hull_displacement_kg,
        hull_gm_m: simulationConfig.hull_gm_m,
        hull_roll_period_s: simulationConfig.hull_roll_period_s,
        hull_accel_point_m: simulationConfig.hull_accel_point_m,
        hull_type: simulationConfig.hull_type,
        hull_design: readHullDesign(),
      });
      return rows[0]?.comfortLevel ?? null;
    } catch (_error) {
      return null;
    }
  }

  /** Single-flight refresh chain: the online-transition refresh and
   * a manual/API refresh can overlap (cron + crew button), and two
   * concurrent payload writes race on the cache files. Queue instead —
   * overlapping triggers run one after the other. */
  let refreshChain = Promise.resolve();

  function serializeRefresh(task) {
    const run = refreshChain.then(task, task);
    refreshChain = run.catch(() => {});
    return run;
  }

  function refreshHere() {
    return serializeRefresh(() => refreshHereQueued());
  }

  function refreshBriefing(routeId, forecastDays) {
    return serializeRefresh(() => refreshBriefingQueued(routeId, forecastDays));
  }

  /**
   * Fetches and caches the briefing payload for a route. Internet
   * weather is only fetched while the link is up; everything served
   * afterwards comes from the cache (on passage the boat is online
   * for about an hour a day, so the last payload must survive the
   * other 23 offline hours).
   *
   * Offline the compile still runs (work doc #55): the Weather API is
   * a local read over the decoded GRIB on disk, so a route changed
   * mid-passage is re-planned from what the boat already carries —
   * ephemeris-only space events, cached hazards, CAP and bulletins —
   * and the payload is marked `offlineCompile`. With no local weather
   * source the cached payload is served honestly instead of failing.
   *
   * @param {string} routeId
   * @param {number} [forecastDays]
   * @returns {Promise<{routeId: string, cached: boolean, cachedAt: string|null, fetchedAt?: string, offline?: boolean}>}
   */
  async function refreshBriefingQueued(
    routeId,
    forecastDays = simulationForecastDays,
  ) {
    const offline = !isOnline();
    let coordinates;
    if (typeof app.resourcesApi?.getResource === "function") {
      let route;
      try {
        route = await app.resourcesApi.getResource("routes", routeId);
      } catch (error) {
        throw new Error(`Route ${routeId} not found (${error.message})`);
      }
      coordinates = route?.feature?.geometry?.coordinates;
    }
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      throw new Error(`Route ${routeId} has no track`);
    }
    // Forward-looking (work doc #28): when the boat is navigating this
    // route, the plan starts where the boat is — the sailed legs drop
    // out, and the trim point's distance along the original plan rides
    // the payload
    const trim = routeTrimFor(routeId, coordinates);
    if (trim) {
      coordinates = trim.coordinates;
      app.debug?.(
        `Briefing trimmed to route progress: ${trim.trimmedFromNm} nm in`,
      );
    }
    const waypoints = sampleRoutePoints(coordinates);
    lastCompiledWaypoints = waypoints;
    lastRouteWaypoints = waypoints;
    // Bulletins ride the same online window as the weather (SPEC §3.1
    // metareaBulletin): pulled first so this briefing carries them.
    // Offline both skip themselves and record checklist skips.
    await refreshBulletinsOnline("briefing", waypoints);
    await refreshSynopticsOnline("briefing", waypoints);
    let payload;
    try {
      payload = await withSourceStatus(WEATHER_SOURCE, () =>
        trackWeatherFetcher({ waypoints, forecastDays }),
      );
      if (payload?.metadata?.weatherApiFallback != null) {
        sourceStatus?.record({
          ...WEATHER_SOURCE,
          note: `Answered by Open-Meteo — Weather API: ${payload.metadata.weatherApiFallback}`,
        });
      }
    } catch (error) {
      if (!offline) {
        throw error;
      }
      // Offline and no local weather: serve the cache honestly
      // (work doc #55) instead of failing the request
      try {
        const cached = await loadPayload(app.getDataDirPath(), routeId);
        if (cached) {
          setStatus(`Offline: serving cached briefing for ${routeId}`);
          return {
            routeId,
            cached: true,
            cachedAt: cached.cachedAt,
            // runFetch's status line reads fetchedAt; the cache's own
            // stamp is the honest answer here too
            ...(cached.cachedAt != null ? { fetchedAt: cached.cachedAt } : {}),
            offline: true,
          };
        }
      } catch (_cacheError) {
        // Unreadable cache: the original failure stands
      }
      throw error;
    }
    if (offline) {
      // Mark the compile so the crew can see where its numbers
      // came from: the GRIB run already on board, not a live fetch
      payload.metadata.offlineCompile = true;
      setStatus(`Briefing for ${routeId} compiled from local GRIB (offline)`);
    }
    attachWeatherViewer(payload);
    const bulletin = await bulletinForTrack(waypoints);
    if (bulletin) {
      payload.metareaBulletin = bulletin;
    }
    await publishWarningsFor("route");
    // Space weather for the departure position (work doc #3):
    // fetched Phase-1 sources plus local Phase-2 ephemeris events,
    // all gated on the payload's own cloud cover; nightly moon and
    // twilight context rides along for the timeline's night glyphs.
    // The event window follows the plan's reachable horizon (work doc
    // #54): the simulation cannot sail past the fetched forecasts, so
    // events beyond them can never belong to any plan. Offline the
    // fetched sources are skipped and the ephemeris answers alone
    // (work doc #55).
    payload.spaceEvents = await fetchSpaceEvents({
      lat: waypoints[0].lat,
      lon: waypoints[0].lon,
      hours: forecastDays * 24,
      online: !offline,
      cloudCoverAt: ephemeris.cloudCoverLookup(payload),
      // Meteors ride the worker's track-positioned evaluation
      // (work doc #37) — fixed-position entries would double-report
      includeMeteors: false,
      dataDir: app.getDataDirPath(),
      spaceTrack: spaceTrackConfig,
      reentryEnabled: reentryWatchEnabled,
      launchEnabled: launchWatchEnabled,
      recordSource: (source, error, { absent = false, skip = false } = {}) => {
        if (source === "reentry") {
          if (absent) {
            sourceStatus?.record({ ...REENTRY_SOURCE, absent: true });
          } else if (skip) {
            sourceStatus?.record({ ...REENTRY_SOURCE, skip: true });
          } else {
            sourceStatus?.record(
              error ? { ...REENTRY_SOURCE, error } : REENTRY_SOURCE,
            );
          }
        } else if (source === "launch") {
          if (skip) {
            sourceStatus?.record({ ...LAUNCH_SOURCE, skip: true });
          } else {
            sourceStatus?.record(
              error ? { ...LAUNCH_SOURCE, error } : LAUNCH_SOURCE,
            );
          }
        }
      },
    });
    payload.celestialNights = await withSourceStatus(EPHEMERIS_SOURCE, () =>
      ephemeris.celestialNights({
        from: new Date(payload.metadata.fetchedAt),
        days: forecastDays,
        lat: waypoints[0].lat,
        lon: waypoints[0].lon,
        eyeHeightM: celestialEyeHeightM,
      }),
    );
    // Territorial waters transitions (work doc #17): corridor tiles
    // download during the online window; the boundary walk resamples
    // the route at ~1 nm so a short territorial hop is not missed.
    // Missing tiles, older Node or a failed download degrade to no
    // transitions — never a failed briefing. Offline the prefetch is
    // pointless; the walk runs on the tiles already on disk.
    try {
      if (!offline) {
        await maritimeZones.prefetchCorridor({
          dataDir: app.getDataDirPath(),
          waypoints,
        });
      }
      const dense = sampleRoutePoints(
        coordinates,
        maritimeZones.SAMPLE_INTERVAL_NM,
      );
      const transitions = await maritimeZones.detectTransitions({
        dataDir: app.getDataDirPath(),
        waypoints: dense,
      });
      if (transitions) {
        payload.zoneTransitions = transitions;
        payload.zoneDisclaimer = maritimeZones.ZONE_DISCLAIMER;
      }
    } catch (error) {
      app.debug?.(`Zone transitions failed: ${error.message}`);
    }
    // The departure the served schedule anchors to (work doc #15):
    // the auto daylight anchor — underway sails from now, night waits
    // for first light, day adds the prep delay unless the sun sets
    // within it. The webapp may override per view; external consumers
    // see numbers consistent with the auto assumption.
    try {
      if (departureConfig.daylightAuto) {
        const { assumedDepartureTime } = await import(
          "../public/sereno-physics.mjs"
        );
        const navState = observations[NAVIGATION_STATE_PATH];
        const underway =
          typeof navState === "string" &&
          !["moored", "anchored"].includes(navState);
        const { time, reason } = assumedDepartureTime({
          now: new Date(payload.metadata.fetchedAt),
          lat: waypoints[0].lat,
          lon: waypoints[0].lon,
          underway,
          prepHours: departureConfig.prepHours,
          dawnAltitudeDeg: departureConfig.dawnAltitudeDeg,
        });
        payload.departure = {
          assumed: true,
          time: time.toISOString(),
          reason,
        };
      }
    } catch (error) {
      app.debug?.(`Departure anchor failed: ${error.message}`);
    }
    await attachHazardEvents(payload, vesselPosition(), waypoints, {
      online: !offline,
    });
    // Energy forecast (work doc #10): rides the payload like the here
    // mode's, powering the 24 h strip; the outlook terms ride along
    payload.energyHourly = adaptEnergyForecast(
      observations[ENERGY_FORECAST_PATH],
    );
    attachEnergyToPayload(payload);
    await attachCapAlerts(payload, waypoints, { online: !offline });
    // Automatic synoptic front passages (work doc #50): detection
    // and tracking over the weather provider's grid caches for the
    // route area, crossings against the route simulation's own
    // schedule. Degrades to a bare, absent block — the briefing
    // never fails over it.
    if (frontsEnabled) {
      try {
        await frontsSource.attachFronts(payload, {
          waypoints,
          cacheRoot: frontsCacheRoot || null,
          dataDir: app.getDataDirPath(),
          app,
          config: simulationConfig,
          recordSource: (source) => sourceStatus?.record(source),
        });
      } catch (error) {
        app.debug?.(`Front passages failed: ${error.message}`);
      }
    }
    // Landfall map source availability (work doc #50 session): the
    // sightings are silently best-effort when the corridor DEM or
    // the Shortbread gazetteer is missing — the checklist says so
    // instead of the crew wondering.
    if (simulationConfig.landfall_enabled !== false) {
      try {
        await landfallSource.recordLandfallSource(app, (source) =>
          sourceStatus?.record(source),
        );
      } catch (error) {
        app.debug?.(`Landfall source check failed: ${error.message}`);
      }
    }
    // The trim point, when the plan anchored to actual progress (work
    // doc #28): the payload's distances count from the boat, and this
    // says how far along the original plan that was
    if (trim) {
      payload.trimmedFromNm = trim.trimmedFromNm;
    }
    await savePayload(app.getDataDirPath(), routeId, payload);
    await writeFile(
      join(app.getDataDirPath(), "weather", "last-route"),
      routeId,
    );
    // A newer GRIB cycle may publish after this compile: schedule the
    // catch-up refresh for this route (work doc #47 session)
    scheduleRunRefresh(
      { kind: "route", routeId, days: forecastDays },
      payload.metadata.cycleTime,
    );
    // Tile freshness (work doc #8): route name when resolvable
    let routeName = routeId;
    try {
      const route = await app.resourcesApi?.getResource?.("routes", routeId);
      routeName = route?.name ?? routeId;
    } catch (_error) {
      // Offline or missing resources API: the id still identifies it
    }
    payload.comfortTier = await currentComfortTier(payload);
    recordBriefCompile(
      payload.metadata.fetchedAt,
      routeName,
      payload.comfortTier,
      "route",
    );
    return {
      routeId,
      cached: true,
      cachedAt: payload.metadata.fetchedAt,
      fetchedAt: payload.metadata.fetchedAt,
      waypoints,
      ...(offline ? { offline: true } : {}),
    };
  }

  /**
   * Runs a weather fetch for the last briefed route (cron/oneshot
   * trigger). The multi-endpoint fetch lands in the briefing refresh;
   * the outcome is surfaced through the plugin status.
   *
   * The route being sailed wins; otherwise the last briefed one is
   * re-briefed. A route that has vanished from resources (deleted
   * after it was briefed) is skipped instead of failing every future
   * refresh — with no route left, conditions-here stays fresh (work
   * doc #7).
   *
   * @param {"oneshot"|"cron"|"position"} trigger
   */
  /** The most recent fetch run's promise: fire-and-forget callers
   * (the delta feed's oneshot, the cron tick) don't await it, but the
   * test harness needs to wait for the whole serialized chain to
   * settle (CI flake: fixed sleeps raced two sequential compiles). */
  let lastFetchRun = Promise.resolve();

  /** Active critical-hazard notifications by id (work doc #30) plus
   * per-id miss counters for the clear hysteresis. Acknowledgements
   * persist on disk (hazard-state.js): a crew ack must survive plugin
   * and server restarts — every restart re-alarming for a cyclone
   * already acknowledged is exactly the alarm fatigue the escalation
   * exists to avoid. Records carry the silenced alert level and the
   * distance at ack time, so a later red or a storm closed to half
   * the acked distance re-alarms. */
  const activeHazardNotifications = new Map();
  const hazardMissCounts = new Map();
  /** Loaded in start(): the plugin factory runs before the server
   * exposes getDataDirPath, and the state file needs the data dir.
   * The published map rides the same file: after a restart the
   * still-active notifications restore visually, not as fresh
   * alarms. */
  let acknowledgedHazards = new Map();
  let publishedHazardValues = new Map();
  /** Waypoints of the most recent compile (route or here): the
   * escalation's track reference between refreshes. */
  let lastCompiledWaypoints = null;
  /** Waypoints of the most recent ROUTE compile: the publication
   * track's route half (work doc #48) — warnings publish for the
   * waters the plan crosses plus the vessel's position, whichever
   * view triggered the pass. */
  let lastRouteWaypoints = null;

  async function runFetch(trigger) {
    if (!isOnline()) {
      sourceStatus?.record({ ...WEATHER_SOURCE, skip: true });
      setStatus(`Fetch skipped while offline (${trigger})`);
      return;
    }
    const lastRouteFile = join(app.getDataDirPath(), "weather", "last-route");
    let lastRouteId = null;
    try {
      lastRouteId = (await readFile(lastRouteFile, "utf8")).trim();
    } catch (_error) {
      lastRouteId = null;
    }
    const activeId = activeRouteId(observations[ACTIVE_ROUTE_PATH]);
    // A route the webapp served from nothing (requested offline,
    // work doc #55) outranks the last-briefed one but never the route
    // being sailed: the crew is explicitly looking at it, and once it
    // has a cache the marker dissolves back into the normal flow
    if (!activeId) {
      const requestedId = await readRequestedRoute();
      if (requestedId && requestedId !== lastRouteId) {
        const alreadyCached = await loadCachedPayload(requestedId);
        if (!alreadyCached) {
          try {
            const result = await refreshBriefing(requestedId);
            setStatus(
              `Briefing for ${requestedId} cached at ${result.fetchedAt ?? "unknown"} (${trigger})`,
            );
            await unlink(requestedRoutePath()).catch(() => {});
            return;
          } catch (error) {
            if (!/not found/i.test(error.message)) {
              app.error(
                `Briefing refresh failed (${trigger}): ${error.message}`,
              );
              setError(
                `Briefing refresh failed (${trigger}): ${error.message}`,
              );
              return;
            }
            // Requested route deleted before it was ever briefed
            app.debug?.(`Requested route ${requestedId} no longer exists`);
            await unlink(requestedRoutePath()).catch(() => {});
          }
        } else {
          // Briefed through some other path (manual update): the
          // marker has done its job
          await unlink(requestedRoutePath()).catch(() => {});
        }
      }
    }
    const candidates = [...new Set([activeId, lastRouteId].filter(Boolean))];
    for (const routeId of candidates) {
      try {
        const result = await refreshBriefing(routeId);
        setStatus(
          `Briefing for ${routeId} cached at ${result.fetchedAt ?? "unknown"} (${trigger})`,
        );
        return;
      } catch (error) {
        if (!/not found/i.test(error.message)) {
          app.error(`Briefing refresh failed (${trigger}): ${error.message}`);
          setError(`Briefing refresh failed (${trigger}): ${error.message}`);
          return;
        }
        // Route deleted since it was briefed: try the next candidate
        app.debug?.(`Route ${routeId} no longer exists (${trigger})`);
        if (routeId === lastRouteId && routeId !== activeId) {
          await unlink(lastRouteFile).catch(() => {});
        }
      }
    }
    try {
      const here = await refreshHere();
      setStatus(`Conditions here cached at ${here.cachedAt} (${trigger})`);
    } catch (error) {
      app.error(`Here refresh failed (${trigger}): ${error.message}`);
      setError(`Here refresh failed (${trigger}): ${error.message}`);
    }
  }

  /**
   * Staleness backstop: the regular triggers are edge-based — the
   * oneshot fires only when the internet state *changes* (including
   * the first observation after startup), and cron windows run only
   * in PERSISTENT_CRON (moored, charged). A server that stays up for
   * days while the link never flips and the machine sits in
   * STANDBY_OFFSHORE would otherwise keep serving a briefing that
   * silently slides days into the past. Runs from the one-minute
   * ticker: when online and the relevant cached briefing (active
   * route, else last briefed, else here) is older than the route TTL,
   * re-fetches it — at most once per retry interval, and only when
   * something is actually cached (fresh installs stay on the
   * oneshot).
   *
   * @param {Date} [now]
   */
  async function refreshIfStale(now = new Date()) {
    if (!isOnline() || now.getTime() - lastStaleRefreshAt < STALE_RETRY_MS) {
      return;
    }
    const activeId = activeRouteId(observations[ACTIVE_ROUTE_PATH]);
    let lastRouteId = null;
    try {
      lastRouteId = (
        await readFile(
          join(app.getDataDirPath(), "weather", "last-route"),
          "utf8",
        )
      ).trim();
    } catch (_error) {
      lastRouteId = null;
    }
    const candidates = [...new Set([activeId, lastRouteId].filter(Boolean))];
    let ageMs = null;
    for (const routeId of candidates) {
      try {
        const cached = await loadPayload(app.getDataDirPath(), routeId);
        const fetchedAt = cached?.payload?.metadata?.fetchedAt;
        if (fetchedAt) {
          ageMs = now.getTime() - new Date(fetchedAt).getTime();
          break;
        }
      } catch (_error) {
        // Unreadable or missing cache: try the next candidate
      }
    }
    // A requested route with no cache never ages fresh (work doc
    // #55): the crew asked for a briefing that does not exist yet
    const requestedId = await readRequestedRoute();
    if (
      requestedId &&
      !candidates.includes(requestedId) &&
      !(await loadCachedPayload(requestedId))
    ) {
      ageMs = ROUTE_TTL_MS;
    }
    if (ageMs == null) {
      try {
        const here = await loadHere();
        const fetchedAt = here?.payload?.metadata?.fetchedAt;
        if (fetchedAt) {
          ageMs = now.getTime() - new Date(fetchedAt).getTime();
        }
      } catch (_error) {
        ageMs = null;
      }
    }
    if (ageMs == null || ageMs < ROUTE_TTL_MS) {
      return;
    }
    lastStaleRefreshAt = now.getTime();
    await runFetch("stale");
  }

  /**
   * Publishes the tile's flat scalar paths over the Signal K stream
   * (work doc #8: tile data flows over the host bus relay — the
   * widget never calls REST).
   */
  /**
   * Publishes one critical-hazard notification as a Signal K delta
   * (work doc #30): every connected client — node dashboards, Vessel
   * Systems, mobile apps — sees it, not just this plugin's webapp.
   *
   * The publish gate is three-tier: a raise (first publish or state
   * change) carries visual+sound; an amendment (same state, new
   * message — GDACS refreshed the distance and impact figures)
   * carries visual only, updating the text without re-triggering
   * sounders; an identical value publishes nothing — re-sending the
   * same state with a fresh timestamp every tick re-alarms boards
   * that treat each value as news. A strictly higher GDACS level
   * (orange → red) publishes as a raise again.
   *
   * @param {string} id - Content-addressed event id
   * @param {{state: string, message: string, level?: string|null}|null}
   *   notification - The notification to raise, or null to clear
   *   (nominal)
   */
  function publishHazardNotification(id, notification) {
    if (typeof app.handleMessage !== "function") {
      return;
    }
    const state = notification ? notification.state : "normal";
    const message = notification ? notification.message : "";
    const level = notification?.level ?? null;
    const before = publishedHazardValues.get(id);
    const verdict = hazardAlerts.classifyPublish({ before, notification });
    if (!verdict.publish) {
      return; // Identical value: silence, not churn
    }
    publishedHazardValues.set(id, {
      state,
      message,
      level,
      at: new Date().toISOString(),
    });
    try {
      saveHazardState(
        app.getDataDirPath(),
        acknowledgedHazards,
        publishedHazardValues,
      );
    } catch (error) {
      app.debug?.(`Hazard state save failed: ${error.message}`);
    }
    app.handleMessage(PLUGIN_ID, {
      context: "vessels.self",
      updates: [
        {
          timestamp: new Date().toISOString(),
          values: [
            {
              path: `notifications.navigation.briefing.hazards.${id}`,
              value: notification
                ? {
                    state,
                    // Amendments and restart restores stay visual:
                    // the text moved on or the server lost the path,
                    // the sounders must not re-fire
                    method:
                      verdict.kind === "raise"
                        ? ["visual", "sound"]
                        : ["visual"],
                    message,
                    timestamp: new Date().toISOString(),
                  }
                : { state: "normal", method: [], message: "" },
            },
          ],
        },
      ],
    });
  }

  /**
   * The escalation runner (work doc #30): classifies the cached
   * warning stream (GDACS events, CAP alerts, bulletin blocks)
   * against the vessel's exposure and publishes Signal K
   * notifications for the qualifying subset. Runs on the ticker —
   * NOT internet-gated: a cached tsunami warning must still raise
   * its notification with the boat offline.
   *
   * Anti-flap (work doc #30): GDACS is fetched 12-hourly, but its
   * alert levels and titles flap between runs, and a compile can
   * switch the exposure reference — so once raised, a tropical
   * cyclone notification LATCHES: it stays warnable while the
   * cyclone still exists in the envelope at any GDACS level (the
   * wide green filter feeds `retainLatched`), clears only after an
   * hour out of the matrix, and GDACS refreshes amend the
   * notification text without re-raising it. Acknowledgements are
   * level- and distance-aware and persist on disk: only a strictly
   * higher level or a storm closed to half the acked distance
   * re-alarms.
   *
   * @param {Date} [now]
   * @returns {Promise<void>}
   */
  async function runHazardEscalation(now = new Date()) {
    if (!sourceStatus) {
      return;
    }
    const vessel = vesselPosition();
    if (!vessel) {
      return; // No position: exposure cannot be judged
    }
    const track = lastCompiledWaypoints?.length
      ? lastCompiledWaypoints.map((w) => [w.lon, w.lat])
      : [[vessel.lon, vessel.lat]];
    const gdacsWide = hazardSource.filterHazards({
      events: await hazardSource.loadHazards(app.getDataDirPath()),
      vessel,
      waypoints: lastCompiledWaypoints ?? [],
      // Wide pass: green and up. retainLatched keeps only the
      // fresh-escalation floor (orange) plus the cyclones this
      // vessel is already warned about, whose dips below orange
      // must not clear the notification
      minAlertLevel: "green",
      now,
    });
    const gdacsEvents = hazardAlerts.retainLatched({
      events: gdacsWide,
      previous: activeHazardNotifications,
      minLevel: "orange",
    });
    const capAlerts = capSource.filterCapAlerts({
      events: await capSource.loadCapAlerts(app.getDataDirPath()),
      track,
      minSeverity: capMinSeverity,
      now,
    });
    // Bulletin blocks: severe-class blocks whose native geometry
    // contains the vessel position now (direct-hit test)
    const bulletin = await bulletinForTrack(
      lastCompiledWaypoints ?? [
        { lat: vessel.lat, lon: vessel.lon, distanceFromStartNm: 0 },
      ],
    );
    const bulletinBlocks = (bulletin?.blocks ?? []).map((block) => ({
      ...block,
      id: `${bulletin.header ?? "bulletin"}|${block.text?.slice(0, 40) ?? ""}`,
      isSevere: () =>
        /\b(GALE|STORM|HURRICANE(?! CENTER)|TYPHOON)\b/i.test(block.text ?? ""),
      containsPoint: (lon, lat) => {
        if (block.geometry?.type !== "polygon") {
          return false;
        }
        const { ringContains } = require("./bulletin-engine.js");
        return ringContains(block.geometry.coordinates, lon, lat);
      },
    }));
    const escalations = hazardAlerts.escalateHazards({
      gdacsEvents,
      capAlerts,
      bulletinBlocks,
      vessel,
      navigationState: observations[NAVIGATION_STATE_PATH],
      hasDepthReading: typeof observations[DEPTH_PATH] === "number",
      now,
    });
    const { active, cleared } = hazardAlerts.applyHysteresis({
      previous: activeHazardNotifications,
      current: escalations,
      missCounts: hazardMissCounts,
    });
    for (const [id, notification] of active) {
      if (
        !hazardAlerts.shouldRaise({
          notification,
          ack: acknowledgedHazards.get(id),
        })
      ) {
        continue; // Acked at this level and distance: stay silent
      }
      publishHazardNotification(id, notification);
    }
    for (const id of cleared) {
      if (activeHazardNotifications.has(id)) {
        publishHazardNotification(id, null); // Back to nominal
        // The ack survives the clear: a source dip that outlasts the
        // grace must not resurrect the alarm when the event returns
      }
    }
    activeHazardNotifications.clear();
    for (const [id, notification] of active) {
      activeHazardNotifications.set(id, notification);
    }
  }

  /**
   * Acknowledges one critical-hazard notification (work doc #30): the
   * notification returns to nominal and the ack persists on disk
   * with the silenced level and the distance at ack time — restarts
   * stay quiet, a later red or a storm closed to half the acked
   * distance re-alarms.
   *
   * @param {string} id - Event id (without the ack prefix)
   */
  function acknowledgeHazard(id) {
    const wanted = String(id);
    let recorded = false;
    for (const key of [...activeHazardNotifications.keys()]) {
      // The notification id embeds the event id; a partial match is
      // enough (the webapp sends the event id from the message data)
      if (key.includes(wanted)) {
        publishHazardNotification(key, null);
        const notification = activeHazardNotifications.get(key);
        acknowledgedHazards.set(key, {
          level: notification?.level ?? null,
          distanceNm: notification?.distanceNm ?? null,
          at: new Date().toISOString(),
        });
        recorded = true;
      }
    }
    if (!recorded) {
      // No active match (the notification already cleared): record
      // the ack as given so a prompt return stays silent
      acknowledgedHazards.set(wanted, {
        level: null,
        distanceNm: null,
        at: new Date().toISOString(),
      });
    }
    try {
      saveHazardState(
        app.getDataDirPath(),
        acknowledgedHazards,
        publishedHazardValues,
      );
    } catch (error) {
      app.debug?.(`Hazard state save failed: ${error.message}`);
    }
  }

  function publishBriefMeta() {
    if (typeof app.handleMessage !== "function") {
      return;
    }
    const hasNew =
      briefMeta.generatedAt != null &&
      (lastAckAt == null || briefMeta.generatedAt > lastAckAt);
    const view = briefMetaView();
    app.handleMessage(PLUGIN_ID, {
      context: "vessels.self",
      updates: [
        {
          timestamp: new Date().toISOString(),
          values: [
            {
              path: BRIEF_GENERATED_AT_PATH,
              value: view.generatedAt,
            },
            { path: BRIEF_ROUTE_PATH, value: view.route },
            { path: BRIEF_COMFORT_PATH, value: view.comfort },
            { path: BRIEF_STALE_PATH, value: view.stale },
            { path: BRIEF_AGE_HOURS_PATH, value: view.ageHours },
            { path: BRIEF_HAS_NEW_PATH, value: hasNew },
          ],
        },
      ],
    });
  }

  /**
   * Records the compiled-brief freshness (refresh paths) and pushes
   * it to the tile.
   *
   * @param {string|null} generatedAt
   * @param {string|null} route - Route name; empty string in here mode
   */
  /**
   * The tile/meta view: current values plus the freshness verdict,
   * shared by the bus publication and GET /api/brief-meta so every
   * consumer sees the same numbers.
   *
   * @param {Date} [now]
   * @returns {object} generatedAt/route/comfort/stale/ageHours/hasNew
   */
  function briefMetaView(now = new Date()) {
    const ageMs =
      briefMeta.generatedAt != null
        ? now.getTime() - new Date(briefMeta.generatedAt).getTime()
        : null;
    const ttl = briefMeta.mode === "route" ? ROUTE_TTL_MS : HERE_TTL_MS;
    const stale = ageMs != null && ageMs > ttl;
    const ageHours =
      ageMs != null ? Math.round((ageMs / 3600000) * 10) / 10 : null;
    const hasNew =
      briefMeta.generatedAt != null &&
      (lastAckAt == null || briefMeta.generatedAt > lastAckAt);
    return {
      generatedAt: briefMeta.generatedAt,
      route: briefMeta.route,
      comfort: briefMeta.comfort,
      stale,
      ageHours,
      hasNew,
    };
  }

  function recordBriefCompile(
    generatedAt,
    route,
    comfort = null,
    mode = "here",
  ) {
    briefMeta.generatedAt = generatedAt;
    briefMeta.route = route;
    briefMeta.comfort = comfort;
    briefMeta.mode = mode;
    publishBriefMeta();
  }

  /**
   * Restores the acknowledged timestamp and seeds the tile with the
   * freshest cached compile (route briefing or here payload) after a
   * restart.
   */
  async function seedBriefMeta() {
    try {
      lastAckAt = JSON.parse(
        await readFile(
          join(app.getDataDirPath(), "weather", "ack.json"),
          "utf8",
        ),
      ).acknowledgedAt;
    } catch (_error) {
      lastAckAt = null;
    }
    try {
      const routeId = (
        await readFile(
          join(app.getDataDirPath(), "weather", "last-route"),
          "utf8",
        )
      ).trim();
      const cached = await loadPayload(app.getDataDirPath(), routeId);
      if (cached?.payload?.metadata?.fetchedAt) {
        let name = routeId;
        try {
          const route = await app.resourcesApi?.getResource?.(
            "routes",
            routeId,
          );
          name = route?.name ?? routeId;
        } catch (_error) {
          // Offline or missing resources API: the id still identifies it
        }
        recordBriefCompile(
          cached.payload.metadata.fetchedAt,
          name,
          cached.payload.comfortTier ?? null,
          "route",
        );
        return;
      }
    } catch (_error) {
      // No last-route: fall through to the here payload
    }
    try {
      const here = await loadHere();
      if (here?.payload?.metadata?.fetchedAt) {
        recordBriefCompile(
          here.payload.metadata.fetchedAt,
          "",
          here.payload.comfortTier ?? null,
          "here",
        );
      }
    } catch (_error) {
      // Nothing cached at all: tile stays muted
    }
  }

  /**
   * Feeds a Signal K delta into the observation cache and re-evaluates
   * the state machine.
   *
   * @param {object} delta - Signal K delta message
   */
  function feedDelta(delta) {
    for (const update of delta.updates || []) {
      for (const { path, value } of update.values || []) {
        if (WATCHED_PATHS.includes(path)) {
          observations[path] = value;
        }
        if (
          path === POSITION_PATH &&
          positionFetchPending &&
          isOnline() &&
          typeof value?.latitude === "number" &&
          typeof value?.longitude === "number"
        ) {
          // The missing fix has arrived (issue #3): re-run the fetch
          // the failed attempt stood in for. One retry per failure —
          // a second failure re-arms through refreshHereQueued.
          positionFetchPending = false;
          lastAutoFetchAt = Date.now();
          lastFetchRun = runFetch("position").catch(() => {});
        }
      }
    }
    const result = stateMachine.update({
      internetState: observations[INTERNET_STATE_PATH],
      navigationState: observations[NAVIGATION_STATE_PATH],
      soc: observations[HOUSE_SOC_PATH],
    });
    if (result.fetch === "oneshot") {
      const now = Date.now();
      if (
        lastAutoFetchAt != null &&
        now - lastAutoFetchAt < AUTO_FETCH_DEBOUNCE_MS
      ) {
        app.debug?.(
          `Oneshot fetch debounced (${Math.round(
            (now - lastAutoFetchAt) / 60000,
          )} min since the last automatic fetch)`,
        );
        return;
      }
      lastAutoFetchAt = now;
      lastFetchRun = runFetch("oneshot").catch(() => {});
    }
  }

  /** Startup grace (ms) before the delta-fed path sources are
   * recorded in the status registry (work doc #23, bergie session
   * note): the server replays current values to new subscriptions a
   * few seconds after start-up, and a snapshot taken before that
   * replay would record a transient failure/absence for paths that
   * are actually fine — navigation.state is the known case.
   * Non-path sources (resources, plugin-provided) record from the
   * first tick. */
  const PATH_SOURCE_GRACE_MS = 2 * 60 * 1000;
  let startedAt = Date.now();

  /**
   * Records the Signal K source availability in the source status
   * registry (work doc #23): the checklist also covers the server
   * side — the subscribed paths the state machine and the payload
   * compile consume, and the resource sources the briefing depends
   * on. A required path with no value since startup reads as a
   * failure (`unavailable`); an optional source that is simply not
   * there (companion plugin not installed, no route being sailed)
   * records as absent — information, not an error.
   *
   * Runs from the cron ticker: delta-fed path sources are skipped
   * during the startup grace period, in which the server replays
   * current values to the new subscriptions.
   *
   * @param {Date} [now]
   */
  async function recordSignalKSources(now = new Date()) {
    if (!sourceStatus) {
      return;
    }
    const unwrap = (v) =>
      v && typeof v === "object" && v.value !== undefined ? v.value : v;
    const selfPath = (path) =>
      typeof app.getSelfPath === "function"
        ? unwrap(app.getSelfPath(path))
        : null;
    // Delta-fed paths: during the startup grace the server has not
    // replayed current values yet, so a snapshot here would lie about
    // sources that are about to populate (navigation.state arrives a
    // few seconds in). Skip them; they record from the next tick.
    if (now.getTime() - startedAt >= PATH_SOURCE_GRACE_MS) {
      const pathSources = [
        {
          id: "sk-internet-state",
          path: INTERNET_STATE_PATH,
          label: "Internet state (signalk-internet)",
          required: true,
        },
        {
          id: "sk-navigation-state",
          path: NAVIGATION_STATE_PATH,
          label: "Navigation state",
          // Optional: many boats never publish navigation.state, and
          // everything that reads it degrades gracefully — the state
          // machine fetches regardless (unset ≠ moored), and the
          // departure anchor treats unset as not underway (work doc
          // #15). A FAIL here would be a permanent false alarm.
          required: false,
        },
        {
          id: "sk-house-soc",
          path: HOUSE_SOC_PATH,
          label: "House battery SoC",
          required: true,
        },
        {
          id: "sk-active-route",
          path: ACTIVE_ROUTE_PATH,
          label: "Active route",
          required: false,
        },
        {
          id: "sk-energy-prediction",
          path: ENERGY_FORECAST_PATH,
          label: "Energy outlook (energy-predictor)",
          required: false,
        },
      ];
      for (const source of pathSources) {
        const missing = observations[source.path] == null;
        sourceStatus.record({
          id: source.id,
          label: source.label,
          kind: "signalk",
          url: source.path,
          ...(missing
            ? source.required
              ? {
                  error: new Error("No value received since startup"),
                  errorClass: "unavailable",
                }
              : { absent: true }
            : {}),
          now,
        });
      }
    }
    // Resource-side sources
    const routesAvailable =
      typeof app.resourcesApi?.getResource === "function" &&
      typeof app.resourcesApi?.listResources === "function";
    sourceStatus.record({
      id: "sk-routes-resources",
      label: "Route resources",
      kind: "signalk",
      url: "resources/routes",
      ...(routesAvailable
        ? {}
        : {
            error: new Error("Resources API not available on this server"),
            errorClass: "unavailable",
          }),
      now,
    });
    // Optional sources: present or absent, never failed
    const optionalSelfPaths = [
      {
        id: "sk-polar",
        path: "polars.activePolar",
        label: "Active polar (polar-management)",
      },
      {
        id: "sk-ships-time",
        path: "environment.time.timezoneOffset",
        label: "Ship's time (signalk-ships-time)",
      },
    ];
    for (const source of optionalSelfPaths) {
      sourceStatus.record({
        id: source.id,
        label: source.label,
        kind: "signalk",
        url: source.path,
        ...(selfPath(source.path) == null ? { absent: true } : {}),
        now,
      });
    }
  }

  /**
   * Sail inventory keys (from `@signalk/sailsconfiguration`) used to
   * filter free-text noise out of manually edited log entries. Empty
   * set when no inventory is configured: everything then parses.
   *
   * @returns {Promise<Set<string>>}
   */
  async function knownSailKeys() {
    const configPath = app.config?.configPath ?? app.dataDir;
    const sails = await readSailsConfiguration(
      join(configPath, "plugin-config-data", "sailsconfiguration.json"),
    );
    // Empty inventory means no filter: every component parses
    return sails.length > 0
      ? new Set(sails.map((sail) => sail.nameKey))
      : undefined;
  }

  const plugin = {
    id: PLUGIN_ID,
    name: "Passage Briefing",
    description:
      "Offshore passage daily briefing: multi-model weather outlook, comfort " +
      "physics and learned sail preferences",
    // Test seam: shift the start-up instant so the source-status grace
    // period can be traversed deterministically
    __setStartedAt: (value) => {
      startedAt = value;
    },
    // Test seam: resolves when the most recent fire-and-forget fetch
    // run and the serialized refresh chain behind it have settled
    __settle: async () => {
      await lastFetchRun;
      await refreshChain;
    },

    schema: {
      type: "object",
      properties: {
        motoring_tws_threshold: {
          type: "number",
          title: "Becalmed Wind Threshold (knots)",
          description:
            "True wind below which the plan drifts (drift mode on) or " +
            "motors — the becalmed case. Above it, the engine decision " +
            "is speed-based, not wind-based.",
          default: DEFAULTS.motoring_tws_threshold,
        },
        motoring_speed_threshold: {
          type: "number",
          title: "Motoring Speed Threshold (knots)",
          description:
            "The engine's fallback bar: when the achieved speed — polar " +
            "speed on course, or VMG while beating in irons — drops " +
            "below this, the motor comes on (work doc #49).",
          default: DEFAULTS.motoring_speed_threshold,
        },
        downwind_night_policy: {
          type: "string",
          title: "Downwind Sail Night Policy",
          enum: ["continue", "break"],
          description:
            '"continue" (default): night hours keep an open downwind-sail ' +
            'deployment — night flying when squall risk is low. "break": dusk ' +
            "ends the deployment, reefable white sails carry the dark period, " +
            "dawn may re-open.",
          default: DEFAULTS.downwind_night_policy,
        },
        drift_mode_enabled: {
          type: "boolean",
          title: "Enable Drift Mode (Zero Fuel / Current Drift)",
          default: DEFAULTS.drift_mode_enabled,
        },
        motor_fuel_l_per_hour: {
          type: "number",
          title: "Motor Fuel Consumption (liters per hour)",
          description:
            "Burn rate of the auxiliary at its passage speed, used when " +
            "drift mode is off and the wind is below the motoring threshold.",
          default: DEFAULTS.motor_fuel_l_per_hour,
        },
        waterline_length_m: {
          type: "number",
          title: "Waterline Length (meters, gap-filler)",
          description:
            "Drives the legacy motion kernel's pitching resonance and " +
            "the hull kernel's LWL. The vessel's published Signal K " +
            "design.length waterline wins when present (its LOA is " +
            "the coarsest fallback); this only gap-fills for boats " +
            "that publish neither.",
          default: DEFAULTS.waterline_length_m,
        },
        hull_beam_m: {
          type: "number",
          title: "Hull Beam (meters, gap-filler)",
          description:
            "Beam of the boat for the hull-grounded motion model " +
            "(work doc #56). The vessel's published Signal K " +
            "design.beam wins when present; this is only used when " +
            "the boat does not publish it — a missing value keeps the " +
            "hour on the legacy comfort kernel.",
          default: DEFAULTS.hull_beam_m,
        },
        hull_canoe_draft_m: {
          type: "number",
          title: "Canoe-body Draught (meters, gap-filler)",
          description:
            "Hull-body draught without appendages — NOT the maximum " +
            "draft with the keel. Only used when Signal K " +
            "design.draft.canoe is not published.",
          default: DEFAULTS.hull_canoe_draft_m,
        },
        hull_displacement_kg: {
          type: "number",
          title: "Displacement (kg, gap-filler)",
          description:
            "Light-ship displacement in kilograms for the motion " +
            "model. Signal K design.displacement wins when present; " +
            "few boats publish it, so set it here for the spectral " +
            "kernel (Jensen, Mansour & Olsen 2004 hull motions) to run.",
          default: DEFAULTS.hull_displacement_kg,
        },
        hull_gm_m: {
          type: "number",
          title: "Metacentric Height GM (meters)",
          description:
            "Transverse metacentric height from the boat's stability " +
            "data — the boat's stiffness. Signal K publishes no GM " +
            "field. The roll natural period derived from it follows " +
            "the IMO ship formula, which runs short for heavy " +
            "full-keel yachts; if you can, set the measured period " +
            "(next setting) instead. Either missing or 0 disables the " +
            "RMS roll figure and the deck-work roll flag while " +
            "vertical acceleration still runs.",
          default: DEFAULTS.hull_gm_m,
        },
        hull_roll_period_s: {
          type: "number",
          title: "Roll Natural Period (seconds, measured)",
          description:
            "The boat's free roll period, timed at the still dock: " +
            "push the shrouds (or swing crew weight) and count full " +
            "cycles — seconds total divided by cycles. Directly " +
            "measurable without any stability docs, and preferred " +
            "over the GM-derived period because it is the boat's own " +
            "number; heavy full-keel cruisers typically sit at 4–5 s. " +
            "0 (default) derives it from GM, or disables roll if " +
            "neither is set.",
          default: DEFAULTS.hull_roll_period_s,
        },
        hull_accel_point_m: {
          type: "number",
          title: "Acceleration Evaluation Point (meters forward of CoG)",
          description:
            "Where on board the vertical acceleration is evaluated: " +
            "0 = amidships, positive forward (the after cockpit sits " +
            "around −2). Pitch lever on the motion the crew feels.",
          default: DEFAULTS.hull_accel_point_m,
        },
        hull_type: {
          type: "string",
          title: "Hull Type",
          enum: ["", "monohull", "catamaran", "trimaran"],
          description:
            "Hull form. The comfort scale is monohull-adapted; a known " +
            "catamaran or trimaran keeps the briefing to the legacy " +
            "motion kernel and the UI says the motion numbers do not " +
            "apply. Empty = unknown (treated as the monohull this " +
            "plugin is built for).",
          default: DEFAULTS.hull_type,
        },
        spool_directory: {
          type: "string",
          title: "Local GRIB/Text Ingestion Directory",
          default: DEFAULTS.spool_directory,
        },
        k_heel: {
          type: "number",
          title: "Heeling Acceleration Multiplier Constant",
          default: DEFAULTS.k_heel,
        },
        k_pitch: {
          type: "number",
          title: "Pitching Acceleration Multiplier Constant",
          default: DEFAULTS.k_pitch,
        },
        lines_of_interest_enabled: {
          type: "boolean",
          title: "Lines of Interest (ceremonial crossings)",
          description:
            "Detect equator, tropic, polar-circle, prime-meridian and " +
            "antimeridian crossings along the planned route.",
          default: DEFAULTS.lines_of_interest_enabled,
        },
        landfall_enabled: {
          type: "boolean",
          title: "Landfall sightings (visual horizon)",
          description:
            "Where and when topography first breaks the visual horizon " +
            "along the planned course, named from the corridor DEM and " +
            "its vector place names.",
          default: DEFAULTS.landfall_enabled,
        },
        height_of_eye_m: {
          type: "number",
          title: "Landfall Height of Eye (meters)",
          description:
            "Observer height above the water for the visual-horizon " +
            "distance: land at height H appears at 2.08·(√h+√H) nm.",
          default: DEFAULTS.height_of_eye_m,
        },
        landfall_max_range_nm: {
          type: "number",
          title: "Landfall Scan Range (nm)",
          default: DEFAULTS.landfall_max_range_nm,
        },
        landfall_min_offshore_hours: {
          type: "number",
          title: "Landfall Minimum Offshore Hours",
          description:
            "Land becomes a reported sighting only after this many hours " +
            "with nothing within the visual horizon — coasting an island " +
            "does not repeat the announcement.",
          default: DEFAULTS.landfall_min_offshore_hours,
        },
        hazard_events_enabled: {
          type: "boolean",
          title: "GDACS Hazard Events (earthquakes, cyclones, floods)",
          description:
            "Poll the GDACS feed during the online window and surface " +
            "events near the vessel or route in the briefing and as " +
            "chart notes.",
          default: DEFAULTS.hazard_events_enabled,
        },
        hazard_min_alert_level: {
          type: "string",
          title: "Minimum GDACS Alert Level",
          description:
            "Green is informational; Orange severe; Red extreme. Only " +
            "events at or above this level surface in the briefing.",
          enum: ["green", "orange", "red"],
          default: DEFAULTS.hazard_min_alert_level,
        },
        hazard_radius_offroute_nm: {
          type: "number",
          title: "Hazard Off-route Radius (nm)",
          description:
            "Events within this distance of the route corridor surface " +
            "in the briefing.",
          default: DEFAULTS.hazard_radius_offroute_nm,
        },
        hazard_radius_ahead_nm: {
          type: "number",
          title: "Hazard Vessel Radius (nm)",
          description:
            "Events within this distance of the vessel itself surface " +
            "in the briefing, regardless of the route.",
          default: DEFAULTS.hazard_radius_ahead_nm,
        },
        hazard_max_age_hours: {
          type: "number",
          title: "Hazard Event Aging (hours)",
          description:
            "Events older than this drop out of the briefing and the " +
            "chart notes.",
          default: DEFAULTS.hazard_max_age_hours,
        },
        fronts_enabled: {
          type: "boolean",
          title: "Automatic Front Passages (GRIB)",
          description:
            "Detect synoptic fronts and troughs in the GRIB run the " +
            "weather provider has on board and time their crossings of " +
            "the planned route on the timeline. Automatic analysis, " +
            "informational only — the official charts stay " +
            "authoritative. Degrades to absent without GRIB caches.",
          default: DEFAULTS.fronts_enabled,
        },
        fronts_cache_root: {
          type: "string",
          title: "GRIB Cache Root (optional)",
          description:
            "Where signalk-grib-weather-provider keeps its .gribcache " +
            "trees. Empty uses the default location beside this " +
            "plugin's data directory.",
          default: DEFAULTS.fronts_cache_root,
        },
        departure_daylight_auto: {
          type: "boolean",
          title: "Anchor Departure to Daylight (auto)",
          description:
            "While the boat is moored, anchor the forecast timeline to a " +
            "realistic departure: next civil dawn at night, prep delay " +
            "during the day, next dawn when the sun would set within the " +
            "prep window. The crew can override per view.",
          default: DEFAULTS.departure_daylight_auto,
        },
        departure_prep_hours: {
          type: "number",
          title: "Departure Prep Delay (hours)",
          description:
            "Assumed time between deciding to leave and casting off " +
            "(0.5–3 h).",
          default: DEFAULTS.departure_prep_hours,
        },
        departure_dawn_altitude_deg: {
          type: "number",
          title: "First Light Sun Altitude (degrees)",
          description:
            "Sun altitude defining first light for the departure anchor " +
            "(−6° = civil dawn).",
          default: DEFAULTS.departure_dawn_altitude_deg,
        },
        departure_days: {
          type: "number",
          title: "Departure Variant Days",
          description:
            "How many departure days the route switcher offers while " +
            "stationary: today plus the +24 h/+48 h/… candidates, each " +
            "the daylight-anchored departure of its own day. The latest " +
            "candidate also needs the forecast horizon to cover its " +
            "arrival.",
          default: DEFAULTS.departure_days,
        },
        forecast_days: {
          type: "number",
          title: "Forecast Horizon (days)",
          description:
            "How many days of weather each route briefing fetches. Every " +
            "extra day costs a fetch per waypoint per refresh — and is " +
            "what makes late departure variants (work doc #34) simulable " +
            "instead of disabled beyond forecast.",
          default: DEFAULTS.forecast_days,
        },
        celestial_eye_height_m: {
          type: "number",
          title: "Eye Height Above Water (meters)",
          description:
            "Height of the observer's eye above the water (0–10 m). " +
            "Sunrise, sunset and moonrise/set stamps in the briefing " +
            "correct for the dip of the vessel's raised horizon.",
          default: DEFAULTS.celestial_eye_height_m,
        },
        reentry_watch_enabled: {
          type: "boolean",
          title: "Reentry watch (decaying satellites)",
          description:
            "Predicted satellite reentries from Space-Track, alerted " +
            "when the ground track comes close enough to see and the " +
            "light is right (fireball at night, sunlit smoke streak by " +
            "day). Needs a free space-track.org account below.",
          default: DEFAULTS.reentry_watch_enabled,
        },
        space_track_identity: {
          type: "string",
          title: "Space-Track username",
          description:
            "Free account at space-track.org — the only machine-" +
            "readable source of reentry predictions.",
          default: "",
        },
        space_track_password: {
          type: "string",
          format: "password",
          title: "Space-Track password",
          default: "",
        },
        launch_watch_enabled: {
          type: "boolean",
          title: "Visible rocket launches",
          description:
            "Twilight launches from pads within range (Launch Library " +
            "2), when the plume would catch the sun from the vessel.",
          default: DEFAULTS.launch_watch_enabled,
        },
        cap_enabled: {
          type: "boolean",
          title: "CAP Official Alerts (structured warnings)",
          description:
            "Fetch OASIS CAP 1.2 feeds during the online window and " +
            "surface alerts near the vessel or route as Official " +
            "Alerts and chart notes. Tsunami warnings are the " +
            "canonical use.",
          default: DEFAULTS.cap_enabled,
        },
        cap_urls: {
          type: "array",
          title: "CAP Feed URLs",
          description:
            "Direct CAP documents (e.g. the tsunami.gov PHEBCAP feed) " +
            "or RSS aggregations whose items link to CAP documents " +
            "(Filtered Alert Hub per-country feeds).",
          items: { type: "string" },
          default: DEFAULTS.cap_urls,
        },
        cap_min_severity: {
          type: "string",
          title: "Minimum CAP Severity",
          description:
            "CAP's own severity vocabulary: Minor, Moderate, Severe, " +
            "Extreme. Only alerts at or above this level surface.",
          enum: ["Minor", "Moderate", "Severe", "Extreme"],
          default: DEFAULTS.cap_min_severity,
        },
        bulletin_urls: {
          type: "array",
          title: "High Seas Bulletin Sources (NAVAREA / HSF text)",
          description:
            "Plain-text or api.weather.gov product URLs, filtered per " +
            "route and cached. Add the METAREA XIV source when verified.",
          items: { type: "string" },
          default: DEFAULTS.bulletin_urls,
        },
        bulletin_stations: {
          type: "array",
          title: "TGFTP Bulletin Stations (zone fast path)",
          description:
            "Station→zone table for the NOAA TGFTP raw-text fast path " +
            "(work doc #9), fetched before the GMDSS portal fallback.",
          items: {
            type: "object",
            properties: {
              zone: { type: "number", title: "GMDSS zone number" },
              header: {
                type: "string",
                title: "WMO header (e.g. FQPS01)",
              },
              station: {
                type: "string",
                title: "Station id (e.g. NFFN)",
              },
            },
          },
          default: DEFAULTS.bulletin_stations,
        },
        publish_metarea_notes: {
          type: "boolean",
          title: "Publish METAREA warnings as chart notes",
          description:
            "Write the geographically filtered warning blocks to the " +
            "server's resources/notes so chart plotters show them.",
          default: DEFAULTS.publish_metarea_notes,
        },
        weather_source: {
          type: "string",
          title: "Weather Source",
          description:
            "auto prefers the server Weather API (signalk-weather-router-plus " +
            "when installed) and falls back to Open-Meteo; the forced " +
            "choices never fall back.",
          enum: ["auto", "weather-api", "open-meteo"],
          default: DEFAULTS.weather_source,
        },
      },
    },

    /**
     * @param {object} options - Persisted plugin configuration
     */
    start: (options) => {
      const config = { ...DEFAULTS, ...(options || {}) };
      // The downwind sail inventory for the deployment advisor (work
      // doc #41): read once, async — the advisor stays silent until
      // it lands rather than recommending canvas the boat may not
      // carry.
      readSailsConfiguration(
        join(
          app.config?.configPath ?? app.getDataDirPath(),
          "plugin-config-data",
          "sailsconfiguration.json",
        ),
      )
        .then((sails) => {
          downwindSailCache = downwindAdvisorSails(sails);
          simulationConfig.downwindSails = downwindSailCache;
        })
        .catch(() => {
          // Absent inventory: no downwind recommendations
        });
      bulletinUrls = Array.isArray(config.bulletin_urls)
        ? config.bulletin_urls
        : [];
      publishNotesEnabled = config.publish_metarea_notes !== false;
      // GDACS hazard events (work doc #22): one switch covers the
      // feed, the briefing surface and the chart notes
      hazardEventsEnabled = config.hazard_events_enabled !== false;
      hazardFilterConfig = {
        minAlertLevel: config.hazard_min_alert_level,
        offRouteRadiusNm: config.hazard_radius_offroute_nm,
        aheadRadiusNm: config.hazard_radius_ahead_nm,
        maxAgeHours: config.hazard_max_age_hours,
      };
      capEnabled = config.cap_enabled !== false;
      capUrls = Array.isArray(config.cap_urls)
        ? config.cap_urls.filter((url) => typeof url === "string" && url)
        : [];
      capMinSeverity = config.cap_min_severity;
      // Automatic front passages (work doc #50): on unless switched
      // off; the cache root override points at a provider cache
      // tree outside the default location.
      frontsEnabled = config.fronts_enabled !== false;
      frontsCacheRoot =
        typeof config.fronts_cache_root === "string"
          ? config.fronts_cache_root
          : "";
      departureConfig = {
        daylightAuto: config.departure_daylight_auto !== false,
        prepHours: config.departure_prep_hours,
        dawnAltitudeDeg: config.departure_dawn_altitude_deg,
      };
      // Eye height above the water (work doc #35): rise/set stamps
      // correct for the dip of the vessel's raised horizon
      celestialEyeHeightM =
        Number.isFinite(config.celestial_eye_height_m) &&
        config.celestial_eye_height_m > 0 &&
        config.celestial_eye_height_m <= 10000
          ? config.celestial_eye_height_m
          : 0;
      // Reentry + launch watch (work doc #36): Space-Track TIP
      // predictions under the vessel's own account, and the Launch
      // Library 2 schedule; both degrade to no events without data
      reentryWatchEnabled = config.reentry_watch_enabled !== false;
      spaceTrackConfig = {
        identity:
          typeof config.space_track_identity === "string"
            ? config.space_track_identity.trim()
            : "",
        password:
          typeof config.space_track_password === "string"
            ? config.space_track_password
            : "",
      };
      launchWatchEnabled = config.launch_watch_enabled !== false;
      // Weather source (work doc #16): the server's Weather API when
      // present (signalk-weather-router-plus registers a provider over
      // its decoded ECMWF run), Open-Meteo per config or fallback.
      // A weather-api request without the provider installed degrades
      // to Open-Meteo for this session instead of killing start() —
      // the console, bulletins and hazard escalation ride the same
      // plugin, and none of them should die over a weather source.
      try {
        trackWeatherFetcher = createWeatherFetcher({
          weatherApi: app.weatherApi,
          weatherSource: config.weather_source,
          isOnline,
        });
      } catch (error) {
        app.error(
          `Weather source misconfigured: ${error.message} — falling back to Open-Meteo`,
        );
        trackWeatherFetcher = createWeatherFetcher({
          weatherApi: app.weatherApi,
          weatherSource: "open-meteo",
          isOnline,
        });
      }
      // Boot scheduling (work doc #47 session): the cached here
      // payload's GRIB cycle anchors a catch-up refresh for runs that
      // published after the last compile; route compiles schedule
      // their own
      void (async () => {
        try {
          const cached = await loadHere();
          scheduleRunRefresh(
            { kind: "here" },
            cached?.payload?.metadata?.cycleTime,
          );
        } catch (_error) {
          // No cached here payload yet: the first compile schedules
        }
      })();
      bulletinStations = Array.isArray(config.bulletin_stations)
        ? config.bulletin_stations.filter(
            (station) =>
              station &&
              Number.isFinite(station.zone) &&
              typeof station.header === "string" &&
              typeof station.station === "string",
          )
        : [];
      // Spool ingestion (SPEC §2.2): files the HF gateway drops into
      // the spool directory ride the same bulletin cache and warning
      // publication as the online fetches — the offline lifeline the
      // configuration knob has always described
      spoolDirectory =
        typeof config.spool_directory === "string" && config.spool_directory
          ? config.spool_directory
          : DEFAULTS.spool_directory;
      spoolWatcher = createSpoolWatcher({
        dir: spoolDirectory,
        onChange: () => {
          void ingestSpool("watch");
        },
      });
      // Departure-day variants (work doc #34): the candidate-day count
      // the route switcher offers, clamped to a sane range
      const departureDays = Math.min(
        Math.max(Math.round(Number(config.departure_days) || 4), 1),
        7,
      );
      // Forecast horizon (days): the fetch weight knob. The default
      // stays the historical 7 — a late departure variant wants more
      simulationForecastDays = Math.min(
        Math.max(Math.round(Number(config.forecast_days) || 7), 1),
        16,
      );
      simulationConfig = {
        motoring_tws_threshold: config.motoring_tws_threshold,
        motoring_speed_threshold: config.motoring_speed_threshold,
        drift_mode_enabled: config.drift_mode_enabled,
        motor_fuel_l_per_hour: config.motor_fuel_l_per_hour,
        waterline_length_m: config.waterline_length_m,
        k_heel: config.k_heel,
        k_pitch: config.k_pitch,
        hull_lwl_m: Number(config.hull_lwl_m) || 0,
        hull_beam_m: Number(config.hull_beam_m) || 0,
        hull_canoe_draft_m: Number(config.hull_canoe_draft_m) || 0,
        hull_displacement_kg: Number(config.hull_displacement_kg) || 0,
        hull_gm_m: Number(config.hull_gm_m) || 0,
        hull_roll_period_s: Number(config.hull_roll_period_s) || 0,
        hull_accel_point_m: Number(config.hull_accel_point_m) || 0,
        hull_type: typeof config.hull_type === "string" ? config.hull_type : "",
        hull_design: readHullDesign(),
        lines_of_interest_enabled: config.lines_of_interest_enabled,
        landfall_enabled: config.landfall_enabled !== false,
        height_of_eye_m: config.height_of_eye_m,
        landfall_max_range_nm: config.landfall_max_range_nm,
        landfall_min_offshore_hours: config.landfall_min_offshore_hours,
        departure_days: departureDays,
        // Downwind sail inventory for the deployment advisor (work
        // doc #41): empty until the start-time read lands — the
        // advisor stays silent rather than recommending canvas the
        // boat may not carry.
        downwindSails: downwindSailCache,
        downwind_night_policy: config.downwind_night_policy,
      };
      stateMachine = new PassageStateMachine();
      db = new PassageDatabase(app.getDataDirPath());

      // Source status registry (work doc #23): configured sources
      // get their checklist entries immediately, even before the
      // first cycle runs
      sourceStatus = createSourceStatus({ dataDir: app.getDataDirPath() });
      // Acknowledgement state survives restarts (work doc #30): the
      // factory runs before getDataDirPath exists, so this loads here
      const hazardState = loadHazardState(app.getDataDirPath());
      acknowledgedHazards = hazardState.acks;
      publishedHazardValues = hazardState.published;
      sourceStatus.define(WEATHER_SOURCE);
      sourceStatus.define(HAZARD_SOURCE);
      sourceStatus.define(EPHEMERIS_SOURCE);
      // The spool ingest's checklist row (the ticker records its
      // outcome — file count or absent — every minute)
      sourceStatus.define({
        id: "bulletin-spool",
        label: "Spool bulletins",
        kind: "bulletin",
        url: spoolDirectory,
      });
      if (frontsEnabled) {
        sourceStatus.define(frontsSource.FRONTS_SOURCE);
      }
      if (config.landfall_enabled !== false) {
        sourceStatus.define(landfallSource.LANDFALL_SOURCE);
      }
      for (const [index, url] of bulletinUrls.entries()) {
        sourceStatus.define({ ...customBulletinSource(index), url });
      }

      // Warm the webapp models module so the first compile does not
      // pay the dynamic-import cost mid-refresh
      modelsPromise ??= import("../public/components/models.mjs");
      modelsPromise.catch(() => {});

      // Notes lifecycle (work doc #12): when publication is disabled
      // the stores clear, so chart plotters stop seeing our warnings
      if (!publishNotesEnabled) {
        clearNotes(notesStore).catch(() => {});
        clearRegions(regionsStore).catch(() => {});
      }

      app.subscriptionmanager.subscribe(
        {
          context: "vessels.self",
          subscribe: WATCHED_PATHS.map((path) => ({ path, policy: "instant" })),
        },
        unsubscribes,
        (err) => app.error(`Subscription error: ${err}`),
        (delta) => feedDelta(delta),
      );

      cronTimer = setInterval(() => {
        const result = stateMachine.tick(new Date());
        if (result.fetch === "cron") {
          lastFetchRun = runFetch("cron").catch(() => {});
        }
        // Staleness backstop: edge-triggered fetches miss the case
        // where the server runs for days without an internet-state
        // change while cron is gated off (sailing, metered, low SoC)
        refreshIfStale(new Date()).catch((error) =>
          app.debug?.(`Staleness check failed: ${error.message}`),
        );
        // Re-emit the tile paths every tick (work doc #13): deltas
        // only travel on change, and widgets that connect after the
        // last compile would otherwise wait up to five minutes for
        // values; stale/ageHours also drift with the clock
        if (briefMeta.generatedAt != null) {
          publishBriefMeta();
        }
        // Signal K source availability for the checklist (work doc
        // #23); the ticker interval doubles as the startup grace
        // period for the server to replay current values
        recordSignalKSources().catch((error) =>
          app.debug?.(`Source status check failed: ${error.message}`),
        );
        // Critical hazard escalation (work doc #30): runs every tick
        // regardless of link state — a cached tsunami warning must
        // still raise its notification with the boat offline
        runHazardEscalation(new Date()).catch((error) =>
          app.debug?.(`Hazard escalation failed: ${error.message}`),
        );
        // Spool ingest: the fs.watch events cover a running gateway,
        // the ticker rescan catches files dropped while the watcher
        // could not attach (directory created after start) and
        // self-heals a missed event
        void ingestSpool("tick");
      }, CRON_TICK_INTERVAL_MS);
      cronTimer.unref?.();

      // Plotter-extension tile (work doc #8): manifest provider plus
      // the public asset mount; goes empty on stop
      if (typeof app.registerResourceProvider === "function") {
        teardownPlotterExt = registerPlotterExtension(app, { id: PLUGIN_ID });
      }

      // Status Tiles example set (work doc #13): read-only provider
      // so the comfort tile can be copied in the tiles screen
      teardownStatusTiles = registerStatusTileExamples(app, {
        id: PLUGIN_ID,
      });

      // The server has no built-in notes provider: the plugin
      // registers as the notes resource provider (work doc #12) and
      // serves the bulletin warnings plus any client-written notes.
      // Regions (work doc #48) ride beside the built-in provider: the
      // resources API merges providers per type, so user-created
      // regions survive untouched
      notesStore = createNotesStore(app.getDataDirPath());
      teardownNotesProvider = registerNotesProvider(app, {
        id: PLUGIN_ID,
        store: notesStore,
      });
      regionsStore = createRegionsStore(app.getDataDirPath());
      teardownRegionsProvider = registerRegionsProvider(app, {
        id: PLUGIN_ID,
        store: regionsStore,
      });
      // Acknowledge put clears the tile's NEW badge
      if (typeof app.registerPutHandler === "function") {
        app.registerPutHandler(
          "vessels.self",
          BRIEF_ACK_PATH,
          async (_ctx, _path, value) => {
            if (typeof value === "string" && value) {
              lastAckAt = value;
              try {
                const dir = join(app.getDataDirPath(), "weather");
                await mkdir(dir, { recursive: true });
                await writeFile(
                  join(dir, "ack.json"),
                  JSON.stringify({ acknowledgedAt: value }),
                );
              } catch (_error) {
                // Persistence is best-effort; the badge still clears
              }
              publishBriefMeta();
            }
            return { state: "COMPLETED" };
          },
        );
      }
      // Seed the tile from the cache after a restart
      seedBriefMeta().catch(() => {});

      setStatus("Passage briefing started");
      return config;
    },

    stop: () => {
      if (cronTimer) {
        clearInterval(cronTimer);
        cronTimer = null;
      }
      // The run-refresh timer keeps the event loop alive for up to
      // half a day — a stopped plugin must not hold the server, and a
      // pending fire must not touch the closed data dir (work doc #47
      // session)
      if (runRefreshTimer) {
        clearTimeout(runRefreshTimer);
        runRefreshTimer = null;
      }
      if (teardownNotesProvider) {
        teardownNotesProvider();
        teardownNotesProvider = null;
      }
      if (teardownRegionsProvider) {
        teardownRegionsProvider();
        teardownRegionsProvider = null;
      }
      if (teardownStatusTiles) {
        teardownStatusTiles();
        teardownStatusTiles = null;
      }
      if (teardownPlotterExt) {
        teardownPlotterExt();
        teardownPlotterExt = null;
      }
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      unsubscribes.length = 0;
      if (db) {
        db.close();
        db = null;
      }
      if (spoolWatcher) {
        spoolWatcher.close();
        spoolWatcher = null;
      }
      if (sourceStatus) {
        // Best-effort: flush the pending persistence write
        sourceStatus.flush().catch(() => {});
        sourceStatus = null;
      }
      stateMachine = null;
      setStatus("Passage briefing stopped");
    },

    /**
     * REST API routes under `/plugins/<id>/`:
     *
     * - `GET /api/status` — state machine state and next cron window
     * - `GET /sources` — per-source ingest status registry (work doc
     *   #23): the webapp checklist and external diagnostics
     * - `GET /api/matrix` — learned sail preference matrix (SPEC §3.2)
     * - `GET /api/events` — recorded logbook sail events
     * - `GET /api/logbook-events` — sail events extracted from the
     *   logbook store (not yet necessarily learned)
     * - `POST /api/backfill` — run the SPEC §4.2 backfill. Query
     *   params: `from`/`to` (ISO window, optional), `source`
     *   (`logbook` default: wind snapshots written in the log entries;
     *   `history`: Signal K History API, needs `baseUrl` and works
     *   only on board with history present).
     *
     * @param {object} router - Express router mounted at the plugin root
     */
    registerWithRouter: (router) => {
      router.get("/api/config", (_req, res) => {
        // Hull data can change between config applies (Vessel Base
        // Data edits) — refresh the design snapshot on every read so
        // the webapp's simulation runs on the current boat (work doc
        // #56)
        simulationConfig.hull_design = readHullDesign();
        res.json(simulationConfig);
      });

      // Sea legs (work doc #40): the passage day context. The history
      // scan needs a reachable History API — the webapp calls with its
      // own origin as baseUrl (same server); failures degrade to nulls
      router.get("/api/sea-legs", async (req, res) => {
        try {
          const base =
            typeof req.query.baseUrl === "string" && req.query.baseUrl
              ? req.query.baseUrl
              : `${req.protocol}://${req.get("host")}`;
          const result = await seaLegs({ baseUrl: base });
          res.json(result);
        } catch (error) {
          res.json({
            passageStartedAt: null,
            dayAtSea: null,
            underwayNow: false,
            error: error.message,
          });
        }
      });

      router.get("/api/status", (_req, res) => {
        res.json({
          state: stateMachine ? stateMachine.state : null,
          nextCronRun: stateMachine?.scheduledCronRun?.toISOString() ?? null,
          online: isOnline(),
          activeRouteId: activeRouteId(observations[ACTIVE_ROUTE_PATH]),
        });
      });

      /** Source status checklist (work doc #23): one entry per
       * ingest path and Signal K source, the outcome of each one's
       * latest cycle. */
      router.get("/sources", (_req, res) => {
        res.json(sourceStatus ? sourceStatus.list() : []);
      });

      router.get("/api/matrix", (_req, res) => {
        res.json(db ? db.getSailPreferenceMatrix() : null);
      });

      // Sail inventory (work doc #41): the classified inventory the
      // proactive downwind recommendations deploy from — empty when
      // no sailsconfiguration data exists
      router.get("/api/sails", async (_req, res) => {
        const configPath = app.config?.configPath ?? app.dataDir;
        const sails = await readSailsConfiguration(
          join(configPath, "plugin-config-data", "sailsconfiguration.json"),
        );
        res.json({ sails });
      });

      router.get("/api/events", (_req, res) => {
        res.json(db ? db.getSailEvents({ limit: 1000 }) : []);
      });

      router.get("/api/logbook-events", async (req, res) => {
        try {
          const events = await readLogbookSailEvents({
            app,
            from:
              typeof req.query.from === "string" ? req.query.from : undefined,
            to: typeof req.query.to === "string" ? req.query.to : undefined,
            knownSailKeys: await knownSailKeys(),
          });
          res.json(events);
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
      });

      router.post("/api/briefing/refresh", async (req, res) => {
        const routeId =
          typeof req.query.route === "string" ? req.query.route : "";
        // Here mode stays online-gated (work doc #7): conditions fetch
        // has no local source to fall back to. Route mode compiles
        // offline from the local GRIB (work doc #55) — the handler
        // below serves the cache when even that cannot answer.
        if (!routeId && !isOnline()) {
          res
            .status(503)
            .json({ error: "Offline: serving cached briefings only" });
          return;
        }
        try {
          // No route requested: refresh conditions at the vessel
          // (work doc #7 here mode)
          if (!routeId) {
            const here = await refreshHere();
            res.json({ mode: "here", cached: true, cachedAt: here.cachedAt });
            return;
          }
          const days =
            typeof req.query.days === "string" && Number(req.query.days) > 0
              ? Number(req.query.days)
              : simulationForecastDays;
          res.json(await refreshBriefing(routeId, days));
        } catch (error) {
          app.error(`Briefing refresh failed: ${error.message}`);
          // Offline failures read as "cannot serve this route" rather
          // than "the fetch broke": the crew can act on that
          res.status(isOnline() ? 502 : 503).json({ error: error.message });
        }
      });

      /**
       * Serves a briefing payload with a top-level `mode` the webapp
       * routes on: `"route"` for the two-screen passage view,
       * `"here"` for the single conditions view (work doc #7). Mode
       * is derived from state: an explicit or active route wins,
       * everything else is here mode.
       */
      router.get("/api/briefing", async (req, res) => {
        // An explicit ?route= (even empty) selects the mode — the
        // route picker's "Conditions here" entry requests exactly
        // that. With no param at all the route being sailed wins,
        // falling back to here when none (work doc #7)
        const explicitRoute = typeof req.query.route === "string";
        const routeId = explicitRoute ? req.query.route.trim() : "";
        const activeId = activeRouteId(observations[ACTIVE_ROUTE_PATH]);
        const effectiveRoute = routeId || (explicitRoute ? "" : activeId);
        if (!effectiveRoute) {
          const here = await loadHere();
          if (!here) {
            // Empty, not 404: the webapp renders its refresh strip
            // instead of logging a failed request
            res.json({
              mode: "here",
              payload: null,
              cached: false,
              online: isOnline(),
            });
            return;
          }
          // Serve-time bulletin re-filter (same as route mode)
          await refilterPayloadBulletin(here.payload);
          res.json({
            mode: "here",
            payload: here.payload,
            cachedAt: here.cachedAt,
            stale: here.stale,
            online: isOnline(),
          });
          return;
        }
        const cached = await loadPayload(app.getDataDirPath(), effectiveRoute);
        if (!cached) {
          // The crew asked for a route the plugin cannot serve yet
          // (created/selected offline, work doc #55): remember it so
          // the next online window briefs it without another tap
          try {
            await mkdir(join(app.getDataDirPath(), "weather"), {
              recursive: true,
            });
            await writeFile(requestedRoutePath(), effectiveRoute);
          } catch (_error) {
            // Marker persistence is best-effort
          }
          res.json({
            mode: "route",
            routeId: effectiveRoute,
            payload: null,
            cached: false,
            online: isOnline(),
          });
          return;
        }
        // A marker for a route that now has a cache has served its
        // purpose — the refresh candidates fall back to last-route
        if ((await readRequestedRoute()) === effectiveRoute) {
          await unlink(requestedRoutePath()).catch(() => {});
        }
        // Serve-time bulletin re-filter: recompute the merged console
        // from the bulletin cache against the payload's track, so
        // parsing and filtering improvements reach cached briefings
        // on the next page load — and a payload compiled before a
        // fresher bulletin arrived picks the newer merged view
        await refilterPayloadBulletin(cached.payload);
        res.json({
          mode: "route",
          routeId: effectiveRoute,
          ...cached,
          cached: true,
          online: isOnline(),
        });
      });

      router.get("/api/bulletin", async (req, res) => {
        // Filtered against the queried route's track; without a route
        // the vessel's own position is the track — an empty track
        // would disable every discard rule and serve the newest cache
        // entry whatever ocean it came from (bergie session, Tonga fix)
        let waypoints = [];
        if (typeof req.query.route === "string") {
          try {
            const route = await app.resourcesApi.getResource(
              "routes",
              req.query.route,
            );
            waypoints = sampleRoutePoints(
              route?.feature?.geometry?.coordinates ?? [],
            );
          } catch {
            // Unknown route: serve the unfiltered bulletin
          }
        } else {
          const here = vesselPosition();
          if (here) {
            waypoints = [here];
          }
        }
        res.json(await bulletinForTrack(waypoints));
      });

      // Acknowledge a critical-hazard notification (work doc #30):
      // the notification returns to nominal for every connected
      // client, and the escalation does not re-raise the event until
      // it leaves the matrix and returns
      // Active critical-hazard notifications (work doc #30): the
      // same list the escalation publishes over the Signal K stream,
      // served here so the webapp banner doesn't have to poll the
      // REST notifications subtree (absent path = noisy 404)
      router.get("/api/hazards/active", (_req, res) => {
        const notifications = [];
        for (const [id, notification] of activeHazardNotifications) {
          if (
            !hazardAlerts.shouldRaise({
              notification,
              ack: acknowledgedHazards.get(id),
            })
          ) {
            continue; // Acked at this level and distance: not banner material
          }
          notifications.push({
            id,
            state: notification.state,
            message: notification.message,
          });
        }
        res.json({ notifications });
      });

      router.post("/api/hazards/ack", async (req, res) => {
        const id = typeof req.body?.id === "string" ? req.body.id : null;
        if (!id) {
          res.status(400).json({ error: "id required" });
          return;
        }
        acknowledgeHazard(id);
        res.json({ acknowledged: id });
      });

      router.post("/api/bulletin/refresh", async (_req, res) => {
        if (!isOnline()) {
          res.status(503).json({
            error: "Offline: bulletins are only fetched while online",
          });
          return;
        }
        // Zone-targeted pull against the vessel position when known
        // (work doc #9), then the configured extra feeds
        const position = vesselPosition();
        await refreshBulletinsOnline(
          "manual",
          position ? [{ lat: position.lat, lon: position.lon }] : [],
        );
        const result = await refreshCustomBulletins();
        res.json(result);
      });

      router.get("/api/brief-meta", (_req, res) => {
        res.json(briefMetaView());
      });

      router.get("/api/synoptic", async (req, res) => {
        let zone =
          typeof req.query.zone === "string" && /^\d+$/.test(req.query.zone)
            ? Number(req.query.zone)
            : null;
        if (zone == null) {
          const position = vesselPosition();
          zone = position
            ? (resolveZones([[position.lon, position.lat]])[0] ?? null)
            : null;
        }
        if (zone == null) {
          res.status(404).json({ error: "No zone to serve a chart for" });
          return;
        }
        const chart = await loadSynoptic(app.getDataDirPath(), zone);
        if (!chart) {
          const lastFailure = await loadSynopticFailure(
            app.getDataDirPath(),
            zone,
          );
          res.status(404).json({
            error: "No cached chart for this zone",
            ...(lastFailure ? { lastFailure } : {}),
          });
          return;
        }
        res
          .type(chart.format === "gif" ? "image/gif" : "image/png")
          .send(chart.bytes);
      });

      router.get("/api/cached", async (_req, res) => {
        res.json(await listCachedRoutes(app.getDataDirPath()));
      });

      router.get("/api/routes", async (_req, res) => {
        try {
          if (typeof app.resourcesApi?.listResources !== "function") {
            res
              .status(501)
              .json({ error: "Resources API not available on this server" });
            return;
          }
          // The resources listing is one of the slowest calls on the
          // server (a second or three per request even for a handful
          // of routes — the store layer re-reads everything, and
          // stale weather-routing routes accumulate beneath it). The
          // list changes rarely, so serve the cache immediately and
          // refresh in the background past the TTL: every UI load
          // after the first is instant, nobody waits for a re-list
          // they did not ask for.
          const now = Date.now();
          const fresh = now - routeListCache.at < ROUTES_CACHE_TTL_MS;
          const refresh = () => {
            if (routeListCache.inFlight) {
              return;
            }
            routeListCache.inFlight = (async () => {
              try {
                const routes = await app.resourcesApi.listResources(
                  "routes",
                  {},
                );
                const activeId = activeRouteId(observations[ACTIVE_ROUTE_PATH]);
                routeListCache.list = Object.entries(routes || {}).map(
                  ([id, route]) => ({
                    id,
                    name: route?.name ?? id,
                  }),
                );
                // Distance only for the active route: inactive
                // weather-routing routes can be numerous, and the
                // picker needs nothing from them but name and id
                const active = Object.entries(routes || {}).find(
                  ([id]) => id === activeId,
                );
                if (active) {
                  routeListCache.distances[active[0]] = routeDistanceNm(
                    active?.[1]?.feature?.geometry?.coordinates ?? [],
                  );
                }
                routeListCache.at = Date.now();
              } catch (error) {
                routeListCache.error = error.message;
                // The cache keeps serving the stale list; without
                // this line a failing resources store is invisible
                app.debug?.(`Route list refresh failed: ${error.message}`);
              } finally {
                routeListCache.inFlight = null;
              }
            })();
          };
          if (routeListCache.list.length === 0) {
            // First call ever: pay the listing once so the picker has
            // its routes from the first paint
            refresh();
            await routeListCache.inFlight;
          } else if (!fresh) {
            // Stale-while-revalidate: answer from cache now
            refresh();
          }
          // The active flag and distance are stamped at serve time:
          // the cached list itself must not go stale on a route switch
          const activeId = activeRouteId(observations[ACTIVE_ROUTE_PATH]);
          res.json(
            routeListCache.list.map((entry) => ({
              ...entry,
              distanceNm: routeListCache.distances[entry.id] ?? null,
              active: entry.id === activeId,
            })),
          );
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
      });

      router.get("/api/polar", async (_req, res) => {
        try {
          const { parseActivePolarId, parsePerformanceFactor } = await import(
            "../public/polar.mjs"
          );
          const raw =
            typeof app.getSelfPath === "function"
              ? app.getSelfPath("polars.activePolar")
              : null;
          const id = parseActivePolarId(raw);
          if (!id) {
            res.json(null); // No active polar: webapp falls back to default
            return;
          }
          const table = await app.resourcesApi.getResource("polars", id);
          res.json({
            id,
            table,
            performanceFactor: parsePerformanceFactor(
              typeof app.getSelfPath === "function"
                ? app.getSelfPath("polars.performanceFactor")
                : null,
            ),
          });
        } catch {
          res.json(null);
        }
      });

      router.post("/api/backfill", async (req, res) => {
        if (!db) {
          res.status(503).json({ error: "Plugin not started" });
          return;
        }
        try {
          const from =
            typeof req.query.from === "string" ? req.query.from : undefined;
          const to =
            typeof req.query.to === "string" ? req.query.to : undefined;
          const events = await readLogbookSailEvents({
            app,
            from,
            to,
            knownSailKeys: await knownSailKeys(),
          });
          const source =
            req.query.source === "history" &&
            typeof req.query.baseUrl === "string"
              ? createHistoryWindStats({ baseUrl: req.query.baseUrl })
              : createLogbookWindStats(await readLogbookEntries(app));
          const summary = await backfillSailEvents({
            db,
            events,
            getWindStats: source,
          });
          res.json(summary);
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
      });
    },
  };

  return {
    ...plugin,
    /** Exposed for tests: the staleness backstop check. */
    refreshIfStale,
    /** Exposed for tests: the Signal K source availability check. */
    recordSignalKSources,
  };
};

module.exports.PLUGIN_ID = PLUGIN_ID;
module.exports.DEFAULTS = DEFAULTS;
module.exports.WATCHED_PATHS = WATCHED_PATHS;
