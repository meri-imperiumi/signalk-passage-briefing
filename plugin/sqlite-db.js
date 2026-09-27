/**
 * SQLite engine for the Passage Briefing plugin (SPEC §4.1).
 *
 * Stores the logbook sail events, the wind history cache extracted from
 * the Signal K History API, and the learned sail preference matrix.
 *
 * Uses the `node:sqlite` builtin (Node >= 23.4, or Node >= 22.5 with the
 * server started with `--experimental-sqlite`). `open()` fails fast with
 * both remedies in the message when the builtin is missing.
 *
 * @file sqlite-db.js
 */

/**
 * TWS bin edges (knots) of the learned sail preference matrix
 * (SPEC §3.2). A sample with TWS `v` belongs to bin
 * `twsBinIndex(v)` — the index of the greatest edge `<= v`.
 */
const TWS_BINS_KNOTS = [0, 5, 10, 15, 20, 25, 30, 35, 40];

/**
 * TWA bin edges (degrees, 0..180) of the learned sail preference matrix
 * (SPEC §3.2).
 */
const TWA_BINS_DEGREES = [0, 30, 60, 90, 120, 150, 180];

/**
 * Learning rate of the exponential moving average applied to matrix
 * triggers (SPEC §4.2).
 */
const EMA_ALPHA = 0.2;

/**
 * Index of the bin edge a value belongs to: the greatest edge `<= value`,
 * clamped to the last bin so values beyond the table stay representable.
 *
 * @param {number} value - Observed quantity (TWS knots or |TWA| degrees)
 * @param {number[]} bins - Sorted ascending bin edges
 * @returns {number} Bin index into `bins`
 */
function binIndexFor(value, bins) {
  let index = 0;
  for (let i = 1; i < bins.length; i++) {
    if (value >= bins[i]) {
      index = i;
    }
  }
  return index;
}

/**
 * TWS bin index for a wind speed in knots.
 *
 * @param {number} knots
 * @returns {number}
 */
function twsBinIndex(knots) {
  return binIndexFor(knots, TWS_BINS_KNOTS);
}

/**
 * TWA bin index for a true wind angle in degrees (0..180).
 *
 * @param {number} degrees
 * @returns {number}
 */
function twaBinIndex(degrees) {
  return binIndexFor(degrees, TWA_BINS_DEGREES);
}

/**
 * Exponential moving average update of a learned trigger
 * (SPEC §4.2): `next = (1 - alpha) * old + alpha * sample`.
 *
 * @param {number|null} old - Previous trigger value (null seeds directly)
 * @param {number} sample - Observed value (e.g. TWS peak in knots)
 * @param {number} [alpha] - Learning rate (default {@link EMA_ALPHA})
 * @returns {number} Updated trigger
 */
function emaUpdate(old, sample, alpha = EMA_ALPHA) {
  if (old == null) {
    return sample;
  }
  return (1 - alpha) * old + alpha * sample;
}

/**
 * Loads the node:sqlite builtin or fails with an actionable message.
 *
 * @returns {{DatabaseSync: typeof import("node:sqlite").DatabaseSync}}
 */
function loadSqlite() {
  try {
    return require("node:sqlite");
  } catch (error) {
    throw new Error(
      `passage-briefing: SQLite storage requires the node:sqlite builtin ` +
        `(Node >= 23.4, or Node >= 22.5 with the server started with ` +
        `--experimental-sqlite): ${error.message}`,
    );
  }
}

/**
 * A logbook sail event as recorded by the backfill engine.
 *
 * @typedef {object} SailEvent
 * @property {string} timestamp - ISO-8601 instant of the event
 * @property {"REEF_INCREASE"|"REEF_DECREASE"|"SAIL_CHANGE"} eventType
 * @property {string} sailState - e.g. `REEF_1_GENOA`
 * @property {boolean} [night] - Whether the event happened at night
 *   (sun below civil twilight)
 * @property {string} [notes]
 */

