const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  PassageDatabase,
  TWS_BINS_KNOTS,
  TWA_BINS_DEGREES,
  EMA_ALPHA,
  twsBinIndex,
  twaBinIndex,
  emaUpdate,
} = require("../plugin/sqlite-db.js");

const makeDb = (label) =>
  new PassageDatabase(mkdtempSync(join(tmpdir(), `passage-${label}-`)));

describe("sqlite db", () => {
  test("creates the spec schema tables", () => {
    const db = makeDb("schema");
    try {
      const tables = db.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
        )
        .all()
        .map((row) => row.name);
      assert.ok(tables.includes("logbook_sail_events"));
      assert.ok(tables.includes("wind_history_cache"));
      assert.ok(tables.includes("learned_sail_matrix"));

      const wal = db.db.prepare("PRAGMA journal_mode").get();
      assert.equal(wal.journal_mode, "wal");
    } finally {
      db.close();
    }
  });

  test("records and lists sail events", () => {
    const db = makeDb("events");
    try {
      const id = db.recordSailEvent({
        timestamp: "2026-08-01T12:00:00Z",
        eventType: "REEF_INCREASE",
        sailState: "REEF_1_GENOA",
        notes: "gust line",
      });
      assert.equal(id, 1);
      db.recordSailEvent({
        timestamp: "2026-08-01T14:00:00Z",
        eventType: "SAIL_CHANGE",
        sailState: "MAIN_FULL_GENOA_100",
      });

      const events = db.getSailEvents();
      assert.equal(events.length, 2);
      assert.equal(events[0].sailState, "MAIN_FULL_GENOA_100");
      assert.equal(events[0].notes, null);
      assert.equal(events[1].eventType, "REEF_INCREASE");
    } finally {
      db.close();
    }
  });

  test("upserts wind history keyed by timestamp", () => {
    const db = makeDb("wind");
    try {
      db.upsertWindHistory({
        timestamp: "2026-08-01T12:00:00Z",
        twsAvg: 12.5,
        twsPeak: 18.2,
        twaAvg: 95,
      });
      db.upsertWindHistory({
        timestamp: "2026-08-01T12:00:00Z",
        twsAvg: 12.8,
        twsPeak: 18.6,
        twaAvg: 94,
      });
      db.upsertWindHistory({
        timestamp: "2026-08-01T12:15:00Z",
        twsAvg: 13.1,
        twsPeak: 16.0,
        twaAvg: 100,
      });

      assert.equal(
        db.db.prepare("SELECT COUNT(*) AS n FROM wind_history_cache").get().n,
        2,
      );
      const window = db.getWindHistory(
        "2026-08-01T12:00:00Z",
        "2026-08-01T12:15:00Z",
      );
      assert.equal(window.length, 2);
      assert.equal(window[0].twsAvg, 12.8);
    } finally {
      db.close();
    }
  });

  test("bins and EMA follow the spec constants", () => {
    assert.deepEqual(TWS_BINS_KNOTS, [0, 5, 10, 15, 20, 25, 30, 35, 40]);
    assert.deepEqual(TWA_BINS_DEGREES, [0, 30, 60, 90, 120, 150, 180]);
    assert.equal(EMA_ALPHA, 0.2);

    assert.equal(twsBinIndex(0), 0);
    assert.equal(twsBinIndex(7.5), 1);
    assert.equal(twsBinIndex(22), 4);
    assert.equal(twsBinIndex(42), 8);
    assert.equal(twaBinIndex(15), 0);
    assert.equal(twaBinIndex(120), 4);
    assert.equal(twaBinIndex(200), 6);
  });

  test("emaUpdate applies the 0.2 learning rate", () => {
    // Spec formula: (1 - 0.2) * old + 0.2 * sample.
    assert.equal(emaUpdate(10, 20), 0.8 * 10 + 0.2 * 20);
    assert.equal(emaUpdate(null, 17.5), 17.5);
  });

  test("matrix bins round-trip in the spec shape", () => {
    const db = makeDb("matrix");
    try {
      db.upsertMatrixBin({
        twsBin: twsBinIndex(12),
        twaBin: twaBinIndex(95),
        preferredSail: "MAIN_FULL_GENOA_100",
        avgTwsTrigger: 12.5,
        peakGustTrigger: 18.0,
        sampleCount: 3,
      });
      // Rebinding the same cell replaces it instead of duplicating.
      db.upsertMatrixBin({
        twsBin: 2,
        twaBin: 3,
        preferredSail: "MAIN_REEF_1_GENOA_100",
        avgTwsTrigger: 12.1,
        peakGustTrigger: 17.4,
        sampleCount: 4,
      });

      const bins = db.getMatrixBins();
      assert.equal(bins.length, 1);
      assert.equal(bins[0].twsBin, 2);
      assert.equal(bins[0].twaBin, 3);

      const matrix = db.getSailPreferenceMatrix();
      assert.deepEqual(matrix.twsBinsKnots, TWS_BINS_KNOTS);
      assert.deepEqual(matrix.twaBinsDegrees, TWA_BINS_DEGREES);
      assert.equal(matrix.matrix.length, 1);
      assert.equal(
        matrix.matrix[0].preferredSailState,
        "MAIN_REEF_1_GENOA_100",
      );
      assert.equal(matrix.matrix[0].minTwsGustTrigger, 17.4);
      assert.equal(matrix.matrix[0].samplesCount, 4);
    } finally {
      db.close();
    }
  });
});

