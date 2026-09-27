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
const WATCHED_PATHS = [
  INTERNET_STATE_PATH,
  NAVIGATION_STATE_PATH,
  HOUSE_SOC_PATH,
];

/**
 * How often the cron ticker checks whether a publication window is due.
 */
const CRON_TICK_INTERVAL_MS = 60 * 1000;

/**
 * Plugin configuration defaults (SPEC §2.1).
 */
const DEFAULTS = {
  motoring_tws_threshold: 3.5,
  drift_mode_enabled: true,
  waterline_length_m: 9.4,
  spool_directory: "/home/node/.signalk/spool/passage-outlook",
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
   * Runs a weather fetch. The multi-endpoint fetch engine lands here;
   * for now the trigger is surfaced through the plugin status so the
   * state machine wiring is observable.
   *
   * @param {"oneshot"|"cron"} trigger
   */
  function runFetch(trigger) {
    setStatus(`Fetching weather (trigger: ${trigger})`);
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
