const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { PassageDatabase } = require("../plugin/sqlite-db.js");
const {
  WINDOW_MINUTES,
  foldTwaDegrees,
  circularMeanDegrees,
  createLogbookWindStats,
  extractWindWindowStats,
  createHistoryWindStats,
  applySailEvent,
  backfillSailEvents,
} = require("../plugin/history-backfill.js");

const makeDb = () =>
  new PassageDatabase(mkdtempSync(join(tmpdir(), "passage-backfill-")));

const approx = (actual, expected, epsilon = 1e-3) =>
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} ≈ ${expected}`,
  );

describe("wind helpers", () => {
  test("folds directions onto 0..180", () => {
    assert.equal(foldTwaDegrees(0), 0);
    assert.equal(foldTwaDegrees(90), 90);
    assert.equal(foldTwaDegrees(210), 150);
    assert.equal(foldTwaDegrees(-30), 30);
    assert.equal(foldTwaDegrees(360), 0);
  });

  test("circular mean of folded angles stays in 0..180", () => {
    assert.equal(circularMeanDegrees([10, 20]), 15);
    assert.equal(circularMeanDegrees([45, 135]), 90);
    // Opposite ends of the folded range average through the middle
    assert.equal(circularMeanDegrees([175, 5]), 90);
    assert.equal(circularMeanDegrees([10]), 10);
  });
});

describe("createLogbookWindStats", () => {
  const entries = [
    {
      datetime: "2023-03-20T08:00:00.000Z",
      wind: { speed: 10, direction: 200 },
    },
    {
      datetime: "2023-03-20T09:20:00.000Z",
      text: "Motor stopped, sailing with Main",
      wind: { speed: 12, direction: 210 },
    },
    {
      datetime: "2023-03-20T09:28:00.000Z",
      text: "Sails set: Main (1st reef)",
      wind: { speed: 16, direction: 220 },
    },
    {
      datetime: "2023-03-20T11:00:00.000Z",
      wind: { speed: 20, direction: 230 },
    },
  ];

  test("collects the event entry and adjacent entries in the window", () => {
    const getStats = createLogbookWindStats(entries);
    const stats = getStats({ timestamp: "2023-03-20T09:28:00.000Z" });
    assert.equal(stats.samples, 2);
    assert.equal(stats.twsAvg, 14);
    assert.equal(stats.twsPeak, 16);
    // Circular mean of 150 (from 210°) and 140 (from 220°)
    assert.equal(Math.round(stats.twaAvg), 145);
  });

  test("window is bounded at 15 minutes before the event", () => {
    const getStats = createLogbookWindStats(entries);
    const stats = getStats({ timestamp: "2023-03-20T09:28:00.000Z" });
    // 08:00 entry (88 min before) is outside the window
    assert.equal(stats.samples, 2);

    const hour = createLogbookWindStats(entries, 300);
    assert.equal(hour({ timestamp: "2023-03-20T09:28:00.000Z" }).samples, 3);
  });

  test("null when the window has no wind data", () => {
    const getStats = createLogbookWindStats(entries);
    assert.equal(getStats({ timestamp: "2023-03-20T10:30:00.000Z" }), null);
  });
});

describe("createHistoryWindStats", () => {
  test("queries the window and converts SI values", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      const u = new URL(url);
      assert.equal(u.pathname, "/signalk/v2/api/history/values");
      assert.equal(
        u.searchParams.get("paths"),
        "environment.wind.speedTrue,environment.wind.angleTrue",
      );
      return {
        ok: true,
        json: async () => ({
          values: [
            { path: "environment.wind.speedTrue" },
            { path: "environment.wind.angleTrue" },
          ],
          data: [
            // m/s, radians: 5.1444 m/s = 10 kn, 210° from = -150° → folded 150
            ["2023-03-20T09:20:00Z", 5.1444, -2.617994],
            ["2023-03-20T09:25:00Z", 8.231, -2.792527],
          ],
        }),
      };
    };
    const getStats = createHistoryWindStats({
      baseUrl: "http://localhost:3000",
      fetchImpl,
    });
    const stats = await getStats({ timestamp: "2023-03-20T09:28:00.000Z" });
    assert.equal(stats.samples, 2);
    // 5.1444 m/s = 10 kn, 8.2310 m/s = 16 kn
    approx(stats.twsAvg, 13);
    approx(stats.twsPeak, 16);
    // Angles −150° and −160° fold to 150° and 160°
    approx(stats.twaAvg, 155);
    const from = new URL(calls[0]).searchParams.get("from");
    const to = new URL(calls[0]).searchParams.get("to");
    assert.equal(
      new Date(to).getTime() - new Date(from).getTime(),
      WINDOW_MINUTES * 60 * 1000,
    );
  });

  test("HTTP errors propagate", async () => {
    const getStats = createHistoryWindStats({
      baseUrl: "http://localhost:3000",
      fetchImpl: async () => ({ ok: false, status: 500, statusText: "boom" }),
    });
    await assert.rejects(
      getStats({ timestamp: "2023-03-20T09:28:00.000Z" }),
      /History API returned 500/,
    );
  });
});

describe("extractWindWindowStats", () => {
  test("bounds the window and skips non-numeric samples", () => {
    const historyData = {
      values: [
        { path: "environment.wind.speedTrue" },
        { path: "environment.wind.angleTrue" },
      ],
      data: [
        ["2023-03-20T09:00:00Z", 5.0, 1.0], // Outside window
        ["2023-03-20T09:20:00Z", 5.1444, 2.617994], // 10 kn, 150° TWA
        ["2023-03-20T09:25:00Z", null, 2.0], // No speed → skipped
        ["2023-03-20T09:27:00Z", 8.23104, 1.5707963], // 16 kn, 90° TWA
      ],
    };
    const stats = extractWindWindowStats({
      historyData,
      from: new Date("2023-03-20T09:15:00Z"),
      to: new Date("2023-03-20T09:28:00Z"),
    });
    assert.equal(stats.samples, 2);
    approx(stats.twsAvg, 13);
    approx(stats.twsPeak, 16);
    approx(stats.twaAvg, 120);
  });

  test("null when no speed column or no data", () => {
    assert.equal(
      extractWindWindowStats({
        historyData: { values: [], data: [] },
        from: new Date("2023-03-20T09:15:00Z"),
        to: new Date("2023-03-20T09:28:00Z"),
      }),
      null,
    );
  });
});

describe("applySailEvent", () => {
  test("seeds the matrix bin and the EMA converges with more samples", () => {
    const db = makeDb();
    try {
      const first = applySailEvent({
        db,
        event: {
          timestamp: "2023-03-20T09:28:00.000Z",
          eventType: "REEF_INCREASE",
          sailState: "GENOA_1_MAIN_1_REEF",
        },
        stats: { samples: 1, twsAvg: 16, twsPeak: 16, twaAvg: 145 },
      });
      assert.equal(first.twsBin, 3); // 15..20 kn bin
      assert.equal(first.twaBin, 4); // 120..150° bin
      assert.equal(first.sampleCount, 1);
      assert.equal(first.avgTwsTrigger, 16);
      assert.equal(first.peakGustTrigger, 16);

      // α = 0.2 EMA toward the new observation (same bin: 15..20 kn)
      const second = applySailEvent({
        db,
        event: {
          timestamp: "2023-03-25T09:28:00.000Z",
          eventType: "REEF_INCREASE",
          sailState: "GENOA_1_MAIN_1_REEF",
        },
        stats: { samples: 2, twsAvg: 18, twsPeak: 21, twaAvg: 145 },
      });
      assert.equal(second.sampleCount, 2);
      approx(second.avgTwsTrigger, 0.8 * 16 + 0.2 * 18);
      approx(second.peakGustTrigger, 0.8 * 16 + 0.2 * 21);

      const matrix = db.getSailPreferenceMatrix();
      assert.equal(matrix.matrix.length, 1);
      assert.equal(matrix.matrix[0].preferredSailState, "GENOA_1_MAIN_1_REEF");
      assert.equal(matrix.matrix[0].samplesCount, 2);

      // Wind cache rows exist for both events
      assert.equal(
        db.getWindHistory("2023-03-20T00:00:00Z", "2023-03-26T00:00:00Z")
          .length,
        2,
      );
    } finally {
      db.close();
    }
  });
});

describe("backfillSailEvents", () => {
  const events = [
    {
      timestamp: "2023-03-20T09:28:00.000Z",
      eventType: "REEF_INCREASE",
      sailState: "GENOA_1_MAIN_1_REEF",
      notes: "Sails set: Main (1st reef), Genoa 1",
    },
    {
      timestamp: "2023-03-20T09:45:00.000Z", // Window has no wind entries
      eventType: "SAIL_CHANGE",
      sailState: "NO_SAILS",
    },
  ];

  test("learns events with wind, skips events without, is idempotent", async () => {
    const db = makeDb();
    try {
      const entries = [
        {
          datetime: "2023-03-20T09:28:00.000Z",
          wind: { speed: 16, direction: 220 },
        },
      ];
      const getWindStats = createLogbookWindStats(entries);

      const first = await backfillSailEvents({ db, events, getWindStats });
      assert.equal(first.total, 2);
      assert.equal(first.learned, 1);
      assert.equal(first.skippedNoData, 1);
      assert.equal(first.cells.length, 1);

      // Recorded into the logbook events table
      assert.equal(db.getSailEvents().length, 1);
      assert.equal(db.getSailEvents()[0].eventType, "REEF_INCREASE");

      // Re-run: everything already cached
      const second = await backfillSailEvents({ db, events, getWindStats });
      assert.equal(second.learned, 0);
      assert.equal(second.skippedCached, 1);
      assert.equal(second.skippedNoData, 1);
      assert.equal(db.getMatrixBins().length, 1);
      assert.equal(db.getMatrixBins()[0].sampleCount, 1);
    } finally {
      db.close();
    }
  });

  test("processes events chronologically regardless of input order", async () => {
    const db = makeDb();
    try {
      const entries = [
        {
          datetime: "2023-03-20T09:28:00.000Z",
          wind: { speed: 16, direction: 220 },
        },
        {
          datetime: "2023-03-21T09:28:00.000Z",
          wind: { speed: 8, direction: 220 },
        },
      ];
      // Shuffled input: the 03-21 reef decrease first, then the two
      // 03-20 events out of order. The shake-out 90 s after the reef
      // shares the reef event's wind window (adjacent-entry wind).
      const summary = await backfillSailEvents({
        db,
        events: [
          {
            timestamp: "2023-03-21T09:28:00.000Z",
            eventType: "REEF_DECREASE",
            sailState: "GENOA_1_MAIN",
          },
          {
            timestamp: "2023-03-20T09:29:30.000Z",
            eventType: "SAIL_CHANGE",
            sailState: "NO_SAILS",
          },
          {
            timestamp: "2023-03-20T09:28:00.000Z",
            eventType: "REEF_INCREASE",
            sailState: "GENOA_1_MAIN_1_REEF",
          },
        ],
        getWindStats: createLogbookWindStats(entries),
      });
      assert.equal(summary.total, 3);
      assert.equal(summary.learned, 3);

      const bins = db.getMatrixBins();
      assert.equal(bins.length, 2);
      // Chronological order matters: the bin's preferred sail is the
      // most recent observation, and the EMA runs over 16 → 16 → 8 kn
      const reefBin = bins.find((bin) => bin.twsBin === 3);
      assert.equal(reefBin.sampleCount, 2);
      approx(reefBin.avgTwsTrigger, 0.8 * 16 + 0.2 * 16);
      assert.equal(reefBin.preferredSail, "NO_SAILS");
      const lightBin = bins.find((bin) => bin.twsBin === 1);
      assert.equal(lightBin.sampleCount, 1);
      assert.equal(lightBin.preferredSail, "GENOA_1_MAIN");
    } finally {
      db.close();
    }
  });
});
