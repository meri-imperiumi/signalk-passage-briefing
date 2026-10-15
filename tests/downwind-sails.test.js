/**
 * Unit tests for the proactive downwind sail recommendations (work
 * doc #41): the deployment gates (envelope, fill floor, point of
 * sail, squall/thunder/night), the minimum deployment window, the
 * retract boundaries, and the overlap resolution across sails.
 *
 * @file downwind-sails.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const simPromise = import("../public/downwind-sails.mjs");
let mod;

test("loads the module", async () => {
  mod = await simPromise;
  assert.equal(typeof mod.downwindRecommendations, "function");
  assert.equal(typeof mod.evaluateDownwindHour, "function");
  assert.equal(typeof mod.isDownwindSail, "function");
});

/** A downwind-sail hour: reach over a residual swell in light air. */
const QUALIFYING_ROW = {
  hoursFromNow: 4,
  timestamp: "2026-06-21T04:00:00.000Z",
  twsKnots: 10,
  gustKnots: 15,
  twdDeg: 180,
  headingDeg: 0,
  awsKnots: 6,
  hsMeters: 1.5,
  tpSeconds: 8,
  night: false,
  sailState: "MAIN_GENOA_1",
  comfortLevel: "easy",
};

const PARASAILOR = {
  name: "Parasailor",
  downwind: true,
  sailFamily: "parasailor",
  minimumWindKnots: 5,
  maximumWindKnots: 25,
  active: true,
};

test("isDownwindSail: server flag wins, name/type match as fallback", () => {
  assert.equal(mod.isDownwindSail(PARASAILOR), true);
  assert.equal(mod.isDownwindSail({ name: "A3", type: "gennaker" }), true);
  assert.equal(mod.isDownwindSail({ name: "Main", type: "mainsail" }), false);
  assert.equal(mod.isDownwindSail(null), false);
});

test("a qualifying hour passes every gate", () => {
  assert.equal(
    mod.evaluateDownwindHour({ row: QUALIFYING_ROW, sail: PARASAILOR }),
    null,
  );
});

test("gates reject the honest-bounded failures", () => {
  const cases = [
    [{ ...QUALIFYING_ROW, awsKnots: 1.2 }, "no fill"],
    [{ ...QUALIFYING_ROW, twdDeg: 45 }, "point of sail"], // close-hauled
    [{ ...QUALIFYING_ROW, twsKnots: 28 }, "wind envelope exit"],
    [{ ...QUALIFYING_ROW, twsKnots: 3 }, "wind envelope exit"], // below min
    [{ ...QUALIFYING_ROW, gustKnots: 26 }, "gust over the envelope"],
    [{ ...QUALIFYING_ROW, sailState: "NO_SAILS" }, "bare poles"],
    [{ ...QUALIFYING_ROW, night: true }, "nightfall"],
    [{ ...QUALIFYING_ROW, hsMeters: 0.3 }, "sails drawing"], // no swell
  ];
  for (const [row, expected] of cases) {
    assert.equal(
      mod.evaluateDownwindHour({ row, sail: PARASAILOR }),
      expected,
      JSON.stringify(row),
    );
  }
});

test("a stowed sail (active: false) still qualifies for deployment", () => {
  // In sailsconfiguration `active` means "currently flying right
  // now" — the stowed Parasailor reads active: false most of the
  // time, and recommending its deployment is the whole point
  // (Lille Ø regression: the real inventory stores it inactive)
  const stowed = { ...PARASAILOR, active: false };
  assert.equal(
    mod.evaluateDownwindHour({ row: QUALIFYING_ROW, sail: stowed }),
    null,
  );
});

test("the payoff is the with-sail tier, not the slatting-forced one", () => {
  // Rows without a learned rig read "rough" (slatting forced under
  // the unknown-rig branch) — the recommendation must not promise
  // "holds rough instead of slatting". The raw acceleration and
  // apparent wind recompute the with-sail tier honestly.
  const rows = [0, 1, 2].map((h) => ({
    ...QUALIFYING_ROW,
    hoursFromNow: h,
    comfortLevel: "rough", // slatting-penalized tier
    azMs2: 0.15, // Raw motion: bands easy on its own
  }));
  const recs = mod.downwindRecommendations(rows, [PARASAILOR]);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].comfortLevel, "easy");

  // Rows without the raw fields fall back to their own tier
  const bare = [0, 1, 2].map((h) => ({
    ...QUALIFYING_ROW,
    hoursFromNow: h,
    comfortLevel: "rough",
    azMs2: null,
  }));
  assert.equal(
    mod.downwindRecommendations(bare, [PARASAILOR])[0].comfortLevel,
    "rough",
  );
});

