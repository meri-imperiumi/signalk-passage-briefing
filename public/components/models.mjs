/**
 * Pure view models for the passage briefing webapp: everything the
 * custom elements render, computed from the worker's exception views
 * (SPEC §6.2). Kept free of DOM so Node can test them; the elements
 * stay thin.
 *
 * @module models
 */

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
 * Sail action cards for the tactical dashboard, oldest first.
 *
 * @param {object|null} exceptions
 * @returns {Array<{hoursFromNow: number, stamp: string, sailState: string, night: boolean}>}
 */
export function sailActionCards(exceptions) {
  return (exceptions?.next24h?.sailChanges ?? []).map((e) => ({
    hoursFromNow: e.hoursFromNow,
    stamp: fmtUtc(e.timestamp),
    sailState: e.sailState ?? "?",
    night: Boolean(e.night),
  }));
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
