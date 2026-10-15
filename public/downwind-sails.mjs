/**
 * Proactive downwind sail recommendations (work doc #41).
 *
 * The blog backtest (work doc #38) showed the crew's downwind
 * light-air days — Parasailor set, sails drawing, following long
 * swell — are champagne, while the same hours on working sails would
 * slat to Rough. This module connects the forecast to the sail
 * inventory: when an hour sits in the slatting regime on a reach or
 * run, the plan's rig is canvas-up, and a configured downwind sail's
 * envelope covers the conditions, recommend deploying it — with the
 * honest gates that keep the recommendation trustworthy.
 *
 * The envelope is honestly bounded (doc #41): under ~2 kn apparent
 * wind a downwind sail will not fill; gusts at or over the sail's
 * configured envelope maximum kill it; squall-risk hours, probable
 * rain squalls and convective air kill it; night kills it by default
 * (most crews are reluctant — configurable); and a two-hour blip is
 * not worth the rigging work, so a qualifying stretch must hold the
 * minimum deployment window before it recommends anything.
 *
 * Pure logic over the simulation's hourly rows, zero dependencies
 * beyond the shared physics — unit-testable.
 *
 * @file downwind-sails.mjs
 */

import {
  rateAcceleration,
  rateApparentWind,
  slattingRisk,
  worseComfort,
} from "./sereno-physics.mjs";

/** Apparent-wind floor below which a downwind sail will not fill. */
export const DOWNWIND_MIN_AWS_KNOTS = 2;

/**
 * TWA magnitude at or beyond which an hour counts as a reach or run:
 * the downwind sail's home turf. Closer to the wind the working
 * canvas is loaded and there is nothing to fix.
 */
export const DOWNWIND_REACH_TWA_DEG = 90;

/**
 * True-wind ceiling when the inventory sets no `maximumWind` for the
 * sail: conservative, and honest about being a default — the crew's
 * own take-down practice (the learned envelope, doc #41 plan step 3)
 * replaces it as logbook data accumulates.
 */
export const DOWNWIND_DEFAULT_MAX_TWS_KNOTS = 25;

/**
 * Minimum qualifying stretch before a deployment is worth the rigging
 * work (doc #41 hassle threshold: a two-hour blip gets a note at
 * most).
 */
export const DOWNWIND_MIN_WINDOW_HOURS = 3;

/**
 * Downwind sail families (work doc #41). Matched case-insensitively
 * against the configured `type` and human `name`. Duplicated from the
 * server-side reader (`plugin/sails-configuration.js`) because the
 * browser cannot import from the plugin tree; the server-classified
 * `downwind` flag wins when the inventory carries it.
 */
const DOWNWIND_FAMILIES = [
  [/PARASAILOR/, "parasailor"],
  [/GENNAKER/, "gennaker"],
  [/CODE\s*Z(ERO)?/, "code zero"],
  [/(ASYM|SPINNAKER)/, "spinnaker"],
];

/**
 * Whether a sail is a downwind sail: the server-classified flag when
 * present, else a name/type match against the known families.
 *
 * @param {{name: string, type: ?string, downwind: ?boolean,
 *   active: ?boolean}} sail
 * @returns {boolean}
 */
export function isDownwindSail(sail) {
  if (!sail || typeof sail.name !== "string") {
    return false;
  }
  if (sail.downwind != null) {
    return sail.downwind === true;
  }
  const hay = `${sail.type ?? ""} ${sail.name}`.toUpperCase();
  return DOWNWIND_FAMILIES.some(([pattern]) => pattern.test(hay));
}

/**
 * Folds a signed TWA in degrees onto the 0..180 magnitude range.
 *
 * @param {number} twaDeg
 * @returns {number}
 */
function twaMagnitude(twaDeg) {
  const folded = Math.abs(((twaDeg % 360) + 360) % 360);
  return folded > 180 ? 360 - folded : folded;
}

