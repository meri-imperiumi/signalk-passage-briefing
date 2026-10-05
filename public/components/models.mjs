/**
 * Pure view models for the passage briefing webapp: everything the
 * custom elements render, computed from the worker's exception views
 * (SPEC §6.2). Kept free of DOM so Node can test them; the elements
 * stay thin.
 *
 * @module models
 */

import {
  assumedDepartureTime,
  greatCircleNm,
  isNight,
  serenoComfort,
  travelDirection,
} from "../sereno-physics.mjs";

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
 * Formats an ISO timestamp's clock time only (`HH:MM`), in ship's
 * time when the vessel publishes a timezone, UTC otherwise. The sky
 * line uses it — rise/set stamps never carry a date, the sky line's
 * night context supplies it.
 *
 * @param {string|null|undefined} iso
 * @returns {string} Empty string when unset/invalid
 */
export function fmtHm(iso) {
  const d = iso != null ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) {
    return "";
  }
  const off = shipTime?.offsetMinutes ?? 0;
  const shifted = new Date(d.getTime() + off * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
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
 * Maps one data-source status registry entry (work doc #23) to its
 * checklist verdict: the bracket glyph, the semantic theme class and
 * whether the last success is older than the source's expected
 * refresh interval.
 *
 * - `ok` sources render `[ OK ]`, unless stale beyond the expected
 *   refresh interval → `[ WARN ]`.
 * - A failed cycle renders `[ FAIL ]`, except the classes that mean
 *   "their server is annoyed or their payload changed shape" — 429
 *   and parse errors — which render `[ WARN ]` (a rate-limited feed
 *   is a wait, a moved URL is a fix-me).
 * - `offline-skipped` cycles never render as FAIL: an offline boat
 *   shows a wall of `[ SKIP ]`, which is correct information.
 * - `absent` optional sources (companion plugin not installed) and
 *   sources never yet attempted render muted.
 *
 * @param {object} entry - Registry entry
 * @param {Date} [now]
 * @returns {{bracket: string, theme: string, stale: boolean}}
 */
export function statusVerdict(entry, now = new Date()) {
  const status = entry?.lastStatus;
  if (status === "skip") {
    return { bracket: "[ SKIP ]", theme: "theme-offline", stale: false };
  }
  if (status === "absent") {
    return { bracket: "[ N/A ]", theme: "theme-offline", stale: false };
  }
  if (status === "fail") {
    const cls = entry.lastError?.class;
    if (cls === "http-429" || cls === "parse") {
      return { bracket: "[ WARN ]", theme: "theme-orange", stale: false };
    }
    return { bracket: "[ FAIL ]", theme: "theme-red", stale: false };
  }
  if (status === "ok") {
    const stale =
      entry.expectedRefreshMs != null &&
      entry.lastSuccessAt != null &&
      now.getTime() - new Date(entry.lastSuccessAt).getTime() >
        entry.expectedRefreshMs;
    return stale
      ? { bracket: "[ WARN ]", theme: "theme-orange", stale: true }
      : { bracket: "[ OK ]", theme: "theme-green", stale: false };
  }
  // No cycle recorded yet: the entry is defined but unproven
  return { bracket: "[ WAIT ]", theme: "theme-offline", stale: false };
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
export function sparklineColumns(hourlyComfort, hours = 24, options = {}) {
  const blocks = (hourlyComfort ?? []).slice(0, hours);
  const maxAws = Math.max(...blocks.map((b) => b.awsKnots ?? 0), 1);
  // When the schedule anchors to an assumed departure (work doc #15),
  // the titles read wall-clock stamps instead of hours-from-now —
  // "first light" should read 06:00, not "+7 h"
  const stamp = (hoursFromNow) =>
    options.anchorMs != null
      ? fmtShip(new Date(options.anchorMs + hoursFromNow * 3600000))
      : `${hoursFromNow}h`;
  return blocks.map((b) => {
    const aws = b.awsKnots ?? 0;
    return {
      hoursFromNow: b.hoursFromNow,
      comfortLevel: b.comfortLevel ?? null,
      slatting: Boolean(b.slatting),
      awsKnots: aws,
      heightPct: Math.max(4, Math.round((aws / maxAws) * 100)),
      color: comfortColor(b.comfortLevel),
      title: `${stamp(b.hoursFromNow)}: ${fmtKn(aws)} AWS, ${b.slatting ? "slatting" : (b.comfortLevel ?? "?")}`,
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
  "FREEZING SPRAY",
  "DENSE FOG",
  "VOLCANIC ASH",
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
    /\b(HURRICANE FORCE|VIOLENT STORM|VERY ROUGH SEAS|ROUGH SEAS|HIGH SEAS|PHENOMENAL SEAS|FREEZING SPRAY|DENSE FOG|VOLCANIC ASH|HURRICANE|CYCLONE|GALE|STORM|SQUALL)\b/gi;
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
      slatting: comfort.slatting,
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
/**
 * Energy summary for the conditions-here view (work doc #10): the
 * predictor's hourly series summed over the forward 24 h, generation
 * and net — the passage strip's here-mode sibling at SOG 0.
 *
 * @param {object|null} payload - Here payload (optional
 *   `energyHourly`)
 * @returns {{netSolar24h: number|null, netBalance24h: number|null}}
 *   kWh, null when the payload carries no forecast
 */
export function hereEnergySummary(payload) {
  const hours = payload?.energyHourly ?? [];
  if (!Array.isArray(hours) || hours.length === 0) {
    return { netSolar24h: null, netBalance24h: null };
  }
  const start = payload?.metadata?.fetchedAt
    ? new Date(payload.metadata.fetchedAt).getTime()
    : Date.now();
  const end = start + 24 * 3600000;
  let solar = 0;
  let balance = 0;
  let seen = 0;
  for (const hour of hours) {
    const t = new Date(hour.timestamp).getTime();
    if (Number.isNaN(t) || t < start || t >= end) {
      continue;
    }
    const solarWh = typeof hour.solarWh === "number" ? hour.solarWh : 0;
    const loadWh = typeof hour.loadWh === "number" ? hour.loadWh : 0;
    solar += solarWh;
    balance += solarWh - loadWh;
    seen++;
  }
  if (seen === 0) {
    return { netSolar24h: null, netBalance24h: null };
  }
  return {
    netSolar24h: Math.round(solar) / 1000,
    netBalance24h: Math.round(balance) / 1000,
  };
}

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
      cloudCover: null,
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
    cloudCover: step.surface?.cloudCover ?? null,
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
 * canvas is down — the plan drifts (`No sails - drifting`), the
 * engine pushes (`Motoring`), or the weather demands the canvas-off
 * regime (`Storm tactics`: at survival wind the tactic — heave to,
 * drogue, run off — is the crew's call, not the simulator's; work
 * doc #27 will pick it up) — instead of implying bare-pole sailing.
 *
 * @param {{sailState: string|null, propulsion?: string|null,
 *   canvasOffRegime?: string|null}} event
 * @returns {string} Human label
 */
function sailEventLabel(event) {
  const label = sailStateLabel(event.sailState);
  if (label === "No sails") {
    if (event.canvasOffRegime === "survival") {
      return "Storm tactics";
    }
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
 * `hazard`, `time`; new event sources become new kinds instead of
 * new blocks (work doc #1's lines of interest will ride in as
 * `line`).
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
 *   `zoneTransitions`, `celestialNights`, `timeZoneChanges`)
 * @returns {Array<{hoursFromNow: number|null, timestamp: string|null, stamp: string, kind: string, severity: string, label: string, detail: string, night: boolean, moon: string|null, cloudCover: number|null, comfortLevel: string|null, slatting: boolean, provenance: object|null}>}
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
 * The night entry nearest an instant from the payload's
 * `celestialNights` — the shared lookup behind the night glyphs
 * (moon phase at nightfall) and the sky line (work docs #17, #33).
 *
 * @param {string|null} timestamp - Event instant (ISO)
 * @param {object|null} payload - Briefing payload
 * @returns {object|null} The nearest `celestialNights` entry
 */
function nearestNight(timestamp, payload) {
  const nights = payload?.celestialNights;
  if (timestamp == null || !Array.isArray(nights) || nights.length === 0) {
    return null;
  }
  const t = new Date(timestamp).getTime();
  if (!Number.isFinite(t)) {
    return null;
  }
  return (
    nights.reduce((best, entry) => {
      const et = new Date(entry.timestamp).getTime();
      if (!Number.isFinite(et)) {
        return best;
      }
      const distance = Math.abs(et - t);
      return best == null || distance < best.distance
        ? { distance, entry }
        : best;
    }, null)?.entry ?? null
  );
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
  const nearest = nearestNight(timestamp, payload);
  return nearest && Number.isFinite(nearest.moonPhaseDeg)
    ? moonGlyph(nearest.moonPhaseDeg)
    : null;
}

/**
 * The sky line (work doc #33): the night's sun/moon times plus the
 * cloud cover at an instant, as labelled segments the views join
 * with separators. Times render `HH:MM` ship time; arrows mark
 * rise/set; ☾ marks nautical dusk, the briefing's own night
 * boundary. Moon stamps appear only inside the night window (dusk to
 * sunrise) — a moon already up at dusk reports its set for tonight
 * and its next rise lands outside the window, so both cases stay
 * quiet rather than confusing. Cloud cover rides separately: null
 * (provider mode, or unknown hour) omits the segment, never invents.
 *
 * @param {object|null} payload - Briefing payload (`celestialNights`
 *   with the work-doc-#33 rise/set fields; older payloads degrade to
 *   whatever fields they carry)
 * @param {object} [options]
 * @param {string|null} [options.timestamp] - Instant the night is
 *   picked for (default: the payload's fetch time)
 * @param {number|null} [options.cloudCover] - Cloud cover percent at
 *   that instant
 * @returns {Array<{text: string, title: string}>} Empty when the
 *   payload predates the sky data
 */
export function skySegments(
  payload,
  { timestamp = null, cloudCover = null } = {},
) {
  const night = nearestNight(
    timestamp ?? payload?.metadata?.fetchedAt ?? null,
    payload,
  );
  if (!night) {
    return [];
  }
  const segments = [];
  if (night.sunset) {
    segments.push({
      text: `☀ ${fmtHm(night.sunset)}↓`,
      title: `sunset ${fmtShip(night.sunset)}`,
    });
  }
  if (night.nauticalDusk) {
    segments.push({
      text: `☾ ${fmtHm(night.nauticalDusk)}`,
      title: `nautical dusk — dark from ${fmtShip(night.nauticalDusk)}`,
    });
  }
  const windowStart = night.nauticalDusk
    ? new Date(night.nauticalDusk).getTime()
    : null;
  const windowEnd = night.sunrise ? new Date(night.sunrise).getTime() : null;
  const inNight = (iso) => {
    if (windowStart == null || windowEnd == null) {
      return false;
    }
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t >= windowStart && t <= windowEnd;
  };
  if (night.moonrise && inNight(night.moonrise)) {
    segments.push({
      text: `☽↑ ${fmtHm(night.moonrise)}`,
      title: `moonrise ${fmtShip(night.moonrise)}`,
    });
  }
  if (night.moonset && inNight(night.moonset)) {
    segments.push({
      text: `☽↓ ${fmtHm(night.moonset)}`,
      title: `moonset ${fmtShip(night.moonset)}`,
    });
  }
  if (cloudCover != null && Number.isFinite(cloudCover)) {
    segments.push({
      text: `☁ ${Math.round(cloudCover)}%`,
      title: `cloud cover ${Math.round(cloudCover)} %`,
    });
  }
  return segments;
}

/**
 * The crew's position at an item's hour, interpolated along the
 * simulated track (the shared geometry behind the night test and the
 * per-item weather-viewer links of work doc #31).
 *
 * @param {number} hoursFromNow - Item hour in the passage schedule
 * @param {Array<{hoursFromNow: number, lat: number, lon: number}>} track
 * @returns {{lat: number, lon: number}|null} Null when no track
 */
function trackPositionAt(hoursFromNow, track) {
  if (!Array.isArray(track) || track.length === 0) {
    return null;
  }
  let before = null;
  let after = null;
  for (const point of track) {
    if (point.hoursFromNow <= hoursFromNow) {
      before = point;
    } else if (after == null) {
      after = point;
      break;
    }
  }
  const reference = before ?? after;
  if (!reference) {
    return null;
  }
  let lat = reference.lat;
  let lon = reference.lon;
  if (before && after) {
    const span = after.hoursFromNow - before.hoursFromNow;
    const f = span > 0 ? (hoursFromNow - before.hoursFromNow) / span : 0;
    lat = before.lat + f * (after.lat - before.lat);
    lon = before.lon + f * (after.lon - before.lon);
  }
  return { lat, lon };
}

/**
 * Night test for a timeline item: the crew's position at that hour,
 * interpolated along the simulated track, tested against the sun
 * (the same sunset threshold the sail logic buckets by). One uniform
 * answer to "does this happen at night", anchored at the payload's
 * fetch time — the same base the `+Xh` labels use.
 *
 * @param {number} hoursFromNow - Item hour in the passage schedule
 * @param {Array<{hoursFromNow: number, lat: number, lon: number}>} track
 * @param {number} baseMs - Epoch ms the schedule is relative to
 * @returns {boolean|null} Null when no track is available
 */
function trackNightAt(hoursFromNow, track, baseMs) {
  const position = trackPositionAt(hoursFromNow, track);
  if (!position) {
    return null;
  }
  return isNight(
    new Date(baseMs + hoursFromNow * 3600000),
    position.lat,
    position.lon,
  );
}

/**
 * Conditions at a timeline item's hour: the simulated track's
 * nearest hourly step (same nearest-step rule the night test uses —
 * the rows are hourly, interpolation between tiers would invent one).
 * Feeds the timeline's conditions tab (work doc #18): every entry
 * paints the comfort color the tactical sparkline uses, so the
 * passage's weather development reads at a glance.
 *
 * @param {number} hoursFromNow - Item hour in the passage schedule
 * @param {Array<{hoursFromNow: number, comfortLevel: string|null,
 *   slatting: boolean}>} track - Simulated hourly track
 * @returns {{comfortLevel: string|null, slatting: boolean}|null} Null
 *   when the track carries no conditions
 */
function trackConditionsAt(hoursFromNow, track) {
  if (!Array.isArray(track) || track.length === 0) {
    return null;
  }
  let reference = null;
  let best = Infinity;
  for (const point of track) {
    if (point.hoursFromNow == null) {
      continue;
    }
    const d = Math.abs(point.hoursFromNow - hoursFromNow);
    if (d < best) {
      best = d;
      reference = point;
    }
  }
  if (!reference || reference.comfortLevel == null) {
    return null;
  }
  return {
    comfortLevel: reference.comfortLevel,
    slatting: Boolean(reference.slatting),
    // Night-darkness context (work doc #32): null when the source
    // publishes no cloud field (provider mode) — never invented
    cloudCover: Number.isFinite(reference.cloudCover)
      ? reference.cloudCover
      : null,
  };
}

/**
 * The effective departure for the passage schedule (work doc #15):
 * auto mode anchors to daylight via {@link assumedDepartureTime}; the
 * manual modes are the crew's word — Now, First light, a fixed offset
 * or a custom instant. Returns the time to feed the simulation, the
 * reason the UI states, and whether the anchor was assumed or chosen.
 *
 * @param {object} params
 * @param {"auto"|"now"|"dawn"|"+1h"|"+2h"|"custom"} params.mode
 * @param {Date|null} params.customTime - Custom instant (mode custom)
 * @param {Date} params.now - Reference instant (payload fetch time is
 *   the stable choice; the caller re-checks on its own cadence)
 * @param {number} params.lat - Start position latitude
 * @param {number} params.lon - Start position longitude
 * @param {boolean} params.underway - Navigation state outside the
 *   moored/anchored set
 * @param {number} params.prepHours - Configured prep delay (hours)
 * @param {number} params.dawnAltitudeDeg - Configured dawn anchor
 * @returns {{time: Date, reason: string, assumed: boolean}}
 */
export function effectiveDeparture({
  mode,
  customTime,
  now,
  lat,
  lon,
  underway,
  prepHours,
  dawnAltitudeDeg,
}) {
  if (mode === "now") {
    return { time: now, reason: "manual", assumed: false };
  }
  if (mode === "+1h" || mode === "+2h") {
    return {
      time: new Date(now.getTime() + Number(mode.slice(1, -1)) * 3600000),
      reason: "manual",
      assumed: false,
    };
  }
  if (mode === "custom") {
    const time = customTime != null ? new Date(customTime) : now;
    return {
      time: Number.isNaN(time.getTime()) ? now : time,
      reason: "manual",
      assumed: false,
    };
  }
  if (mode === "dawn") {
    // Manual first light: the dawn anchor, underway or not — the crew
    // said when, even if the state machine disagrees
    return {
      ...assumedDepartureTime({
        now,
        lat,
        lon,
        underway: false,
        dawnAltitudeDeg,
      }),
      assumed: false,
    };
  }
  // Auto: daylight-anchored, skipped entirely when underway
  return {
    ...assumedDepartureTime({
      now,
      lat,
      lon,
      underway,
      prepHours,
      dawnAltitudeDeg,
    }),
    assumed: true,
  };
}

/**
 * Trims a compiled waypoint list to the boat's actual position (work
 * doc #28, live re-anchor): the briefing is forward-looking, so
 * between compiles the simulated plan starts at the boat, not the
 * route origin — sailed waypoints drop out, the boat position joins
 * the track carrying the nearest waypoint's forecasts (weather at
 * 15 nm offset differs little; the simulation interpolates the rest),
 * and distances recompute from the boat.
 *
 * Pure geometry, no re-fetch: the payload's waypoint forecasts carry
 * timestamps, and the simulation interpolates weather at the boat's
 * position. Null when there is nothing to trim (no position, short
 * track).
 *
 * @param {Array<{lat: number, lon: number, distanceFromStartNm:
 *   number, forecasts: Array<object>}>} waypoints - Compiled payload
 *   waypoints (30 nm resample of the plan)
 * @param {{lat: number, lon: number}|null} vessel - Vessel position
 * @returns {{waypoints: Array<object>, progressNm: number}|null} The
 *   trimmed list (first entry is the boat) and the boat's progress
 *   along the compiled plan (nm)
 */
export function trimWaypointsToPosition(waypoints, vessel) {
  if (
    !Array.isArray(waypoints) ||
    waypoints.length < 2 ||
    !vessel ||
    !Number.isFinite(vessel.lat) ||
    !Number.isFinite(vessel.lon)
  ) {
    return null;
  }
  let nearest = 0;
  let best = Infinity;
  waypoints.forEach((waypoint, index) => {
    const d = greatCircleNm(vessel.lat, vessel.lon, waypoint.lat, waypoint.lon);
    if (d < best) {
      best = d;
      nearest = index;
    }
  });
  const anchor = waypoints[nearest];
  // The boat's progress: the compiled distance up to the nearest
  // waypoint, plus the hop from it to the boat (cross-track included —
  // sailing to the next waypoint from here is what the crew will do)
  const progressNm =
    anchor.distanceFromStartNm +
    greatCircleNm(vessel.lat, vessel.lon, anchor.lat, anchor.lon);
  // The boat replaces the anchor waypoint; waypoints still ahead keep
  // their forecasts, distances recomputed from the boat. A waypoint
  // that now sits behind (the boat passed it) drops out.
  const boat = {
    ...anchor,
    lat: vessel.lat,
    lon: vessel.lon,
    distanceFromStartNm: 0,
  };
  const ahead = waypoints
    .slice(nearest + 1)
    .map((w) => ({
      ...w,
      distanceFromStartNm:
        Math.round((w.distanceFromStartNm - progressNm) * 10) / 10,
    }))
    .filter((w) => w.distanceFromStartNm >= 0);
  return {
    waypoints: [boat, ...ahead],
    progressNm: Math.round(progressNm * 10) / 10,
  };
}

/**
 * Formats a position for the timeline detail line: degrees and
 * minutes are overkill here — one decimal and a hemisphere letter.
 *
 * @param {number|null} lat - Latitude degrees
 * @param {number|null} lon - Longitude degrees east
 * @returns {string|null}
 */
function formatCoord(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(1)}°${ns} ${Math.abs(lon).toFixed(1)}°${ew}`;
}

export function mergeTimeline(exceptions, payload = null) {
  const summary = exceptions?.passageSummary ?? {};
  const fetchMs = payload?.metadata?.fetchedAt
    ? new Date(payload.metadata.fetchedAt).getTime()
    : null;
  const items = [];
  // Chronology is one scale (work doc #15): when a departure anchor
  // is active, every `+Xh` is hours-from-departure — sim-derived
  // events already are, and timestamped payload events convert from
  // their absolute stamps. Without an anchor (underway, or an old
  // payload) the scale is hours-from-fetch, as it always was.
  const anchor = summary.departure ?? payload?.departure ?? null;
  const anchorMs =
    anchor?.time != null ? new Date(anchor.time).getTime() : null;
  const hoursFor = (item) => {
    if (item.timestamp != null) {
      const t = new Date(item.timestamp).getTime();
      const base = anchorMs ?? fetchMs;
      if (Number.isFinite(t) && base != null) {
        return Math.round(((t - base) / 3600000) * 10) / 10;
      }
    }
    return item.hoursFromNow ?? null;
  };
  const push = (item) => {
    items.push({
      timestamp: null,
      label: "?",
      detail: "",
      night: false,
      comfortLevel: null,
      slatting: false,
      cloudCover: null,
      provenance: null,
      ...item,
      stamp: fmtShip(item.timestamp),
      moon: moonGlyphFor(item.timestamp, payload),
      hoursFromNow: hoursFor(item),
    });
  };

  // The assumed departure, as an event (work doc #15): a delayed
  // departure — first light, or the prep delay — is the first thing
  // that happens on the passage. Underway and polar-fallback cases
  // are not delayed and read from the now-card instead.
  const departure = summary.departure ?? payload?.departure ?? null;
  if (
    departure?.time != null &&
    (departure.reason === "next_dawn" || departure.reason === "daylight_prep")
  ) {
    push({
      hoursFromNow: relHours(departure.time, fetchMs),
      timestamp: departure.time,
      kind: "departure",
      severity: "info",
      label:
        departure.reason === "next_dawn"
          ? "Departure at first light"
          : "Departure after prep",
      detail:
        departure.reason === "next_dawn"
          ? "anchored to daylight — nobody casts off in the dark"
          : "stow, hoist, cast off within daylight",
    });
  }

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
    // enriched conditions block. When the tier came from the
    // slatting penalty (work doc #14: light air over a residual
    // swell), the detail says so — "rough" alone would send someone
    // looking for wind that isn't there.
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
        conditions?.slatting ? "slatting" : (conditions?.comfortLevel ?? null),
        anchorText,
      ]
        .filter(Boolean)
        .join(" · "),
      night: Boolean(e.night),
      // The conditions block is the reefing logic's tier at the
      // change point — authoritative over the track's nearest hour
      comfortLevel: conditions?.comfortLevel ?? null,
      slatting: Boolean(conditions?.slatting),
      cloudCover: conditions?.cloudCover ?? null,
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
  // picks up its share by hoursFromNow). Provenance (work doc #31):
  // the note's url is the GDACS event page the note was built from
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
      provenance: h.url
        ? {
            kind: "warning",
            label: "GDACS",
            url: h.url,
            viewerUrl: null,
            at: h.timestamp ?? null,
          }
        : null,
    });
  }

  // Space events (work doc #3): aurora-class alerts are tactical,
  // comet notes are strategic sky items. Provenance (work doc #31)
  // rides the event — satellite passes carry the tracker link,
  // computed ephemeris carries none
  for (const e of payload?.spaceEvents ?? []) {
    push({
      hoursFromNow: relHours(e.timestamp, fetchMs),
      timestamp: e.timestamp ?? null,
      kind: "space",
      severity: e.tactical ? "warn" : "info",
      label: e.description ?? e.kind ?? "Sky event",
      provenance: e.provenance ?? null,
    });
  }

  // GDACS hazard events (work doc #22): earthquakes, cyclones, floods
  // and volcanoes near the vessel or route — timeline kind `hazard`,
  // the alert level setting the severity
  for (const h of payload?.hazardEvents ?? []) {
    push({
      hoursFromNow: relHours(h.timestamp, fetchMs),
      timestamp: h.timestamp ?? null,
      kind: "hazard",
      severity: h.alertLevel === "red" ? "severe" : "warn",
      label: h.title ?? `${h.type ?? ""} hazard event`.trim(),
      detail: [
        h.distanceNm != null ? `${h.distanceNm} nm` : null,
        h.bearingDeg != null ? `${h.bearingDeg}°` : null,
        h.type ?? null,
      ]
        .filter(Boolean)
        .join(" · "),
      provenance: h.provenance ?? null,
    });
  }

  // Territorial waters transitions (work doc #17): the simulation
  // timestamps the plugin's crossings against the passage schedule
  // (summary), falling back to the payload's undated transitions;
  // the timeline kind is always `zone`. Leaving territorial waters
  // carries the connectivity note — the metered-ocean boundary.
  // When the crossing lands in another timezone than the vessel's
  // current one, the event says so (work doc #19) — exactly the
  // moment a crew sets watches and re-plans arrival in local time.
  for (const z of summary.zoneTransitions ?? payload?.zoneTransitions ?? []) {
    const territory = z.territory?.name ?? "?";
    push({
      hoursFromNow: z.hoursFromNow ?? relHours(z.timestamp, fetchMs),
      timestamp: z.timestamp ?? null,
      kind: "zone",
      severity: "info",
      label: `${z.kind === "leave" ? "Leaving" : "Entering"} ${territory} territorial waters`,
      detail: [
        z.connectivity === "ocean"
          ? "ocean data rules beyond this point"
          : null,
        z.distanceFromStartNm != null
          ? `${Math.round(z.distanceFromStartNm)} nm from departure`
          : null,
        z.zoneOffsetMinutes != null &&
        (shipTime == null || z.zoneOffsetMinutes !== shipTime.offsetMinutes)
          ? `time zone ${offsetLabel(z.zoneOffsetMinutes)}`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
      provenance: z.provenance ?? null,
    });
  }

  // Zone meridian crossings offshore (work doc #19): solar time
  // drifts 1 h per 15° of longitude, so watch schedules quietly
  // desynchronize from the sun unless the clock follows. The event
  // advises; what the crew does with the clock is the master's
  // discretion.
  for (const c of summary.timeZoneChanges ?? payload?.timeZoneChanges ?? []) {
    push({
      hoursFromNow: c.hoursFromNow ?? relHours(c.timestamp, fetchMs),
      timestamp: c.timestamp ?? null,
      kind: "time",
      severity: "info",
      label: `Crossing ${c.meridian ?? "a zone meridian"}`,
      detail: `solar time 1 h ${c.eastbound ? "ahead" : "behind"} — clock change due`,
    });
  }

  // Night indicators for every dated item (work doc #17 session
  // feedback): interpolate the crew's position at the item's hour
  // from the simulated track and test the sun — one uniform answer
  // to "does this happen at night", not just for sail changes. The
  // sail events' own bucket (the reefing logic's authoritative one)
  // is left untouched.
  const track = summary.track ?? [];
  // The night test instant: hoursFromNow is departure-relative while
  // an anchor is active (the track is too), fetch-relative otherwise
  const baseMs = anchorMs ?? fetchMs ?? Date.now();
  // Weather provenance chain (work doc #31): the simulated items are
  // the forecast's output — they chain to the payload's weather
  // provenance record, deep-linking the on-board viewer to the
  // item's own hour and position when the sibling webapp is
  // installed. Items with no record stay quiet: absence never
  // implies external authority.
  const weatherProv = payload?.metadata?.provenance ?? null;
  const SIMULATED_KINDS = new Set(["sail", "maneuver", "convective", "sea"]);
  const derivedProvenance = (item) => {
    if (!weatherProv || item.hoursFromNow == null) {
      return null;
    }
    const position = trackPositionAt(item.hoursFromNow, track);
    let viewerUrl = null;
    if (weatherProv.viewerBase && position) {
      const at = new Date(baseMs + item.hoursFromNow * 3600000);
      viewerUrl = `${weatherProv.viewerBase}?lat=${position.lat.toFixed(4)}&lon=${position.lon.toFixed(4)}&time=${at.toISOString()}&layer=wind`;
    }
    // The external origin follows the item too (work doc #31 session
    // feedback): the Open-Meteo page for the patch of ocean the boat
    // plans to be at, not the departure's. Provider mode publishes
    // no external origin — only the viewer link carries depth there.
    let url = weatherProv.url ?? null;
    if (url && position) {
      try {
        const origin = new URL(url);
        origin.searchParams.set("latitude", position.lat.toFixed(4));
        origin.searchParams.set("longitude", position.lon.toFixed(4));
        url = origin.toString();
      } catch (_error) {
        // Keep the payload-level origin rather than dropping it
      }
    }
    return {
      kind: "derived",
      label: `Simulated on board · ${weatherProv.label}`,
      url,
      viewerUrl,
      at: weatherProv.at ?? null,
    };
  };
  for (const item of items) {
    if (!item.night && item.hoursFromNow != null) {
      item.night = trackNightAt(item.hoursFromNow, track, baseMs) ?? false;
    }
    // The conditions tab (work doc #18): every item paints the tier
    // at its hour; sail changes keep their own enriched conditions
    // block when the track has none or the item predates it
    if (item.hoursFromNow != null && item.comfortLevel == null) {
      const conditions = trackConditionsAt(item.hoursFromNow, track);
      if (conditions) {
        item.comfortLevel = conditions.comfortLevel;
        item.slatting = conditions.slatting;
      }
    }
    // Night-darkness context (work doc #32): cloud cover at the
    // item's hour — null when the source publishes none
    if (item.hoursFromNow != null && item.cloudCover == null) {
      const conditions = trackConditionsAt(item.hoursFromNow, track);
      if (conditions) {
        item.cloudCover = conditions.cloudCover;
      }
    }
    if (!item.provenance && SIMULATED_KINDS.has(item.kind)) {
      item.provenance = derivedProvenance(item);
    }
  }

  // Energy events (work doc #10): the predictor's own surplus and
  // deficit terms, not an independent derivation — surplus is forecast
  // curtailment (battery full, yield continues), deficit is the
  // outlook status saying the battery keeps going down
  for (const e of payload?.energyEvents ?? []) {
    const deficit = e.type === "deficit";
    push({
      hoursFromNow: relHours(e.timestamp, fetchMs),
      timestamp: e.timestamp ?? null,
      kind: "energy",
      severity: deficit
        ? e.status === "critical"
          ? "severe"
          : "warn"
        : "info",
      label: deficit
        ? e.status === "critical"
          ? "Energy critical"
          : "Energy deficit"
        : "Energy surplus",
      detail: [
        e.netWh != null
          ? `${e.netWh >= 0 ? "+" : "−"}${(Math.abs(e.netWh) / 1000).toFixed(1)} kWh`
          : null,
        e.timestamp != null && e.endTimestamp != null
          ? `until ${fmtUtc(e.endTimestamp)}`
          : null,
        deficit && e.timeToEmpty != null
          ? `battery depleted by ${fmtUtc(e.timeToEmpty)}`
          : null,
        e.type === "surplus" ? "run opportunistic loads" : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }

  // Lines of interest (work doc #1): the traditional ceremonial
  // crossings, riding the timeline as `line` events (the general form
  // the timeline was built for — no separate block)
  for (const l of summary.linesOfInterest ?? []) {
    push({
      hoursFromNow: relHours(l.eta, fetchMs),
      timestamp: l.eta ?? null,
      kind: "line",
      severity: "info",
      label: l.ceremony ? `${l.lineName} — ${l.ceremony}` : l.lineName,
      detail: [
        formatCoord(l.lat, l.lon),
        l.note ?? null,
        l.distanceFromStartNm != null
          ? `${Math.round(l.distanceFromStartNm)} nm from departure`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
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
  // Cloud cover at a night arrival (work doc #32): the ETA hour on
  // the same schedule scale mergeTimeline uses (departure-anchored
  // when an anchor runs, fetch-relative otherwise), read off the
  // track's nearest row — null beyond the simulated horizon
  const track = summary.track ?? [];
  const anchor = summary.departure ?? payload?.departure ?? null;
  const anchorMs =
    anchor?.time != null ? new Date(anchor.time).getTime() : null;
  const fetchMs = payload?.metadata?.fetchedAt
    ? new Date(payload.metadata.fetchedAt).getTime()
    : null;
  const cloudFor = (timestamp) => {
    if (timestamp == null) {
      return null;
    }
    const t = new Date(timestamp).getTime();
    const base = anchorMs ?? fetchMs;
    if (!Number.isFinite(t) || base == null) {
      return null;
    }
    const hours = Math.round(((t - base) / 3600000) * 10) / 10;
    return trackConditionsAt(hours, track)?.cloudCover ?? null;
  };
  const row = (label, timestamp, isNight) => ({
    label,
    stamp: fmtShip(timestamp),
    night: isNight === true,
    // Actual moon phase for night arrivals (work doc #3); null when
    // the payload predates celestialNights — the renderer falls back
    // to the fixed crescent
    moon: isNight === true ? moonGlyphFor(timestamp, payload) : null,
    // Night-darkness context (work doc #32): null when the source
    // publishes no cloud field or the ETA is off the track
    cloud: isNight === true ? cloudFor(timestamp) : null,
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
