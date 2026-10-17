/**
 * On-disk hazard acknowledgement state (work doc #30 anti-flap): acks
 * survive plugin and server restarts, stale entries prune, and a
 * corrupt file degrades to an empty map instead of taking the
 * escalation down.
 *
 * @file hazard-state.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  loadHazardState,
  saveHazardState,
  ACK_FILE,
} = require("../plugin/hazard-state.js");

test("state round-trips through the state file", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hazard-state-"));
  const acks = new Map([
    [
      "gdacs-TC1001339",
      { level: "orange", distanceNm: 708.3, at: new Date().toISOString() },
    ],
  ]);
  const published = new Map([
    [
      "gdacs-TC1001339",
      {
        state: "emergency",
        message: "Tropical cyclone: ONE-26 — 708.3 nm",
        level: "orange",
        at: new Date().toISOString(),
      },
    ],
  ]);
  saveHazardState(dataDir, acks, published);
  const loaded = loadHazardState(dataDir);
  assert.deepEqual(
    loaded.acks.get("gdacs-TC1001339"),
    acks.get("gdacs-TC1001339"),
  );
  assert.equal(loaded.published.get("gdacs-TC1001339").state, "emergency");
  assert.equal(
    loaded.published.get("gdacs-TC1001339").restored,
    true,
    "published entries load flagged for visual restore",
  );

  // The file is readable JSON with both maps
  const raw = JSON.parse(readFileSync(join(dataDir, ACK_FILE), "utf8"));
  assert.ok(raw.acked["gdacs-TC1001339"]);
  assert.ok(raw.published["gdacs-TC1001339"]);
});

test("stale acks prune on load and save", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hazard-state-"));
  const fresh = new Date().toISOString();
  const stale = new Date(Date.now() - 8 * 24 * 3600000).toISOString();
  saveHazardState(
    dataDir,
    new Map([
      ["gdacs-fresh", { level: "orange", distanceNm: 100, at: fresh }],
      ["gdacs-stale", { level: "red", distanceNm: 50, at: stale }],
    ]),
    new Map([
      [
        "gdacs-fresh",
        { state: "emergency", message: "x", level: "orange", at: fresh },
      ],
      [
        "gdacs-stale",
        { state: "emergency", message: "x", level: "red", at: stale },
      ],
    ]),
  );
  const loaded = loadHazardState(dataDir);
  assert.ok(loaded.acks.has("gdacs-fresh"));
  assert.ok(!loaded.acks.has("gdacs-stale"), "week-old ack pruned");
  assert.ok(loaded.published.has("gdacs-fresh"));
  assert.ok(!loaded.published.has("gdacs-stale"), "week-old published pruned");
});

test("a corrupt state file degrades to an empty map", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hazard-state-"));
  writeFileSync(join(dataDir, ACK_FILE), "{not json");
  const loaded = loadHazardState(dataDir);
  assert.equal(loaded.acks.size, 0, "empty, not a crash");
  assert.equal(loaded.published.size, 0, "empty, not a crash");
});
