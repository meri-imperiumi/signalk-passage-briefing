/**
 * Tack & gybe detection over the simulated passage track (work doc
 * #5). A tack is the sail-state transition across the eye of the
 * wind (signed TWA through 0°), a gybe the transition as the wind
 * passes the stern (through ±180°). Detected crossings are returned
 * as sail events in the §6.2 shape with a maneuver annotation, so
 * they ride the existing sail-change displays.
 *
 * Pure and DOM-free: imported by `route-sim.mjs` (worker) and
 * unit-testable in Node.
 *
 * Conventions: headings and wind directions are degrees true, wind
 * direction is where the wind blows FROM; signed TWA is normalized
 * to (−180°, 180°], positive meaning wind from the starboard side
 * (starboard tack).
 *
 * @file tack-gybe.js
 */

/**
 * Crossings where either side's |TWA| sits below this margin are
 * rejected as wind wobble around the planned course.
 */
export const MIN_TWA_MARGIN_DEG = 25;

/**
 * SOG above which a step counts as sailing (mirrors the simulation's
 * arrival threshold); drift-mode steps sit at zero.
 */
const SAILING_SOG_KNOTS = 0.05;

/**
 * Normalizes an angle to (−180°, 180°].
 *
 * @param {number} deg
 * @returns {number}
 */
export function wrap180(deg) {
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/**
 * Tack side for a signed TWA: positive means the wind blows from
 * the starboard side, so the boat is on the starboard tack.
 *
 * @param {number} signedTwaDeg
 * @returns {"port"|"starboard"}
 */
export function tackSide(signedTwaDeg) {
  return signedTwaDeg >= 0 ? "starboard" : "port";
}

/**
 * Whether a simulation hour is a sailing step: not motoring, actually
 * making way (drift-mode hours sit at SOG 0) and the plan's rig up —
 * with canvas down there is nothing to tack or gybe (work doc #5
 * session feedback: the engine turns the boat, the current carries
 * it, neither is a maneuver).
 *
 * @param {object} row - Hourly simulation row
 * @returns {boolean}
 */
function isSailing(row) {
  return (
    !row.motoring &&
    (row.sogKnots ?? 0) > SAILING_SOG_KNOTS &&
    row.sailState !== "NO_SAILS"
  );
}

/**
 * Signed TWA of one simulation row, or null when the row carries no
 * usable wind/heading pair.
 *
 * @param {object} row
 * @returns {number|null}
 */
function signedTwa(row) {
  if (typeof row.headingDeg !== "number" || typeof row.twdDeg !== "number") {
    return null;
  }
  return wrap180(row.twdDeg - row.headingDeg);
}

/**
 * Linear interpolation fraction of the signed-TWA path from `a` to
 * `b` (both wrapped, `d` = wrap180(b − a)) at the crossing value.
 *
 * @param {number} a - Start signed TWA
 * @param {number} crossing - Crossing value (0 for tacks, ±180 for gybes)
 * @param {number} d - Wrapped step from a to b
 * @returns {number} Fraction 0..1
 */
function crossingFraction(a, crossing, d) {
  if (Math.abs(d) < 1e-9) {
    return 0;
  }
  return Math.min(1, Math.max(0, (crossing - a) / d));
}

/**
 * Detects tacks and gybes along the hourly simulation rows.
 *
 * @param {Array<object>} hourly - Simulation hourly rows (need
 *   timestamp, hoursFromNow, lat, lon, headingDeg, twdDeg, twsKnots,
 *   sogKnots, distanceFromStartNm, sailState, motoring)
 * @param {object} [options]
 * @param {number} [options.minTwaMarginDeg] - Reject crossings where
 *   either side's |TWA| is below this (wind wobble guard)
 * @returns {Array<object>} Maneuver sail events, time-sorted
 */
export function detectManeuvers(
  hourly,
  { minTwaMarginDeg = MIN_TWA_MARGIN_DEG } = {},
) {
  const rows = (hourly ?? []).filter(isSailing);
  // Anchors: sailing steps with an established wind side (|TWA| above
  // the margin). A crossing counts only when the established side
  // flips between anchors — wind wobble that stays on one side never
  // fabricates a maneuver, while a genuine veer spread across a
  // low-wind-angle hour still lands its tack.
  const anchors = [];
  for (const r of rows) {
    const twa = signedTwa(r);
    if (twa != null && Math.abs(twa) >= minTwaMarginDeg) {
      anchors.push({ row: r, twa });
    }
  }
  const events = [];
  for (let i = 1; i < anchors.length; i++) {
    const { row: a, twa: twaA } = anchors[i - 1];
    const { row: b, twa: twaB } = anchors[i];
    const sideA = tackSide(twaA);
    const sideB = tackSide(twaB);
    if (sideA === sideB) {
      continue; // No crossing of the boat's wind line
    }
    let maneuver;
    let crossing;
    if (Math.abs(twaA) < 90 && Math.abs(twaB) < 90) {
      maneuver = "tack";
      crossing = 0;
    } else if (Math.abs(twaA) > 90 && Math.abs(twaB) > 90) {
      maneuver = "gybe";
      // The path wraps through +180 going positive, −180 negative
      crossing = wrap180(twaB - twaA) >= 0 ? 180 : -180;
    } else {
      continue; // One side on each beam: no clean classification
    }
    const d = wrap180(twaB - twaA);
    const f = crossingFraction(twaA, crossing, d);
    const lerp = (x, y) => x + (y - x) * f;
    const timeA = new Date(a.timestamp).getTime();
    const timeB = new Date(b.timestamp).getTime();
    const stamp =
      Number.isFinite(timeA) && Number.isFinite(timeB)
        ? new Date(lerp(timeA, timeB)).toISOString()
        : (b.timestamp ?? null);
    const state = b.sailState ?? a.sailState ?? null;
    events.push({
      hoursFromNow:
        Math.round(lerp(a.hoursFromNow ?? 0, b.hoursFromNow ?? 0) * 10) / 10,
      timestamp: stamp,
      eta: stamp,
      sailState: state != null ? `${state}@${sideB}` : `@${sideB}`,
      maneuver,
      fromTack: sideA,
      toTack: sideB,
      lat: lerp(a.lat, b.lat),
      lon: lerp(a.lon, b.lon),
      distanceFromStartNm:
        Math.round(
          lerp(a.distanceFromStartNm ?? 0, b.distanceFromStartNm ?? 0) * 10,
        ) / 10,
      twsAtManeuver: b.twsKnots ?? a.twsKnots ?? null,
    });
  }
  return events.sort((x, y) => x.hoursFromNow - y.hoursFromNow);
}
