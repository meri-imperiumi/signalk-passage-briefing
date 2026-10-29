/**
 * Tests for the downwind-sail advisor's gates and window logic
 * (work doc #41) — the pure evaluator the planner and the backtest
 * runner share.
 *
 * @file spinnaker-advisor.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectDownwindWindows,
  DOWNWIND_MIN_TWA_DEG,
  DOWNWIND_FILL_MIN_AWS_KNOTS,
  DOWNWIND_MIN_WINDOW_HOURS,
  evaluateDownwindSail,
} = require("../public/spinnaker-advisor.mjs");

const ENVELOPE = { minTwsKnots: 7, maxTwsKnots: 14 };

const base = {
  twsKnots: 9,
  twaDeg: 150,
  awsKnots: 7,
  hsMeters: 0.8,
  gustFactor: 1.2,
  night: false,
  envelope: ENVELOPE,
};

test("the gates fire in order with honest reasons", () => {
  assert.equal(evaluateDownwindSail(base), null, "a trade-wind hour qualifies");
  assert.equal(evaluateDownwindSail({ ...base, twaDeg: 45 }), "point of sail");
  assert.equal(
    evaluateDownwindSail({ ...base, twaDeg: -45 }),
    "point of sail",
    "signed angles fold by abs: a port-tack close reach fails",
  );
  assert.equal(
    evaluateDownwindSail({ ...base, twsKnots: 5 }),
    "wind below envelope",
  );
  assert.equal(
    evaluateDownwindSail({ ...base, twsKnots: 20 }),
    "wind above envelope",
  );
  assert.equal(
    evaluateDownwindSail({ ...base, gustFactor: 2.4 }),
    "squall gusts",
    "the squall gate fires before the envelope ceiling",
  );
  // The gusts answer to the envelope ceiling too: a calm-factor hour
  // (19-24 kn mean, gusts to 30 past a 25 kn Parasailor) is too much
  // wind for the sail — the mean passing the gate is not enough
  assert.equal(
    evaluateDownwindSail({ ...base, gustKnots: 18 }),
    "gust above envelope",
    "gusts past the envelope ceiling kill the hour",
  );
  assert.equal(
    evaluateDownwindSail({ ...base, gustKnots: 13 }),
    null,
    "gusts inside the envelope keep the hour",
  );
  assert.equal(
    evaluateDownwindSail({ ...base, twsKnots: 20, gustKnots: 22 }),
    "wind above envelope",
    "the sustained breach names itself before the gust breach",
  );
  assert.equal(
    evaluateDownwindSail({ ...base, gustFactor: 2.4, gustKnots: 18 }),
    "squall gusts",
    "squall cycling keeps its precedence over the gust ceiling",
  );
  assert.equal(
    evaluateDownwindSail({ ...base, storm: true }),
    "squall window",
    "named forecast events (rain squalls, convective air) kill the hour",
  );
  assert.equal(
    evaluateDownwindSail({ ...base, awsKnots: 1.4 }),
    "below fill floor",
  );
  assert.equal(
    evaluateDownwindSail({ ...base, hsMeters: 4.2 }),
    "sea state",
    "above the crew's own take-down band (flown max 3.3 m)",
  );
  assert.equal(evaluateDownwindSail({ ...base, night: true }), "night");
  assert.equal(
    evaluateDownwindSail({ ...base, night: true, nightOk: true }),
    null,
  );
  assert.equal(evaluateDownwindSail({ twaDeg: NaN }), "unknown");
  // The plan's own rig gates the deployment: no downwind sail flies
  // over a motoring stretch, and the anchored schedule's rig changes
  // end the window whatever the wind says (work doc #47 session: the
  // Parasailor window sailed through a motoring stretch and a dawn
  // re-rig, its take-down 32 hours after the engine started)
  assert.equal(
    evaluateDownwindSail({ ...base, underCanvas: false }),
    "bare poles",
  );
  assert.equal(
    evaluateDownwindSail({ ...base, rigChanged: true }),
    "rig change",
  );
  // Absent fields never gate: the legacy callers pass neither
  assert.equal(evaluateDownwindSail(base), null);
});

test("the crew's own numbers shape the constants", () => {
  // Downwind sails are deep: the default floor sits at 90 and the
  // per-class floors carry the crew's stated 130 (Parasailor); they
  // fly a third of their hours after dark
  assert.equal(DOWNWIND_MIN_TWA_DEG, 90);
  assert.equal(DOWNWIND_FILL_MIN_AWS_KNOTS, 2);
  assert.equal(DOWNWIND_MIN_WINDOW_HOURS, 3);
});

test("the per-class TWA floor overrides the default", () => {
  // The Parasailor floor is 130: a 110 deg hour is reaching water
  // no sail aboard covers
  assert.equal(
    evaluateDownwindSail({
      ...base,
      twaDeg: 110,
      envelope: { minTwaDeg: 130 },
    }),
    "point of sail",
  );
  assert.equal(
    evaluateDownwindSail({
      ...base,
      twaDeg: 135,
      envelope: { minTwaDeg: 130 },
    }),
    null,
  );
});

test("night hours continue an open window but never open one", () => {
  const hour = (h, reason, night = false) => ({
    hourMs: Date.parse("2026-06-20T06:00:00Z") + h * 3600000,
    qualifies: reason == null,
    reason,
    night,
  });
  const ok = null;
  const hours = [
    hour(0, ok),
    hour(1, ok),
    hour(2, ok),
    hour(3, "night", true), // sails stay up overnight
    hour(4, "night", true),
    hour(5, ok),
    hour(6, ok),
  ];
  const windows = collectDownwindWindows(hours);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].hours, 7);

  // A window that STARTS at night does not recommend: rigging in the
  // dark is the reluctance the gate models
  const nightStart = [
    hour(0, "night", true),
    hour(1, "night", true),
    hour(2, "night", true),
    hour(3, "night", true),
  ];
  assert.equal(collectDownwindWindows(nightStart).length, 0);

  // Short blips stay quiet (the hassle threshold)
  const blip = [hour(0, ok), hour(1, ok)];
  assert.equal(collectDownwindWindows(blip).length, 0);
});
