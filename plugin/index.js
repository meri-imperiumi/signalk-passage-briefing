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
const { readFile, writeFile } = require("node:fs/promises");

const { PassageStateMachine } = require("./state-machine.js");
const { PassageDatabase } = require("./sqlite-db.js");
const {
  readLogbookEntries,
  readLogbookSailEvents,
} = require("./logbook-source.js");
const { readSailsConfiguration } = require("./sails-configuration.js");
const {
  backfillSailEvents,
  createHistoryWindStats,
  createLogbookWindStats,
} = require("./history-backfill.js");
const {
  DEFAULT_FORECAST_DAYS,
  fetchWeatherAlongTrack,
  listCachedRoutes,
  loadPayload,
  routeDistanceNm,
  sampleRoutePoints,
  savePayload,
} = require("./fetch-engine.js");

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

/**
 * Self path of the vessel's active route, as published by autopilot /
 * navigation apps (same source the dead-reckoning webapp consumes).
 */
const ACTIVE_ROUTE_PATH = "navigation.course.activeRoute";

const WATCHED_PATHS = [
  INTERNET_STATE_PATH,
  NAVIGATION_STATE_PATH,
  HOUSE_SOC_PATH,
  ACTIVE_ROUTE_PATH,
];

/**
 * How often the cron ticker checks whether a publication window is due.
 */
const CRON_TICK_INTERVAL_MS = 60 * 1000;

/**
 * Plugin configuration defaults (SPEC §2.1). The spool directory
 * resolves against the server user's home so no absolute path is
 * hardcoded (on the standard install this is
 * `~/.signalk/spool/passage-outlook`).
 */
const DEFAULTS = {
  motoring_tws_threshold: 3.5,
  drift_mode_enabled: true,
  waterline_length_m: 9.4,
  spool_directory: join(homedir(), ".signalk", "spool", "passage-outlook"),
  k_heel: 0.35,
  k_pitch: 0.4,
};

/**
 * @param {ServerAPI} app - Signal K server API
 * @returns {Plugin}
 */
