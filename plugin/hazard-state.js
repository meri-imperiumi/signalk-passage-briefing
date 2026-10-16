/**
 * On-disk acknowledgement state for critical hazard notifications
 * (work doc #30 anti-flap): the ack must survive plugin and server
 * restarts, or every restart re-alarms the crew for a cyclone they
 * already acknowledged. Acks are keyed by notification id and record
 * the alert level they silenced, so a later escalation to a strictly
 * higher level (orange → red) re-alarms while same-level refreshes
 * stay quiet.
 *
 * Entries age out after a week: a cyclone acknowledged today should
 * still be silent next restart, but ack memory must not grow
 * unbounded, and a week-old hazard id is stale by any measure.
 *
 * @file hazard-state.js
 */

const { readFileSync, renameSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const ACK_FILE = "hazards-state.json";
const ACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Loads the acknowledgement map, pruning stale entries.
 *
 * @param {string} dataDir - Plugin data directory
 * @returns {Map<string, {level: string|null, at: string}>} Ack by
 *   notification id; empty when no state exists yet or the file is
 *   corrupt (a crashed read must not take the escalation down —
 *   re-alarms are annoying, a dead plugin is worse)
 */
function loadHazardAcks(dataDir) {
  const acks = new Map();
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, ACK_FILE), "utf8"));
    const now = Date.now();
    for (const [id, record] of Object.entries(raw?.acked ?? {})) {
      const at = new Date(record?.at).getTime();
      if (Number.isFinite(at) && now - at < ACK_TTL_MS) {
        acks.set(id, record);
      }
    }
  } catch {
    // No state yet (first boot) or unreadable file: start empty
  }
  return acks;
}

/**
 * Saves the acknowledgement map, pruning stale entries and writing
 * atomically (tmp file + rename, so a crash mid-write cannot leave a
 * half-read JSON behind).
 *
 * @param {string} dataDir - Plugin data directory
 * @param {Map<string, {level: string|null, at: string}>} acks
 * @returns {void}
 */
function saveHazardAcks(dataDir, acks) {
  const acked = {};
  const now = Date.now();
  for (const [id, record] of acks ?? []) {
    const at = new Date(record?.at).getTime();
    if (Number.isFinite(at) && now - at < ACK_TTL_MS) {
      acked[id] = record;
    }
  }
  const path = join(dataDir, ACK_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ acked }, null, 2)}\n`);
  renameSync(tmp, path);
}

module.exports = { loadHazardAcks, saveHazardAcks, ACK_FILE, ACK_TTL_MS };
