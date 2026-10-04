const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const tgPromise = import("../public/tack-gybe.js");

const approx = (actual, expected, epsilon = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} ≈ ${expected} (±${epsilon})`,
  );

/**
 * Builds one hourly simulation row for the detection tests.
 *
 * @param {object} overrides
 * @returns {object}
 */
function row(overrides = {}) {
  return {
    hoursFromNow: 1,
    timestamp: "2026-06-21T01:00:00.000Z",
    lat: 0.5,
    lon: 0,
    distanceFromStartNm: 5,
    headingDeg: 0,
    twdDeg: 45,
    twsKnots: 12,
    sogKnots: 5,
    sailState: "MAIN_FULL",
    motoring: false,
    night: false,
    ...overrides,
  };
}

describe("tack & gybe detection", () => {
  test("wrap180 normalizes to (-180, 180]", async () => {
    const { wrap180 } = await tgPromise;
    assert.equal(wrap180(0), 0);
    assert.equal(wrap180(180), 180);
    assert.equal(wrap180(-180), 180);
    assert.equal(wrap180(190), -170);
    assert.equal(wrap180(-190), 170);
    assert.equal(wrap180(540), 180);
  });

  test("tackSide: positive TWA is starboard", async () => {
    const { tackSide } = await tgPromise;
    assert.equal(tackSide(30), "starboard");
    assert.equal(tackSide(-30), "port");
    assert.equal(tackSide(170), "starboard");
  });

  test("upwind beat: single tack with interpolated crossing", async () => {
    const { detectManeuvers } = await tgPromise;
    const events = detectManeuvers([
      row({
        hoursFromNow: 1,
        timestamp: "2026-06-21T01:00:00.000Z",
        headingDeg: 30,
        twdDeg: 60,
        lat: 0.5,
        distanceFromStartNm: 5,
      }),
      row({
        hoursFromNow: 2,
        timestamp: "2026-06-21T02:00:00.000Z",
        headingDeg: 90,
        twdDeg: 60,
        lat: 0.4,
        distanceFromStartNm: 10,
      }),
    ]);
    assert.equal(events.length, 1);
    const [e] = events;
    assert.equal(e.maneuver, "tack");
    assert.equal(e.fromTack, "starboard");
    assert.equal(e.toTack, "port");
    assert.equal(e.sailState, "MAIN_FULL@port");
    // TWA +30 → −30: crossing at the segment midpoint
    assert.equal(e.hoursFromNow, 1.5);
    assert.equal(e.timestamp, "2026-06-21T01:30:00.000Z");
    assert.equal(e.eta, e.timestamp);
    approx(e.lat, 0.45);
    assert.equal(e.distanceFromStartNm, 7.5);
    assert.equal(e.twsAtManeuver, 12);
  });

  test("downwind run: gybe classified across ±180", async () => {
    const { detectManeuvers } = await tgPromise;
    const events = detectManeuvers([
      row({ headingDeg: 0, twdDeg: 170 }),
      row({ headingDeg: 0, twdDeg: -170 }),
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0].maneuver, "gybe");
    assert.equal(events[0].fromTack, "starboard");
    assert.equal(events[0].toTack, "port");
  });

  test("TWA wrap-around near ±180 still detects the gybe", async () => {
    const { detectManeuvers } = await tgPromise;
    const events = detectManeuvers([
      row({ hoursFromNow: 1, headingDeg: 0, twdDeg: 175 }),
      row({ hoursFromNow: 2, headingDeg: 0, twdDeg: -176 }),
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0].maneuver, "gybe");
    // The path from +175 to −176 wraps through +180: ΔTWA =
    // wrap(−351) = +9°, crossing at f = (180 − 175)/9 = 5/9 ≈ 0.556,
    // rounded to the sim row's 0.1 h precision
    approx(events[0].hoursFromNow, 1.6, 0.001);
  });

  test("motoring legs are excluded", async () => {
    const { detectManeuvers } = await tgPromise;
    const events = detectManeuvers([
      row({ headingDeg: 30, twdDeg: 60 }),
      row({ headingDeg: 90, twdDeg: 60, motoring: true }),
      row({ headingDeg: 150, twdDeg: 60 }),
    ]);
    assert.equal(events.length, 0);
  });

  test("drift-mode hours (SOG 0) are excluded", async () => {
    const { detectManeuvers } = await tgPromise;
    const events = detectManeuvers([
      row({ headingDeg: 30, twdDeg: 60 }),
      row({ headingDeg: 90, twdDeg: 60, sogKnots: 0 }),
      row({ headingDeg: 150, twdDeg: 60 }),
    ]);
    assert.equal(events.length, 0);
  });

  test("canvas-down hours are excluded", async () => {
    const { detectManeuvers } = await tgPromise;
    // NO_SAILS rows making way (motor-carried current-assisted) are
    // course changes under power, not maneuvers
    const events = detectManeuvers([
      row({ headingDeg: 30, twdDeg: 60 }),
      row({ headingDeg: 90, twdDeg: 60, sailState: "NO_SAILS" }),
      row({ headingDeg: 150, twdDeg: 60 }),
    ]);
    assert.equal(events.length, 0);
  });

  test("wobble below the 25° margin is rejected", async () => {
    const { detectManeuvers, MIN_TWA_MARGIN_DEG } = await tgPromise;
    assert.equal(MIN_TWA_MARGIN_DEG, 25);
    const events = detectManeuvers([
      row({ headingDeg: 40, twdDeg: 60 }),
      row({ headingDeg: 80, twdDeg: 60 }),
    ]);
    assert.equal(events.length, 0);
  });

  test("gradual veer through a low-wind-angle hour still lands the tack", async () => {
    const { detectManeuvers } = await tgPromise;
    // TWA +45 → +5 → −45: the mid hour dips below the margin while
    // the wind swings through the eye, but the established side flips
    const events = detectManeuvers([
      row({ hoursFromNow: 1, headingDeg: 0, twdDeg: 45 }),
      row({ hoursFromNow: 2, headingDeg: 0, twdDeg: 5 }),
      row({ hoursFromNow: 3, headingDeg: 0, twdDeg: -45 }),
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0].maneuver, "tack");
    assert.equal(events[0].fromTack, "starboard");
    assert.equal(events[0].toTack, "port");
  });

  test("wobble that never flips the established side stays silent", async () => {
    const { detectManeuvers } = await tgPromise;
    const events = detectManeuvers([
      row({ hoursFromNow: 1, headingDeg: 0, twdDeg: 45 }),
      row({ hoursFromNow: 2, headingDeg: 0, twdDeg: 10 }),
      row({ hoursFromNow: 3, headingDeg: 0, twdDeg: 45 }),
    ]);
    assert.equal(events.length, 0);
  });

  test("mixed beam reach (one side < 90, one > 90) is not classified", async () => {
    const { detectManeuvers } = await tgPromise;
    const events = detectManeuvers([
      row({ headingDeg: 30, twdDeg: 60 }),
      row({ headingDeg: 170, twdDeg: 60 }),
    ]);
    assert.equal(events.length, 0);
  });

  test("multi-maneuver route: tack then gybe, time-sorted", async () => {
    const { detectManeuvers } = await tgPromise;
    const events = detectManeuvers([
      row({ hoursFromNow: 1, headingDeg: 30, twdDeg: 60 }),
      row({ hoursFromNow: 2, headingDeg: 90, twdDeg: 60 }),
      row({ hoursFromNow: 3, headingDeg: 90, twdDeg: -95 }),
      row({ hoursFromNow: 4, headingDeg: 90, twdDeg: -60 }),
    ]);
    assert.equal(events.length, 2);
    assert.equal(events[0].maneuver, "tack");
    assert.equal(events[1].maneuver, "gybe");
    assert.ok(events[0].hoursFromNow <= events[1].hoursFromNow);
  });

  test("no wind data yields no events", async () => {
    const { detectManeuvers } = await tgPromise;
    const events = detectManeuvers([
      row({ headingDeg: 30, twdDeg: null }),
      row({ headingDeg: 90, twdDeg: null }),
    ]);
    assert.equal(events.length, 0);
  });

  test("no sail state: event still carries the tack label", async () => {
    const { detectManeuvers } = await tgPromise;
    const events = detectManeuvers([
      row({ headingDeg: 30, twdDeg: 60, sailState: null }),
      row({ headingDeg: 90, twdDeg: 60, sailState: null }),
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0].sailState, "@port");
  });
});