describe("learned-matrix reset migration (work doc #26)", () => {
  test("the reset clears the derived stores exactly once", () => {
    const db = makeDb("nosails-migration");
    try {
      // Fresh construction runs the migration on empty tables
      assert.equal(db.db.prepare("PRAGMA user_version").get().user_version, 1);

      // Seed the derived stores, then re-run migrate: the version
      // marker keeps the reset from wiping live data
      db.upsertMatrixBin({
        twsBin: 3,
        twaBin: 4,
        night: true,
        preferredSail: "NO_SAILS",
        avgTwsTrigger: 16,
        peakGustTrigger: 20,
        sampleCount: 2,
      });
      db.upsertWindHistory({
        timestamp: "2023-03-20T09:28:00.000Z",
        twsAvg: 16,
        twsPeak: 20,
        twaAvg: 140,
      });
      db.migrate();
      assert.equal(db.getMatrixBins().length, 1);
      assert.equal(
        db.getWindHistory("2023-03-20T00:00:00Z", "2023-03-21T00:00:00Z")
          .length,
        1,
      );
    } finally {
      db.close();
    }
  });

  test("a pre-existing database is rebuilt from scratch", () => {
    const db = makeDb("nosails-reset");
    try {
      // Simulate a database learned under the old rules
      db.db.prepare("PRAGMA user_version = 0").run();
      db.upsertMatrixBin({
        twsBin: 3,
        twaBin: 4,
        night: true,
        preferredSail: "NO_SAILS",
        avgTwsTrigger: 16,
        peakGustTrigger: 20,
        sampleCount: 2,
      });
      db.upsertWindHistory({
        timestamp: "2023-03-20T09:28:00.000Z",
        twsAvg: 16,
        twsPeak: 20,
        twaAvg: 140,
      });
      db.recordSailEvent({
        timestamp: "2023-03-20T09:28:00.000Z",
        eventType: "SAIL_CHANGE",
        sailState: "NO_SAILS",
      });

      db.migrate();

      // Everything derived is gone; the logbook files outside the
      // store are the source of truth and the next backfill rebuilds
      assert.equal(db.getMatrixBins().length, 0);
      assert.equal(
        db.getWindHistory("2023-03-20T00:00:00Z", "2023-03-21T00:00:00Z")
          .length,
        0,
      );
      assert.equal(db.getSailEvents({ limit: 100 }).length, 0);
      assert.equal(db.db.prepare("PRAGMA user_version").get().user_version, 1);
    } finally {
      db.close();
    }
  });
});
