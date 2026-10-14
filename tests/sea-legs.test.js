/**
 * Tests for the sea-legs passage counter (work doc #40): restart-safe
 * passage start from History API state rows and the day-at-sea count.
 * All offline — the fetch implementation is a stub.
 *
 * @file sea-legs.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  dayAtSea,
  passageStartFromRows,
  seaLegs,
} = require("../plugin/sea-legs.js");

const H = 3600000;
const DAY = 24 * H;

/** Builds a state-row fetch stub from a time→state table. */
function fetchFromStates(states) {
  return async (url) => {
    const from = Date.parse(new URL(url).searchParams.get("from"));
    const to = Date.parse(new URL(url).searchParams.get("to"));
    const rows = [];
    for (const [iso, state] of states) {
      const t = Date.parse(iso);
      if (t >= from && t <= to) {
        rows.push([iso, state]);
      }
    }
    return {
      ok: true,
      json: async () => ({ data: rows }),
    };
  };
}

test("passage start is the first underway sample after the last stop", () => {
  const now = Date.parse("2026-03-12T12:00:00Z");
  const rows = [
    { tMs: now - 5 * DAY, state: "anchored" },
    { tMs: now - 4 * DAY, state: "sailing" },
    { tMs: now - 3 * DAY, state: "sailing" },
    { tMs: now - DAY, state: "anchored" },
    { tMs: now - H, state: "sailing" },
    { tMs: now, state: "sailing" },
  ];
  const found = passageStartFromRows(rows, now);
  assert.equal(found.underwayNow, true);
  assert.equal(found.startedMs, now - H);
});

test("stopped now means no active passage", () => {
  const now = Date.parse("2026-03-12T12:00:00Z");
  const rows = [
    { tMs: now - 3 * DAY, state: "sailing" },
    { tMs: now - DAY, state: "moored" },
    { tMs: now, state: "moored" },
  ];
  const found = passageStartFromRows(rows, now);
  assert.deepEqual(found, { startedMs: null, underwayNow: false });
});

test("underway through the whole window means the passage predates it", () => {
  const now = Date.parse("2026-03-12T12:00:00Z");
  const rows = [
    { tMs: now - 5 * DAY, state: "sailing" },
    { tMs: now, state: "sailing" },
  ];
  const found = passageStartFromRows(rows, now);
  assert.deepEqual(found, { startedMs: null, underwayNow: true });
});

test("sparse null states do not break the backward scan", () => {
  const now = Date.parse("2026-03-12T12:00:00Z");
  const rows = [
    { tMs: now - 2 * DAY, state: "anchored" },
    { tMs: now - DAY, state: null },
    { tMs: now - H, state: "sailing" },
    { tMs: now, state: null },
  ];
  const found = passageStartFromRows(rows, now);
  // Current state carries back to the last known: sailing, and the
  // departure is the sailing sample after the anchored one
  assert.equal(found.underwayNow, true);
  assert.equal(found.startedMs, now - H);
});

test("day at sea counts from the departure time of day", () => {
  const start = Date.parse("2026-03-10T15:00:00Z");
  assert.equal(dayAtSea(start, start), 1);
  assert.equal(dayAtSea(start, start + 23 * H), 1);
  assert.equal(dayAtSea(start, start + 24 * H), 2);
  assert.equal(dayAtSea(start, start + 10 * DAY), 11);
});

test("seaLegs orchestrates the backward scan across windows", async () => {
  const now = new Date("2026-03-12T12:00:00Z");
  const fetchImpl = fetchFromStates([
    ["2026-03-05T00:00:00Z", "sailing"],
    ["2026-03-08T00:00:00Z", "anchored"],
    ["2026-03-08T06:00:00Z", "sailing"],
  ]);
  const result = await seaLegs({
    baseUrl: "http://test",
    now,
    fetchImpl,
  });
  assert.equal(result.underwayNow, true);
  assert.equal(result.passageStartedAt, "2026-03-08T06:00:00.000Z");
  // ~4.25 days after departure
  assert.equal(result.dayAtSea, 5);
});

test("seaLegs reports an anchored boat with nulls", async () => {
  const now = new Date("2026-03-12T12:00:00Z");
  const fetchImpl = fetchFromStates([["2026-03-10T00:00:00Z", "anchored"]]);
  const result = await seaLegs({
    baseUrl: "http://test",
    now,
    fetchImpl,
  });
  assert.deepEqual(result, {
    passageStartedAt: null,
    dayAtSea: null,
    underwayNow: false,
  });
});