test("squall, rain and convective hours fail their named gates", () => {
  const gates = {
    squallHours: new Set([4]),
    rainHours: new Set([5]),
    convectiveHours: new Set([6]),
  };
  assert.equal(
    mod.evaluateDownwindHour({ row: QUALIFYING_ROW, sail: PARASAILOR, gates }),
    "squall window",
  );
  assert.equal(
    mod.evaluateDownwindHour({
      row: { ...QUALIFYING_ROW, hoursFromNow: 5 },
      sail: PARASAILOR,
      gates,
    }),
    "probable rain squalls",
  );
  assert.equal(
    mod.evaluateDownwindHour({
      row: { ...QUALIFYING_ROW, hoursFromNow: 6 },
      sail: PARASAILOR,
      gates,
    }),
    "convective air",
  );
});

test("short stretches below the hassle threshold produce nothing", () => {
  // Two qualifying hours: a two-hour blip gets a note at most
  const rows = [0, 1].map((h) => ({ ...QUALIFYING_ROW, hoursFromNow: h }));
  const sails = [PARASAILOR];
  assert.deepEqual(mod.downwindRecommendations(rows, sails), []);
});

test("a qualifying stretch recommends deployment with a retract boundary", () => {
  // Five qualifying hours, then a squall window ends the sail
  const rows = [];
  for (let h = 0; h < 5; h++) {
    rows.push({ ...QUALIFYING_ROW, hoursFromNow: h });
  }
  rows.push({
    ...QUALIFYING_ROW,
    hoursFromNow: 5,
    twsKnots: 10,
    gustKnots: 32, // factor 3.2, over the squall bars
  });
  const recs = mod.downwindRecommendations(rows, [PARASAILOR], {
    squallHours: new Set([5]),
  });
  assert.equal(recs.length, 1);
  const rec = recs[0];
  assert.equal(rec.sailName, "Parasailor");
  assert.equal(rec.hoursFromNow, 0);
  assert.equal(rec.hoursCount, 5);
  assert.equal(rec.retractHoursFromNow, 5);
  assert.equal(rec.retractReason, "squall window");
  // The honest payoff: the worst tier the window holds
  assert.equal(rec.comfortLevel, "easy");
});

test("the window runs to the horizon without a retract reason", () => {
  const rows = [0, 1, 2, 3].map((h) => ({
    ...QUALIFYING_ROW,
    hoursFromNow: h,
  }));
  const recs = mod.downwindRecommendations(rows, [PARASAILOR]);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].retractHoursFromNow, null);
  assert.equal(recs[0].retractReason, null);
});

test("night hours break the window into day stretches", () => {
  const rows = [];
  for (let h = 0; h < 8; h++) {
    rows.push({ ...QUALIFYING_ROW, hoursFromNow: h, night: h === 4 });
  }
  // Default: night kills it — two day stretches of 4 qualifying hours
  const recs = mod.downwindRecommendations(rows, [PARASAILOR]);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].retractReason, "nightfall");
  assert.equal(recs[0].retractHoursFromNow, 4);
  assert.equal(recs[1].hoursFromNow, 5);
  // Opt-in night deployment joins the stretch
  const joined = mod.downwindRecommendations(rows, [PARASAILOR], {
    nightDeployment: true,
  });
  assert.equal(joined.length, 1);
  assert.equal(joined[0].hoursCount, 8);
});

test("overlapping sails resolve to the longer payoff", () => {
  const rows = [0, 1, 2, 3, 4, 5].map((h) => ({
    ...QUALIFYING_ROW,
    hoursFromNow: h,
  }));
  const codeZero = {
    name: "Code Zero",
    downwind: true,
    sailFamily: "code zero",
    minimumWindKnots: 5,
    maximumWindKnots: 25,
    active: true,
  };
  // Both sails qualify everywhere; Parasailor wins via the later
  // start (longer window) — deterministic, one recommendation
  const recs = mod.downwindRecommendations(rows, [PARASAILOR, codeZero], {
    minimumWindowHours: 4,
  });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].sailFamily, "parasailor");
});

test("no downwind sails, no recommendations", () => {
  const rows = [0, 1, 2].map((h) => ({ ...QUALIFYING_ROW, hoursFromNow: h }));
  assert.deepEqual(
    mod.downwindRecommendations(rows, [{ name: "Main", downwind: false }]),
    [],
  );
  assert.deepEqual(mod.downwindRecommendations(rows, null), []);
});
