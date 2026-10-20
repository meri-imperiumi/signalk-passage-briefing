/**
 * Pure-JavaScript port of the gribreader front-detector (work doc
 * #50): automatic synoptic fronts, troughs and pressure centres from
 * a multi-step GRIB forecast, tracked through the forecast steps and
 * tested for crossings of a (moving) position.
 *
 * The reference implementation lives in `front-detector/` (Rust);
 * this port is verified against its golden test vectors — copied
 * verbatim into `tests/fixtures/fronts/` — real forecast slices with
 * the exact
 * output the Rust code gives for them. The method: Gaussian-smoothed
 * mean sea-level pressure gives pressure troughs (Hessian curvature
 * inside cyclonic flow) and highs/lows; 850 hPa temperature and wind
 * type the fronts with the thermal front parameter (Renard & Clarke
 * 1965, Hewson 1998); a trough on the cold side of a thermal zone
 * places the front where a forecaster would draw it; matching lines
 * across steps builds tracks; a track passing from south to north of
 * the boat's scheduled position is a front passage.
 *
 * This is an automatic analysis, not a forecaster's chart: it finds
 * roughly half of the fronts a forecaster draws and over-draws warm
 * and stationary fronts. Consumers must attach the CAVEAT and treat
 * passages as informational, never as hazard alerts.
 *
 * Faithfulness notes (Rust → JavaScript traps, see porting/README):
 * rounding is half-away-from-zero (`Math.round` is half-up),
 * Euclidean remainders stay non-negative, `join` iterates its node
 * table in sorted key order like Rust's `BTreeMap`, minimums keep
 * the first of ties, and GRIB values are f32 — inputs are rounded
 * through `Math.fround` so both implementations see the same bits.
 *
 * @file fronts-detect.js
 */

/**
 * Earth radius in km (the reference implementation's constant).
 */
const R = 6371.0;

/**
 * Kilometres per degree of latitude.
 */
const KM_DEG = (R * Math.PI) / 180.0;

/**
 * Distance the cross-front wind is sampled at, on the cold side of
 * a trough or front line.
 */
const WIND_OFFSET_KM = 150.0;

/**
 * Mean wind shift across a trough that marks it as a front.
 */
const FRONT_SHIFT_DEG = 60.0;

/**
 * A thermal line marks the warm edge of a zone whose front a trough
 * locates, up to this far ahead.
 */
const ZONE_KM = 400.0;

/**
 * The automatic-analysis caveat every consumer must carry.
 */
const CAVEAT =
  "An automatic analysis from 850 hPa temperature and wind (thermal front parameter) and from pressure, not a forecaster's chart. Occluded fronts are shown as cold or warm.";

/**
 * Detection thresholds, the reference implementation's defaults.
 *
 * @type {{smooth_km: number, tfp_min: number, gradient_min: number,
 *   front_speed_ms: number, min_front_km: number, trough_curvature:
 *   number, trough_vorticity: number, min_trough_km: number,
 *   centre_radius_km: number, centre_prominence_hpa: number}}
 */
const DEFAULT_PARAMS = {
  smooth_km: 150.0,
  tfp_min: 0.4,
  gradient_min: 0.5,
  front_speed_ms: 2.5,
  min_front_km: 500.0,
  trough_curvature: 0.2,
  trough_vorticity: 2e-5,
  min_trough_km: 300.0,
  centre_radius_km: 500.0,
  centre_prominence_hpa: 2.0,
};

/**
 * Tracking thresholds, the reference implementation's defaults.
 *
 * @type {{max_speed_ms: number, min_km: number, max_gap_steps:
 *   number, min_life_h: number, piece_window_h: number}}
 */
const DEFAULT_TRACK_PARAMS = {
  max_speed_ms: 20.0,
  min_km: 150.0,
  max_gap_steps: 1,
  min_life_h: 12.0,
  piece_window_h: 6.0,
};

/**
 * Track kinds whose passages count for a Southern Hemisphere boat.
 */
const CROSSING_KINDS = ["cold", "front", "trough", "stationary"];

/**
 * Rounds half away from zero, like Rust's `f64::round`
 * (`Math.round` rounds half towards +∞).
 *
 * @param {number} x
 * @returns {number}
 */
