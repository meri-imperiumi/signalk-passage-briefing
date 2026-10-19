/**
 * Polar performance lookup for the simulation (SPEC §5.1).
 *
 * Consumes the vessel's canonical `polars` resource table — the same
 * contract signalk-polar-management publishes and signalk-polar-tools
 * (dead reckoning, energy predictor) consume:
 *
 *   { kind: 'polarTable',
 *     axes: { tws: [m/s], twa: [rad] },
 *     values: { boatSpeedMatrix: [twsIdx][twaIdx] },
 *     symmetry: { portStarboardSymmetric: true } }
 *
 * Interpolation semantics match the other consumers exactly:
 *
 * - bilinear over the TWS × TWA grid, port/starboard symmetric via
 *   |TWA| when the flag is set;
 * - TWA below the table's closest-winded angle scales linearly toward
 *   zero at head-to-wind; above the last column clamps (dead run);
 * - TWS below the first row scales linearly toward zero at calm; above
 *   the last row clamps (hull speed does not grow with more wind).
 *
 * The worker receives the table (resolved from `polars.activePolar`
 * by the main thread or the plugin's `/api/polar` route) together with
 * the published `polars.performanceFactor`. A missing or malformed
 * table falls back to the built-in default below, so a fresh install
 * still routes sensibly.
 *
 * The simulation runs in knots while the table is SI; conversion
 * happens here, at the boundary.
 *
 * @module polar
 */

/**
 * Knots per m/s.
 */
import { Polar } from "./vendor/polar/polar-math.js";

const MS_TO_KN = 1.943844;

const DEG = Math.PI / 180;

/** The vendored polar engine, prepared once per table object. */
const engineCache = new WeakMap();

const KN_TO_MS = 0.514444;

/**
 * Default fallback polar in the canonical format: a conservative
 * cruising monohull (Lille Ø, 9.4 m waterline). Authored in knots and
 * converted to the table's SI units so the source stays readable.
 */
const FALLBACK_TWS_KN = [4, 6, 8, 10, 12, 15, 20, 25];
const FALLBACK_TWA_DEG = [0, 20, 30, 40, 60, 90, 120, 150, 180];
const FALLBACK_STW_KN = [
  //      0    20   30   40   60   90  120  150  180
  [0, 0.0, 1.5, 2.2, 2.8, 3.0, 2.8, 2.0, 0.0], //   4 kn
  [0, 2.0, 3.0, 3.8, 4.4, 4.6, 4.4, 3.6, 1.5], //   6 kn
  [0, 3.0, 4.2, 5.0, 5.6, 5.8, 5.6, 4.8, 2.5], //   8 kn
  [0, 3.8, 5.0, 5.8, 6.4, 6.6, 6.4, 5.6, 3.2], //  10 kn
  [0, 4.4, 5.6, 6.4, 7.0, 7.2, 7.0, 6.2, 3.8], //  12 kn
  [0, 5.0, 6.2, 7.0, 7.6, 7.8, 7.6, 6.8, 4.4], //  15 kn
  [0, 5.6, 6.8, 7.6, 8.2, 8.4, 8.2, 7.4, 5.0], //  20 kn
  [0, 6.0, 7.0, 7.8, 8.4, 8.5, 8.3, 7.5, 5.2], //  25 kn
];

/**
 * Built-in default polar table (canonical shape, SI units).
 */
export const DEFAULT_POLAR_TABLE = {
  kind: "polarTable",
  schemaVersion: "1.0.0",
  units: { tws: "m/s", twa: "rad", boatSpeed: "m/s" },
  axes: {
    tws: FALLBACK_TWS_KN.map((kn) => kn * KN_TO_MS),
    twa: FALLBACK_TWA_DEG.map((deg) => deg * DEG),
  },
  values: {
    boatSpeedMatrix: FALLBACK_STW_KN.map((row) =>
      row.map((kn) => kn * KN_TO_MS),
    ),
  },
  symmetry: { portStarboardSymmetric: true },
};

/**
 * Extracts the resource id from a `polars.activePolar` value. Accepts
 * the plain delta form (`{href: "/resources/polars/<id>"}`), the
 * `getSelfPath`-wrapped form (`{value: {href: ...}}`), and full API
 * URLs — the same contract as signalk-polar-management consumers.
 *
 * @param {unknown} value - Signal K value of `polars.activePolar`
 * @returns {string|null} Resource id, or null when unset/malformed
 */
