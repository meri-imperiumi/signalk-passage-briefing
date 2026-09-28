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
 * Formats fuel in gallons with one decimal.
 *
 * @param {number|null|undefined} gallons
 * @returns {string} Empty string when unset/invalid
 */
export function fmtGal(gallons) {
  if (gallons == null || !Number.isFinite(gallons)) {
    return "";
  }
  return `${gallons.toFixed(1)} gal`;
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
    stamp: fmtUtc(step.timestamp),
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
    stamp: fmtUtc(block?.timestamp),
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
 * Sail action cards for the tactical dashboard, oldest first.
 * Maneuver events (work doc #5) carry `maneuver`, `toTack` and the
 * expected TWS so the cards can read "Tack to starboard ~14:20, 12 kt".
 *
 * @param {object|null} exceptions
 * @returns {Array<{hoursFromNow: number, stamp: string, label: string, night: boolean, maneuver: string|null, toTack: string|null, twsKnots: number|null}>}
 */
export function sailActionCards(exceptions) {
  return (exceptions?.next24h?.sailChanges ?? []).map((e) => ({
    hoursFromNow: e.hoursFromNow,
    stamp: fmtUtc(e.timestamp),
    label: sailStateLabel(e.sailState) || "?",
    night: Boolean(e.night),
    maneuver: e.maneuver ?? null,
    toTack: e.toTack ?? null,
    twsKnots: e.twsAtManeuver ?? null,
  }));
}

/**
 * Whole-route sail-work timeline for the strategic outlook (work doc
 * #5): recommendation-driven changes plus tacks/gybes, oldest first.
 *
 * @param {object|null} exceptions
 * @returns {Array<{hoursFromNow: number, stamp: string, label: string, detail: string}>}
 */
export function sailWorkTimeline(exceptions) {
  return (exceptions?.passageSummary?.sailChanges ?? []).map((e) => {
    const state = String(e.sailState ?? "?");
    const [combination, tack] = state.split("@");
    const label = e.maneuver
      ? `${e.maneuver === "tack" ? "Tack" : "Gybe"} to ${e.toTack ?? tack ?? "?"}`
      : sailStateLabel(combination) || state;
    const detail = [
      e.distanceFromStartNm != null
        ? `${Math.round(e.distanceFromStartNm)} nm`
        : null,
      e.twsAtManeuver != null ? fmtKn(e.twsAtManeuver) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      hoursFromNow: e.hoursFromNow,
      stamp: fmtUtc(e.timestamp),
      label,
      detail,
    };
  });
}

/**
 * View model for the strategic ETA table.
 *
 * @param {object|null} exceptions
 * @returns {{rows: Array<{label: string, stamp: string}>, motorHours: string, fuel: string}}
 */
export function etaTable(exceptions) {
  const summary = exceptions?.passageSummary ?? {};
  return {
    rows: [
      { label: "P10", stamp: fmtUtc(summary.etaP10) },
      { label: "P50", stamp: fmtUtc(summary.etaP50) },
      { label: "P90", stamp: fmtUtc(summary.etaP90) },
    ],
    motorHours:
      summary.totalMotorHours != null ? fmtHours(summary.totalMotorHours) : "",
    fuel: summary.totalFuelGal != null ? fmtGal(summary.totalFuelGal) : "",
  };
}
