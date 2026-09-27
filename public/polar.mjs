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
const MS_TO_KN = 1.943844;

const DEG = Math.PI / 180;

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
 * First index whose axis value is >= target.
 *
 * @param {number[]} axis - Ascending axis values
 * @param {number} target
 * @returns {number} Index in [0, axis.length]
 */
function upperIndex(axis, target) {
  let lo = 0;
  let hi = axis.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (axis[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Plain bilinear interpolation inside the grid bounds.
 *
 * @param {object} table - Validated canonical table
 * @param {number} twsMs - Clamped TWS (m/s)
 * @param {number} twaRad - Clamped TWA (rad, ≥ 0 with symmetry)
 * @returns {number} Boat speed (m/s)
 */
function bilinear(table, twsMs, twaRad) {
  const { tws, twa } = table.axes;
  const matrix = table.values.boatSpeedMatrix;
  const i = upperIndex(tws, twsMs);
  const j = upperIndex(twa, twaRad);
  const i0 = Math.max(0, i - 1);
  const j0 = Math.max(0, j - 1);
  const i1 = Math.min(tws.length - 1, i0 + 1);
  const j1 = Math.min(twa.length - 1, j0 + 1);

  const tw = tws[i1] > tws[i0] ? (twsMs - tws[i0]) / (tws[i1] - tws[i0]) : 0;
  const ta = twa[j1] > twa[j0] ? (twaRad - twa[j0]) / (twa[j1] - twa[j0]) : 0;

  const s00 = matrix[i0][j0];
  const s01 = matrix[i0][j1];
  const s10 = matrix[i1][j0];
  const s11 = matrix[i1][j1];
  return (
    s00 * (1 - tw) * (1 - ta) +
    s01 * (1 - tw) * ta +
    s10 * tw * (1 - ta) +
    s11 * tw * ta
  );
}

/**
 * Boat speed through water from a polar table at given conditions,
 * in knots. Out-of-grid and unit handling per the module docs; a null
 * table falls back to {@link DEFAULT_POLAR_TABLE}, a malformed table
 * yields 0 (the boat then drifts rather than sailing on fiction).
 *
 * @param {object|null} table - Canonical polar resource (or null)
 * @param {number} twsKnots - True wind speed (kn)
 * @param {number} twaRad - True wind angle (rad, signed ok)
 * @param {object} [options]
 * @param {number} [options.performanceFactor=1] - Derating
 *   multiplier from `polars.performanceFactor`, clamped to [0, 1]
 * @returns {number} Speed through water (kn)
 */
export function polarSpeedKnots(
  table,
  twsKnots,
  twaRad,
  { performanceFactor = 1 } = {},
) {
  const active = table ?? DEFAULT_POLAR_TABLE;
  if (!isInterpolatableTable(active)) {
    return 0;
  }
  if (!Number.isFinite(twsKnots) || !Number.isFinite(twaRad) || twsKnots <= 0) {
    return 0;
  }
  const pf = Number.isFinite(performanceFactor)
    ? Math.min(1, Math.max(0, performanceFactor))
    : 1;

  const symmetric = active.symmetry?.portStarboardSymmetric !== false;
  let twa = symmetric ? Math.abs(twaRad) : twaRad;

  // TWS axis: below the table scales toward zero at calm, above clamps
  let twsScale = 1;
  let twsMs = twsKnots / MS_TO_KN;
  const twsAxis = active.axes.tws;
  if (twsMs < twsAxis[0]) {
    twsScale = twsMs / twsAxis[0];
    twsMs = twsAxis[0];
  } else if (twsMs > twsAxis[twsAxis.length - 1]) {
    twsMs = twsAxis[twsAxis.length - 1];
  }

  // TWA axis: pinch below the closest-winded angle, clamp on the run
  let twaScale = 1;
  const twaAxis = active.axes.twa;
  if (twa < 0) {
    twa = 0;
  }
  if (twa < twaAxis[0]) {
    twaScale = twaAxis[0] > 0 ? twa / twaAxis[0] : 0;
    twa = twaAxis[0];
  } else if (twa > twaAxis[twaAxis.length - 1]) {
    twa = twaAxis[twaAxis.length - 1];
  }

  const speedMs = bilinear(active, twsMs, twa);
  return Math.max(0, speedMs * twsScale * twaScale * pf * MS_TO_KN);
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