/**
 * Why one hour fails the deployment gates, or null when it qualifies.
 * The reason strings double as retract reasons on the segment end, so
 * they read as the thing that ends the sail: `wind envelope exit`,
 * `gust over the envelope`, `squall window`, `probable rain squalls`,
 * `convective air`, `nightfall`, `point of sail`, `bare poles`,
 * `no fill`, `sea state`.
 *
 * @param {object} params
 * @param {object} params.row - One simulation hourly row
 * @param {object} params.sail - Inventory entry (`minimumWindKnots`,
 *   `maximumWindKnots`; the momentary `active` flag is not a gate)
 * @param {object} [params.gates] - Precomputed hour-gate context
 * @param {Set<number>} [params.gates.squallHours] - Squall-risk hours
 * @param {Set<number>} [params.gates.rainHours] - Probable-squall
 *   rain hours
 * @param {Set<number>} [params.gates.convectiveHours] - CAPE/K-index
 *   anomaly hours
 * @param {boolean} [params.gates.nightDeployment] - Whether night
 *   hours may qualify (default false: most crews are reluctant)
 * @param {number} [params.gates.maximumSeaStateM] - Sea-state
 *   ceiling; null until the learned take-down threshold exists
 * @param {number} [params.gates.defaultMaxTwsKnots] - Ceiling when
 *   the inventory sets none
 * @returns {string|null} Failure reason, null when the hour qualifies
 */
export function evaluateDownwindHour({ row, sail, gates = {} }) {
  // Note: the inventory's `active` flag is deliberately not a gate —
  // in sailsconfiguration it means "currently flying right now" (the
  // plugin computes `sails.area.active` from it), not "usable". The
  // stowed Parasailor reads active: false most of the time; recommending
  // its deployment is the whole point.
  // The recommendation rides the plan's canvas-up hours: with bare
  // poles the boat is under engine or adrift, not a sail problem
  if (row.sailState === "NO_SAILS") {
    return "bare poles";
  }
  const twaDeg =
    row.twdDeg != null && row.headingDeg != null
      ? twaMagnitude(row.twdDeg - row.headingDeg)
      : null;
  if (twaDeg == null || twaDeg < DOWNWIND_REACH_TWA_DEG) {
    return "point of sail";
  }
  const tws = row.twsKnots;
  if (!Number.isFinite(tws)) {
    return "no wind data";
  }
  // Apparent-wind fill floor: under ~2 kn AWS the sail hangs limp
  const aws = row.awsKnots;
  if (!Number.isFinite(aws) || aws < DOWNWIND_MIN_AWS_KNOTS) {
    return "no fill";
  }
  // Named forecast events take precedence as retract reasons: they
  // are the forecast's explicit "sail comes down now" markers
  if (gates.squallHours?.has(row.hoursFromNow)) {
    return "squall window";
  }
  if (gates.rainHours?.has(row.hoursFromNow)) {
    return "probable rain squalls";
  }
  if (gates.convectiveHours?.has(row.hoursFromNow)) {
    return "convective air";
  }
  const maxTws =
    sail.maximumWindKnots ??
    gates.defaultMaxTwsKnots ??
    DOWNWIND_DEFAULT_MAX_TWS_KNOTS;
  if (tws > maxTws) {
    return "wind envelope exit";
  }
  const minTws = sail.minimumWindKnots;
  if (minTws != null && tws < minTws) {
    return "wind envelope exit";
  }
  // Forecast gusts against the sail's envelope maximum: only a
  // configured maximum is honest — the default ceiling is a guess,
  // and the squall gate below carries the squally-air case
  if (
    sail.maximumWindKnots != null &&
    Number.isFinite(row.gustKnots) &&
    row.gustKnots > sail.maximumWindKnots
  ) {
    return "gust over the envelope";
  }
  // The slatting regime itself: residual swell with too little wind
  // to keep the working sails loaded. Evaluated with the sail state
  // unknown — the plan's rig reads as "sailing" in the three-way rule
  // and would suppress the very regime this recommendation fixes
  const slatting = slattingRisk({
    hsMeters: row.hsMeters,
    twsKnots: tws,
    twaRad: (twaDeg * Math.PI) / 180,
    sailState: null,
  });
  if (!slatting) {
    return "sails drawing";
  }
  const nightOk = gates.nightDeployment === true;
  if (row.night && !nightOk) {
    return "nightfall";
  }
  const ceiling = gates.maximumSeaStateM;
  if (
    ceiling != null &&
    Number.isFinite(row.hsMeters) &&
    row.hsMeters > ceiling
  ) {
    return "sea state";
  }
  return null;
}

/**
 * The comfort tier the crew would feel with the downwind sail
 * drawing: the row's raw motion acceleration and apparent wind,
 * banded without the slatting penalty. The hourly row's own
 * `comfortLevel` carries the slatting-forced tier when the plan's rig
 * is unknown (the three-way rule's legacy conservative branch), which
 * would make the payoff read "holds rough instead of slatting" —
 * circular. The raw `azMs2` rides the row unbanded, so the with-sail
 * tier recomputes honestly; rows without it fall back to their own
 * tier.
 *
 * @param {object} row - One simulation hourly row
 * @returns {string|null}
 */
