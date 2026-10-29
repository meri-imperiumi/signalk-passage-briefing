/**
 * Sail-change event source: the signalk-logbook `logentries` resource.
 *
 * signalk-logbook serves its entries as a Signal K v2 resource of type
 * `logentries` (the contract documented in that repo's
 * `docs/logentries-resource.md`): each entry is `{id, datetime, text,
 * telemetry[], author, origin, category}`, where `telemetry` carries
 * flattened delta pathvalues — `{path, value, $source?}` — in Signal K
 * SI units. Sail changes land in the entry `text` field written by the
 * logbook's automatic triggers, plus manual edits the crew appended
 * afterwards:
 *
 * - `Sails set: Main (1st reef), Genoa 1 (20% furled)` — sail change
 *   while sailing;
 * - `Sailing with Main, Genoa 1` — first entry of a sailing session;
 * - `Motorsailing with Main, Genoa 1`;
 * - `Motor stopped, sailing with Main, Genoa 1` — motor stop snapshot,
 *   *not* a sail action (state update only);
 * - `Sails down, motoring` (also `… motor on`, `… and motor on`) —
 *   sails stowed;
 * - free-text suffixes after the sail list (`. Gusts up to 27kt. …`)
 *   from manual edits are ignored.
 *
 * The reader lists entries through `app.resourcesApi` (in-process, no
 * tokens) and normalizes the resource representation into the shape
 * the event extractor and the wind-stats builder consume: position
 * from the `navigation.position` pathvalue, wind snapshots from
 * `environment.wind.speedOverGround` (m/s → knots), the wind's
 * relative angle from `environment.wind.angleTrue` (radians →
 * degrees, signed, relative to the bow), the compass direction from
 * `environment.wind.directionTrue` (radians → degrees, FROM
 * convention) and the vessel heading from `navigation.headingTrue`
 * (radians → degrees). This module is the *only* place that knows the
 * resource representation.
 *
 * TWA derivation ({@link twaDegFromEntry}): the learned matrix bins
 * by |true wind angle| (angle to the bow, 0..180) — the same quantity
 * the History-API wind stats fold from `environment.wind.angleTrue`.
 * An entry's own angle snapshot is used directly; a direction
 * snapshot only converts with the entry's heading
 * (direction − heading, folded). A direction without a heading is
 * wind-relative-to-north and says nothing about the point of sail —
 * reporting it as TWA would fill the matrix's close-hauled…running
 * bins with compass values, so the angle stays unknown (null) and
 * the observation trains TWS only.
 *
 * @file logbook-source.js
 */

/**
 * The Signal K resource type signalk-logbook registers.
 */
const RESOURCE_TYPE = "logentries";

/**
 * The `logentries` listing contract requires an explicit window or
 * limit (a bare listing answers 400); these bound "all history".
 */
const ALL_HISTORY_FROM = "1970-01-01T00:00:00.000Z";
const ALL_HISTORY_TO = "9999-12-31T23:59:59.999Z";

/** Lookback added before a windowed read: the entries just before the
 * window carry the sail state its first changes classify against, so
 * listing a month no longer parses the whole log (a 1000-day logbook
 * means 1000 file reads and YAML parses per full listing — enough to
 * exhaust the server heap). */
const STATE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/** Normalizes a window bound (Date | ISO string) to the ISO-8601 the
 * logentries listing contract expects, or null when absent. */
