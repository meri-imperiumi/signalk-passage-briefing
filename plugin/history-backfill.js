/**
 * Sail preference backfill engine (SPEC §4.2).
 *
 * For each logbook sail event the engine gathers the wind conditions
 * of the 15-minute window ending at the event, condenses them into
 * TWS average / TWS peak / circular-mean TWA, caches them, and folds
 * the observation into the learned sail preference matrix with an
 * exponential moving average (α = 0.2).
 *
 * Wind sources are pluggable through a `getWindStats(event)` callback:
 *
 * - {@link createLogbookWindStats} reads the wind snapshots the crew
 *   wrote into the logbook entries themselves (the event entry and any
 *   adjacent entries in the window, e.g. hourly entries). This is the
 *   default and needs no History API — usable anywhere, including
 *   ashore with a copy of the log repository.
 * - {@link createHistoryWindStats} queries the Signal K History API
 *   (`environment.wind.speedTrue` / `environment.wind.angleTrue`) for
 *   the window. This is the SPEC §4.2 source of record and is meant
 *   for the on-board backfill run where the full-resolution history is
 *   present.
 *
 * Backfills are idempotent: an event whose timestamp already has a
 * `wind_history_cache` row is skipped, so re-running over overlapping
 * windows never double-counts samples in the EMA.
 *
 * @file history-backfill.js
 */

const { twsBinIndex, twaBinIndex, emaUpdate } = require("./sqlite-db.js");

/**
 * Lazy handle on the shared physics module (ESM, imported from this
 * CJS module on first use) for the day/night bucket.
 *
 * @type {Promise<typeof import("../public/sereno-physics.mjs")>|null}
 */
let physicsPromise = null;

/**
 * @returns {Promise<typeof import("../public/sereno-physics.mjs")>}
 */
function loadPhysics() {
  if (!physicsPromise) {
    physicsPromise = import("../public/sereno-physics.mjs");
  }
  return physicsPromise;
}

/**
 * Wind window ending at each sail event (SPEC §4.2).
 */
const WINDOW_MINUTES = 15;

/**
 * Signal K paths queried from the History API.
 */
const WIND_PATHS = ["environment.wind.speedTrue", "environment.wind.angleTrue"];

/**
 * History API sample resolution (seconds).
 */
const HISTORY_RESOLUTION_SECONDS = 10;

/**
 * Meters per second per knot (History API values are SI).
 */
const MS_TO_KNOTS = 1.943844;

/**
 * Parses a timestamp that carries no explicit offset as UTC (the
 * History API returns naive ISO strings).
 *
 * @param {string} time - ISO 8601 timestamp
 * @returns {Date}
 */
function parseUtcTimestamp(time) {
  const hasOffset = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(time);
  return new Date(hasOffset ? time : `${time}Z`);
}

/**
 * Folds a true wind direction in degrees onto the 0..180 TWA magnitude
 * range of the learned matrix bins.
 *
 * @param {number} degrees - True wind direction (degrees)
 * @returns {number} |TWA| in 0..180 degrees
 */
function foldTwaDegrees(degrees) {
  const normalized = ((degrees % 360) + 360) % 360;
  return normalized > 180 ? 360 - normalized : normalized;
}

/**
 * Circular mean of wind angles given in degrees, folded to 0..180.
 *
 * @param {number[]} degreesList - Folded angles (0..180 degrees)
 * @returns {number} Circular mean (0..180 degrees)
 */
function circularMeanDegrees(degreesList) {
  let sinSum = 0;
  let cosSum = 0;
  for (const degrees of degreesList) {
    const rad = (degrees * Math.PI) / 180;
    sinSum += Math.sin(rad);
    cosSum += Math.cos(rad);
  }
  const mean = (Math.atan2(sinSum, cosSum) * 180) / Math.PI;
  return foldTwaDegrees(mean);
}

/**
 * Wind statistics of a sail event's window (SPEC §4.2 step 2).
 *
 * @typedef {object} WindWindowStats
 * @property {number} samples - Number of wind observations
 * @property {number} twsAvg - Mean true wind speed (kn)
 * @property {number} twsPeak - Peak true wind speed (kn)
 * @property {number} twaAvg - Circular mean true wind angle (deg,
 *   0..180)
 */