function withSailComfort(row) {
  if (!Number.isFinite(row.azMs2) || !Number.isFinite(row.awsKnots)) {
    return row.comfortLevel ?? null;
  }
  return worseComfort(
    rateApparentWind(row.awsKnots),
    rateAcceleration(row.azMs2),
  );
}

/**
 * Builds the proactive deployment recommendations for a simulated
 * passage: contiguous qualifying stretches per downwind sail, held
 * through the minimum deployment window, with the retract boundary
 * and the reason the sail comes down.
 *
 * Overlapping stretches across sails resolve to the longest: when two
 * downwind sails both qualify the plan recommends the one with the
 * longer payoff, not two sails at once.
 *
 * @param {Array<object>} rows - Simulation hourly rows
 * @param {Array<object>} sails - Classified sail inventory
 * @param {object} [options]
 * @param {Set<number>} [options.squallHours]
 * @param {Set<number>} [options.rainHours]
 * @param {Set<number>} [options.convectiveHours]
 * @param {boolean} [options.nightDeployment]
 * @param {number} [options.maximumSeaStateM]
 * @param {number} [options.minimumWindowHours] - Default
 *   {@link DOWNWIND_MIN_WINDOW_HOURS}
 * @param {number} [options.defaultMaxTwsKnots]
 * @returns {Array<object>} `{hoursFromNow, timestamp, sailName,
 *   sailFamily, retractHoursFromNow, retractTimestamp, retractReason,
 *   hoursCount, comfortLevel}` — comfortLevel is the worst tier in
 *   the window (the honest promise), null when rows carry none
 */
export function downwindRecommendations(rows, sails, options = {}) {
  const candidates = (sails ?? []).filter(isDownwindSail);
  if (candidates.length === 0 || !Array.isArray(rows) || rows.length === 0) {
    return [];
  }
  const gates = {
    squallHours: options.squallHours ?? new Set(),
    rainHours: options.rainHours ?? new Set(),
    convectiveHours: options.convectiveHours ?? new Set(),
    nightDeployment: options.nightDeployment === true,
    maximumSeaStateM: options.maximumSeaStateM ?? null,
    defaultMaxTwsKnots: options.defaultMaxTwsKnots,
  };
  const minimumWindowHours =
    options.minimumWindowHours ?? DOWNWIND_MIN_WINDOW_HOURS;

  const segments = [];
  for (const sail of candidates) {
    let start = null;
    const flush = (endIndex) => {
      if (start == null) {
        return;
      }
      const window = rows.slice(start, endIndex);
      const hoursCount = window.length;
      if (hoursCount >= minimumWindowHours) {
        const comfortTiers = window.map(withSailComfort).filter(Boolean);
        segments.push({
          hoursFromNow: window[0].hoursFromNow,
          timestamp: window[0].timestamp ?? null,
          sailName: sail.name,
          sailFamily: sail.sailFamily ?? null,
          retractHoursFromNow:
            endIndex < rows.length ? rows[endIndex].hoursFromNow : null,
          retractTimestamp:
            endIndex < rows.length ? (rows[endIndex].timestamp ?? null) : null,
          retractReason:
            endIndex < rows.length
              ? evaluateDownwindHour({ row: rows[endIndex], sail, gates })
              : null,
          hoursCount,
          comfortLevel:
            comfortTiers.length > 0 ? comfortTiers.reduce(worseComfort) : null,
        });
      }
      start = null;
    };
    for (let i = 0; i < rows.length; i++) {
      const fails = evaluateDownwindHour({ row: rows[i], sail, gates });
      if (fails == null) {
        if (start == null) {
          start = i;
        }
      } else {
        flush(i);
      }
    }
    flush(rows.length);
  }

  // Overlap resolution: longest qualifying stretch wins, earlier
  // start breaks ties
  segments.sort(
    (a, b) => b.hoursCount - a.hoursCount || a.hoursFromNow - b.hoursFromNow,
  );
  const chosen = [];
  for (const segment of segments) {
    const start = segment.hoursFromNow;
    const end = segment.retractHoursFromNow ?? Number.POSITIVE_INFINITY;
    const overlaps = chosen.some((c) => {
      const cStart = c.hoursFromNow;
      const cEnd = c.retractHoursFromNow ?? Number.POSITIVE_INFINITY;
      return start < cEnd && cStart < end;
    });
    if (!overlaps) {
      chosen.push(segment);
    }
  }
  return chosen.sort((a, b) => a.hoursFromNow - b.hoursFromNow);
}
