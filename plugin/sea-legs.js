/**
 * Sea legs: restart-safe passage day counter (work doc #40).
 *
 * Serves the "Day N at sea" context the briefing timeline and
 * headline can surface: when the current passage started, derived
 * entirely from persisted signals so a server restart cannot lose
 * it. Deliberately no threshold math — the backtest showed no
 * support for exposure-based comfort easing (see work doc #40's
 * quantification update); this is crew-facing context only.
 *
 * Design note: Signal K is gaining a "trips resource" spec from
 * other developers. The history scan below is an explicit stopgap
 * behind a swappable seam — when the trips resource lands, its
 * reader replaces `passageStartFromHistory` without touching the
 * callers.
 *
 * @file sea-legs.js
 */

const STOPPED_STATES = new Set([
  "anchored",
  "moored",
  "not under command",
  "aground",
]);

/** Lookback cap in days — beyond this the scan gives up honestly. */
const MAX_LOOKBACK_DAYS = 30;

/**
 * Coarse history resolution (s) for the state scan: navigation.state
 * transitions are not brief, and 15-min samples keep a week window
 * well under the History API's response row cap.
 */
const STATE_RESOLUTION_SECONDS = 900;

/**
 * Passage start from state rows: the first under-way sample after
 * the most recent stopped sample. Scanning backward from now keeps
 * the definition restart-safe — nothing accumulates in memory.
 *
 * @param {Array<{tMs: number, state: string|null}>} rows - State
 *   samples ascending by time
 * @param {number} nowMs - Current instant
 * @returns {{startedMs: number|null, underwayNow: boolean}|null}
 *   `startedMs` null when the boat is stopped now (no active
 *   passage) or when no stopped→underway transition exists inside
 *   the scanned window (passage predates it)
 */
function passageStartFromRows(rows, nowMs) {
  const sorted = [...rows].sort((a, b) => a.tMs - b.tMs);
  // The current state: last known sample at or before now
  let current = null;
  for (const row of sorted) {
    if (row.tMs > nowMs) {
      break;
    }
    if (row.state != null) {
      current = row.state;
    }
  }
  if (current == null) {
    return null;
  }
  const underwayNow = !STOPPED_STATES.has(current);
  if (!underwayNow) {
    return { startedMs: null, underwayNow };
  }
  // Most recent stopped sample strictly before now
  let lastStopped = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (
      sorted[i].tMs <= nowMs &&
      sorted[i].state != null &&
      STOPPED_STATES.has(sorted[i].state)
    ) {
      lastStopped = i;
      break;
    }
  }
  if (lastStopped < 0) {
    // Underway the whole window: the passage predates the scan
    return { startedMs: null, underwayNow };
  }
  for (let i = lastStopped + 1; i < sorted.length; i++) {
    const row = sorted[i];
    if (row.tMs > nowMs) {
      break;
    }
    if (row.state != null && !STOPPED_STATES.has(row.state)) {
      return { startedMs: row.tMs, underwayNow };
    }
  }
  // Stopped sample is the newest known state but current says
  // underway — inconsistent window, treat as unknown
  return { startedMs: null, underwayNow };
}

/**
 * Queries one window of navigation.state from the History API.
 *
 * @param {object} params
 * @param {string} params.baseUrl - Signal K server base URL
 * @param {string} [params.token] - Bearer token
 * @param {Date} params.from - Window start
 * @param {Date} params.to - Window end
 * @param {number} [params.resolution] - Sample resolution (s)
 * @param {typeof fetch} [params.fetchImpl] - Fetch implementation
 * @returns {Promise<Array<{tMs: number, state: string|null}>>}
 */
async function queryStateWindow({
  baseUrl,
  token,
  from,
  to,
  resolution = STATE_RESOLUTION_SECONDS,
  fetchImpl = fetch,
}) {
  const url = new URL("/signalk/v2/api/history/values", baseUrl);
  url.searchParams.set("paths", "navigation.state");
  url.searchParams.set("from", from.toISOString());
  url.searchParams.set("to", to.toISOString());
  url.searchParams.set("resolution", String(resolution));
  const response = await fetchImpl(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    throw new Error(`History API ${response.status}: ${response.statusText}`);
  }
  const payload = await response.json();
  const rows = payload?.data ?? [];
  return rows.map((row) => {
    const value = row[1];
    return {
      tMs: Date.parse(row[0]),
      state: typeof value === "string" ? value.toLowerCase() : null,
    };
  });
}

/**
 * Scans backward from now for the last stopped→underway transition,
 * in week-sized windows up to the lookback cap.
 *
 * @param {object} params
 * @param {string} params.baseUrl - Signal K server base URL
 * @param {string} [params.token] - Bearer token
 * @param {Date} [params.now] - Evaluation instant
 * @param {typeof fetch} [params.fetchImpl] - Fetch implementation
 * @returns {Promise<{startedMs: number|null, underwayNow: boolean}>}
 */
async function passageStartFromHistory({
  baseUrl,
  token,
  now = new Date(),
  fetchImpl = fetch,
}) {
  const rows = [];
  const weekMs = 7 * 24 * 3600000;
  for (let end = now.getTime(); ; end -= weekMs) {
    const start = new Date(end - weekMs);
    const window = await queryStateWindow({
      baseUrl,
      token,
      from: start,
      to: new Date(end),
      fetchImpl,
    });
    rows.push(...window);
    const found = passageStartFromRows(rows, now.getTime());
    if (found?.startedMs != null) {
      return found;
    }
    // The window's own start reached: past the cap, report honestly
    if (start.getTime() <= now.getTime() - MAX_LOOKBACK_DAYS * 24 * 3600000) {
      return found ?? { startedMs: null, underwayNow: false };
    }
  }
}

/**
 * Day N at sea for an instant: the passage-start time-of-day is the
 * day boundary, so "day 2" begins 24 h after departure — the crew's
 * own counting.
 *
 * @param {number} startedMs - Passage start epoch ms
 * @param {number} atMs - Instant to count
 * @returns {number} 1-based day number
 */
function dayAtSea(startedMs, atMs) {
  return Math.floor((atMs - startedMs) / (24 * 3600000)) + 1;
}

/**
 * The sea-legs briefing context: passage start and day count, or
 * nulls when the boat is not under way or the scan found nothing.
 *
 * @param {object} params
 * @param {string} params.baseUrl - Signal K server base URL
 * @param {string} [params.token] - Bearer token
 * @param {Date} [params.now] - Evaluation instant
 * @param {typeof fetch} [params.fetchImpl] - Fetch implementation
 * @returns {Promise<{passageStartedAt: string|null, dayAtSea: number|null, underwayNow: boolean}>}
 */
async function seaLegs({
  baseUrl,
  token,
  now = new Date(),
  fetchImpl = fetch,
}) {
  const found = await passageStartFromHistory({
    baseUrl,
    token,
    now,
    fetchImpl,
  });
  const dayAtSeaValue =
    found.startedMs != null ? dayAtSea(found.startedMs, now.getTime()) : null;
  return {
    passageStartedAt:
      found.startedMs != null ? new Date(found.startedMs).toISOString() : null,
    dayAtSea: dayAtSeaValue,
    underwayNow: found.underwayNow,
  };
}

module.exports = {
  MAX_LOOKBACK_DAYS,
  STATE_RESOLUTION_SECONDS,
  STOPPED_STATES,
  dayAtSea,
  passageStartFromHistory,
  passageStartFromRows,
  queryStateWindow,
  seaLegs,
};