/**
 * Builds a `getWindStats(event)` function that derives the window wind
 * statistics from the wind snapshots written in the logbook entries
 * (human-friendly units: knots, degrees true). All entries carrying a
 * numeric `wind.speed` within `[t − window, t]` contribute — the sail
 * event's own entry and any adjacent entries such as the hourly
 * automatic entries.
 *
 * @param {Array<{datetime: string|Date, wind?: {speed?: number, direction?: number}}>|
 *   Array<{datetime: string|Date, text?: string, wind?: {speed?: number, direction?: number}}>} entries
 *   All logbook entries (not just sail events)
 * @param {number} [windowMinutes] - Window length (default
 *   {@link WINDOW_MINUTES})
 * @returns {(event: {timestamp: string}) => WindWindowStats|null}
 */
function createLogbookWindStats(entries, windowMinutes = WINDOW_MINUTES) {
  // Pre-index the wind-carrying entries once, sorted by time.
  const windEntries = entries
    .map((entry) => ({
      time: new Date(entry.datetime).getTime(),
      twsKnots:
        entry.wind && typeof entry.wind.speed === "number"
          ? entry.wind.speed
          : null,
      twaDeg:
        entry.wind && typeof entry.wind.direction === "number"
          ? foldTwaDegrees(entry.wind.direction)
          : null,
    }))
    .filter((e) => Number.isFinite(e.time) && e.twsKnots != null)
    .sort((a, b) => a.time - b.time);

  return (event) => {
    const endMs = new Date(event.timestamp).getTime();
    const startMs = endMs - windowMinutes * 60 * 1000;
    const speeds = [];
    const angles = [];
    for (const entry of windEntries) {
      if (entry.time < startMs || entry.time > endMs) {
        continue;
      }
      speeds.push(entry.twsKnots);
      if (entry.twaDeg != null) {
        angles.push(entry.twaDeg);
      }
    }
    if (speeds.length === 0) {
      return null;
    }
    return {
      samples: speeds.length,
      twsAvg: speeds.reduce((a, b) => a + b, 0) / speeds.length,
      twsPeak: Math.max(...speeds),
      twaAvg: angles.length > 0 ? circularMeanDegrees(angles) : 0,
    };
  };
}

/**
 * Queries the Signal K History API (SPEC §4.2 step 1). Numeric wind
 * paths need no aggregate-method suffix.
 *
 * @param {object} params
 * @param {string} params.baseUrl - Signal K server base URL
 * @param {string} [params.token] - Bearer token (defaults to the
 *   SIGNALK_TOKEN env var)
 * @param {string} [params.provider] - History provider ID
 * @param {Date} params.from - Window start
 * @param {Date} params.to - Window end
 * @param {string[]} [params.paths] - Paths to query (default
 *   {@link WIND_PATHS})
 * @param {number} [params.resolution] - Resolution in seconds
 * @param {typeof fetch} [params.fetchImpl] - Fetch implementation (tests)
 * @returns {Promise<object>} History API `/values` response
 */
async function queryHistory({
  baseUrl,
  token = process.env.SIGNALK_TOKEN,
  provider,
  from,
  to,
  paths = WIND_PATHS,
  resolution = HISTORY_RESOLUTION_SECONDS,
  fetchImpl = fetch,
}) {
  const url = new URL("/signalk/v2/api/history/values", baseUrl);
  url.searchParams.set("paths", paths.join(","));
  url.searchParams.set("from", from.toISOString());
  url.searchParams.set("to", to.toISOString());
  url.searchParams.set("resolution", String(resolution));
  if (provider) {
    url.searchParams.set("provider", provider);
  }
  const headers = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    throw new Error(
      `History API returned ${response.status}: ${response.statusText}`,
    );
  }
  return response.json();
}

/**
 * Extracts wind window statistics from a History API `/values`
 * response (SPEC §4.2 steps 1–2). Values are SI: speedTrue in m/s,
 * angleTrue in radians.
 *
 * @param {object} params
 * @param {object} params.historyData - History API response
 * @param {Date} params.from - Window start (inclusive)
 * @param {Date} params.to - Window end (inclusive)
 * @returns {WindWindowStats|null} Null when the window has no wind data
 */
