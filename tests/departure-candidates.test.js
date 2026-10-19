const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const physics = () => import("../public/sereno-physics.mjs");

// Tonga fixtures, the same the assumedDepartureTime tests use
const LAT = -21.1;
const LON = -175.2;

describe("departure-day candidates (work doc #34)", () => {
  test("underway: the single now-departure, no variants", async () => {
    const { departureCandidates } = await physics();
    const now = new Date("2026-10-04T20:00:00Z");
    const candidates = departureCandidates({
      now,
      lat: LAT,
      lon: LON,
      underway: true,
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].reason, "underway");
    assert.equal(candidates[0].dayOffset, 0);
    assert.equal(candidates[0].time.getTime(), now.getTime());
  });

  test("night now: consecutive dawns, one per candidate day", async () => {
    const { departureCandidates } = await physics();
    // 12:00 UTC at 175°W ≈ deep night (the work doc #15 fixture)
    const now = new Date("2026-10-04T12:00:00Z");
    const candidates = departureCandidates({ now, lat: LAT, lon: LON });
    assert.equal(candidates.length, 3);
    for (const [index, candidate] of candidates.entries()) {
      assert.equal(candidate.dayOffset, index);
      assert.equal(candidate.reason, "next_dawn");
    }
    // Each candidate day anchors to its own dawn, ~24 h apart
    const d0 = candidates[0].time.getTime();
    const d1 = candidates[1].time.getTime();
    const d2 = candidates[2].time.getTime();
    assert.ok(
      d1 - d0 > 23 * 3600000 && d1 - d0 < 25 * 3600000,
      `dawn gap ${((d1 - d0) / 3600000).toFixed(2)} h`,
    );
    assert.ok(
      d2 - d1 > 23 * 3600000 && d2 - d1 < 25 * 3600000,
      `dawn gap ${((d2 - d1) / 3600000).toFixed(2)} h`,
    );
  });

  test("day now: the same prep-anchored decision, one day later", async () => {
    const { departureCandidates } = await physics();
    // Local mid-day at 175°W: prep window inside daylight
    const now = new Date("2026-10-04T23:00:00Z");
    const candidates = departureCandidates({ now, lat: LAT, lon: LON });
    assert.equal(candidates.length, 3);
    assert.equal(candidates[0].reason, "daylight_prep");
    assert.equal(candidates[1].reason, "daylight_prep");
    // Tomorrow's candidate repeats the same rules 24 h later
    assert.equal(
      candidates[1].time.getTime() - candidates[0].time.getTime(),
      24 * 3600000,
    );
  });

  test("days parameter bounds the enumeration", async () => {
    const { departureCandidates } = await physics();
    const now = new Date("2026-10-04T12:00:00Z");
    assert.equal(
      departureCandidates({ now, lat: LAT, lon: LON, days: 2 }).length,
      2,
    );
    assert.equal(
      departureCandidates({ now, lat: LAT, lon: LON, days: 5 }).length,
      5,
    );
  });
});