/**
 * One learned matrix cell (SPEC §3.2).
 *
 * @typedef {object} MatrixBin
 * @property {number} twsBin - TWS bin index
 * @property {number} twaBin - TWA bin index
 * @property {string} preferredSailState - e.g. `MAIN_REEF_1_GENOA_100`
 * @property {number} avgTwsTrigger - EMA of observed TWS average (kn)
 * @property {number} minTwsGustTrigger - EMA of observed TWS peak (kn)
 * @property {number} samplesCount - Number of merged samples
 */

/**
 * Learned sail preference matrix (SPEC §3.2).
 *
 * @typedef {object} SailPreferenceMatrix
 * @property {number[]} twsBinsKnots
 * @property {number[]} twaBinsDegrees
 * @property {MatrixBin[]} matrix
 */

/**
 * SQLite-backed store for sail events, wind history, and the learned
 * sail preference matrix.
 */
class PassageDatabase {
  /**
   * Opens (and initializes) the database inside `dataDir`.
   *
   * @param {string} dataDir - Plugin data directory
   *   (`app.getDataDirPath()`), created when missing
   * @param {object} [options]
   * @param {string} [options.filename] - Database file name
   */
  constructor(dataDir, { filename = "passage-outlook.sqlite" } = {}) {
    const { mkdirSync } = require("node:fs");
    const { join } = require("node:path");
    mkdirSync(dataDir, { recursive: true });

    const { DatabaseSync } = loadSqlite();
    this.path = join(dataDir, filename);
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  /**
   * Creates the schema (SPEC §4.1) when missing.
   */
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS logbook_sail_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        sail_state TEXT NOT NULL,
        night INTEGER NOT NULL DEFAULT 0,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS wind_history_cache (
        timestamp TEXT PRIMARY KEY,
        tws_avg REAL NOT NULL,
        tws_peak REAL NOT NULL,
        twa_avg REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS learned_sail_matrix (
        tws_bin INTEGER NOT NULL,
        twa_bin INTEGER NOT NULL,
        night INTEGER NOT NULL DEFAULT 0,
        preferred_sail TEXT NOT NULL,
        avg_tws_trigger REAL NOT NULL,
        peak_gust_trigger REAL NOT NULL,
        sample_count INTEGER NOT NULL,
        PRIMARY KEY (tws_bin, twa_bin, night)
      );
    `);
  }

  /**
   * Records a logbook sail event.
   *
   * @param {SailEvent} event
   * @returns {number} Inserted row id
   */
  recordSailEvent({ timestamp, eventType, sailState, night = false, notes }) {
    const result = this.db
      .prepare(
        `INSERT INTO logbook_sail_events (timestamp, event_type, sail_state, night, notes)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(timestamp, eventType, sailState, night ? 1 : 0, notes ?? null);
    return Number(result.lastInsertRowid);
  }

  /**
   * Lists recorded sail events, newest first.
   *
   * @param {object} [options]
   * @param {number} [options.limit] - Maximum rows (default 100)
   * @returns {Array<SailEvent & {id: number, night: boolean}>}
   */
  getSailEvents({ limit = 100 } = {}) {
    return this.db
      .prepare(
        `SELECT id, timestamp, event_type AS eventType, sail_state AS sailState,
                night, notes
         FROM logbook_sail_events
         ORDER BY timestamp DESC, id DESC
         LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({ ...row, night: Boolean(row.night) }));
  }

  /**
   * Inserts or replaces a wind history sample (SPEC §4.2 window stats).
   *
   * @param {object} sample
   * @param {string} sample.timestamp - ISO-8601 instant (primary key)
   * @param {number} sample.twsAvg - Mean true wind speed (kn)
   * @param {number} sample.twsPeak - Peak true wind speed (kn)
   * @param {number} sample.twaAvg - Circular mean true wind angle (deg)
   */
  upsertWindHistory({ timestamp, twsAvg, twsPeak, twaAvg }) {
    this.db
      .prepare(
        `INSERT INTO wind_history_cache (timestamp, tws_avg, tws_peak, twa_avg)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (timestamp) DO UPDATE SET
           tws_avg = excluded.tws_avg,
           tws_peak = excluded.tws_peak,
           twa_avg = excluded.twa_avg`,
      )
      .run(timestamp, twsAvg, twsPeak, twaAvg);
  }

  /**
   * Fetches cached wind history samples in a window.
   *
   * @param {string} from - ISO-8601 start (inclusive)
   * @param {string} to - ISO-8601 end (inclusive)
   * @returns {Array<{timestamp: string, twsAvg: number, twsPeak: number, twaAvg: number}>}
   */
  getWindHistory(from, to) {
    return this.db
      .prepare(
        `SELECT timestamp, tws_avg AS twsAvg, tws_peak AS twsPeak, twa_avg AS twaAvg
         FROM wind_history_cache
         WHERE timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC`,
      )
      .all(from, to);
  }

  /**
   * Inserts or replaces a learned matrix cell. The day/night buckets
   * stay separate: the crew reefs deeper at night than the conditions
   * alone require (windvane steering, unseeable squalls), and that is
   * a behavior worth keeping.
   *
   * @param {object} bin
   * @param {number} bin.twsBin
   * @param {number} bin.twaBin
   * @param {boolean} [bin.night]
   * @param {string} bin.preferredSail
   * @param {number} bin.avgTwsTrigger
   * @param {number} bin.peakGustTrigger
   * @param {number} bin.sampleCount
   */
  upsertMatrixBin({
    twsBin,
    twaBin,
    night = false,
    preferredSail,
    avgTwsTrigger,
    peakGustTrigger,
    sampleCount,
  }) {
    this.db
      .prepare(
        `INSERT INTO learned_sail_matrix
           (tws_bin, twa_bin, night, preferred_sail, avg_tws_trigger, peak_gust_trigger, sample_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tws_bin, twa_bin, night) DO UPDATE SET
           preferred_sail = excluded.preferred_sail,
           avg_tws_trigger = excluded.avg_tws_trigger,
           peak_gust_trigger = excluded.peak_gust_trigger,
           sample_count = excluded.sample_count`,
      )
      .run(
        twsBin,
        twaBin,
        night ? 1 : 0,
        preferredSail,
        avgTwsTrigger,
        peakGustTrigger,
        sampleCount,
      );
  }

  /**
   * Raw learned matrix rows, ordered by bin coordinates.
   *
   * @returns {Array<{twsBin: number, twaBin: number, night: boolean, preferredSail: string, avgTwsTrigger: number, peakGustTrigger: number, sampleCount: number}>}
   */
  getMatrixBins() {
    return this.db
      .prepare(
        `SELECT tws_bin AS twsBin, twa_bin AS twaBin, night,
                preferred_sail AS preferredSail,
                avg_tws_trigger AS avgTwsTrigger,
                peak_gust_trigger AS peakGustTrigger,
                sample_count AS sampleCount
         FROM learned_sail_matrix
         ORDER BY tws_bin ASC, twa_bin ASC, night ASC`,
      )
      .all()
      .map((row) => ({ ...row, night: Boolean(row.night) }));
  }

  /**
   * Learned sail preference matrix in the SPEC §3.2 shape.
   *
   * @returns {SailPreferenceMatrix}
   */
  getSailPreferenceMatrix() {
    return {
      twsBinsKnots: TWS_BINS_KNOTS,
      twaBinsDegrees: TWA_BINS_DEGREES,
      matrix: this.getMatrixBins().map((row) => ({
        twsBin: row.twsBin,
        twaBin: row.twaBin,
        night: row.night,
        preferredSailState: row.preferredSail,
        minTwsGustTrigger: row.peakGustTrigger,
        samplesCount: row.sampleCount,
      })),
    };
  }

  /**
   * Checkpoints the WAL and closes the database.
   */
  close() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
}

module.exports = {
  PassageDatabase,
  TWS_BINS_KNOTS,
  TWA_BINS_DEGREES,
  EMA_ALPHA,
  binIndexFor,
  twsBinIndex,
  twaBinIndex,
  emaUpdate,
};