function extractWindWindowStats({ historyData, from, to }) {
  const columns = new Map();
  for (const [index, column] of (historyData.values || []).entries()) {
    if (column.path != null && !columns.has(column.path)) {
      columns.set(column.path, index + 1);
    }
  }
  const speedColumn = columns.get("environment.wind.speedTrue");
  const angleColumn = columns.get("environment.wind.angleTrue");
  if (speedColumn == null) {
    return null;
  }

  const fromMs = from.getTime();
  const toMs = to.getTime();
  const speeds = [];
  const angles = [];
  for (const row of historyData.data || []) {
    const time = parseUtcTimestamp(row[0]).getTime();
    if (time < fromMs || time > toMs) {
      continue;
    }
    const speedMs = row[speedColumn];
    if (typeof speedMs !== "number" || !Number.isFinite(speedMs)) {
      continue;
    }
    speeds.push(speedMs * MS_TO_KNOTS);
    if (angleColumn != null) {
      const angleRad = row[angleColumn];
      if (typeof angleRad === "number" && Number.isFinite(angleRad)) {
        angles.push(foldTwaDegrees((angleRad * 180) / Math.PI));
      }
    }
  }
  if (speeds.length === 0) {
    return null;
  }
  return {
    samples: speeds.length,
    twsAvg: speeds.reduce((a, b) => a + b, 0) / speeds.length,
    twsPeak: Math.max(...speeds),
    twaAvg: angles.length > 0 ? circularMeanDegrees(angles) : 0,
  };
}

/**
 * Builds a `getWindStats(event)` function backed by the Signal K
 * History API (the SPEC §4.2 source of record, for the on-board run).
 * Each event triggers one window query.
 *
 * @param {object} [options]
 * @param {string} options.baseUrl - Signal K server base URL
 * @param {string} [options.token] - Bearer token (defaults to the
 *   SIGNALK_TOKEN env var)
 * @param {string} [options.provider] - History provider ID
 * @param {number} [options.windowMinutes] - Window length (default
 *   {@link WINDOW_MINUTES})
 * @param {number} [options.resolution] - Resolution in seconds
 * @param {typeof fetch} [options.fetchImpl] - Fetch implementation (tests)
 * @returns {(event: {timestamp: string}) => Promise<WindWindowStats|null>}
 */
function createHistoryWindStats({
  baseUrl,
  token,
  provider,
  windowMinutes = WINDOW_MINUTES,
  resolution,
  fetchImpl,
} = {}) {
  return async (event) => {
    const to = new Date(event.timestamp);
    const from = new Date(to.getTime() - windowMinutes * 60 * 1000);
    const historyData = await queryHistory({
      baseUrl,
      token,
      provider,
      from,
      to,
      resolution,
      fetchImpl,
    });
    return extractWindWindowStats({ historyData, from, to });
  };
}

/**
 * Folds one sail event observation into the learned matrix
 * (SPEC §4.2 step 3) and caches the window statistics.
 *
 * The matrix bins are indexed by the window's average TWS and TWA plus
 * the day/night bucket — the crew reefs deeper at night than the
 * conditions alone require, and the matrix keeps both behaviors.
 * Both trigger columns learn through the α = 0.2 EMA: the average
 * trigger from the window's mean wind, the peak/gust trigger from the
 * window's peak wind. The preferred sail of a bin is the most recent
 * observation.
 *
 * Canvas-off observations are gated (work doc #26): a `NO_SAILS`
 * observation folds into the rig matrix only when the weather
 * justifies it — the two-regime decision the rig actually encodes.
 * A mid-scale one is a propulsion decision (the engine drives) or a
 * non-passage state (anchorage, marina); folding it would teach the
 * plan to hold bare poles through sail-carrying weather.
 *
 * @param {object} params
 * @param {import("./sqlite-db.js").PassageDatabase} params.db
 * @param {{timestamp: string, eventType: string, sailState: string, night?: boolean, notes?: string}} params.event
 * @param {WindWindowStats} params.stats
 * @param {boolean} [params.night] - Day/night bucket of the event
 *   (defaults to the event's own flag, else day)
 * @param {object} [params.physics] - The loaded sereno-physics module
 *   (constants for the regime gates). Omitted, the gate stays
 *   conservative: a `NO_SAILS` observation cannot be justified and is
 *   kept out of the rig matrix.
 * @returns {{twsBin: number, twaBin: number, night: boolean,
 *   preferredSail: string, avgTwsTrigger: number, peakGustTrigger:
 *   number, sampleCount: number}|null} The learned cell, or null when
 *   the observation was gated out of the rig matrix
 */
