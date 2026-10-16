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
  loadHazardAcks,
  saveHazardAcks,
  ACK_FILE,
} = require("../plugin/hazard-state.js");

test("acks round-trip through the state file", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hazard-state-"));
  const acks = new Map([
    [
      "gdacs-TC1001339",
      { level: "orange", distanceNm: 708.3, at: new Date().toISOString() },
    ],
  ]);
  saveHazardAcks(dataDir, acks);
  const loaded = loadHazardAcks(dataDir);
  assert.deepEqual(loaded.get("gdacs-TC1001339"), acks.get("gdacs-TC1001339"));

  // The file is readable JSON with the acks under `acked`
  const raw = JSON.parse(readFileSync(join(dataDir, ACK_FILE), "utf8"));
  assert.ok(raw.acked["gdacs-TC1001339"]);
});

test("stale acks prune on load and save", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hazard-state-"));
  const fresh = new Date().toISOString();
  const stale = new Date(Date.now() - 8 * 24 * 3600000).toISOString();
  saveHazardAcks(
    dataDir,
    new Map([
      ["gdacs-fresh", { level: "orange", distanceNm: 100, at: fresh }],
      ["gdacs-stale", { level: "red", distanceNm: 50, at: stale }],
    ]),
  );
  const loaded = loadHazardAcks(dataDir);
  assert.ok(loaded.has("gdacs-fresh"));
  assert.ok(!loaded.has("gdacs-stale"), "week-old ack pruned");
});

test("a corrupt state file degrades to an empty map", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hazard-state-"));
  writeFileSync(join(dataDir, ACK_FILE), "{not json");
  const loaded = loadHazardAcks(dataDir);
  assert.equal(loaded.size, 0, "empty, not a crash");
});