function isoWindowBound(value) {
  if (value == null) {
    return null;
  }
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid logbook window bound: ${String(value)}`);
  }
  return new Date(ms).toISOString();
}

/**
 * m/s → knots (1852 m per NM).
 */
const MS_TO_KNOTS = 3600 / 1852;

/**
 * Radians → degrees.
 */
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Entry texts that declare a new sail state as a sail *action* (the
 * crew changed something). The capture group is the sail list, possibly
 * followed by manually appended free text.
 */
const SAIL_CHANGE_RE =
  /^(?:sails set:|sailing with|motorsailing with)\s+(.*)$/i;

/**
 * Entry texts that carry a sail state snapshot without being a sail
 * action (motor stop while sailing).
 */
const SAIL_STATE_RE = /^motor stopped, sailing with\s+(.*)$/i;

/**
 * Entry texts declaring bare poles (sails stowed). Free-text suffixes
 * are ignored.
 */
const SAILS_DOWN_RE =
  /^(?:sails down, motoring|sails down, motor on|sails down and motor on)\b/i;

/**
 * `Motor stopped, sailing` without a sail list: a snapshot with unknown
 * state — it must not clobber the previously known state.
 */
const SAIL_STATE_UNKNOWN_RE = /^motor stopped, sailing\s*$/i;

/**
 * One sail component of a list, e.g. `Genoa 1 (20% furled)`.
 */
const SAIL_COMPONENT_RE = /^([^()]+?)\s*(?:\(([^)]*)\))?$/;

/**
 * Normalizes a sail name to the canonical key form used in sail-state
 * keys (uppercase, `_` separators).
 *
 * @param {string} name - Raw component name
 * @returns {string}
 */
function normalizeSailName(name) {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
}

/**
 * Parses a sail list string ("Main (1st reef), Genoa 1 (20% furled).
 * Poled out wing on wing") into a sail state object.
 *
 * The list is cut at the first period outside parentheses — the crew's
 * manual notes follow as sentences after it — then split on commas and
 * parsed component by component. A component is a sail name with an
 * optional parenthetical carrying `(1st reef)` and/or `(20% furled)`
 * modifiers; unrecognized parentheticals are ignored. Components that
 * do not look like sails (leftover sentence fragments) end the parse.
 *
 * @param {string} text - Sail list (with optional trailing free text)
 * @param {object} [options]
 * @param {Set<string>} [options.knownSailKeys] - When given, only
 *   components whose normalized name is in this set (the vessel's
 *   `@signalk/sailsconfiguration` inventory) are accepted; the first
 *   unknown component ends the parse, filtering out free-text noise
 *   from manually edited entries
 * @returns {Object<string, {reefs: number|null, furledPercent: number|null}>|null}
 *   State object keyed by normalized sail name, or null when no sail
 *   component could be parsed (unknown state)
 */
function parseSailsString(text, { knownSailKeys } = {}) {
  // Cut at the first period outside parentheses (manual notes follow).
  let depth = 0;
  let end = text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
    } else if (ch === "." && depth === 0) {
      end = i;
      break;
    }
  }
  const list = text.slice(0, end);
  if (!list.trim()) {
    return null;
  }

  // Split on commas outside parentheses.
  const parts = [];
  depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
    } else if (ch === "," && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));

  const state = {};
  for (const part of parts) {
    const match = SAIL_COMPONENT_RE.exec(part.trim());
    const name = match ? normalizeSailName(match[1]) : "";
    if (!name || /[^A-Z0-9_]/.test(name)) {
      // Not a sail name (sentence fragment) — stop the parse with what
      // we have so far.
      break;
    }
    if (knownSailKeys && !knownSailKeys.has(name)) {
      // Not part of the vessel's sail inventory — manual free text.
      break;
    }
    let reefs = null;
    let furledPercent = null;
    if (match[2]) {
      const reefMatch = /(\d+)\s*(?:st|nd|rd|th)?\s*reef/i.exec(match[2]);
      if (reefMatch) {
        reefs = Number(reefMatch[1]);
      }
      const furledMatch = /(\d+)\s*%\s*furled/i.exec(match[2]);
      if (furledMatch) {
        furledPercent = Number(furledMatch[1]);
      }
    }
    state[name] = { reefs, furledPercent };
  }
  return Object.keys(state).length > 0 ? state : null;
}

/**
 * Stable canonical key for a sail state, e.g.
 * `GENOA_1_20_FURLED_MAIN_1_REEF` (components sorted by name so the
 * key is order-independent).
 *
 * @param {Object<string, {reefs: number|null, furledPercent: number|null}>|null} state
 * @returns {string} Canonical key; `NO_SAILS` for bare poles
 */
function sailStateKey(state) {
  if (!state || Object.keys(state).length === 0) {
    return "NO_SAILS";
  }
  return Object.keys(state)
    .sort()
    .map((name) => {
      const component = name.replace(/[^A-Z0-9]+/g, "_");
      const { reefs, furledPercent } = state[name];
      const bits = [component];
      if (reefs != null) {
        bits.push(String(reefs), "REEF");
      }
      if (furledPercent != null) {
        bits.push(String(furledPercent), "FURLED");
      }
      return bits.join("_");
    })
    .join("_");
}

/**
 * Total sail reduction of one sail: reef count plus furled fraction.
 * The headsail furler is a reef by another name.
 *
 * @param {{reefs: number|null, furledPercent: number|null}} sail
 * @returns {number}
 */
function reductionOf(sail) {
  return (sail.reefs ?? 0) + (sail.furledPercent ?? 0) / 100;
}

/**
 * Classifies a sail state change against the previous state
 * (SPEC §4.1 event types). Presence changes (a sail set or handed)
 * dominate; otherwise any pure increase in reef/furl reduction is a
 * REEF_INCREASE, a pure decrease a REEF_DECREASE, and anything mixed
 * or numeric-equal a SAIL_CHANGE.
 *
 * @param {object|null} prevState
 * @param {object|null} nextState
 * @returns {"REEF_INCREASE"|"REEF_DECREASE"|"SAIL_CHANGE"}
 */
function classifySailChange(prevState, nextState) {
  if (!prevState || !nextState) {
    return "SAIL_CHANGE";
  }
  const names = new Set([...Object.keys(prevState), ...Object.keys(nextState)]);
  let increased = false;
  let decreased = false;
  for (const name of names) {
    const before = prevState[name];
    const after = nextState[name];
    if (!before || !after) {
      return "SAIL_CHANGE"; // Sail set or handed
    }
    const delta = reductionOf(after) - reductionOf(before);
    if (delta > 0) {
      increased = true;
    } else if (delta < 0) {
      decreased = true;
    }
  }
  if (increased && !decreased) {
    return "REEF_INCREASE";
  }
  if (decreased && !increased) {
    return "REEF_DECREASE";
  }
  return "SAIL_CHANGE";
}

/**
 * A sail-change event extracted from the logbook (SPEC §3.2/§4.1
 * shape, before it reaches the database).
 *
 * @typedef {object} LogbookSailEvent
 * @property {string} timestamp - ISO-8601 instant of the log entry
 * @property {"REEF_INCREASE"|"REEF_DECREASE"|"SAIL_CHANGE"} eventType
 * @property {string} sailState - Canonical state key, e.g.
 *   `MAIN_1_REEF_GENOA_1`
 * @property {string} [notes] - Original log text
 * @property {{latitude: number, longitude: number}} [position] - Log
 *   entry position, used by the backfill to bucket day/night
 * @property {number} [twsKnots] - Wind snapshot in the entry (kn)
 * @property {number} [twaDeg] - True wind angle snapshot (deg, folded
 *   to 0..180)
 */

/**
 * Extracts sail-change events from logbook entries (chronological
 * order is restored here), tracking the continuously-known sail state
 * across entries so changes classify against the last known setup.
 *
 * @param {Array<{datetime: string, text?: string, wind?: {speed?: number, direction?: number}}>|
 *   Array<{datetime: Date, text?: string, wind?: {speed?: number, direction?: number}}>} entries
 * @param {object} [options]
 * @param {Set<string>} [options.knownSailKeys] - Sail inventory name
 *   keys to accept (see {@link parseSailsString})
 * @returns {Array<LogbookSailEvent>}
 */
function extractSailEvents(entries, { knownSailKeys } = {}) {
  const sorted = [...entries]
    .filter((entry) => Boolean(entry?.datetime))
    .sort(
      (a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime(),
    );

  /** @type {object|null} */
  let prevState = null;
  const events = [];
  for (const entry of sorted) {
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    if (!text) {
      continue;
    }
    const timestamp = new Date(entry.datetime).toISOString();

    const down = SAILS_DOWN_RE.exec(text);
    const change = SAIL_CHANGE_RE.exec(text);
    const snapshot = SAIL_STATE_RE.exec(text);
    if (SAIL_STATE_UNKNOWN_RE.test(text)) {
      continue; // Unknown state — keep the previous one
    }

    const parseOptions = { knownSailKeys };
    let nextState = null;
    let isAction = false;
    if (down) {
      nextState = {};
      isAction = true;
    } else if (change) {
      nextState = parseSailsString(change[1], parseOptions);
      isAction = nextState != null;
    } else if (snapshot) {
      nextState = parseSailsString(snapshot[1], parseOptions);
    }

    if (nextState == null) {
      continue;
    }

    const wind =
      entry.wind && typeof entry.wind.speed === "number"
        ? {
            twsKnots: entry.wind.speed,
            twaDeg: twaDegFromEntry(entry),
          }
        : {};

    if (isAction) {
      const nextKey = sailStateKey(nextState);
      if (nextKey !== sailStateKey(prevState)) {
        const position =
          entry.position &&
          typeof entry.position.latitude === "number" &&
          typeof entry.position.longitude === "number"
            ? {
                latitude: entry.position.latitude,
                longitude: entry.position.longitude,
              }
            : undefined;
        events.push({
          timestamp,
          eventType: classifySailChange(prevState, nextState),
          sailState: nextKey,
          notes: text,
          position,
          ...wind,
        });
      }
    }
    prevState = nextState;
  }
  return events;
}

/**
 * Folds a true wind direction (degrees, 0..360, or signed) onto the
 * 0..180 TWA magnitude range used by the learned matrix bins.
 *
 * @param {number|null} degrees - True wind direction (degrees)
 * @returns {number|null} |TWA| in 0..180 degrees
 */
function foldTwaDegrees(degrees) {
  if (degrees == null || !Number.isFinite(degrees)) {
    return null;
  }
  const normalized = ((degrees % 360) + 360) % 360;
  return normalized > 180 ? 360 - normalized : normalized;
}

/**
 * |TWA| of a normalized logbook entry, folded to the 0..180 range the
 * learned matrix bins use. The entry's own wind-angle snapshot wins
 * (`environment.wind.angleTrue`, relative to the bow — the same
 * quantity the History-API source of record folds); a compass
 * direction converts only with the entry's heading
 * (direction − heading). A direction without a heading is not a wind
 * angle — the answer is null (unknown), never a compass value
 * masquerading as a point of sail.
 *
 * @param {{wind?: {angle?: number, direction?: number}, heading?: number}} entry
 *   Normalized entry (see {@link normalizeLogEntry})
 * @returns {number|null} |TWA| in 0..180 degrees, null when unknown
 */
function twaDegFromEntry(entry) {
  const wind = entry?.wind;
  if (wind && Number.isFinite(wind.angle)) {
    return foldTwaDegrees(wind.angle);
  }
  if (
    wind &&
    Number.isFinite(wind.direction) &&
    Number.isFinite(entry?.heading)
  ) {
    return foldTwaDegrees(wind.direction - entry.heading);
  }
  return null;
}

/**
 * Normalizes a `logentries` resource entry into the shape the event
 * extractor and wind-stats builder consume: `datetime` and `text`
 * pass through; `position` comes from the `navigation.position`
 * pathvalue; the wind snapshot comes from
 * `environment.wind.speedOverGround` (m/s → kn), the wind's compass
 * direction from `environment.wind.directionTrue` (rad → deg, FROM
 * convention), the wind's angle to the bow from
 * `environment.wind.angleTrue` (rad → deg, signed) and the vessel
 * heading from `navigation.headingTrue` (rad → deg). The same path
 * may appear more than once (multiple `$source`s per the Multiple
 * Values logic) — the first usable value wins. Unknown paths and
 * logbook fields are ignored: this consumer needs the snapshot only.
 *
 * @param {object} entry - Resource entry (`{id, datetime, text, telemetry[], …}`)
 * @returns {{datetime?: string, text?: string, position?: {latitude: number, longitude: number}, wind?: {speed?: number, direction?: number, angle?: number}, heading?: number}|null}
 *   Normalized entry, or null for non-objects
 */
function normalizeLogEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  /** @type {ReturnType<typeof normalizeLogEntry>} */
  const out = {};
  if (typeof entry.datetime === "string") {
    out.datetime = entry.datetime;
  }
  if (typeof entry.text === "string") {
    out.text = entry.text;
  }
  const telemetry = Array.isArray(entry.telemetry) ? entry.telemetry : [];
  for (const pathvalue of telemetry) {
    if (
      !pathvalue ||
      typeof pathvalue.path !== "string" ||
      pathvalue.value == null
    ) {
      continue;
    }
    const { path, value } = pathvalue;
    if (path === "navigation.position") {
      if (
        !out.position &&
        typeof value.latitude === "number" &&
        typeof value.longitude === "number"
      ) {
        out.position = { latitude: value.latitude, longitude: value.longitude };
      }
    } else if (path === "environment.wind.speedOverGround") {
      if (
        out.wind?.speed === undefined &&
        typeof value === "number" &&
        Number.isFinite(value)
      ) {
        out.wind = { ...out.wind, speed: value * MS_TO_KNOTS };
      }
    } else if (path === "environment.wind.directionTrue") {
      if (
        out.wind?.direction === undefined &&
        typeof value === "number" &&
        Number.isFinite(value)
      ) {
        out.wind = { ...out.wind, direction: value * RAD_TO_DEG };
      }
    } else if (path === "environment.wind.angleTrue") {
      if (
        out.wind?.angle === undefined &&
        typeof value === "number" &&
        Number.isFinite(value)
      ) {
        out.wind = { ...out.wind, angle: value * RAD_TO_DEG };
      }
    } else if (path === "navigation.headingTrue") {
      if (
        out.heading === undefined &&
        typeof value === "number" &&
        Number.isFinite(value)
      ) {
        out.heading = value * RAD_TO_DEG;
      }
    }
  }
  return out;
}

/**
 * Lists every logbook entry through the server's resources API, in
 * chronological order. The `logentries` listing contract requires an
 * explicit window, so "all history" is an explicit epoch-to-eternity
 * range.
 *
 * Loud on an unusable source: a missing resources API (old server)
 * or a failed listing (the logbook plugin not installed — no provider
 * for the type) throws with the reason, so the human-initiated runs
 * that read the logbook (backfill, event diagnostics) can say why
 * they found nothing instead of silently reporting zero events.
 *
 * The read honors an optional window: the provider then only loads
 * the entries in it. Without a window the read stays the explicit
 * epoch-to-eternity range — callers that need the whole log ask for
 * it, and everything else should pass one.
 *
 * @param {object} app - Signal K plugin `app`
 * @param {object} [options]
 * @param {Date|string} [options.from] - Window start (inclusive)
 * @param {Date|string} [options.to] - Window end (inclusive)
 * @returns {Promise<Array<object>>} Normalized entries, oldest first
 * @throws {Error} When the resources API or the `logentries` provider
 *   is unavailable
 */
async function readLogbookEntries(app, { from, to } = {}) {
  if (typeof app?.resourcesApi?.listResources !== "function") {
    throw new Error("Resources API not available on this server");
  }
  let resourceMap;
  try {
    resourceMap = await app.resourcesApi.listResources(RESOURCE_TYPE, {
      from: isoWindowBound(from) ?? ALL_HISTORY_FROM,
      to: isoWindowBound(to) ?? ALL_HISTORY_TO,
    });
  } catch (error) {
    throw new Error(
      `No logentries resource provider on this server — install signalk-logbook to backfill from the log (${error.message})`,
    );
  }
  if (!resourceMap || typeof resourceMap !== "object") {
    return [];
  }
  return Object.values(resourceMap)
    .map(normalizeLogEntry)
    .filter(Boolean)
    .sort(
      (a, b) =>
        new Date(a.datetime ?? 0).getTime() -
        new Date(b.datetime ?? 0).getTime(),
    );
}

/**
 * Lists every logbook entry over the REST surface of the resources
 * API — the transport for tools run outside the server process
 * (ashore, against a reachable Signal K server). Unlike the
 * in-process reader this one is loud: failures throw, since a CLI
 * run by a human should report why it found nothing.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl] - Server base URL
 *   (default `http://localhost:3000`)
 * @param {string} [options.token] - Bearer token (readonly suffices
 *   for reads)
 * @param {Date|string} [options.from] - Window start (inclusive)
 * @param {Date|string} [options.to] - Window end (inclusive)
 * @returns {Promise<Array<object>>} Normalized entries, oldest first
 */
async function readLogbookEntriesRest({ baseUrl, token, from, to } = {}) {
  const base = (baseUrl ?? "http://localhost:3000").replace(/\/+$/, "");
  const query = new URLSearchParams({
    from: isoWindowBound(from) ?? ALL_HISTORY_FROM,
    to: isoWindowBound(to) ?? ALL_HISTORY_TO,
  });
  const url = `${base}/signalk/v2/api/resources/${RESOURCE_TYPE}?${query}`;
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    throw new Error(
      `logentries listing returned ${response.status}: ${response.statusText}`,
    );
  }
  const resourceMap = await response.json();
  if (!resourceMap || typeof resourceMap !== "object") {
    return [];
  }
  return Object.values(resourceMap)
    .map(normalizeLogEntry)
    .filter(Boolean)
    .sort(
      (a, b) =>
        new Date(a.datetime ?? 0).getTime() -
        new Date(b.datetime ?? 0).getTime(),
    );
}