function applySailEvent({
  db,
  event,
  stats,
  night = event.night ?? false,
  physics = null,
}) {
  db.upsertWindHistory({
    timestamp: event.timestamp,
    twsAvg: stats.twsAvg,
    twsPeak: stats.twsPeak,
    twaAvg: stats.twaAvg,
  });

  if (
    event.sailState === "NO_SAILS" &&
    noSailsWindowRegime(stats, physics) == null
  ) {
    return null;
  }

  const twsBin = twsBinIndex(stats.twsAvg);
  const twaBin = twaBinIndex(stats.twaAvg);
  const existing = db
    .getMatrixBins()
    .find(
      (bin) =>
        bin.twsBin === twsBin && bin.twaBin === twaBin && bin.night === night,
    );

  const cell = {
    twsBin,
    twaBin,
    night,
    preferredSail: event.sailState,
    avgTwsTrigger: emaUpdate(existing?.avgTwsTrigger ?? null, stats.twsAvg),
    peakGustTrigger: emaUpdate(
      existing?.peakGustTrigger ?? null,
      stats.twsPeak,
    ),
    sampleCount: (existing?.sampleCount ?? 0) + 1,
  };
  db.upsertMatrixBin(cell);
  return cell;
}

/**
 * The canvas-off regime a wind window justifies (work doc #26): the
 * rig is already down in these observations, so apparent wind ≈ true
 * wind and the regimes read off the window stats. Light air uses the
 * comfort model's point-of-sail slatting gates (work doc #14: 7 kt
 * upwind, 12 kt downwind); survival reads the window's peak gust
 * against the top of the Sereno AWS bands.
 *
 * @param {WindWindowStats} stats - Window statistics
 * @param {object|null} physics - The sereno-physics module (regime
 *   gate constants); null keeps the gate conservative
 * @returns {"slatting"|"survival"|null}
 */
function noSailsWindowRegime(stats, physics) {
  if (!stats || !physics) {
    return null;
  }
  const { twsAvg, twsPeak, twaAvg } = stats;
  if (!Number.isFinite(twsAvg)) {
    return null;
  }
  const upwind = Math.abs(Number.isFinite(twaAvg) ? twaAvg : 0) < 90;
  const lightFloor = upwind
    ? physics.SLATTING_TWS_UPWIND_KNOTS
    : physics.SLATTING_TWS_DOWNWIND_KNOTS;
  if (twsAvg < lightFloor) {
    return "slatting";
  }
  if (Number.isFinite(twsPeak) && twsPeak >= physics.SAILS_MAX_AWS_KNOTS) {
    return "survival";
  }
  return null;
}

/**
 * Runs the backfill over a list of sail events (SPEC §4.2). Events are
 * processed chronologically; an event already present in
 * `wind_history_cache` is skipped so re-runs are idempotent. Learned
 * events are also recorded into `logbook_sail_events`.
 *
 * Each event lands in the day or night matrix bucket: events with a
 * position get the bucket from the sun altitude at the event (below
 * the end of civil twilight is night — past dusk, squalls stop being
 * visible and the crew reefs deeper); events without a position are
 * treated as day.
 *
 * @param {object} params
 * @param {import("./sqlite-db.js").PassageDatabase} params.db
 * @param {Array<{timestamp: string, eventType: string, sailState: string, position?: {latitude: number, longitude: number}, night?: boolean, notes?: string}>} params.events
 * @param {(event: {timestamp: string}) => WindWindowStats|null|Promise<WindWindowStats|null>} params.getWindStats
 *   Wind source (see {@link createLogbookWindStats} and
 *   {@link createHistoryWindStats})
 * @returns {Promise<{total: number, learned: number, skippedCached: number,
 *   skippedNoData: number, cells: object[]}>}
 */