function roundHalfAway(x) {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * Output rounding: `round(x, scale)` = round(x·scale)/scale.
 *
 * @param {number} x
 * @param {number} scale
 * @returns {number}
 */
function round(x, scale) {
  return roundHalfAway(x * scale) / scale;
}

/**
 * Non-negative remainder, like Rust's `rem_euclid`: plain fmod for
 * non-negative results (exact — no redundant add/subtract), one
 * addition for negatives.
 *
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function remEuclid(a, b) {
  const r = a % b;
  return r < 0 ? r + Math.abs(b) : r;
}

/**
 * Linear interpolation of two [lon, lat] points.
 *
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @param {number} t
 * @returns {[number, number]}
 */
function lerp(a, b, t) {
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/**
 * The four cell corners starting at (row j, col i): NW, NE, SE, SW.
 *
 * @param {Float64Array|number[]} values
 * @param {number} width
 * @param {number} k
 * @returns {[number, number, number, number]}
 */
function corners(values, width, k) {
  return [values[k], values[k + 1], values[k + width + 1], values[k + width]];
}

/**
 * Bilinear interpolation inside a unit cell, skipping missing
 * corners (weights at zero contribute nothing).
 *
 * @param {[number, number, number, number]} v - NW, NE, SE, SW
 * @param {number} x - 0 west, 1 east
 * @param {number} y - 0 north, 1 south
 * @returns {number}
 */
function bilinear(v, x, y) {
  const weights = [(1.0 - x) * (1.0 - y), x * (1.0 - y), x * y, (1.0 - x) * y];
  let sum = 0.0;
  for (let i = 0; i < 4; i++) {
    if (weights[i] > 1e-12) {
      sum += v[i] * weights[i];
    }
  }
  return sum;
}

/**
 * Great-circle distance in km.
 *
 * @param {[number, number]} a - [lon, lat]
 * @param {[number, number]} b
 * @returns {number}
 */
function distance(a, b) {
  const h =
    Math.sin(((b[1] - a[1]) * Math.PI) / 360.0) ** 2 +
    Math.cos((a[1] * Math.PI) / 180.0) *
      Math.cos((b[1] * Math.PI) / 180.0) *
      Math.sin(((b[0] - a[0]) * Math.PI) / 360.0) ** 2;
  return 2.0 * R * Math.asin(Math.sqrt(Math.min(Math.max(h, 0.0), 1.0)));
}

/**
 * One decoded GRIB field on a regular lat-lon grid. The first row is
 * the northernmost latitude; longitude rises by dlon per column and
 * may run past 180 so lines stay continuous across the date line.
 *
 * @typedef {object} Field
 * @property {{lat0: number, lon0: number, dlat: number, dlon: number,
 *   nlat: number, nlon: number, isGlobalLon: boolean}} grid
 * @property {Float64Array} values - Row-major, NaN for missing data
 */

/**
 * Bilinear interpolation of one field at a position, skipping
 * missing corners; NaN outside the grid.
 *
 * @param {Field} f
 * @param {number} lat
 * @param {number} lon
 * @returns {number}
 */
function spatial(f, lat, lon) {
  const g = f.grid;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NaN;
  }
  const y = (g.lat0 - lat) / g.dlat;
  if (y < -1e-9 || y > g.nlat - 1 + 1e-9) {
    return NaN;
  }
  const j0 = Math.trunc(Math.min(Math.max(Math.floor(y), 0), g.nlat - 1));
  const j1 = Math.min(j0 + 1, g.nlat - 1);
  const fy = j0 === j1 ? 0.0 : Math.min(Math.max(y - j0, 0.0), 1.0);
  // Accept any equivalent longitude representation.
  const x = remEuclid(lon - g.lon0, 360.0) / g.dlon;
  if (!g.isGlobalLon && x > g.nlon - 1 + 1e-9) {
    return NaN;
  }
  const i0 = Math.trunc(Math.min(Math.floor(x), g.nlon - 1));
  const i1 = g.isGlobalLon ? (i0 + 1) % g.nlon : Math.min(i0 + 1, g.nlon - 1);
  const fx = i0 === i1 ? 0.0 : Math.min(Math.max(x - i0, 0.0), 1.0);
  const v = [
    f.values[j0 * g.nlon + i0],
    f.values[j0 * g.nlon + i1],
    f.values[j1 * g.nlon + i0],
    f.values[j1 * g.nlon + i1],
  ];
  const weights = [
    (1.0 - fy) * (1.0 - fx),
    (1.0 - fy) * fx,
    fy * (1.0 - fx),
    fy * fx,
  ];
  let sum = 0.0;
  let weight = 0.0;
  for (let i = 0; i < 4; i++) {
    if (Number.isFinite(v[i]) && weights[i] > 0.0) {
      sum += v[i] * weights[i];
      weight += weights[i];
    }
  }
  // The reference stores fields as f32; interpolation rounds likewise.
  return weight > 0.0 ? Math.fround(sum / weight) : NaN;
}

/**
 * Gaussian kernel sampled every `step` km, value 1/2 at `half` km
 * (half-width at half-maximum), cut at three sigma and at `max`
 * samples.
 *
 * @param {number} step
 * @param {number} half
 * @param {number} max
 * @returns {number[]}
 */
function kernel(step, half, max) {
  const radius = Math.max(
    0,
    Math.ceil((3.0 * half) / Math.sqrt(2.0 * Math.LN2) / step),
  );
  const out = [];
  for (let i = 0; i <= Math.min(radius, max); i++) {
    out.push(Math.exp(-Math.LN2 * ((i * step) / half) ** 2));
  }
  return out;
}

/**
 * Separable Gaussian smoothing in kilometres, so the kernel covers
 * the same ground at every latitude. A missing cell stays missing;
 * neighbours never fill it in.
 *
 * @param {number[]} values
 * @param {{lat0: number, dlat: number, lon0: number, dlon: number,
 *   nlat: number, nlon: number}} g
 * @param {number} half - Half-width at half-maximum, km
 * @returns {number[]}
 */
function smooth(values, g, half) {
  const tmp = new Array(values.length).fill(NaN);
  const out = new Array(values.length).fill(NaN);
  const vertical = kernel(g.dlat * KM_DEG, half, g.nlat - 1);
  const average = (vals, k, stride, pos, size, weights) => {
    // Keep source gaps missing.
    if (!Number.isFinite(vals[k])) {
      return NaN;
    }
    let sum = 0.0;
    let weight = 0.0;
    for (
      let offset = -(weights.length - 1);
      offset <= weights.length - 1;
      offset++
    ) {
      const index = pos + offset;
      if (index < 0 || index >= size) {
        continue;
      }
      const v = vals[k + offset * stride];
      if (Number.isFinite(v)) {
        const w = weights[Math.abs(offset)];
        sum += w * v;
        weight += w;
      }
    }
    return sum / weight;
  };
  for (let j = 0; j < g.nlat; j++) {
    for (let i = 0; i < g.nlon; i++) {
      const k = j * g.nlon + i;
      tmp[k] = average(values, k, g.nlon, j, g.nlat, vertical);
    }
  }
  for (let j = 0; j < g.nlat; j++) {
    const dx =
      g.dlon *
      KM_DEG *
      Math.max(Math.cos(((g.lat0 - j * g.dlat) * Math.PI) / 180.0), 0.01);
    const horizontal = kernel(dx, half, g.nlon - 1);
    for (let i = 0; i < g.nlon; i++) {
      const k = j * g.nlon + i;
      out[k] = average(tmp, k, 1, i, g.nlon, horizontal);
    }
  }
  return out;
}

/**
 * Longitudinal span of a bounding box, date-line safe.
 *
 * @param {{west: number, east: number}} b
 * @returns {number}
 */
function span(b) {
  if (b.east - b.west === 360.0) {
    return 360.0;
  }
  return remEuclid(b.east - b.west, 360.0);
}

/**
 * Formats a Unix timestamp like the reference implementation:
 * `2026-10-06T18:00:00Z`, no milliseconds.
 *
 * @param {number} t - Unix seconds
 * @returns {string}
 */
function timestamp(t) {
  return new Date(t * 1000).toISOString().replace(".000Z", "Z");
}

/**
 * Signs a cell's eigenvector corners so neighbours agree, visiting
 * SW last: non-orientable cells (which surround a degenerate
 * eigenvector) return null and the contour skips them.
 *
 * @param {[number, number, number, number]} east
 * @param {[number, number, number, number]} north
 * @returns {[number, number, number, number]|null}
 */
function orientation(east, north) {
  for (let i = 0; i < 4; i++) {
    if (!Number.isFinite(east[i]) || !Number.isFinite(north[i])) {
      return null;
    }
  }
  const dot = (a, b) => east[a] * east[b] + north[a] * north[b];
  const signs = [1.0, 1.0, 1.0, 1.0];
  for (const [at, neighbour] of [
    [0, 3],
    [2, 3],
    [1, Math.abs(dot(1, 0)) >= Math.abs(dot(1, 2)) ? 0 : 2],
  ]) {
    if (dot(at, neighbour) * signs[neighbour] < 0.0) {
      signs[at] = -1.0;
    }
  }
  for (let i = 0; i < 4; i++) {
    if (dot(i, (i + 1) % 4) * signs[i] * signs[(i + 1) % 4] < -1e-12) {
      return null;
    }
  }
  return signs;
}

/**
 * Marching squares for one cell of corner values (NW, NE, SE, SW),
 * returning zero-contour segments in cell-local coordinates.
 * Ambiguous saddles use the sign of the diagonal products.
 *
 * @param {[number, number, number, number]} v
 * @returns {Array<[[number, number], [number, number]]>}
 */
function marching(v) {
  const vertices = [
    [0.0, 0.0],
    [1.0, 0.0],
    [1.0, 1.0],
    [0.0, 1.0],
  ];
  const hits = [];
  for (let e = 0; e < 4; e++) {
    const n = (e + 1) % 4;
    if (v[e] >= 0.0 !== v[n] >= 0.0) {
      hits.push(lerp(vertices[e], vertices[n], v[e] / (v[e] - v[n])));
    }
  }
  if (hits.length === 2) {
    return [[hits[0], hits[1]]];
  }
  if (hits.length === 4) {
    if (v[0] * v[2] - v[1] * v[3] >= 0.0) {
      return [
        [hits[0], hits[1]],
        [hits[2], hits[3]],
      ];
    }
    return [
      [hits[0], hits[3]],
      [hits[1], hits[2]],
    ];
  }
  return [];
}

/**
 * Roots of the bilinear field along a straight contour segment: a
 * mask boundary inside the cell cuts the segment there, so a mask
 * never creates a spurious contour connection.
 *
 * @param {[number, number, number, number]} v
 * @param {[number, number]} a - Segment start in cell coordinates
 * @param {[number, number]} b - Segment end
 * @param {number} threshold
 * @param {number[]} cuts - Mutated: roots inside (0, 1) are pushed
 */
function maskRoots(v, a, b, threshold, cuts) {
  const c = bilinear(v, a[0], a[1]) - threshold;
  const end = bilinear(v, b[0], b[1]) - threshold;
  const m = lerp(a, b, 0.5);
  const mid = bilinear(v, m[0], m[1]) - threshold;
  const aa = 2.0 * (end + c - 2.0 * mid);
  const bb = end - c - aa;
  const push = (t) => {
    if (t > 0.0 && t < 1.0) {
      cuts.push(t);
    }
  };
  if (Math.abs(aa) < 1e-14) {
    if (Math.abs(bb) > 1e-14) {
      push(-c / bb);
    }
  } else {
    const d = bb * bb - 4.0 * aa * c;
    if (d >= 0.0) {
      push((-bb - Math.sqrt(d)) / (2.0 * aa));
      push((-bb + Math.sqrt(d)) / (2.0 * aa));
    }
  }
}

/**
 * Clips a segment to the area box, date-line safe. Null when the
 * segment lies fully outside.
 *
 * @param {[number, number]} a - [lon, lat]
 * @param {[number, number]} b
 * @param {{south: number, north: number, west: number, east: number}} area
 * @returns {[[number, number], [number, number]]|null}
 */
function clipArea(a, b, area) {
  let lo = 0.0;
  let hi = 1.0;
  for (const [axis, min, max] of [
    [0, area.west, area.west + span(area)],
    [1, area.south, area.north],
  ]) {
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < 1e-12) {
      if (a[axis] < min || a[axis] > max) {
        return null;
      }
    } else {
      const t0 = (min - a[axis]) / delta;
      const t1 = (max - a[axis]) / delta;
      lo = Math.max(lo, Math.min(t0, t1));
      hi = Math.min(hi, Math.max(t0, t1));
    }
  }
  if (hi - lo <= 1e-10) {
    return null;
  }
  return [lerp(a, b, lo), lerp(a, b, hi)];
}

/**
 * Joins contour segments into polylines, matching the reference's
 * `BTreeMap` ordering: nodes iterate in sorted (lon key, lat key)
 * order, which decides which lines come out first and which end
 * they start from. Branch points never connect arbitrarily — open
 * lines trace first, then closed loops.
 *
 * @param {Array<[[number, number], [number, number]]>} segments
 * @returns {Array<[number, number][]>}
 */