/**
 * Reads the logbook through the resources API and extracts
 * sail-change events, optionally bounded to a window. A window bounds
 * the provider read too — padded with a fixed state lookback so the
 * first in-window changes still classify against recent prior state
 * (a change whose previous rig predates the lookback degrades to a
 * generic `SAIL_CHANGE`; the entry's own rig snapshot stays exact).
 * Pre-read `entries` skip the provider entirely and keep the
 * unbounded state tracking of a full listing.
 *
 * @param {object} [options]
 * @param {object} [options.app] - Signal K plugin `app`; omitted when
 *   `entries` is given
 * @param {Date|string} [options.from] - Window start (inclusive)
 * @param {Date|string} [options.to] - Window end (inclusive)
 * @param {Array<object>} [options.entries] - Pre-read entries (tests,
 *   tools that already listed); overrides `app`
 * @param {Set<string>} [options.knownSailKeys] - Sail inventory name
 *   keys to accept (see {@link parseSailsString})
 * @returns {Promise<Array<LogbookSailEvent>>}
 */
async function readLogbookSailEvents({
  app,
  from,
  to,
  entries,
  knownSailKeys,
} = {}) {
  // The read reaches back past the window so state tracking
  // classifies the first in-window change; extraction sees those
  // lookback entries too, and the range filter below drops their
  // events again
  const readFrom =
    from != null && entries == null
      ? new Date(new Date(from).getTime() - STATE_LOOKBACK_MS)
      : undefined;
  const all =
    entries || (await readLogbookEntries(app, { from: readFrom, to }));
  const events = extractSailEvents(all, { knownSailKeys });
  if (from == null && to == null) {
    return events;
  }
  const fromMs = from != null ? new Date(from).getTime() : -Infinity;
  const toMs = to != null ? new Date(to).getTime() : Infinity;
  return events.filter((event) => {
    const t = new Date(event.timestamp).getTime();
    return t >= fromMs && t <= toMs;
  });
}

module.exports = {
  RESOURCE_TYPE,
  normalizeSailName,
  parseSailsString,
  sailStateKey,
  classifySailChange,
  extractSailEvents,
  normalizeLogEntry,
  readLogbookEntries,
  readLogbookEntriesRest,
  readLogbookSailEvents,
  foldTwaDegrees,
  twaDegFromEntry,
};