export function parseActivePolarId(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const v =
    value.value && typeof value.value === "object" ? value.value : value;
  const href = typeof v.href === "string" ? v.href : null;
  if (!href) {
    return null;
  }
  const match = href.match(/\/resources\/polars\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Reads the `polars.performanceFactor` delta value, clamped to
 * [0, 1] (1 when unset/invalid — polar-management publishes 1 as its
 * default).
 *
 * @param {unknown} value
 * @returns {number}
 */
export function parsePerformanceFactor(value) {
  const v =
    value && typeof value === "object" && typeof value.value === "number"
      ? value.value
      : typeof value === "number"
        ? value
        : null;
  if (v == null || !Number.isFinite(v)) {
    return 1;
  }
  return Math.min(1, Math.max(0, v));
}

/**
 * Validates the shape of a canonical polar table enough for
 * interpolation: ascending non-empty axes and a rectangular matrix
 * matching the axes' dimensions.
 *
 * @param {unknown} table - Candidate polar resource
 * @returns {boolean}
 */
export function isInterpolatableTable(table) {
  if (!table || typeof table !== "object") {
    return false;
  }
  const { axes, values } = table;
  if (!Array.isArray(axes?.tws) || !Array.isArray(axes?.twa)) {
    return false;
  }
  if (axes.tws.length < 1 || axes.twa.length < 1) {
    return false;
  }
  if (!Array.isArray(values?.boatSpeedMatrix)) {
    return false;
  }
  if (values.boatSpeedMatrix.length !== axes.tws.length) {
    return false;
  }
  for (let i = 0; i < axes.tws.length; i++) {
    const row = values.boatSpeedMatrix[i];
    if (!Array.isArray(row) || row.length !== axes.twa.length) {
      return false;
    }
    for (let j = 0; j < axes.twa.length; j++) {
      if (typeof row[j] !== "number" || !Number.isFinite(row[j])) {
        return false;
      }
    }
    if (i > 0 && !(axes.tws[i] > axes.tws[i - 1])) {
      return false;
    }
  }
  for (let j = 1; j < axes.twa.length; j++) {
    if (!(axes.twa[j] > axes.twa[j - 1])) {
      return false;
    }
  }
  return true;
}

/**
 * The prepared polar lookup: the vendored polar-math engine (PCHIP
 * over observed cells, modeled pinch/in-irons, run extrapolation —
 * work doc #25) behind the knots boundary. Constructed once per
 * table and cached — `prepareEntries` runs once, the simulation
 * queries it per step.
 *
 * A malformed table falls back to {@link DEFAULT_POLAR_TABLE}'s
 * engine: the same fallback a missing polar gets, rather than sailing
 * on nothing.
 *
 * @param {object|null} table - Canonical polar resource (or null)
 * @returns {{speedAt: (twsKnots: number, twaRad: number,
 *   performanceFactor?: number) => {speedKnots: number|null,
 *   state: string|null}, beatAt: (twsKnots: number,
 *   performanceFactor?: number) => {twaRad: number, speedKnots:
 *   number, vmgKnots: number}|null}}
 */
export function polarEngine(table) {
  const source = table ?? DEFAULT_POLAR_TABLE;
  let engine = engineCache.get(source);
  if (engine !== undefined) {
    return engine;
  }
  let polar;
  try {
    polar = Polar.fromTable(source);
  } catch {
    polar = Polar.fromTable(DEFAULT_POLAR_TABLE);
  }
  const normalizeAngle = (twa) => Math.atan2(Math.sin(twa), Math.cos(twa));
  engine = {
    /**
     * Speed through water on a course, knots — `null` when the course
     * sits below the modeled pinch boundary (in irons): the boat
     * cannot sail there, and the caller decides tack or motor (work
     * doc #49). `state` is the vendored query's TWA state
     * (`in_range` | `pinching` | `in_irons` | `extrapolated` |
     * `below_range` | `above_range`).
     */
    speedAt(twsKnots, twaRad, performanceFactor = 1) {
      const pf = Math.min(1, Math.max(0, performanceFactor));
      const result = polar.speedAt({
        tws: twsKnots / MS_TO_KN,
        twa: normalizeAngle(twaRad),
        performanceFactor: pf,
      });
      return {
        speedKnots: result.value == null ? null : result.value * MS_TO_KN,
        state: result.state?.twa ?? null,
      };
    },
    /**
     * The row's beat target — the best upwind angle and speed the
     * crew's own data supports, with the VMG a tacking beat makes
     * good toward a course too close to the wind. `null` when the
     * row has no observed upwind data to derive one from.
     */
    beatAt(twsKnots, performanceFactor = 1) {
      const pf = Math.min(1, Math.max(0, performanceFactor));
      const result = polar.targetsAt({
        tws: twsKnots / MS_TO_KN,
        performanceFactor: pf,
      });
      const beat = result.value?.beat;
      if (
        beat == null ||
        !Number.isFinite(beat.twa) ||
        !Number.isFinite(beat.speed) ||
        !Number.isFinite(beat.vmg)
      ) {
        return null;
      }
      return {
        twaRad: beat.twa,
        speedKnots: beat.speed * MS_TO_KN,
        vmgKnots: beat.vmg * MS_TO_KN,
      };
    },
  };
  engineCache.set(source, engine);
  return engine;
}

/**
 * Great-circle initial bearing from one position to another.
 *
 * @param {number} lat1 - Degrees
 * @param {number} lon1 - Degrees
 * @param {number} lat2 - Degrees
 * @param {number} lon2 - Degrees
 * @returns {number} Bearing (radians, true)
 */
export function bearingRad(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * DEG;
  const φ2 = lat2 * DEG;
  const dλ = (lon2 - lon1) * DEG;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return Math.atan2(y, x);
}
