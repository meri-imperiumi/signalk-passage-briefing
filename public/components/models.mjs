/**
 * Pure view models for the passage briefing webapp: everything the
 * custom elements render, computed from the worker's exception views
 * (SPEC §6.2). Kept free of DOM so Node can test them; the elements
 * stay thin.
 *
 * @module models
 */

import { isNight, serenoComfort, travelDirection } from "../sereno-physics.mjs";

const DEG = Math.PI / 180;

/**
 * Comfort tier order (SPEC §5.2) with the CSS custom property that
 * carries the tier color (see css/visuals.css).
 */
export const COMFORT_TIERS = [
  { level: "champagne", css: "var(--comfort-champagne)" },
  { level: "easy", css: "var(--comfort-easy)" },
  { level: "coffee", css: "var(--comfort-coffee)" },
  { level: "rough", css: "var(--comfort-rough)" },
  { level: "sick", css: "var(--comfort-sick)" },
];

const TIER_BY_LEVEL = new Map(COMFORT_TIERS.map((t) => [t.level, t.css]));

/**
 * Comfort tier color for a level name.
 *
 * @param {string|null} level
 * @returns {string} CSS color value
 */
export function comfortColor(level) {
  return TIER_BY_LEVEL.get(level) ?? "var(--comfort-unknown)";
}

/**
 * Formats an ISO timestamp as `MM-DD HH:MMZ` (UTC, explicitly
 * suffixed; dates YYYY-MM-DD practicable).
 *
 * @param {string|null|undefined} iso
 * @returns {string} Empty string when unset/invalid
 */
export function fmtUtc(iso) {
  const d = iso != null ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) {
    return "";
  }
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

/**
 * Age of a briefing payload in hours, from its fetch timestamp
 * (`metadata.fetchedAt`) to a reference time. Null when the payload
 * carries no fetch time.
 *
 * @param {object|null} payload
 * @param {Date} [now]
 * @returns {number|null}
 */
export function briefingAgeHours(payload, now = new Date()) {
  const fetched = payload?.metadata?.fetchedAt;
  if (!fetched) {
    return null;
  }
  const ms = new Date(fetched).getTime();
  if (Number.isNaN(ms)) {
    return null;
  }
  return Math.max(0, (now.getTime() - ms) / 3600000);
}

/**
 * The vessel's published timezone (Signal K `environment.time.*`, as
 * served by signalk-ships-time): the session-wide state behind
 * {@link fmtShip}. `offsetMinutes` comes from
 * `environment.time.timezoneOffset` (`(-)hhmm` encoding, parsed with
 * {@link parseTimezoneOffset}); `region` is
 * `environment.time.timezoneRegion` when known. The offset is the
 * crew's *current* zone: stamps far into the passage render in it
 * too, with the offset on every stamp making that explicit.
 *
 * @type {{offsetMinutes: number, region: string|null}|null}
 */
let shipTime = null;

/**
 * Parses a Signal K `environment.time.timezoneOffset` value
 * (`(-)hhmm` encoding, e.g. `200` = UTC+2, `-930` = UTC-9:30) into
 * minutes. Accepts numbers and numeric strings; null when absent or
 * malformed (minutes ≥ 60, |hhmm| ≥ 2400, non-finite).
 *
 * @param {number|string|null|undefined} value
 * @returns {number|null} Offset in minutes
 */
export function parseTimezoneOffset(value) {
  const raw = typeof value === "string" ? Number(value) : value;
  if (raw == null || !Number.isFinite(raw)) {
    return null;
  }
  const abs = Math.abs(Math.round(raw));
  const minutes = Math.trunc(abs / 100) * 60 + (abs % 100);
  if (abs % 100 >= 60 || abs >= 2400) {
    return null;
  }
  return Math.sign(raw) * minutes;
}

/**
 * Sets the vessel's timezone for stamp rendering (see
 * {@link shipTime}). Null clears it — stamps fall back to UTC.
 *
 * @param {{offsetMinutes: number, region?: string|null}|null} time
 */
export function setShipTime(time) {
  shipTime =
    time && Number.isFinite(time.offsetMinutes)
      ? { offsetMinutes: time.offsetMinutes, region: time.region ?? null }
      : null;
}

/**
 * Zone label for the header pill: the IANA region when known, else
 * the offset (`UTC+03:30`). Empty without ship's time.
 *
 * @returns {string}
 */
