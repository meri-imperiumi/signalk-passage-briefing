/**
 * On-disk state for critical hazard notifications (work doc #30
 * anti-flap): both the crew's acknowledgements AND the published
 * notification values must survive plugin and server restarts. The
 * ack silences re-raises across restarts; the published map makes a
 * restart of an ALARMING notification restore it visually (no
 * sound) instead of re-raising it — every restart re-alarming the
 * crew for a cyclone already sounding is exactly the alarm fatigue
 * the escalation exists to avoid.
 *
 * Acks are keyed by notification id and record the alert level and
 * distance they silenced, so a later escalation to a strictly higher
 * level (orange → red) or a storm closed to half the acked distance
 * re-alarms while same-level refreshes stay quiet.
 *
 * Entries age out after a week: a cyclone acknowledged today should
 * still be silent next restart, but state must not grow unbounded,
 * and a week-old hazard id is stale by any measure.
 *
 * @file hazard-state.js
 */

const { readFileSync, renameSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const ACK_FILE = "hazards-state.json";
const ACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Loads the persisted notification state, pruning stale entries.
 *
 * @param {string} dataDir - Plugin data directory
 * @returns {{acks: Map<string, {level: string|null, distanceNm:
 *   number|null, at: string}>, published: Map<string, {state: string,
 *   message: string, level: string|null, at: string, restored:
 *   boolean}>}} Empty maps when no state exists yet or the file is
 *   corrupt (a crashed read must not take the escalation down —
 *   re-alarms are annoying, a dead plugin is worse)
 */
function loadHazardState(dataDir) {
  const state = { acks: new Map(), published: new Map() };
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, ACK_FILE), "utf8"));
    const now = Date.now();
    for (const [id, record] of Object.entries(raw?.acked ?? {})) {
      const at = new Date(record?.at).getTime();
      if (Number.isFinite(at) && now - at < ACK_TTL_MS) {
        state.acks.set(id, record);
      }
    }
    for (const [id, record] of Object.entries(raw?.published ?? {})) {
      const at = new Date(record?.at).getTime();
      if (Number.isFinite(at) && now - at < ACK_TTL_MS) {
        // `restored` marks the entry as read-from-disk: the first
        // cycle republishes it VISUALLY (restoring the notification
        // path the server lost at restart) without the sounder
        state.published.set(id, { ...record, restored: true });
      }
    }
  } catch {
    // No state yet (first boot) or unreadable file: start empty
  }
  return state;
}

/**
 * Saves the notification state, pruning stale entries and writing
 * atomically (tmp file + rename, so a crash mid-write cannot leave a
 * half-read JSON behind).
 *
 * @param {string} dataDir - Plugin data directory
 * @param {Map<string, {level: string|null, distanceNm: number|null,
 *   at: string}>} acks
 * @param {Map<string, {state: string, message: string, level:
 *   string|null, at: string, restored?: boolean}>} published
 * @returns {void}
 */
function saveHazardState(dataDir, acks, published) {
  const acked = {};
  const out = {};
  const now = Date.now();
  for (const [id, record] of acks ?? []) {
    const at = new Date(record?.at).getTime();
    if (Number.isFinite(at) && now - at < ACK_TTL_MS) {
      acked[id] = record;
    }
  }
  for (const [id, record] of published ?? []) {
    const at = new Date(record?.at).getTime();
    if (Number.isFinite(at) && now - at < ACK_TTL_MS) {
      out[id] = { ...record, restored: undefined };
    }
  }
  const path = join(dataDir, ACK_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ acked, published: out }, null, 2)}\n`);
  renameSync(tmp, path);
}

module.exports = {
  loadHazardState,
  saveHazardState,
  ACK_FILE,
  ACK_TTL_MS,
};
