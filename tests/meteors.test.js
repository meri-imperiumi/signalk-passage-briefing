/**
 * Unit tests for the meteor-shower night evaluation (work doc #37),
 * focused on the window math (audit fix): the `hours` param is a count
 * of HOURS, and the candidate-screen's far edge must bind at
 * `end + CANDIDATE_BEFORE_MS` — an earlier version multiplied the
 * hours by DAY_MS, computing a day-scale end from an hour count and
 * leaving the far-side gate dead.
 *
 * @file meteors.test.js
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { meteorNightEvents } = require("../public/components/meteors.mjs");

/** The Lyrids, April 22 14:00 UTC — the shower the fixtures aim at. */
const PEAK_MS = Date.UTC(2027, 3, 22, 14);

/**
 * A night context entry the way celestialNights emits them: a dusk
 * anchor, the dawn bracket and a moon reading the caller vouches for.
 */
function night(anchorMs, { lengthHours = 12 } = {}) {
  return {
    timestamp: new Date(anchorMs).toISOString(),
    nauticalDusk: new Date(anchorMs).toISOString(),
    nauticalDawn: new Date(anchorMs + lengthHours * 3600000).toISOString(),
    moonIllumination: 0,
  };
}

describe("meteor window", () => {
  test("a peak far beyond the window produces no events", () => {
    // Window: Apr 12 + 24 h. Peak ten days out — inside the dead
    // gate's old day-scale reach (which fired the climbing night),
    // far outside the honest end + 46 h screen.
    const from = new Date(Date.UTC(2027, 3, 12, 12));
    const nights = [night(PEAK_MS - 20 * 3600000)];
    const events = meteorNightEvents({
      from,
      hours: 24,
      nights,
      lat: 34, // Lyrid radiant overhead at this latitude
    });
    assert.deepEqual(events, []);
  });

  test("a peak inside the window fires its peak night", () => {
    // Window covers the peak; the night whose dark hours hold the
    // peak anchors the event with the ZHR wording
    const from = new Date(Date.UTC(2027, 3, 21, 12));
    const events = meteorNightEvents({
      from,
      hours: 24,
      nights: [night(Date.UTC(2027, 3, 22, 0), { lengthHours: 16 })],
      lat: 34,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].name, "Lyrids");
    assert.match(events[0].description, /peak tonight/);
  });

  test("a peak just past the window end still owns its climbing night", () => {
    // Window ends Apr 22 00:00; the peak lands 14 h later — inside
    // the end + 46 h bracket, so the in-window night keeps its
    // "climbing toward" watch (work doc #37's documented edge case)
    const from = new Date(Date.UTC(2027, 3, 21, 12));
    const events = meteorNightEvents({
      from,
      hours: 12,
      nights: [night(Date.UTC(2027, 3, 21, 18))],
      lat: 34,
    });
    assert.equal(events.length, 1);
    assert.match(events[0].description, /climbing toward/);
  });

  test("a peak just before the window start still owns its past night", () => {
    // Window starts Apr 23 12:00; the peak was 22 h earlier — inside
    // the from − 32 h bracket, so the following night reports "just
    // past"
    const from = new Date(Date.UTC(2027, 3, 23, 12));
    const events = meteorNightEvents({
      from,
      hours: 24,
      nights: [night(Date.UTC(2027, 3, 23, 18))],
      lat: 34,
    });
    assert.equal(events.length, 1);
    assert.match(events[0].description, /just past/);
  });
});