function join(segments) {
  const key = (p) =>
    `${roundHalfAway(p[0] * 1e8)},${roundHalfAway(p[1] * 1e8)}`;
  const nodes = new Map();
  const edges = [];
  const unique = new Set();
  for (const [a, b] of segments) {
    const ka = key(a);
    const kb = key(b);
    if (ka === kb || unique.has(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`)) {
      continue;
    }
    unique.add(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);
    const id = edges.length;
    edges.push([ka, kb]);
    if (!nodes.has(ka)) {
      nodes.set(ka, { point: a, edges: [] });
    }
    if (!nodes.has(kb)) {
      nodes.set(kb, { point: b, edges: [] });
    }
    nodes.get(ka).edges.push(id);
    nodes.get(kb).edges.push(id);
  }
  // Sorted key order, like the reference's BTreeMap/BTreeSet walks.
  const sortedKeys = [...nodes.keys()].sort((x, y) => {
    const [x0, x1] = x.split(",").map(Number);
    const [y0, y1] = y.split(",").map(Number);
    return x0 - y0 || x1 - y1;
  });
  const used = new Array(edges.length).fill(false);
  const out = [];
  const starts = sortedKeys
    .filter((k) => nodes.get(k).edges.length !== 2)
    .concat(sortedKeys);
  for (const start of starts) {
    for (const edge of nodes.get(start).edges) {
      if (used[edge]) {
        continue;
      }
      const line = [nodes.get(start).point];
      let at = start;
      let next = edge;
      for (;;) {
        used[next] = true;
        const [a, b] = edges[next];
        at = at === a ? b : a;
        line.push(nodes.get(at).point);
        if (at === start || nodes.get(at).edges.length !== 2) {
          break;
        }
        const id = nodes.get(at).edges.find((i) => !used[i]);
        if (id === undefined) {
          break;
        }
        next = id;
      }
      out.push(line);
    }
  }
  return out;
}

/**
 * Traces the zero contour of `values` inside the masks, clipped to
 * the bilinearly interpolated mask and the area box, then joined
 * into polylines. Eigenvector sign alignment applies when `axes`
 * carries the (east, north) component fields.
 *
 * @param {{lat0: number, lon0: number, dlat: number, dlon: number,
 *   nlat: number, nlon: number}} grid
 * @param {{south: number, north: number, west: number, east: number}} b
 * @param {number[]} values - The contour's zero field
 * @param {Array<[number[], number]>} masks - [field, threshold]
 * @param {[number[], number[]]|null} axes - Eigenvector components
 * @returns {Array<[number, number][]>}
 */
function contours(grid, b, values, masks, axes) {
  const segments = [];
  for (let j = 1; j < grid.nlat - 2; j++) {
    for (let i = 1; i < grid.nlon - 2; i++) {
      const lon = grid.lon0 + i * grid.dlon;
      const lat = grid.lat0 - j * grid.dlat;
      if (
        lon > b.west + span(b) ||
        lon + grid.dlon < b.west ||
        lat < b.south ||
        lat - grid.dlat > b.north
      ) {
        continue;
      }
      const k = j * grid.nlon + i;
      const cellValues = corners(values, grid.nlon, k);
      if (!cellValues.every((v) => Number.isFinite(v))) {
        continue;
      }
      // A scan can carry a sign seam from an eigenvalue degeneracy
      // outside the mask; align both west and south neighbours in
      // this cell before contouring.
      let signs = null;
      if (axes) {
        signs = orientation(
          corners(axes[0], grid.nlon, k),
          corners(axes[1], grid.nlon, k),
        );
        if (signs === null) {
          continue;
        }
        for (let c = 0; c < 4; c++) {
          cellValues[c] *= signs[c];
        }
      }
      const cell = masks.map(([field, threshold]) => [
        corners(field, grid.nlon, k),
        threshold,
      ]);
      if (cell.some(([m]) => m.some((v) => !Number.isFinite(v)))) {
        continue;
      }
      if (cell.some(([m, t]) => m.every((x) => x < t))) {
        continue;
      }
      for (const [a, z] of marching(cellValues)) {
        // Clip the contour to the bilinearly interpolated mask,
        // including threshold boundaries inside a cell, rather than
        // discarding boundary cells.
        const cuts = [0.0, 1.0];
        for (const [m, t] of cell) {
          maskRoots(m, a, z, t, cuts);
        }
        cuts.sort((x, y) => x - y);
        for (let c = cuts.length - 1; c > 0; c--) {
          if (Math.abs(cuts[c] - cuts[c - 1]) < 1e-10) {
            cuts.splice(c, 1);
          }
        }
        const intervals = [];
        for (let c = 0; c + 1 < cuts.length; c++) {
          const mid = lerp(a, z, (cuts[c] + cuts[c + 1]) / 2.0);
          if (cell.some(([m, t]) => bilinear(m, mid[0], mid[1]) < t)) {
            continue;
          }
          const last = intervals[intervals.length - 1];
          if (last && Math.abs(last[1] - cuts[c]) < 1e-10) {
            last[1] = cuts[c + 1];
          } else {
            intervals.push([cuts[c], cuts[c + 1]]);
          }
        }
        for (const [lo, hi] of intervals) {
          const position = (t) => {
            const p = lerp(a, z, t);
            return [lon + p[0] * grid.dlon, lat - p[1] * grid.dlat];
          };
          const segment = clipArea(position(lo), position(hi), b);
          if (segment) {
            segments.push(segment);
          }
        }
      }
    }
  }
  return join(segments);
}

/**
 * The area plus its smoothing halo, cut from the pressure grid, with
 * smoothed MSLP in hPa. Centres need only this; the other layers
 * live on its grid and sample through it.
 */
class Pressure {
  /**
   * Crops the source pressure field to the area plus halo and
   * smooths it. Wind fields on a different grid are resampled
   * through bilinear interpolation before their own smoothing. Null
   * when the area holds too little data to work with.
   *
   * @param {Field} p - MSLP in Pa
   * @param {[Field, Field]|null} wind - 10 m wind u/v in m/s
   * @param {{south: number, north: number, west: number, east: number}} b
   * @param {typeof DEFAULT_PARAMS} params
   * @returns {[Pressure, Surface|null]|null}
   */
  static crop(p, wind, b, params) {
    const src = p.grid;
    // Three sigma beyond the wind sampling offsets, plus the
    // differentiation stencil.
    const halo =
      Math.max(WIND_OFFSET_KM, params.centre_radius_km) +
      (3.0 * params.smooth_km) / Math.sqrt(2.0 * Math.LN2);
    const j0 = Math.max(
      0,
      Math.trunc(Math.floor((src.lat0 - b.north - halo / KM_DEG) / src.dlat)) -
        1,
    );
    const j1 = Math.min(
      src.nlat - 1,
      Math.trunc(Math.ceil((src.lat0 - b.south + halo / KM_DEG) / src.dlat)) +
        1,
    );
    const lon0 = b.west + remEuclid(src.lon0 - b.west + 180.0, 360.0) - 180.0;
    const cos = Math.max(
      0.01,
      Math.cos(
        (Math.max(Math.abs(b.south), Math.abs(b.north)) * Math.PI) / 180.0,
      ),
    );
    let i0 =
      Math.trunc(
        Math.floor((b.west - halo / (KM_DEG * cos) - lon0) / src.dlon),
      ) - 1;
    let i1 =
      Math.trunc(
        Math.ceil((b.west + span(b) + halo / (KM_DEG * cos) - lon0) / src.dlon),
      ) + 1;
    if (!src.isGlobalLon) {
      i0 = Math.max(0, i0);
      i1 = Math.min(src.nlon - 1, i1);
    }
    if (j1 < j0 + 2 || i1 < i0 + 2) {
      return null;
    }
    const grid = {
      lat0: src.lat0 - j0 * src.dlat,
      lon0: lon0 + i0 * src.dlon,
      dlat: src.dlat,
      dlon: src.dlon,
      nlat: j1 - j0 + 1,
      nlon: i1 - i0 + 1,
      isGlobalLon: false,
    };
    const cells = () => {
      const out = [];
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          out.push([j, i, j * src.nlon + remEuclid(i, src.nlon)]);
        }
      }
      return out;
    };
    const pressure = cells().map(([, , k]) => p.values[k] / 100.0);
    const a = new Pressure(grid, smooth(pressure, grid, params.smooth_km));
    let surface = null;
    if (wind) {
      const windOn = (f) => {
        const sameGrid =
          f.grid.lat0 === src.lat0 &&
          f.grid.lon0 === src.lon0 &&
          f.grid.dlat === src.dlat &&
          f.grid.dlon === src.dlon &&
          f.grid.nlat === src.nlat &&
          f.grid.nlon === src.nlon;
        const values = cells().map(([j, i, k]) => {
          if (sameGrid) {
            return f.values[k];
          }
          const lat = src.lat0 - j * src.dlat;
          const lon = lon0 + i * src.dlon;
          return spatial(f, lat, lon);
        });
        return smooth(values, grid, params.smooth_km);
      };
      surface = new Surface(a, windOn(wind[0]), windOn(wind[1]));
    }
    return [a, surface];
  }

  constructor(grid, p) {
    /** @type {{lat0: number, lon0: number, dlat: number, dlon: number,
     *   nlat: number, nlon: number}} */
    this.grid = grid;
    /** @type {number[]} Smoothed MSLP in hPa */
    this.p = p;
  }

  /**
   * Cell lookup for bilinear sampling; null outside the grid.
   *
   * @param {[number, number]} point - [lon, lat]
   * @returns {[number, number, number]|null}
   */
  cell(point) {
    const g = this.grid;
    const x = (point[0] - g.lon0) / g.dlon;
    const y = (g.lat0 - point[1]) / g.dlat;
    if (x < 0.0 || y < 0.0 || x > g.nlon - 1 || y > g.nlat - 1) {
      return null;
    }
    const i = Math.min(Math.trunc(Math.floor(x)), g.nlon - 2);
    const j = Math.min(Math.trunc(Math.floor(y)), g.nlat - 2);
    return [j * g.nlon + i, x - i, y - j];
  }

  /**
   * Bilinear sample of a layer on this grid.
   *
   * @param {number[]} values
   * @param {[number, number]} point
   * @returns {number}
   */
  sample(values, point) {
    const at = this.cell(point);
    if (at === null) {
      return NaN;
    }
    const [k, x, y] = at;
    return bilinear(corners(values, this.grid.nlon, k), x, y);
  }

  /**
   * Highs and lows: a grid point lower than its eight neighbours and
   * than every point within the radius, prominent against the mean
   * pressure inside it. Missing data inside the radius disqualifies
   * the point. Points within 150 km of the area edge are skipped.
   *
   * @param {{south: number, north: number, west: number, east: number}} b
   * @param {typeof DEFAULT_PARAMS} params
   * @returns {Array<{kind: string, lon: number, lat: number, pressure_hpa: number}>}
   */
  centres(b, params) {
    const g = this.grid;
    const out = [];
    for (let j = 1; j < g.nlat - 1; j++) {
      const lat = g.lat0 - j * g.dlat;
      for (let i = 1; i < g.nlon - 1; i++) {
        const lon = g.lon0 + i * g.dlon;
        const point = [lon, lat];
        if (
          Math.min(lat - b.south, b.north - lat) * KM_DEG < 150.0 ||
          Math.min(lon - b.west, b.west + span(b) - lon) *
            KM_DEG *
            Math.cos((lat * Math.PI) / 180.0) <
            150.0
        ) {
          continue;
        }
        const k = j * g.nlon + i;
        const p = this.p[k];
        if (!Number.isFinite(p)) {
          continue;
        }
        // Cheap candidate test before the full physical-radius search.
        const neighbours = [
          k - 1,
          k + 1,
          k - g.nlon,
          k + g.nlon,
          k - g.nlon - 1,
          k - g.nlon + 1,
          k + g.nlon - 1,
          k + g.nlon + 1,
        ];
        let low = neighbours.every((n) => this.p[n] >= p);
        let high = neighbours.every((n) => this.p[n] <= p);
        if (!low && !high) {
          continue;
        }
        const dj = Math.ceil(params.centre_radius_km / (KM_DEG * g.dlat));
        const cos = Math.cos(
          (Math.min(Math.abs(lat) + params.centre_radius_km / KM_DEG, 89.0) *
            Math.PI) /
            180.0,
        );
        const di = Math.ceil(params.centre_radius_km / (KM_DEG * g.dlon * cos));
        let sum = 0.0;
        let count = 0;
        for (
          let y = Math.max(0, j - dj);
          y <= Math.min(j + dj, g.nlat - 1);
          y++
        ) {
          for (
            let x = Math.max(0, i - di);
            x <= Math.min(i + di, g.nlon - 1);
            x++
          ) {
            const n = y * g.nlon + x;
            const q = this.p[n];
            if (
              distance(point, [g.lon0 + x * g.dlon, g.lat0 - y * g.dlat]) >
              params.centre_radius_km
            ) {
              continue;
            }
            // Do not infer prominence across a data gap.
            if (!Number.isFinite(q)) {
              low = false;
              high = false;
              continue;
            }
            low = low && (q > p || (q === p && n >= k));
            high = high && (q < p || (q === p && n >= k));
            sum += q;
            count += 1;
          }
        }
        const mean = sum / count;
        let kind = null;
        if (low && mean - p >= params.centre_prominence_hpa) {
          kind = "low";
        } else if (high && p - mean >= params.centre_prominence_hpa) {
          kind = "high";
        } else {
          continue;
        }
        out.push({
          kind,
          lon: round(lon, 100.0),
          lat: round(lat, 100.0),
          pressure_hpa: round(p, 10.0),
        });
      }
    }
    return out;
  }
}

/**
 * Pressure curvature and surface wind, which troughs are traced
 * from. Exists only with surface wind.
 */
class Surface {
  /**
   * Central differences of the smoothed pressure (hPa) and wind
   * (m/s) in kilometres; the larger eigenvalue of the pressure
   * Hessian is the curvature across the trough, and the smoothed
   * pressure gradient along the sign-aligned eigenvector is the
   * contour field trough axes are traced from.
   *
   * @param {Pressure} a
   * @param {number[]} u - Smoothed 10 m wind east component
   * @param {number[]} v - Smoothed 10 m wind north component
   */
  constructor(a, u, v) {
    const grid = a.grid;
    const n = grid.nlat * grid.nlon;
    this.u = u;
    this.v = v;
    this.curvature = new Array(n).fill(NaN);
    this.vorticity = new Array(n).fill(NaN);
    this.east = new Array(n).fill(NaN);
    this.north = new Array(n).fill(NaN);
    this.g = new Array(n).fill(NaN);
    const dy = grid.dlat * KM_DEG;
    // South to north, west to east: both orientation neighbours have
    // been visited.
    for (let j = grid.nlat - 2; j >= 1; j--) {
      const lat = grid.lat0 - j * grid.dlat;
      const dx = grid.dlon * KM_DEG * Math.cos((lat * Math.PI) / 180.0);
      if (dx < 1e-6) {
        continue;
      }
      for (let i = 1; i < grid.nlon - 1; i++) {
        const k = j * grid.nlon + i;
        const w = k - 1;
        const e = k + 1;
        const s = k + grid.nlon;
        const nn = k - grid.nlon;
        const px = (a.p[e] - a.p[w]) / (2.0 * dx);
        const py = (a.p[nn] - a.p[s]) / (2.0 * dy);
        const xx = (a.p[e] - 2.0 * a.p[k] + a.p[w]) / (dx * dx);
        const yy = (a.p[nn] - 2.0 * a.p[k] + a.p[s]) / (dy * dy);
        const xy =
          (a.p[nn + 1] - a.p[nn - 1] - a.p[s + 1] + a.p[s - 1]) /
          (4.0 * dx * dy);
        const lambda = (xx + yy + Math.hypot(xx - yy, 2.0 * xy)) / 2.0;
        this.curvature[k] = lambda * 100.0 ** 2;
        // Spherical relative vorticity:
        // (dv/dlon - d(u·cos(lat))/dlat)/(R·cos(lat)), sign-flipped
        // per hemisphere so cyclonic is positive everywhere.
        const zeta =
          (this.v[e] - this.v[w]) / (2.0 * dx * 1000.0) -
          (this.u[nn] - this.u[s]) / (2.0 * dy * 1000.0) +
          (this.u[k] * Math.tan((lat * Math.PI) / 180.0)) / (R * 1000.0);
        this.vorticity[k] = lat === 0.0 ? 0.0 : zeta * Math.sign(lat);
        const angle = Math.atan2(2.0 * xy, xx - yy) / 2.0;
        let ey = Math.sin(angle);
        let ex = Math.cos(angle);
        const neighbour = Number.isFinite(this.east[w]) ? w : s;
        if (ex * this.east[neighbour] + ey * this.north[neighbour] < 0.0) {
          ex = -ex;
          ey = -ey;
        }
        this.east[k] = ex;
        this.north[k] = ey;
        this.g[k] = px * ex + py * ey;
      }
    }
  }

  /**
   * The sign-aligned cross-trough unit vector at a point.
   *
   * @param {Pressure} a
   * @param {[number, number]} point
   * @returns {[number, number]}
   */
  normal(a, point) {
    const grid = a.grid;
    const at = a.cell(point);
    if (at === null) {
      return [NaN, NaN];
    }
    const [k, x, y] = at;
    const east = corners(this.east, grid.nlon, k);
    const north = corners(this.north, grid.nlon, k);
    const signs = orientation(east, north);
    if (signs === null) {
      return [NaN, NaN];
    }
    return [
      bilinear(
        east.map((v, i) => v * signs[i]),
        x,
        y,
      ),
      bilinear(
        north.map((v, i) => v * signs[i]),
        x,
        y,
      ),
    ];
  }

  /**
   * Trough axes (and, wind-shift classified, untyped fronts).
   *
   * @param {Pressure} a
   * @param {{south: number, north: number, west: number, east: number}} b
   * @param {typeof DEFAULT_PARAMS} params
   * @returns {object[]}
   */
  lines(a, b, params) {
    return contours(
      a.grid,
      b,
      this.g,
      [
        [this.curvature, params.trough_curvature],
        [this.vorticity, params.trough_vorticity],
      ],
      [this.east, this.north],
    )
      .map((points) => this.measure(a, points, params))
      .filter((line) => line !== null);
  }

  /**
   * Length, mean curvature, mean pressure and mean 10 m wind shift
   * along a traced line; drops it when too short or the shift
   * cannot be measured. A shift of at least 60° combined with at
   * least 500 km marks the line as an untyped wind-shift front.
   *
   * @param {Pressure} a
   * @param {[number, number][]} points
   * @param {typeof DEFAULT_PARAMS} params
   * @returns {object|null}
   */
  measure(a, points, params) {
    let length = 0.0;
    let strength = 0.0;
    let pressure = 0.0;
    let shift = 0.0;
    let shiftLength = 0.0;
    for (let i = 0; i + 1 < points.length; i++) {
      const pair = [points[i], points[i + 1]];
      const d = distance(pair[0], pair[1]);
      const mid = lerp(pair[0], pair[1], 0.5);
      length += d;
      strength += a.sample(this.curvature, mid) * d;
      pressure += a.sample(a.p, mid) * d;
      const [ex, ey] = this.normal(a, mid);
      const norm = Math.hypot(ex, ey);
      const dx =
        (WIND_OFFSET_KM * ex) /
        norm /
        (KM_DEG * Math.cos((mid[1] * Math.PI) / 180.0));
      const dy = (WIND_OFFSET_KM * ey) / norm / KM_DEG;
      const pa = [mid[0] - dx, mid[1] - dy];
      const pb = [mid[0] + dx, mid[1] + dy];
      const ua = a.sample(this.u, pa);
      const va = a.sample(this.v, pa);
      const ub = a.sample(this.u, pb);
      const vb = a.sample(this.v, pb);
      if (
        [ua, va, ub, vb].every((v) => Number.isFinite(v)) &&
        Math.hypot(ua, va) > 1e-6 &&
        Math.hypot(ub, vb) > 1e-6
      ) {
        const angle =
          remEuclid(
            (Math.atan2(ua, va) - Math.atan2(ub, vb)) * (180.0 / Math.PI) +
              180.0,
            360.0,
          ) - 180.0;
        shift += Math.abs(angle) * d;
        shiftLength += d;
      }
    }
    if (
      length < params.min_trough_km ||
      length === 0.0 ||
      shiftLength === 0.0 ||
      !Number.isFinite(strength) ||
      !Number.isFinite(pressure)
    ) {
      return null;
    }
    const shiftMean = shift / shiftLength;
    const kind =
      shiftMean >= FRONT_SHIFT_DEG && length >= params.min_front_km
        ? "front"
        : "trough";
    const line = newLine(kind, points, length, strength, pressure);
    if (line === null) {
      return null;
    }
    line.shift_deg = round(shiftMean, 10.0);
    return line;
  }
}

/**
 * The 850 hPa thermal layer: temperature gradient, thermal front
 * parameter and the cross-front wind, which type the fronts.
 */
class Thermal {
  /**
   * Resamples 850 hPa temperature and wind to the pressure grid and
   * smooths them, then takes the thermal front parameter (TFP = the
   * temperature gradient's increase towards the cold side) and the
   * TFP ridge field the front lines are traced from.
   *
   * @param {Pressure} a
   * @param {Field} t - 850 hPa temperature in K
   * @param {Field} u - 850 hPa wind east in m/s
   * @param {Field} v - 850 hPa wind north in m/s
   * @param {typeof DEFAULT_PARAMS} params
   */
  constructor(a, t, u, v, params) {
    const [east0, north0] = gradient(
      resample(t, a.grid, params.smooth_km),
      a.grid,
    );
    const magnitude = east0.map((x, k) => Math.hypot(x, north0[k]));
    const east = magnitude.map((m, k) => (m > 1e-9 ? east0[k] / m : NaN));
    const north = magnitude.map((m, k) => (m > 1e-9 ? north0[k] / m : NaN));
    const [gx, gy] = gradient(magnitude, a.grid);
    const tfp = magnitude.map((_, k) => -(gx[k] * east[k] + gy[k] * north[k]));
    const [lx, ly] = gradient(tfp, a.grid);
    const locating = tfp.map((_, k) => lx[k] * east[k] + ly[k] * north[k]);
    this.gradient = magnitude;
    this.east = east;
    this.north = north;
    this.tfp = tfp;
    this.locating = locating;
    this.u = resample(u, a.grid, params.smooth_km);
    this.v = resample(v, a.grid, params.smooth_km);
  }

  /**
   * The cross-front wind towards the warm air, sampled `behind_km`
   * into the cold air, and the unit normal towards the warm air at
   * `point`.
   *
   * @param {Pressure} a
   * @param {[number, number]} point
   * @param {number} behindKm
   * @returns {[number, [number, number]]}
   */
  wind(a, point, behindKm) {
    const x = a.sample(this.east, point);
    const y = a.sample(this.north, point);
    const hyp = Math.hypot(x, y);
    const n = [x / hyp, y / hyp];
    const at = [
      point[0] -
        (behindKm * n[0]) / (KM_DEG * Math.cos((point[1] * Math.PI) / 180.0)),
      point[1] - (behindKm * n[1]) / KM_DEG,
    ];
    return [a.sample(this.u, at) * n[0] + a.sample(this.v, at) * n[1], n];
  }

  /**
   * Thermal front lines, typed cold, warm or stationary along their
   * length by the 850 hPa wind pushing cold air towards warm air.
   *
   * @param {Pressure} a
   * @param {{south: number, north: number, west: number, east: number}} b
   * @param {typeof DEFAULT_PARAMS} params
   * @returns {object[]}
   */
  lines(a, b, params) {
    const out = [];
    for (const points of contours(
      a.grid,
      b,
      this.locating,
      [
        [this.tfp, params.tfp_min],
        [this.gradient, params.gradient_min],
      ],
      null,
    )) {
      const speeds = points.map((p) => this.wind(a, p, 0.0)[0]);
      for (const [kind, part] of splitTypes(
        points,
        speeds,
        params.front_speed_ms,
      )) {
        const line = this.measure(a, kind, part, 0.0);
        if (line !== null && line.length_km >= params.min_front_km) {
          out.push(line);
        }
      }
    }
    return out;
  }

  /**
   * A trough with a wind shift that mostly lies in a thermal zone
   * locates a front. Forecasters draw fronts at the pressure trough
   * and wind shift, on the cold side of the zone, while the thermal
   * line marks its warm edge.
   *
   * @param {Pressure} a
   * @param {object} trough
   * @param {typeof DEFAULT_PARAMS} params
   * @returns {boolean}
   */
  locates(a, trough, params) {
    let zone = 0.0;
    for (let i = 0; i + 1 < trough.points.length; i++) {
      if (
        a.sample(
          this.gradient,
          lerp(trough.points[i], trough.points[i + 1], 0.5),
        ) >= params.gradient_min
      ) {
        zone += distance(trough.points[i], trough.points[i + 1]);
      }
    }
    return trough.kind === "front" && zone * 2.0 >= trough.length_km;
  }

  /**
   * The fronts along a trough's axis. The smoothed wind at the shift
   * blends both air masses, so the cold air's push is taken
   * {@link WIND_OFFSET_KM} behind the trough.
   *
   * @param {Pressure} a
   * @param {object} trough
   * @param {typeof DEFAULT_PARAMS} params
   * @returns {object[]}
   */
  troughFronts(a, trough, params) {
    const speeds = trough.points.map((p) => {
      const tfp = a.sample(this.tfp, p);
      // Beyond the thermal field's stencil, near the grid's edge,
      // the axis is cut short.
      return Number.isFinite(tfp) ? this.wind(a, p, WIND_OFFSET_KM)[0] : NaN;
    });
    const out = [];
    for (const [kind, points] of splitTypes(
      trough.points,
      speeds,
      params.front_speed_ms,
    )) {
      const line = this.measure(a, kind, points, WIND_OFFSET_KM);
      if (line !== null) {
        line.shift_deg = trough.shift_deg;
        out.push(line);
      }
    }
    return out;
  }

  /**
   * Length, mean TFP, mean pressure, mean motion and push speed
   * along a typed front piece.
   *
   * @param {Pressure} a
   * @param {string} kind
   * @param {[number, number][]} points
   * @param {number} behindKm
   * @returns {object|null}
   */
  measure(a, kind, points, behindKm) {
    let length = 0.0;
    let strength = 0.0;
    let pressure = 0.0;
    let speed = 0.0;
    const motion = [0.0, 0.0];
    for (let i = 0; i + 1 < points.length; i++) {
      const pair = [points[i], points[i + 1]];
      const d = distance(pair[0], pair[1]);
      const mid = lerp(pair[0], pair[1], 0.5);
      const [s, n] = this.wind(a, mid, behindKm);
      length += d;
      strength += a.sample(this.tfp, mid) * d;
      pressure += a.sample(a.p, mid) * d;
      speed += Math.abs(s) * d;
      const sign = kind === "warm" ? -1.0 : 1.0;
      motion[0] += sign * n[0] * d;
      motion[1] += sign * n[1] * d;
    }
    if (
      length === 0.0 ||
      ![strength, pressure, speed, motion[0], motion[1]].every((x) =>
        Number.isFinite(x),
      )
    ) {
      return null;
    }
    const moving = kind !== "stationary";
    const line = newLine(kind, points, length, strength, pressure);
    if (line === null) {
      return null;
    }
    if (moving) {
      line.motion_deg = remEuclid(
        round(
          remEuclid(
            Math.atan2(motion[0], motion[1]) * (180.0 / Math.PI),
            360.0,
          ),
          10.0,
        ),
        360.0,
      );
      line.speed_kn = round((speed / length) * (3600.0 / 1852.0), 10.0);
    }
    return line;
  }
}

/**
 * Central differences in K/(100 km) — K/(100 km)² when applied
 * again. Interior points only.
 *
 * @param {number[]} values
 * @param {{lat0: number, lon0: number, dlat: number, dlon: number,
 *   nlat: number, nlon: number}} g
 * @returns {[number[], number[]]} [east, north]
 */
function gradient(values, g) {
  const east = new Array(values.length).fill(NaN);
  const north = new Array(values.length).fill(NaN);
  for (let j = 1; j < g.nlat - 1; j++) {
    const dx =
      g.dlon * KM_DEG * Math.cos(((g.lat0 - j * g.dlat) * Math.PI) / 180.0);
    if (dx < 1e-6) {
      continue;
    }
    for (let i = 1; i < g.nlon - 1; i++) {
      const k = j * g.nlon + i;
      east[k] = (100.0 * (values[k + 1] - values[k - 1])) / (2.0 * dx);
      north[k] =
        (100.0 * (values[k - g.nlon] - values[k + g.nlon])) /
        (2.0 * g.dlat * KM_DEG);
    }
  }
  return [east, north];
}

/**
 * Resamples a source field onto a target grid and smooths it.
 *
 * @param {Field} field
 * @param {{lat0: number, lon0: number, dlat: number, dlon: number,
 *   nlat: number, nlon: number}} g
 * @param {number} half
 * @returns {number[]}
 */
function resample(field, g, half) {
  const values = new Array(g.nlat * g.nlon);
  for (let k = 0; k < values.length; k++) {
    values[k] = spatial(
      field,
      g.lat0 - Math.trunc(k / g.nlon) * g.dlat,
      g.lon0 + (k % g.nlon) * g.dlon,
    );
  }
  return smooth(values, g, half);
}

/**
 * Shared output shape and rounding of both detectors. Null when
 * rounding collapses the line to one point.
 *
 * @param {string} kind
 * @param {[number, number][]} points
 * @param {number} length
 * @param {number} strength
 * @param {number} pressure
 * @returns {object|null}
 */
function newLine(kind, points, length, strength, pressure) {
  const rounded = [];
  for (const p of points) {
    const q = [round(p[0], 100.0), round(p[1], 100.0)];
    const last = rounded[rounded.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) {
      rounded.push(q);
    }
  }
  if (rounded.length < 2) {
    return null;
  }
  return {
    kind,
    points: rounded,
    length_km: round(length, 10.0),
    strength: round(strength / length, 10.0),
    pressure_hpa: round(pressure / length, 10.0),
  };
}

/**
 * Splits a traced line where the cross-front wind's finite runs and
 * the ±threshold crossings change the classification; a wind gap
 * cuts the line.
 *
 * @param {[number, number][]} points
 * @param {number[]} speeds
 * @param {number} threshold
 * @returns {Array<[string, [number, number][]]>}
 */
function splitTypes(points, speeds, threshold) {
  const out = [];
  // Each finite run of `speeds` is classified on its own; a wind gap
  // cuts the line.
  let runStart = -1;
  for (let i = 0; i <= speeds.length; i++) {
    const finite = i < speeds.length && Number.isFinite(speeds[i]);
    if (finite && runStart < 0) {
      runStart = i;
    } else if (!finite && runStart >= 0) {
      if (i - runStart >= 2) {
        out.push(
          ...classify(
            points.slice(runStart, i),
            speeds.slice(runStart, i),
            threshold,
          ),
        );
      }
      runStart = -1;
    }
  }
  return out;
}

/**
 * Interpolates point classifications to their threshold crossings,
 * sharing endpoints; runs shorter than 150 km are absorbed into
 * their longer neighbour so a front does not flicker between types.
 *
 * @param {[number, number][]} points
 * @param {number[]} speeds
 * @param {number} threshold
 * @returns {Array<[string, [number, number][]]>}
 */
function classify(points, speeds, threshold) {
  const runs = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const pair = [points[i], points[i + 1]];
    const s = [speeds[i], speeds[i + 1]];
    const cuts = [0.0, 1.0];
    for (const limit of [-threshold, threshold]) {
      const t = (limit - s[0]) / (s[1] - s[0]);
      if (t > 0.0 && t < 1.0) {
        cuts.push(t);
      }
    }
    cuts.sort((a, b) => a - b);
    for (let c = cuts.length - 1; c > 0; c--) {
      if (cuts[c] === cuts[c - 1]) {
        cuts.splice(c, 1);
      }
    }
    for (let c = 0; c + 1 < cuts.length; c++) {
      const sMid = s[0] + (s[1] - s[0]) * ((cuts[c] + cuts[c + 1]) / 2.0);
      const kind =
        sMid >= threshold ? "cold" : sMid <= -threshold ? "warm" : "stationary";
      const start = lerp(pair[0], pair[1], cuts[c]);
      const end = lerp(pair[0], pair[1], cuts[c + 1]);
      const last = runs[runs.length - 1];
      if (
        last &&
        last[0] === kind &&
        distance(last[1][last[1].length - 1], start) < 1e-6
      ) {
        last[1].push(end);
      } else {
        runs.push([kind, [start, end]]);
      }
    }
  }
  const length = (p) => {
    let sum = 0.0;
    for (let i = 0; i + 1 < p.length; i++) {
      sum += distance(p[i], p[i + 1]);
    }
    return sum;
  };
  // Absorb the shortest run first, favouring the longer adjacent run.
  while (runs.length > 1) {
    let shortest = -1;
    let shortestLength = NaN;
    for (let i = 0; i < runs.length; i++) {
      const l = length(runs[i][1]);
      if (l < 150.0 && (shortest < 0 || l < shortestLength)) {
        shortest = i;
        shortestLength = l;
      }
    }
    if (shortest < 0) {
      break;
    }
    const i = shortest;
    const neighbour =
      i === 0
        ? 1
        : i + 1 === runs.length ||
            length(runs[i - 1][1]) >= length(runs[i + 1][1])
          ? i - 1
          : i + 1;
    runs[i][0] = runs[neighbour][0];
    let j = 0;
    while (j + 1 < runs.length) {
      if (runs[j][0] === runs[j + 1][0]) {
        const [, next] = runs.splice(j + 1, 1)[0];
        runs[j][1].push(...next.slice(1));
      } else {
        j += 1;
      }
    }
  }
  return runs;
}

/**
 * Distance from a point to a great-circle segment, in km.
 *
 * @param {[number, number]} p
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @returns {number}
 */
function segmentDistance(p, a, b) {
  const bearing = (x, y) => {
    const dl = ((y[0] - x[0]) * Math.PI) / 180.0;
    const latX = (x[1] * Math.PI) / 180.0;
    const latY = (y[1] * Math.PI) / 180.0;
    return Math.atan2(
      Math.sin(dl) * Math.cos(latY),
      Math.cos(latX) * Math.sin(latY) -
        Math.sin(latX) * Math.cos(latY) * Math.cos(dl),
    );
  };
  const d = distance(a, p) / R;
  const angle = bearing(a, p) - bearing(a, b);
  const along = Math.atan2(Math.sin(d) * Math.cos(angle), Math.cos(d)) * R;
  if (along < 0.0) {
    return distance(p, a);
  }
  if (along > distance(a, b)) {
    return distance(p, b);
  }
  return (
    Math.abs(
      Math.asin(Math.min(Math.max(Math.sin(d) * Math.sin(angle), -1.0), 1.0)),
    ) * R
  );
}

/**
 * Whether more than half of a trough's length lies within `radius`
 * of one of the fronts.
 *
 * @param {object} trough
 * @param {object[]} fronts
 * @param {number} radiusKm
 * @returns {boolean}
 */
function overlapsFront(trough, fronts, radiusKm) {
  let close = 0.0;
  let total = 0.0;
  for (let i = 0; i + 1 < trough.points.length; i++) {
    const pair = [trough.points[i], trough.points[i + 1]];
    const d = distance(pair[0], pair[1]);
    const samples = Math.max(1, Math.ceil(d / 25.0));
    for (let k = 0; k < samples; k++) {
      const p = lerp(pair[0], pair[1], (k + 0.5) / samples);
      if (
        fronts.some((front) => {
          for (let s = 0; s + 1 < front.points.length; s++) {
            if (
              segmentDistance(p, front.points[s], front.points[s + 1]) <=
              radiusKm
            ) {
              return true;
            }
          }
          return false;
        })
      ) {
        close += d / samples;
      }
    }
    total += d;
  }
  return close > total / 2.0;
}

/**
 * A step's lines from the layers it has. Fronts located by their
 * trough replace the thermal lines of their zone. A trough's
 * curvature fades before its front does, so each front follows its
 * trough's axis for as long as the flow stays cyclonic.
 *
 * @param {Pressure} a
 * @param {Surface|null} surface
 * @param {Thermal|null} thermal
 * @param {{south: number, north: number, west: number, east: number}} b
 * @param {typeof DEFAULT_PARAMS} params
 * @returns {object[]}
 */
function stepLines(a, surface, thermal, b, params) {
  if (surface === null && thermal === null) {
    return [];
  }
  if (surface === null) {
    return thermal.lines(a, b, params);
  }
  if (thermal === null) {
    return surface.lines(a, b, params);
  }
  const lines = thermal.lines(a, b, params);
  const troughs = surface.lines(a, b, params);
  const axes = surface.lines(a, b, { ...params, trough_curvature: 0.0 });
  const seeds = troughs.filter((trough) => thermal.locates(a, trough, params));
  const fronts = axes
    .filter((axis) => seeds.some((seed) => overlapsFront(seed, [axis], 50.0)))
    .flatMap((axis) => thermal.troughFronts(a, axis, params));
  // Seeds stay troughs; the 200 km check below drops those their
  // fronts cover.
  for (const trough of troughs) {
    trough.kind = "trough";
  }
  const kept = lines.filter((line) => !overlapsFront(line, fronts, ZONE_KM));
  kept.push(...fronts);
  kept.push(...troughs.filter((trough) => !overlapsFront(trough, kept, 200.0)));
  return kept;
}

/**
 * Validates the parameter object like the reference implementation.
 *
 * @param {typeof DEFAULT_PARAMS} params
 * @returns {boolean}
 */
function paramsValid(params) {
  return (
    [
      params.smooth_km,
      params.tfp_min,
      params.gradient_min,
      params.front_speed_ms,
      params.min_front_km,
      params.trough_curvature,
      params.trough_vorticity,
      params.min_trough_km,
      params.centre_radius_km,
      params.centre_prominence_hpa,
    ].every((x) => Number.isFinite(x) && x >= 0.0) &&
    params.smooth_km !== 0.0 &&
    params.centre_radius_km !== 0.0
  );
}

/**
 * Detects fronts, troughs and pressure centres for every step.
 *
 * @param {object} input
 * @param {string} input.label - Model label; its first word becomes
 *   the output `model`
 * @param {number} input.referenceTime - Run time, Unix seconds
 * @param {Array<{time: number, fields: Object<string, Field>}>} input.steps
 *   Ascending forecast steps; field keys `mslp`, `wind_u_10m`,
 *   `wind_v_10m`, `temp_850hpa`, `wind_u_850hpa`, `wind_v_850hpa`,
 *   pressures in Pa, temperature in K, wind in m/s
 * @param {{south: number, north: number, west: number, east: number}|null} area
 *   Limit the output to a box (west greater than east crosses the
 *   date line); null means the whole pressure grid extent
 * @param {typeof DEFAULT_PARAMS} [params]
 * @returns {{schema: string, model: string, run: string, method: string,
 *   params: object, caveat: string, steps: Array}} The reference
 *   implementation's `fronts/v2` output
 */
function detect(input, area, params = DEFAULT_PARAMS) {
  if (!paramsValid(params)) {
    throw new Error("invalid front parameters");
  }
  if (
    area !== null &&
    ([area.south, area.north, area.west, area.east].some(
      (x) => !Number.isFinite(x),
    ) ||
      area.south >= area.north ||
      area.south < -90.0 ||
      area.north > 90.0 ||
      span(area) === 0.0)
  ) {
    throw new Error("invalid front area");
  }
  const steps = [...input.steps].sort((x, y) => x.time - y.time);
  let thermalMethod = false;
  const outSteps = [];
  for (const step of steps) {
    const mslp = step.fields.mslp;
    if (!mslp) {
      continue;
    }
    const windU = step.fields.wind_u_10m;
    const windV = step.fields.wind_v_10m;
    const wind = windU && windV ? [windU, windV] : null;
    const upper =
      step.fields.temp_850hpa &&
      step.fields.wind_u_850hpa &&
      step.fields.wind_v_850hpa
        ? [
            step.fields.temp_850hpa,
            step.fields.wind_u_850hpa,
            step.fields.wind_v_850hpa,
          ]
        : null;
    thermalMethod = thermalMethod || upper !== null;
    const g = mslp.grid;
    const b = area ?? {
      south: g.lat0 - (g.nlat - 1) * g.dlat,
      north: g.lat0,
      west: remEuclid(g.lon0 + 180.0, 360.0) - 180.0,
      east:
        remEuclid(g.lon0 + 180.0, 360.0) -
        180.0 +
        (g.isGlobalLon ? 360.0 : (g.nlon - 1) * g.dlon),
    };
    let lines = [];
    let centres = [];
    const cropped = Pressure.crop(mslp, wind, b, params);
    if (cropped !== null) {
      const [a, surface] = cropped;
      const thermal = upper
        ? new Thermal(a, upper[0], upper[1], upper[2], params)
        : null;
      lines = stepLines(a, surface, thermal, b, params);
      centres = a.centres(b, params);
    }
    outSteps.push({ time: timestamp(step.time), lines, centres });
  }
  const modelWord = input.label.trim().split(/\s+/)[0];
  return {
    schema: "fronts/v2",
    model: modelWord ? modelWord.toLowerCase() : "unknown",
    run: timestamp(input.referenceTime),
    method: thermalMethod ? "thermal-front-parameter" : "trough-wind-shift",
    params: { ...params },
    caveat: CAVEAT,
    steps: outSteps,
  };
}

// ---------------------------------------------------------------------------
// Tracking: linking detections through time, and front passages at a
// (moving) position.
// ---------------------------------------------------------------------------

/**
 * The longitude representation of `lon` nearest `anchor`.
 *
 * @param {number} lon
 * @param {number} anchor
 * @returns {number}
 */
function lonNear(lon, anchor) {
  return lon + 360.0 * Math.round((anchor - lon) / 360.0);
}

/**
 * Parses a `fronts/v2` timestamp into Unix seconds.
 *
 * @param {string} at
 * @returns {number}
 */
function parseTimestamp(at) {
  const t = Date.parse(at) / 1000;
  if (!Number.isFinite(t)) {
    throw new Error(`invalid front timestamp ${at}`);
  }
  return t;
}

/**
 * Unit sphere vector of a [lon, lat] point.
 *
 * @param {[number, number]} p
 * @returns {[number, number, number]}
 */
function vector(p) {
  const lon = (p[0] * Math.PI) / 180.0;
  const lat = (p[1] * Math.PI) / 180.0;
  return [
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
  ];
}

/**
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {number}
 */
function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {[number, number, number]}
 */
function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Angle between unit vectors, radians.
 *
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {number}
 */
function arc(a, b) {
  return Math.acos(Math.min(Math.max(dot3(a, b), -1.0), 1.0));
}

/**
 * Distance from a point to a great-circle segment on the unit
 * sphere, scaled to km.
 *
 * @param {[number, number, number]} p
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {number}
 */
function segmentDistance3(p, a, b) {
  const normal = cross3(a, b);
  const norm = dot3(normal, normal);
  let dist = Math.min(arc(p, a), arc(p, b));
  if (norm > 1e-16) {
    const projection = dot3(p, normal) / norm;
    const q = [
      p[0] - projection * normal[0],
      p[1] - projection * normal[1],
      p[2] - projection * normal[2],
    ];
    const length = Math.sqrt(dot3(q, q));
    if (length > 1e-12) {
      const u = [q[0] / length, q[1] / length, q[2] / length];
      if (arc(a, u) + arc(u, b) <= arc(a, b) + 1e-8) {
        dist = Math.min(dist, arc(p, u));
      }
    }
  }
  return dist * 6371.0;
}

/**
 * Mean great-circle distance from a line to an observation's
 * segments, in km.
 *
 * @param {[number, number][]} line
 * @param {{time: number, lines: [number, number][][]}} observation
 * @returns {number}
 */
function meanDistance(line, observation) {
  const segments = [];
  for (const part of observation.lines) {
    for (let i = 0; i + 1 < part.length; i++) {
      segments.push([vector(part[i]), vector(part[i + 1])]);
    }
  }
  let sum = 0.0;
  for (const p of line) {
    const v = vector(p);
    let min = Infinity;
    for (const [a, b] of segments) {
      const d = segmentDistance3(v, a, b);
      if (d < min) {
        min = d;
      }
    }
    sum += min;
  }
  return sum / line.length;
}

/**
 * A track kind keeps its family when its type changes between
 * steps: wind-shift lines (troughs, untyped fronts) and cold fronts
 * match each other; warm and stationary fronts match each other.
 *
 * @param {string} kind
 * @param {string} other
 * @returns {boolean}
 */
function sameFamily(kind, other) {
  if (kind === other) {
    return true;
  }
  const family = (k) => k === "cold" || k === "front" || k === "trough";
  return family(kind) && family(other);
}

/**
 * Mean [lat, lon] of an observation's points, longitudes anchored to
 * the first point so date-line lines stay continuous.
 *
 * @param {{time: number, lines: [number, number][][]}} observation
 * @returns {[number, number]}
 */
function meanPosition(observation) {
  const anchor = observation.lines[0][0][0];
  const points = observation.lines.flat();
  let lat = 0.0;
  let lon = 0.0;
  for (const p of points) {
    lat += p[1];
    lon += lonNear(p[0], anchor);
  }
  return [lat / points.length, lon / points.length];
}

/**
 * Links detected lines across steps into tracks. A line matches the
 * nearest live track of the same family within
 * max(150 km, 20 m/s × Δt); unmatched lines start new tracks; a
 * track may miss one step and survive. Tracks shorter than 12 h are
 * dropped unless they sit beside a lasting track within 6 h — the
 * pieces a front's line produces when it jumps between steps.
 * Tracks are numbered by first appearance.
 *
 * @param {{schema: string, steps: Array<{time: string, lines: Array}>}} file
 * @param {typeof DEFAULT_TRACK_PARAMS} [params]
 * @returns {Array<{id: number, kind: string, observations: Array}>}
 */
function track(file, params = DEFAULT_TRACK_PARAMS) {
  if (file.schema !== "fronts/v2") {
    throw new Error("expected fronts/v2");
  }
  if (
    [
      params.max_speed_ms,
      params.min_km,
      params.min_life_h,
      params.piece_window_h,
    ].some((v) => !Number.isFinite(v) || v < 0.0)
  ) {
    throw new Error("invalid front track parameters");
  }
  const tracks = [];
  const seen = [];
  let previous = null;
  for (let stepIndex = 0; stepIndex < file.steps.length; stepIndex++) {
    const step = file.steps[stepIndex];
    const time = parseTimestamp(step.time);
    if (previous !== null && time <= previous) {
      throw new Error("front steps must increase in time");
    }
    previous = time;
    // Keep the preceding observation for matching all fragments in
    // this step.
    const latest = tracks.map((t) => t.observations.length - 1);
    for (const line of step.lines) {
      const kind = line.kind;
      if (!["cold", "warm", "stationary", "front", "trough"].includes(kind)) {
        throw new Error(`unknown front kind ${kind}`);
      }
      if (line.points.length < 2) {
        continue;
      }
      if (
        line.points.some(
          (p) =>
            !Number.isFinite(p[0]) ||
            !Number.isFinite(p[1]) ||
            Math.abs(p[1]) > 90.0,
        )
      ) {
        throw new Error("invalid front coordinates");
      }
      let candidate = null;
      let candidateDistance = 0.0;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (
          !sameFamily(kind, t.kind) ||
          stepIndex - seen[i] > params.max_gap_steps + 1
        ) {
          continue;
        }
        const observation = t.observations[latest[i] ?? 0];
        const dist = meanDistance(line.points, observation);
        const limit = Math.max(
          params.min_km,
          (params.max_speed_ms * (time - observation.time)) / 1000.0,
        );
        if (dist <= limit && (candidate === null || dist < candidateDistance)) {
          candidate = i;
          candidateDistance = dist;
        }
      }
      if (candidate !== null) {
        const t = tracks[candidate];
        if (t.observations[t.observations.length - 1].time !== time) {
          t.observations.push({ time, lines: [] });
        }
        t.observations[t.observations.length - 1].lines.push(line.points);
        seen[candidate] = stepIndex;
      } else {
        tracks.push({
          id: 0,
          kind,
          observations: [{ time, lines: [line.points] }],
        });
        seen.push(stepIndex);
      }
    }
  }
  const lasting = [];
  const short = [];
  for (const t of tracks) {
    const life =
      t.observations[t.observations.length - 1].time - t.observations[0].time;
    (life >= params.min_life_h * 3600.0 ? lasting : short).push(t);
  }
  // Where a lasting front's line jumps between steps, the tracker
  // splits the jump into a short track of its own. Keep such a piece
  // when it lies next to a lasting front.
  for (const piece of short) {
    if (
      piece.observations.length >= 2 &&
      lasting.some((l) => beside(piece, l, params))
    ) {
      lasting.push(piece);
    }
  }
  lasting.sort((a, b) => {
    const [alat, alon] = meanPosition(a.observations[0]);
    const [blat, blon] = meanPosition(b.observations[0]);
    return (
      a.observations[0].time - b.observations[0].time ||
      alat - blat ||
      alon - blon
    );
  });
  for (let i = 0; i < lasting.length; i++) {
    lasting[i].id = i + 1;
  }
  return lasting;
}

/**
 * Whether a short piece track lies next to a lasting track: any
 * observation pair within the piece window and the speed limit.
 *
 * @param {{id: number, kind: string, observations: Array}} piece
 * @param {{id: number, kind: string, observations: Array}} lastingTrack
 * @param {typeof DEFAULT_TRACK_PARAMS} params
 * @returns {boolean}
 */
function beside(piece, lastingTrack, params) {
  if (!sameFamily(piece.kind, lastingTrack.kind)) {
    return false;
  }
  return piece.observations.some((a) => {
    const points = [].concat(...a.lines);
    return lastingTrack.observations.some((b) => {
      const dt = Math.abs(a.time - b.time);
      return (
        dt <= params.piece_window_h * 3600.0 &&
        meanDistance(points, b) <=
          Math.max(params.min_km, (params.max_speed_ms * dt) / 1000.0)
      );
    });
  });
}

/**
 * The front's latitudes at a longitude, interpolated along an
 * observation's lines.
 *
 * @param {{time: number, lines: [number, number][][]}} observation
 * @param {number} lon
 * @returns {number[]}
 */
function frontLatAt(observation, lon) {
  const latitudes = [];
  for (const line of observation.lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = [lonNear(line[i + 1][0], a[0]), line[i + 1][1]];
      const at = lonNear(lon, (a[0] + b[0]) / 2.0);
      if (at >= Math.min(a[0], b[0]) && at <= Math.max(a[0], b[0])) {
        if (a[0] === b[0]) {
          latitudes.push(a[1], b[1]);
        } else {
          latitudes.push(a[1] + ((b[1] - a[1]) * (at - a[0])) / (b[0] - a[0]));
        }
      }
    }
  }
  return latitudes;
}

/**
 * Times when a tracked front passes `position(time)` — a moving
 * boat or a fixed point — interpolated between the two forecast
 * steps that bracket it. Written for the Southern Hemisphere: a
 * passage is a front moving from south of the position to north of
 * it (a Northern Hemisphere port later is a sign flip). Fronts
 * further than 5° of latitude away, and steps over 12 h apart, are
 * ignored.
 *
 * @param {Array<{id: number, kind: string, observations: Array}>} tracks
 * @param {(time: number) => [number, number]|null} position - Boat
 *   position at Unix seconds: [lat, lon] or null
 * @param {string[]} [kinds] - Track kinds that count; defaults to
 *   {@link CROSSING_KINDS}
 * @returns {Array<{time: number, lat: number, lon: number, track_id: number, kind: string}>}
 */
function passages(tracks, position, kinds = CROSSING_KINDS) {
  const out = [];
  for (const t of tracks) {
    if (!kinds.includes(t.kind)) {
      continue;
    }
    for (let i = 0; i + 1 < t.observations.length; i++) {
      const a = t.observations[i];
      const b = t.observations[i + 1];
      if (b.time - a.time > 12 * 3600 || b.time <= a.time) {
        continue;
      }
      const nearest = (o) => {
        const at = position(o.time);
        if (at === null) {
          return null;
        }
        const [lat, lon] = at;
        let best = null;
        for (const v of frontLatAt(o, lon)) {
          if (
            Math.abs(v - lat) <= 5.0 &&
            (best === null || Math.abs(v - lat) < Math.abs(best - lat))
          ) {
            best = v;
          }
        }
        return best === null ? null : best - lat;
      };
      const da = nearest(a);
      const db = nearest(b);
      if (da !== null && db !== null && da < 0.0 && db >= 0.0) {
        const time = a.time + Math.round(((b.time - a.time) * -da) / (db - da));
        const at = position(time);
        if (at !== null) {
          out.push({
            time,
            lat: at[0],
            lon: at[1],
            track_id: t.id,
            kind: t.kind,
          });
        }
      }
    }
  }
  out.sort((x, y) => x.time - y.time || x.track_id - y.track_id);
  return out;
}

module.exports = {
  R,
  KM_DEG,
  WIND_OFFSET_KM,
  FRONT_SHIFT_DEG,
  ZONE_KM,
  CAVEAT,
  DEFAULT_PARAMS,
  DEFAULT_TRACK_PARAMS,
  CROSSING_KINDS,
  round,
  lerp,
  corners,
  bilinear,
  distance,
  spatial,
  kernel,
  smooth,
  span,
  timestamp,
  orientation,
  marching,
  maskRoots,
  clipArea,
  join,
  contours,
  gradient,
  resample,
  splitTypes,
  classify,
  segmentDistance,
  overlapsFront,
  detect,
  track,
  passages,
  frontLatAt,
  lonNear,
};