async function backfillSailEvents({ db, events, getWindStats }) {
  const physics = await loadPhysics();
  const { isNight } = physics;
  const sorted = [...events].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  let learned = 0;
  let skippedCached = 0;
  let skippedNoData = 0;
  let skippedNoSails = 0;
  const cells = [];

  for (const event of sorted) {
    if (!event.timestamp || Number.isNaN(new Date(event.timestamp).getTime())) {
      skippedNoData++;
      continue;
    }
    const cached = db.getWindHistory(event.timestamp, event.timestamp);
    if (cached.length > 0) {
      skippedCached++;
      continue;
    }
    const stats = await getWindStats(event);
    if (!stats) {
      skippedNoData++;
      continue;
    }
    const night =
      event.night ??
      (event.position
        ? isNight(
            new Date(event.timestamp),
            event.position.latitude,
            event.position.longitude,
          )
        : false);
    const cell = applySailEvent({ db, event, stats, night, physics });
    if (cell) {
      cells.push(cell);
      learned++;
    } else {
      // Gated out of the rig matrix (work doc #26): still cached and
      // recorded, but nothing was learned
      skippedNoSails++;
    }
    db.recordSailEvent({
      timestamp: event.timestamp,
      eventType: event.eventType,
      sailState: event.sailState,
      night,
      notes: event.notes,
    });
  }

  return {
    total: sorted.length,
    learned,
    skippedCached,
    skippedNoData,
    skippedNoSails,
    cells,
  };
}

const round1 = (value) => Math.round(value * 10) / 10;

/**
 * Summarizes the sailing conditions per sail combination from the
 * learned events and their cached wind statistics. Answers "in what
 * conditions do we fly this setup?" — the raw material behind the
 * learned matrix, and the comparison baseline for the configured
 * whole-sail wind limits of `@signalk/sailsconfiguration`.
 *
 * @param {Array<{timestamp: string, eventType: string, sailState: string}>} events
 *   Learned sail events (e.g. `db.getSailEvents()` output or the
 *   logbook events that were backfilled)
 * @param {Array<{timestamp: string, twsAvg: number, twsPeak: number, twaAvg: number}>} windRows
 *   Cached wind window statistics (`db.getWindHistory()` output)
 * @returns {Array<{sailState: string, samples: number,
 *   eventTypes: Object<string, number>, twsAvgMin: number,
 *   twsAvgMean: number, twsAvgMax: number, twsPeakMax: number,
 *   twaMin: number, twaMean: number, twaMax: number}>}
 *   One row per sail state, ordered by mean TWS ascending
 */
function summarizeSailUsage(events, windRows) {
  const statsByTimestamp = new Map(windRows.map((row) => [row.timestamp, row]));
  const groups = new Map();
  for (const event of events) {
    const stats = statsByTimestamp.get(event.timestamp);
    if (!stats) {
      continue;
    }
    const night = Boolean(event.night);
    const key = `${event.sailState}|${night ? "night" : "day"}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        sailState: event.sailState,
        night,
        samples: 0,
        eventTypes: {},
        twsAvg: [],
        twsPeak: [],
        twa: [],
      };
      groups.set(key, group);
    }
    group.samples++;
    group.eventTypes[event.eventType] =
      (group.eventTypes[event.eventType] ?? 0) + 1;
    group.twsAvg.push(stats.twsAvg);
    group.twsPeak.push(stats.twsPeak);
    group.twa.push(stats.twaAvg);
  }

  const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
  return Array.from(groups.values())
    .map((group) => ({
      sailState: group.sailState,
      night: group.night,
      samples: group.samples,
      eventTypes: group.eventTypes,
      twsAvgMin: round1(Math.min(...group.twsAvg)),
      twsAvgMean: round1(mean(group.twsAvg)),
      twsAvgMax: round1(Math.max(...group.twsAvg)),
      twsPeakMax: round1(Math.max(...group.twsPeak)),
      twaMin: round1(Math.min(...group.twa)),
      twaMean: round1(mean(group.twa)),
      twaMax: round1(Math.max(...group.twa)),
    }))
    .sort((a, b) => a.twsAvgMean - b.twsAvgMean);
}

module.exports = {
  WINDOW_MINUTES,
  WIND_PATHS,
  HISTORY_RESOLUTION_SECONDS,
  MS_TO_KNOTS,
  parseUtcTimestamp,
  foldTwaDegrees,
  circularMeanDegrees,
  createLogbookWindStats,
  createHistoryWindStats,
  queryHistory,
  extractWindWindowStats,
  applySailEvent,
  backfillSailEvents,
  summarizeSailUsage,
};