export function shipTimeLabel() {
  if (!shipTime) {
    return "";
  }
  if (shipTime.region) {
    return shipTime.region;
  }
  return `UTC${offsetLabel(shipTime.offsetMinutes)}`;
}

/**
 * Compact offset label: `+03` for whole hours, `-09:30` otherwise.
 *
 * @param {number} minutes
 * @returns {string}
 */
function offsetLabel(minutes) {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const h = String(Math.trunc(abs / 60)).padStart(2, "0");
  const m = abs % 60;
  return m > 0 ? `${sign}${h}:${String(m).padStart(2, "0")}` : `${sign}${h}`;
}

/**
 * Formats an ISO timestamp for display: in ship's time when the
 * vessel publishes a timezone (`MM-DD HH:MM +03` — the offset rides
 * on every stamp, so a zone crossing mid-passage reads honestly),
 * falling back to {@link fmtUtc} otherwise.
 *
 * @param {string|null|undefined} iso
 * @returns {string} Empty string when unset/invalid
 */
export function fmtShip(iso) {
  if (!shipTime) {
    return fmtUtc(iso);
  }
  const d = iso != null ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) {
    return "";
  }
  const shifted = new Date(d.getTime() + shipTime.offsetMinutes * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())} ${offsetLabel(shipTime.offsetMinutes)}`;
}

/**
 * Formats a duration in hours as `1d 04h`, `5h 20m` or `45m`.
 *
 * @param {number|null|undefined} hours
 * @returns {string} Empty string when unset/invalid
 */
export function fmtHours(hours) {
  if (hours == null || !Number.isFinite(hours)) {
    return "";
  }
  const total = Math.max(0, Math.round(hours * 60));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) {
    return `${d}d ${String(h).padStart(2, "0")}h`;
  }
  if (h > 0) {
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }
  return `${m}m`;
}

/**
 * Formats a speed in knots with one decimal.
 *
 * @param {number|null|undefined} knots
 * @returns {string} Empty string when unset/invalid
 */
export function fmtKn(knots) {
  if (knots == null || !Number.isFinite(knots)) {
    return "";
  }
  return `${knots.toFixed(1)} kn`;
}

/**
 * Formats fuel in liters with one decimal (SI — never imperial).
 *
 * @param {number|null|undefined} liters
 * @returns {string} Empty string when unset/invalid
 */
export function fmtLiters(liters) {
  if (liters == null || !Number.isFinite(liters)) {
    return "";
  }
  return `${liters.toFixed(1)} l`;
}

/**
 * Columns for the 24-bar horizon sparkline: bar height tracks AWS
 * within the window (max of the window → 100%), fill color maps the
 * comfort tier.
 *
 * @param {Array<{hoursFromNow: number, comfortLevel: string, awsKnots: number}>|
 *   null} hourlyComfort - First 24h comfort blocks
 * @param {number} [hours=24]
 * @returns {Array<{hoursFromNow: number, comfortLevel: string, awsKnots: number, heightPct: number, color: string, title: string}>}
 */
export function sparklineColumns(hourlyComfort, hours = 24) {
  const blocks = (hourlyComfort ?? []).slice(0, hours);
  const maxAws = Math.max(...blocks.map((b) => b.awsKnots ?? 0), 1);
  return blocks.map((b) => {
    const aws = b.awsKnots ?? 0;
    return {
      hoursFromNow: b.hoursFromNow,
      comfortLevel: b.comfortLevel ?? null,
      awsKnots: aws,
      heightPct: Math.max(4, Math.round((aws / maxAws) * 100)),
      color: comfortColor(b.comfortLevel),
      title: `${b.hoursFromNow}h: ${fmtKn(aws)} AWS, ${b.comfortLevel ?? "?"}`,
    };
  });
}

/**
 * Severe weather keywords highlighted in the strategic outlook
 * (work doc #4 §5).
 */
export const SEVERE_KEYWORDS = [
  "GALE",
  "STORM",
  "HURRICANE FORCE",
  "VIOLENT STORM",
  "SQUALL",
  "ROUGH SEAS",
  "VERY ROUGH SEAS",
  "HIGH SEAS",
  "PHENOMENAL SEAS",
];

/**
 * Splits bulletin text into tokens for severe-keyword highlighting:
 * consecutive non-severe words are grouped into one token each, so
 * the renderer builds a handful of DOM nodes instead of one per
 * word. Case-insensitive match, original casing preserved.
 *
 * @param {string|null|undefined} text
 * @returns {Array<{text: string, severe: boolean}>}
 */
export function splitSevere(text) {
  if (!text) {
    return [];
  }
  const pattern =
    /\b(HURRICANE FORCE|VIOLENT STORM|VERY ROUGH SEAS|ROUGH SEAS|HIGH SEAS|PHENOMENAL SEAS|GALE|STORM|SQUALL)\b/gi;
  const tokens = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) {
      tokens.push({ text: text.slice(last, match.index), severe: false });
    }
    tokens.push({ text: match[0], severe: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    tokens.push({ text: text.slice(last), severe: false });
  }
  return tokens;
}

/**
 * Hourly comfort rows for the conditions-here view (work doc #7):
 * the here payload's single waypoint evaluated at SOG 0, where the
 * Sereno apparent wind is effectively the true wind, so the comfort
 * mapping stays honest for life at anchor. Rows share the passage
 * simulation's hourly shape so the sparkline machinery is reused.
 *
 * @param {object|null} payload - Here payload (UnifiedWeatherPayload
 *   with one waypoint, `metadata.mode === "here"`)
 * @param {object} [config] - Simulation config subset
 *   (waterline_length_m, k_heel, k_pitch)
 * @param {number} [hours=24]
 * @returns {Array<{hoursFromNow: number, timestamp: string, awsKnots: number, azMs2: number, comfortLevel: string, twsKnots: number|null, sogKnots: number, night: boolean}>}
 */
export function hereHourly(payload, config = {}, hours = 24) {
  const waypoint = payload?.waypoints?.[0];
  const steps = waypoint?.forecasts ?? [];
  if (steps.length === 0) {
    return [];
  }
  const start = payload?.metadata?.fetchedAt
    ? new Date(payload.metadata.fetchedAt)
    : new Date(steps[0].timestamp);
  const rows = [];
  for (const step of steps) {
    const t = new Date(step.timestamp);
    const hoursFromNow = (t.getTime() - start.getTime()) / 3600000;
    if (hoursFromNow < 0 || hoursFromNow >= hours) {
      continue;
    }
    const tws = step.surface?.tws;
    const comfort = serenoComfort(
      {
        hsMeters: step.marine?.hsCombined ?? 0,
        tpSeconds: step.marine?.tpCombined ?? 0,
        waveTravelDirectionRad: travelDirection(
          (step.marine?.dirCombined ?? 0) * DEG,
        ),
      },
      {
        sogKnots: 0,
        headingRad: 0,
        waterlineLengthM: config.waterline_length_m ?? 9.4,
        kHeel: config.k_heel ?? 0.35,
        kPitch: config.k_pitch ?? 0.4,
      },
      { twsKnots: tws ?? 0, twaRad: 0 },
    );
    rows.push({
      hoursFromNow: Math.round(hoursFromNow * 10) / 10,
      timestamp: step.timestamp,
      awsKnots: comfort.awsKnots,
      azMs2: comfort.acceleration.value,
      comfortLevel: comfort.comfort,
      twsKnots: tws,
      sogKnots: 0,
      night: isNight(t, waypoint.lat, waypoint.lon),
    });
  }
  return rows;
}

/**
 * Conditions-now summary for the conditions-here view (work doc #7):
 * the first forecast step, plus the 3-hour pressure trend.
 *
 * @param {object|null} payload - Here payload
 * @param {Array<object>} [rows] - {@link hereHourly} rows for comfort
 * @returns {{comfortLevel: string|null, color: string, twsKnots: number|null, twdDeg: number|null, gustKnots: number|null, hsMeters: number|null, tpSeconds: number|null, currentDriftKnots: number|null, currentSetDeg: number|null, mslpHpa: number|null, mslpTrend: number|null, stamp: string}}
 */
export function hereNow(payload, rows = []) {
  const step = payload?.waypoints?.[0]?.forecasts?.[0];
  if (!step) {
    return {
      comfortLevel: null,
      color: comfortColor(null),
      twsKnots: null,
      twdDeg: null,
      gustKnots: null,
      hsMeters: null,
      tpSeconds: null,
      currentDriftKnots: null,
      currentSetDeg: null,
      mslpHpa: null,
      mslpTrend: null,
      stamp: "",
    };
  }
  const forecasts = payload.waypoints[0].forecasts;
  const mslpNow = step.surface?.mslp ?? null;
  const mslp3h = forecasts[3]?.surface?.mslp;
  const mslpTrend =
    mslpNow != null && typeof mslp3h === "number"
      ? Math.round((mslp3h - mslpNow) * 10) / 10
      : null;
  return {
    comfortLevel: rows[0]?.comfortLevel ?? null,
    color: comfortColor(rows[0]?.comfortLevel),
    twsKnots: step.surface?.tws ?? null,
    twdDeg: step.surface?.twd ?? null,
    gustKnots: step.surface?.gust ?? null,
    hsMeters: step.marine?.hsCombined ?? null,
    tpSeconds: step.marine?.tpCombined ?? null,
    currentDriftKnots: step.current?.drift ?? null,
    currentSetDeg: step.current?.set ?? null,
    mslpHpa: mslpNow,
    mslpTrend,
    stamp: fmtShip(step.timestamp),
  };
}

/**
 * Current-hour summary for the tactical dashboard's big readout.
 *
 * @param {object|null} exceptions - Worker exception view
 * @returns {{comfortLevel: string|null, awsKnots: number|null, hoursFromNow: number|null, color: string, stamp: string}}
 */
export function tacticalNow(exceptions) {
  const block = exceptions?.next24h?.comfortBlocks?.[0] ?? null;
  return {
    comfortLevel: block?.comfortLevel ?? null,
    awsKnots: block?.awsKnots ?? null,
    hoursFromNow: block?.hoursFromNow ?? null,
    color: comfortColor(block?.comfortLevel),
    stamp: fmtShip(block?.timestamp),
  };
}

/**
 * Sail-type words that mark the start of a new sail component inside
 * a canonical sail-state key. Reef/furl bits always terminate their
 * component, so only consecutive *full* sails are ambiguous without
 * the vessel's sail inventory — this small dictionary of common sail
 * types closes the gap (e.g. `GENOA_1_MAIN` is two sails, not one
 * named "Genoa 1 Main").
 */
const SAIL_COMPONENT_WORDS = new Set([
  "MAIN",
  "GENOA",
  "JIB",
  "STAYSAIL",
  "FORESAIL",
  "MIZZEN",
  "SPINNAKER",
  "GENNAKER",
  "YANKEE",
  "FOCK",
  "CODE",
  "DRIFTER",
  "SPIN",
]);

/**
 * Human-readable label for a canonical sail-state key (as built by
 * `logbook-source.js` `sailStateKey`): `GENOA_1_30_FURLED_MAIN_1_REEF`
 * reads as `Genoa 1 30% furled + Main 1 reef`, `NO_SAILS` as
 * `No sails`. A trailing `@side` (maneuver states) is ignored.
 *
 * @param {string|null|undefined} key - Canonical key, e.g. `MAIN_1_REEF`
 * @returns {string} Label, or the raw input when nothing parses
 */
export function sailStateLabel(key) {
  const raw = String(key ?? "").trim();
  if (!raw) {
    return "";
  }
  const combination = raw.split("@")[0];
  if (!combination || combination === "?") {
    return raw;
  }
  if (combination === "NO_SAILS") {
    return "No sails";
  }

  const components = [];
  let words = [];
  let reefs = null;
  let furled = null;
  const flush = () => {
    if (words.length > 0 || reefs != null || furled != null) {
      components.push({ words, reefs, furled });
    }
    words = [];
    reefs = null;
    furled = null;
  };

  const tokens = combination.split("_");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const value = /^\d+$/.test(token) ? Number(token) : null;
    const next = tokens[i + 1];
    if (value != null && (next === "REEF" || next === "FURLED")) {
      // Bit run `N REEF` / `N FURLED`: ends the component name run
      if (next === "REEF") {
        reefs = value;
      } else {
        furled = value;
      }
      i++;
      continue;
    }
    if (
      words.length > 0 &&
      (reefs != null || furled != null || SAIL_COMPONENT_WORDS.has(token))
    ) {
      flush();
    }
    words.push(token);
  }
  flush();

  if (components.length === 0) {
    return raw;
  }
  return components
    .map(({ words: sailWords, reefs: nReef, furled: nFurled }) => {
      const name = sailWords
        .map((word) =>
          /^\d/.test(word)
            ? word
            : word.charAt(0) + word.slice(1).toLowerCase(),
        )
        .join(" ");
      const bits = [];
      if (nReef != null) {
        bits.push(`${nReef} reef${nReef === 1 ? "" : "s"}`);
      }
      if (nFurled != null) {
        bits.push(`${nFurled}% furled`);
      }
      return [name, ...bits].filter(Boolean).join(" ");
    })
    .join(" + ");
}

/**
 * Label for one sail-change event: bare "No sails" says WHY the
 * canvas is down — the plan drifts (`No sails - drifting`) or the
 * engine pushes (`Motoring`) — instead of implying bare-pole sailing.
 *
 * @param {{sailState: string|null, propulsion?: string|null}} event
 * @returns {string} Human label
 */
function sailEventLabel(event) {
  const label = sailStateLabel(event.sailState);
  if (label === "No sails") {
    if (event.propulsion === "adrift") {
      return "No sails - drifting";
    }
    if (event.propulsion === "motor") {
      return "Motoring";
    }
  }
  return label;
}

/**
 * Hours from the payload's fetch time to an event timestamp, rounded
 * to a tenth. Null when either side is missing or unparsable — the
 * item then sorts undated, last.
 *
 * @param {string|null|undefined} timestamp
 * @param {number|null} fetchMs - Epoch ms of the payload fetch
 * @returns {number|null}
 */
function relHours(timestamp, fetchMs) {
  if (fetchMs == null || timestamp == null) {
    return null;
  }
  const ms = new Date(timestamp).getTime();
  return Number.isNaN(ms) ? null : Math.round((ms - fetchMs) / 360000) / 10;
}

/**
 * Detail line for an episode-shaped timeline item: the peak-value
 * parts, plus the episode's time range when it spans more than one
 * step ("until <stamp>", in ship's time like every other stamp).
 *
 * @param {{hoursFromNow: number|null, untilHoursFromNow:
 *   number|null, untilTimestamp: string|null}} episode
 * @param {Array<string|null>} parts - Peak value fragments
 * @returns {string}
 */
function episodeDetail(episode, parts) {
  const all = [...parts];
  if (
    episode.untilHoursFromNow != null &&
    episode.hoursFromNow != null &&
    episode.untilHoursFromNow - episode.hoursFromNow > 0.05
  ) {
    const stamp = fmtShip(episode.untilTimestamp);
    if (stamp) {
      all.push(`until ${stamp}`);
    }
  }
  return all.filter(Boolean).join(" · ");
}

/**
 * Unified passage timeline (work doc #18): every event source mapped
 * to one chronological shape — `{hoursFromNow, timestamp, stamp,
 * kind, severity, label, detail}` — sorted by time, undated last.
 * Kinds: `sail`, `maneuver`, `convective`, `sea`, `zone`, `space`,
 * `hazard`; new event sources become new kinds instead of new blocks
 * (work doc #1's lines of interest will ride in as `line`).
 * Severities: `info`, `warn`, `severe` — the renderer's colour
 * scale. The tactical dashboard renders the 24 h slice of this list,
 * the strategic outlook the whole passage.
 *
 * Sail changes and planned tacks/gybes come from the whole-passage
 * summary: the 24 h view is a slice of the same simulation list, so
 * merging both views would duplicate every early entry. Space events
 * and zone transitions ride the briefing payload; their
 * `hoursFromNow` is derived from the timestamp against the payload's
 * fetch time (aurora peaks carry a real forecast time; comet notes
 * are current-sky items and sort first).
 *
 * @param {object|null} exceptions - Worker exception view
 * @param {object|null} payload - Briefing payload
 *   (UnifiedWeatherPayload; optional `spaceEvents`,
 *   `zoneTransitions`, `celestialNights`)
 * @returns {Array<{hoursFromNow: number|null, timestamp: string|null, stamp: string, kind: string, severity: string, label: string, detail: string, night: boolean, moon: string|null}>}
 */
/**
 * Night glyph for a moon phase angle (work doc #3: the actual moon
 * phase instead of a fixed crescent). 0° = new, 90° = first quarter,
 * 180° = full, 270° = third quarter.
 *
 * @param {number} phaseDeg - Moon phase angle in degrees
 * @returns {string} One of the eight moon-phase glyphs
 */
export function moonGlyph(phaseDeg) {
  const sector = Math.floor(((((phaseDeg % 360) + 360) % 360) + 22.5) / 45) % 8;
  return ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"][sector];
}

/**
 * Night glyph for an instant from the payload's `celestialNights`
 * (nearest nightly entry), or null when the payload predates the
 * field or carries no timestamp.
 *
 * @param {string|null} timestamp - Event instant (ISO)
 * @param {object|null} payload - Briefing payload
 * @returns {string|null}
 */
function moonGlyphFor(timestamp, payload) {
  const nights = payload?.celestialNights;
  if (timestamp == null || !Array.isArray(nights) || nights.length === 0) {
    return null;
  }
  const t = new Date(timestamp).getTime();
  if (!Number.isFinite(t)) {
    return null;
  }
  const nearest = nights.reduce((best, entry) => {
    const et = new Date(entry.timestamp).getTime();
    if (!Number.isFinite(et)) {
      return best;
    }
    const distance = Math.abs(et - t);
    return best == null || distance < best.distance
      ? { distance, entry }
      : best;
  }, null);
  return nearest && Number.isFinite(nearest.entry.moonPhaseDeg)
    ? moonGlyph(nearest.entry.moonPhaseDeg)
    : null;
}

export function mergeTimeline(exceptions, payload = null) {
  const summary = exceptions?.passageSummary ?? {};
  const fetchMs = payload?.metadata?.fetchedAt
    ? new Date(payload.metadata.fetchedAt).getTime()
    : null;
  const items = [];
  const push = (item) => {
    items.push({
      hoursFromNow: null,
      timestamp: null,
      label: "?",
      detail: "",
      night: false,
      ...item,
      stamp: fmtShip(item.timestamp),
      moon: moonGlyphFor(item.timestamp, payload),
    });
  };

  // Sail work (work doc #5): recommendation-driven changes plus the
  // tacks/gybes the plan implies; maneuvers read as the sail work
  // they demand
  for (const e of summary.sailChanges ?? []) {
    const maneuver = e.maneuver === "tack" || e.maneuver === "gybe";
    const state = String(e.sailState ?? "?");
    const [, tack] = state.split("@");
    const label = maneuver
      ? `${e.maneuver === "tack" ? "Tack" : "Gybe"} to ${e.toTack ?? tack ?? "?"}`
      : sailEventLabel(e) || state;
    // Conditions at the change point (work doc #18): what the crew
    // is rigging into — true wind, sea state, comfort tier. Falls
    // back to the bare maneuver TWS for payloads without the
    // enriched conditions block.
    const conditions = e.conditions ?? null;
    const tws = conditions?.twsKnots ?? e.twsAtManeuver ?? null;
    // Why the change sits where it sits: watch handover when a watch
    // schedule runs, else the sunrise/sunset it waits for
    const anchorText =
      e.anchor === "watch"
        ? "watch change"
        : e.anchor === "dusk"
          ? "at dusk"
          : e.anchor === "dawn"
            ? "at dawn"
            : null;
    push({
      hoursFromNow: e.hoursFromNow ?? null,
      timestamp: e.timestamp ?? null,
      kind: maneuver ? "maneuver" : "sail",
      severity: maneuver ? "warn" : "info",
      label,
      detail: [
        e.distanceFromStartNm != null
          ? `${Math.round(e.distanceFromStartNm)} nm`
          : null,
        tws != null ? `${fmtKn(tws)} TWS` : null,
        conditions?.hsMeters != null
          ? `Hs ${conditions.hsMeters.toFixed(1)} m`
          : null,
        conditions?.comfortLevel ?? null,
        anchorText,
      ]
        .filter(Boolean)
        .join(" · "),
      night: Boolean(e.night),
    });
  }

  // Macro sea-state anomaly episodes (steepness below the breaking
  // ratio): peak ratio and seas over the episode's time range
  for (const a of summary.macroSeaAnomalies ?? []) {
    push({
      hoursFromNow: a.hoursFromNow ?? null,
      timestamp: a.timestamp ?? null,
      kind: "sea",
      severity: "warn",
      label: "Steep sea",
      detail: episodeDetail(a, [
        a.steepnessRatio != null ? `ratio ${a.steepnessRatio}` : null,
        a.hsMeters != null ? `Hs ${a.hsMeters.toFixed(1)} m` : null,
      ]),
    });
  }

  // Convective warning episodes (CAPE / K-index thresholds): peak
  // values over the range; CAPE in J/kg, K-index to one decimal.
  // Episodes whose peak stays under the severe bars render as plain
  // warnings, not red
  for (const c of summary.convectiveWarnings ?? []) {
    push({
      hoursFromNow: c.hoursFromNow ?? null,
      timestamp: c.timestamp ?? null,
      kind: "convective",
      severity: c.marginal ? "warn" : "severe",
      label: "Convection risk",
      detail: episodeDetail(c, [
        c.cape != null ? `CAPE ${Math.round(c.cape)} J/kg` : null,
        c.kIndex != null ? `K ${c.kIndex.toFixed(1)}` : null,
      ]),
    });
  }

  // Hazard notes along the track (whole passage; the tactical slice
  // picks up its share by hoursFromNow)
  for (const h of summary.hazards ?? []) {
    push({
      hoursFromNow: h.hoursFromNow ?? null,
      timestamp: h.timestamp ?? null,
      kind: "hazard",
      severity: "severe",
      label: h.description ?? h.noteId ?? "Hazard note",
      detail:
        h.distanceNm != null && h.distanceNm > 0
          ? `${h.distanceNm} nm off`
          : "",
    });
  }

  // Space events (work doc #3): aurora-class alerts are tactical,
  // comet notes are strategic sky items
  for (const e of payload?.spaceEvents ?? []) {
    push({
      hoursFromNow: relHours(e.timestamp, fetchMs),
      timestamp: e.timestamp ?? null,
      kind: "space",
      severity: e.tactical ? "warn" : "info",
      label: e.description ?? e.kind ?? "Sky event",
    });
  }

  // Territorial waters transitions (work doc #17): the source object
  // carries `enter`/`leave` in its own `kind`; the timeline kind is
  // always `zone`
  for (const z of payload?.zoneTransitions ?? []) {
    const territory = z.territory?.name ?? "?";
    push({
      hoursFromNow: z.hoursFromNow ?? relHours(z.timestamp, fetchMs),
      timestamp: z.timestamp ?? null,
      kind: "zone",
      severity: "info",
      label: `${z.kind === "leave" ? "Leaving" : "Entering"} ${territory} territorial waters`,
      detail:
        z.distanceFromStartNm != null
          ? `${Math.round(z.distanceFromStartNm)} nm`
          : "",
    });
  }

  return items.sort((a, b) => {
    if (a.hoursFromNow == null || b.hoursFromNow == null) {
      return a.hoursFromNow == null && b.hoursFromNow == null
        ? 0
        : a.hoursFromNow == null
          ? 1
          : -1;
    }
    return a.hoursFromNow - b.hoursFromNow;
  });
}

/**
 * View model for the strategic ETA table.
 *
 * @param {object|null} exceptions - Worker exception view
 * @param {object|null} [payload] - Briefing payload; its
 *   `celestialNights` give night arrivals their moon-phase glyph
 * @returns {{rows: Array<{label: string, stamp: string, night: boolean, moon: string|null}>, motorHours: string, fuel: string}}
 */
export function etaTable(exceptions, payload = null) {
  const summary = exceptions?.passageSummary ?? {};
  const night = summary.etaNight ?? {};
  const row = (label, timestamp, isNight) => ({
    label,
    stamp: fmtShip(timestamp),
    night: isNight === true,
    // Actual moon phase for night arrivals (work doc #3); null when
    // the payload predates celestialNights — the renderer falls back
    // to the fixed crescent
    moon: isNight === true ? moonGlyphFor(timestamp, payload) : null,
  });
  return {
    rows: [
      row("P10", summary.etaP10, night.p10),
      row("P50", summary.etaP50, night.p50),
      row("P90", summary.etaP90, night.p90),
    ],
    motorHours:
      summary.totalMotorHours != null ? fmtHours(summary.totalMotorHours) : "",
    fuel:
      summary.totalFuelLiters != null ? fmtLiters(summary.totalFuelLiters) : "",
  };
}