module.exports = (app) => {
  const setStatus = (app.setPluginStatus || app.setProviderStatus)?.bind(app);
  const unsubscribes = [];

  /** @type {PassageStateMachine|null} */
  let stateMachine = null;
  /** @type {PassageDatabase|null} */
  let db = null;
  /** @type {NodeJS.Timeout|null} */
  let cronTimer = null;
  /** Last known values of the watched paths. */
  const observations = {
    [INTERNET_STATE_PATH]: null,
    [NAVIGATION_STATE_PATH]: null,
    [HOUSE_SOC_PATH]: null,
  };

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

  /**
   * Fetches and caches the briefing payload for a route. Internet
   * weather is only fetched while the link is up; everything served
   * afterwards comes from the cache (on passage the boat is online
   * for about an hour a day, so the last payload must survive the
   * other 23 offline hours).
   *
   * @param {string} routeId
   * @param {number} [forecastDays]
   * @returns {Promise<{routeId: string, cached: boolean, cachedAt: string|null, fetchedAt?: string}>}
   */
  async function refreshBriefing(
    routeId,
    forecastDays = DEFAULT_FORECAST_DAYS,
  ) {
    if (!isOnline()) {
      throw new Error("Offline: internet weather is only fetched while online");
    }
    let coordinates;
    if (typeof app.resourcesApi?.getResource === "function") {
      const route = await app.resourcesApi.getResource("routes", routeId);
      coordinates = route?.feature?.geometry?.coordinates;
    }
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      throw new Error(`Route ${routeId} has no track`);
    }
    const waypoints = sampleRoutePoints(coordinates);
    const payload = await fetchWeatherAlongTrack({ waypoints, forecastDays });
    await savePayload(app.getDataDirPath(), routeId, payload);
    await writeFile(
      join(app.getDataDirPath(), "weather", "last-route"),
      routeId,
    );
    return {
      routeId,
      cached: true,
      cachedAt: payload.metadata.fetchedAt,
      fetchedAt: payload.metadata.fetchedAt,
    };
  }

  /**
   * Runs a weather fetch for the last briefed route (cron/oneshot
   * trigger). The multi-endpoint fetch lands in the briefing refresh;
   * the outcome is surfaced through the plugin status.
   *
   * @param {"oneshot"|"cron"} trigger
   */
  async function runFetch(trigger) {
    if (!isOnline()) {
      setStatus(`Fetch skipped while offline (${trigger})`);
      return;
    }
    // The route being sailed wins; otherwise re-brief the last one
    let routeId = activeRouteId(observations[ACTIVE_ROUTE_PATH]);
    if (!routeId) {
      try {
        routeId = (
          await readFile(
            join(app.getDataDirPath(), "weather", "last-route"),
            "utf8",
          )
        ).trim();
      } catch (_error) {
        setStatus("No route briefed yet: pick a route in the webapp");
        return;
      }
    }
    try {
      const result = await refreshBriefing(routeId);
      setStatus(
        `Briefing for ${routeId} cached at ${result.fetchedAt} (${trigger})`,
      );
    } catch (error) {
      app.error(`Briefing refresh failed (${trigger}): ${error.message}`);
      setStatus(`Briefing refresh failed: ${error.message}`);
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
      }
    }
    const result = stateMachine.update({
      internetState: observations[INTERNET_STATE_PATH],
      navigationState: observations[NAVIGATION_STATE_PATH],
      soc: observations[HOUSE_SOC_PATH],
    });
    if (result.fetch === "oneshot") {
      runFetch("oneshot");
    }
  }

  /**
   * Location of the signalk-logbook on-disk store. When the Signal K
   * Resource API grows logbook support, this (and the logbook-source
   * module behind it) is the swap point.
   *
   * @returns {string}
   */
  function logbookStoreDir() {
    const configPath = app.config?.configPath ?? app.dataDir;
    return join(configPath, "plugin-config-data", "signalk-logbook");
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

    schema: {
      type: "object",
      properties: {
        motoring_tws_threshold: {
          type: "number",
          title: "Motoring TWS Threshold (knots)",
          default: DEFAULTS.motoring_tws_threshold,
        },
        drift_mode_enabled: {
          type: "boolean",
          title: "Enable Drift Mode (Zero Fuel / Current Drift)",
          default: DEFAULTS.drift_mode_enabled,
        },
        waterline_length_m: {
          type: "number",
          title: "Waterline Length (meters)",
          default: DEFAULTS.waterline_length_m,
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
      },
    },

    /**
     * @param {object} options - Persisted plugin configuration
     */
    start: (options) => {
      const config = { ...DEFAULTS, ...(options || {}) };

      stateMachine = new PassageStateMachine();
      db = new PassageDatabase(app.getDataDirPath());

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
          runFetch("cron");
        }
      }, CRON_TICK_INTERVAL_MS);
      cronTimer.unref?.();

      setStatus("Passage briefing started");
      return config;
    },

    stop: () => {
      if (cronTimer) {
        clearInterval(cronTimer);
        cronTimer = null;
      }
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      unsubscribes.length = 0;
      if (db) {
        db.close();
        db = null;
      }
      stateMachine = null;
      setStatus("Passage briefing stopped");
    },

    /**
     * REST API routes under `/plugins/<id>/`:
     *
     * - `GET /api/status` — state machine state and next cron window
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
      router.get("/api/status", (_req, res) => {
        res.json({
          state: stateMachine ? stateMachine.state : null,
          nextCronRun: stateMachine?.scheduledCronRun?.toISOString() ?? null,
          online: isOnline(),
          activeRouteId: activeRouteId(observations[ACTIVE_ROUTE_PATH]),
        });
      });

      router.get("/api/matrix", (_req, res) => {
        res.json(db ? db.getSailPreferenceMatrix() : null);
      });

      router.get("/api/events", (_req, res) => {
        res.json(db ? db.getSailEvents({ limit: 1000 }) : []);
      });

      router.get("/api/logbook-events", async (req, res) => {
        try {
          const events = await readLogbookSailEvents({
            dir: logbookStoreDir(),
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
        if (!routeId) {
          res.status(400).json({ error: "route query parameter required" });
          return;
        }
        if (!isOnline()) {
          res
            .status(503)
            .json({ error: "Offline: serving cached briefings only" });
          return;
        }
        try {
          const days =
            typeof req.query.days === "string" && Number(req.query.days) > 0
              ? Number(req.query.days)
              : DEFAULT_FORECAST_DAYS;
          res.json(await refreshBriefing(routeId, days));
        } catch (error) {
          app.error(`Briefing refresh failed: ${error.message}`);
          res.status(502).json({ error: error.message });
        }
      });

      router.get("/api/briefing", async (req, res) => {
        const routeId =
          typeof req.query.route === "string" ? req.query.route : "";
        if (!routeId) {
          res.status(400).json({ error: "route query parameter required" });
          return;
        }
        const cached = await loadPayload(app.getDataDirPath(), routeId);
        if (!cached) {
          res.status(404).json({ error: "No cached briefing for this route" });
          return;
        }
        res.json({ ...cached, online: isOnline() });
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
          const routes = await app.resourcesApi.listResources("routes", {});
          const activeId = activeRouteId(observations[ACTIVE_ROUTE_PATH]);
          const list = Object.entries(routes || {}).map(([id, route]) => ({
            id,
            name: route?.name ?? id,
            distanceNm: routeDistanceNm(
              route?.feature?.geometry?.coordinates ?? [],
            ),
            active: id === activeId,
          }));
          res.json(list);
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
            dir: logbookStoreDir(),
            from,
            to,
            knownSailKeys: await knownSailKeys(),
          });
          const source =
            req.query.source === "history" &&
            typeof req.query.baseUrl === "string"
              ? createHistoryWindStats({ baseUrl: req.query.baseUrl })
              : createLogbookWindStats(
                  await readLogbookEntries(logbookStoreDir()),
                );
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

  return plugin;
};

module.exports.PLUGIN_ID = PLUGIN_ID;
module.exports.DEFAULTS = DEFAULTS;
module.exports.WATCHED_PATHS = WATCHED_PATHS;
