/**
 * Golden-vector tests for the fronts detector port (work doc #50):
 * the JavaScript in plugin/fronts-detect.js must reproduce the Rust
 * reference implementation's output on real forecast slices —
 * `tests/fixtures/fronts/` holds the exact outputs the reference
 * gives for GFS and ECMWF analyses, in both the thermal and the
 * pressure-only method, plus a seven-step tracking and passage case.
 * The fixtures are verbatim copies of the reference checkout's
 * `porting/vectors/` — that checkout is not part of this repository;
 * regenerate with `cargo run --release --example vectors` there and
 * re-copy when the method changes.
 *
 * Comparison mirrors porting/check.mjs exactly: structure must
 * match, numbers may differ by at most 0.011 (output points are
 * rounded to 0.01°, other values to 0.1; the last bits of hypot,
 * atan2 and exp differ between languages).
 *
 * @file fronts-detect.test.js
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const {
  detect,
  track,
  passages,
  CROSSING_KINDS,
  CAVEAT,
  DEFAULT_PARAMS,
  maskRoots,
  orientation,
  marching,
  splitTypes,
  distance,
  KM_DEG,
} = require("../plugin/fronts-detect.js");

const VECTORS = join(__dirname, "fixtures", "fronts");
const TOLERANCE = 0.011;

/**
 * Loads a porting vector.
 *
 * @param {string} name
 * @returns {{description: string, input: object, expected: object}}
 */
function vector(name) {
  return JSON.parse(readFileSync(join(VECTORS, name), "utf8"));
}

/**
 * Converts a vector's flat field list into the detector's step
 * input, rounding values through f32 like the reference's field
 * storage.
 *
 * @param {object} input - Vector input
 * @returns {{label: string, referenceTime: number, steps: Array}}
 */
function stepsFromVector(input) {
  const steps = new Map();
  for (const field of input.fields) {
    const time = field.valid_time;
    if (!steps.has(time)) {
      steps.set(time, { time, fields: {} });
    }
    steps.get(time).fields[field.variable] = {
      grid: {
        lat0: field.grid.lat0,
        lon0: field.grid.lon0,
        dlat: field.grid.dlat,
        dlon: field.grid.dlon,
        nlat: field.grid.nlat,
        nlon: field.grid.nlon,
        isGlobalLon: field.grid.is_global_lon,
      },
      values: Float64Array.from(field.values, (v) =>
        Number.isFinite(v) ? Math.fround(v) : NaN,
      ),
    };
  }
  return {
    label: input.label,
    referenceTime: input.reference_time,
    steps: [...steps.values()].sort((a, b) => a.time - b.time),
  };
}

/**
 * Structural comparison with numeric tolerance, same semantics as
 * porting/check.mjs: object keys must match on both sides, array
 * lengths must match, numbers compare within tolerance.
 *
 * @param {*} expected
 * @param {*} actual
 * @param {string} [path]
 * @returns {string[]} Differences
 */
function compare(expected, actual, path = "$") {
  const differences = [];
  if (typeof expected === "number" && typeof actual === "number") {
    if (Math.abs(expected - actual) > TOLERANCE) {
      differences.push(`${path}: expected ${expected}, got ${actual}`);
    }
  } else if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      differences.push(
        `${path}: expected ${expected.length} items, got ${actual.length}`,
      );
    }
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) {
      differences.push(...compare(expected[i], actual[i], `${path}[${i}]`));
    }
  } else if (
    expected &&
    actual &&
    typeof expected === "object" &&
    typeof actual === "object"
  ) {
    for (const key of new Set([
      ...Object.keys(expected),
      ...Object.keys(actual),
    ])) {
      if (!(key in actual)) {
        differences.push(`${path}.${key}: missing`);
      } else if (!(key in expected)) {
        differences.push(`${path}.${key}: not expected`);
      } else {
        differences.push(
          ...compare(expected[key], actual[key], `${path}.${key}`),
        );
      }
    }
  } else if (expected !== actual) {
    differences.push(
      `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
  return differences;
}

/** Runs one detection vector through the port and diffs the output. */
function checkDetectionVector(name) {
  const v = vector(name);
  const actual = detect(stepsFromVector(v.input), v.input.area, {
    ...DEFAULT_PARAMS,
    ...v.input.params,
  });
  const differences = compare(v.expected, actual);
  assert.deepEqual(
    differences,
    [],
    `${name}: ${differences.length} difference(s)\n  ${differences.slice(0, 20).join("\n  ")}`,
  );
}

describe("fronts detection golden vectors (work doc #50)", () => {
  test("GFS pressure-only: trough, wind-shift front and one low", () => {
    checkDetectionVector("gfs-2026100618-pressure-only.json");
  });

  test("GFS thermal: cold, warm and stationary fronts", () => {
    checkDetectionVector("gfs-2026100618-thermal.json");
  });

  test("ECMWF thermal: all four line kinds on a larger grid", () => {
    checkDetectionVector("ecmwf-2025102800-thermal.json");
  });

  test("every detection vector carries the caveat and schema", () => {
    for (const name of [
      "gfs-2026100618-pressure-only.json",
      "gfs-2026100618-thermal.json",
      "ecmwf-2025102800-thermal.json",
    ]) {
      const actual = detect(stepsFromVector(vector(name).input), null, {
        ...DEFAULT_PARAMS,
        ...vector(name).input.params,
      });
      assert.equal(actual.schema, "fronts/v2");
      assert.equal(actual.caveat, CAVEAT);
    }
  });
});

describe("fronts tracking golden vector (work doc #50)", () => {
  const v = vector("tracks.json");

  /** The seven-step detection file the vector feeds the tracker. */
  const tracked = track(v.input.fronts, { ...v.input.params });

  test("13 tracks, matching the reference", () => {
    const differences = compare(v.expected.tracks, tracked);
    assert.deepEqual(
      differences,
      [],
      `${differences.length} difference(s)\n  ${differences.slice(0, 20).join("\n  ")}`,
    );
  });

  test("passages at the five fixed points", () => {
    for (const [i, point] of v.input.points.entries()) {
      const actual = passages(
        tracked,
        () => [point.lat, point.lon],
        CROSSING_KINDS,
      ).map((p) => ({ time: p.time, track_id: p.track_id, kind: p.kind }));
      const differences = compare(v.expected.passages[i], actual);
      assert.deepEqual(
        differences,
        [],
        `point ${i}: ${differences.length} difference(s)\n  ${differences.slice(0, 20).join("\n  ")}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Synthetic unit tests ported from the reference implementation's own
// test suite: small forecasts with known answers.
// ---------------------------------------------------------------------------

/** The synthetic-case grid: 0.25°, 65×49, Tasman between 174°E and the date line. */
function syntheticGrid() {
  return {
    lat0: -22.0,
    lon0: 174.0,
    dlat: 0.25,
    dlon: 0.25,
    nlat: 65,
    nlon: 49,
    isGlobalLon: false,
  };
}

/**
 * Builds the reference's synthetic forecast: a parabolic pressure
 * trough on the 180° meridian with (optionally) a cyclonic wind
 * shift across it.
 *
 * @param {{shift: boolean, trough: boolean, lon0?: number}} options
 * @returns {{label: string, referenceTime: number, steps: Array}}
 */
function synthetic({ shift, trough, lon0 = 174.0 }) {
  const grid = { ...syntheticGrid(), lon0 };
  const f32 = (v) => Math.fround(v);
  const values = (variable) => {
    const out = new Float64Array(grid.nlat * grid.nlon);
    for (let j = 0; j < grid.nlat; j++) {
      const lat = grid.lat0 - j * grid.dlat;
      for (let i = 0; i < grid.nlon; i++) {
        const lon = lon0 + i * grid.dlon;
        const x =
          (((((lon - 180.0 + 180.0) % 360.0) + 360.0) % 360.0) - 180.0) *
          KM_DEG *
          Math.cos((lat * Math.PI) / 180.0);
        let v;
        if (variable === "mslp") {
          v = 100.0 * (1000.0 + (trough ? 0.5 * 1.2 * (x / 100.0) ** 2 : 0.0));
        } else if (variable === "wind_u_10m") {
          v = shift ? 5.0 : 0.0;
        } else {
          v = shift ? -18.0 * Math.tanh(x / 75.0) : 8.0;
        }
        out[j * grid.nlon + i] = f32(v);
      }
    }
    return { grid, values: out };
  };
  return {
    label: "GFS synthetic",
    referenceTime: 0,
    steps: [
      {
        time: 0,
        fields: {
          mslp: values("mslp"),
          wind_u_10m: values("wind_u_10m"),
          wind_v_10m: values("wind_v_10m"),
        },
      },
    ],
  };
}

/** The synthetic tests' area box. */
function area() {
  return { south: -34.0, north: -26.0, west: 176.0, east: -176.0 };
}

describe("fronts detection synthetic cases (ported from the reference tests)", () => {
  test("southern cyclonic shift traces one north-south front", () => {
    const file = detect(synthetic({ shift: true, trough: true }), area());
    const lines = file.steps[0].lines;
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0].kind, "front");
    for (const p of lines[0].points) {
      assert.ok(Math.abs(p[0] - 180.0) < 0.03, JSON.stringify(lines[0].points));
    }
    assert.ok(lines[0].shift_deg > 100.0);
    assert.ok(Math.abs(lines[0].length_km - 8.0 * KM_DEG) < 1.0);
    assert.ok(Math.abs(lines[0].strength - 1.2) < 0.2);
  });

  test("trough without wind shift is masked out", () => {
    const file = detect(synthetic({ shift: false, trough: true }), area());
    assert.deepEqual(file.steps[0].lines, []);
  });

  test("uniform fields have no lines", () => {
    const file = detect(synthetic({ shift: false, trough: false }), area());
    assert.deepEqual(file.steps[0].lines, []);
  });

  test("gaussian low and high need only pressure", () => {
    const g = {
      lat0: -15.0,
      lon0: 158.0,
      dlat: 0.5,
      dlon: 0.5,
      nlat: 61,
      nlon: 81,
      isGlobalLon: false,
    };
    const values = new Float64Array(g.nlat * g.nlon);
    for (let k = 0; k < values.length; k++) {
      const p = [
        g.lon0 + (k % g.nlon) * g.dlon,
        g.lat0 - Math.floor(k / g.nlon) * g.dlat,
      ];
      values[k] = Math.fround(
        101000.0 +
          2400.0 * Math.exp(-((distance(p, [188.0, -30.0]) / 350.0) ** 2)) -
          2400.0 * Math.exp(-((distance(p, [168.0, -30.0]) / 350.0) ** 2)),
      );
    }
    const data = {
      label: "GFS synthetic",
      referenceTime: 0,
      steps: [{ time: 0, fields: { mslp: { grid: g, values } } }],
    };
    const b = { west: 160.0, east: -164.0, south: -43.0, north: -17.0 };
    const file = detect(data, b);
    assert.equal(file.steps.length, 1);
    assert.deepEqual(file.steps[0].lines, []);
    const centres = file.steps[0].centres;
    assert.equal(centres.length, 2, JSON.stringify(centres));
    for (const [kind, lon] of [
      ["low", 168.0],
      ["high", 188.0],
    ]) {
      const c = centres.find((c) => c.kind === kind);
      assert.ok(c, `no ${kind}`);
      assert.ok(Math.abs(c.lon - lon) < 0.6, JSON.stringify(c));
      assert.ok(Math.abs(c.lat + 30.0) < 0.6, JSON.stringify(c));
    }
    assert.deepEqual(
      detect(data, { ...b, west: 167.5, east: 188.5 }).steps[0].centres,
      [],
    );
  });

  test("thermal classification and true motion", () => {
    for (const [wind, kind, motion] of [
      [8.0, "cold", 90.0],
      [-8.0, "warm", 270.0],
      [0.0, "stationary", null],
    ]) {
      const data = thermalSynthetic(wind, false);
      const file = detect(data, area());
      assert.equal(file.method, "thermal-front-parameter");
      const lines = file.steps[0].lines;
      assert.equal(lines.length, 1, JSON.stringify(lines));
      assert.equal(lines[0].kind, kind);
      assert.ok(lines[0].length_km > 850.0);
      assert.ok(lines[0].strength >= 0.3);
      for (const p of lines[0].points) {
        assert.ok(p[0] >= 176.0 && p[0] <= 184.0, JSON.stringify(p));
      }
      for (let i = 0; i + 1 < lines[0].points.length; i++) {
        assert.ok(
          Math.abs(lines[0].points[i + 1][0] - lines[0].points[i][0]) < 1.0,
        );
      }
      assert.equal(lines[0].shift_deg, undefined);
      if (motion !== null) {
        assert.ok(
          Math.abs(lines[0].motion_deg - motion) < 5.0,
          JSON.stringify(lines[0]),
        );
        assert.ok(Math.abs(lines[0].speed_kn - 15.6) < 0.2);
      } else {
        assert.equal(lines[0].motion_deg, undefined);
        assert.equal(lines[0].speed_kn, undefined);
      }
    }
  });

  test("uniform temperature has no fronts", () => {
    const file = detect(thermalSynthetic(8.0, true), area());
    assert.deepEqual(file.steps[0].lines, []);
  });
});

/**
 * The reference's thermal synthetic: the wind-shift forecast (no
 * pressure trough) plus an 850 hPa temperature front (tanh fold at
 * `foldLon`) pushed by an 850 hPa zonal wind.
 *
 * @param {number} wind - 850 hPa zonal wind, m/s
 * @param {boolean} uniform - Uniform temperature: no front
 * @param {number} [foldLon] - Temperature fold meridian
 * @returns {{label: string, referenceTime: number, steps: Array}}
 */
function thermalSynthetic(wind, uniform, foldLon = 179.0) {
  const data = synthetic({ shift: true, trough: false });
  const grid = syntheticGrid();
  const f32 = (v) => Math.fround(v);
  const temp = new Float64Array(grid.nlat * grid.nlon);
  const u850 = new Float64Array(grid.nlat * grid.nlon);
  const v850 = new Float64Array(grid.nlat * grid.nlon);
  for (let j = 0; j < grid.nlat; j++) {
    for (let i = 0; i < grid.nlon; i++) {
      const lon = grid.lon0 + i * grid.dlon;
      const k = j * grid.nlon + i;
      temp[k] = f32(
        280.0 + (uniform ? 0.0 : 12.0 * Math.tanh((lon - foldLon) / 0.7)),
      );
      u850[k] = f32(wind);
      v850[k] = 0.0;
    }
  }
  data.steps[0].fields.temp_850hpa = { grid, values: temp };
  data.steps[0].fields.wind_u_850hpa = { grid, values: u850 };
  data.steps[0].fields.wind_v_850hpa = { grid, values: v850 };
  return data;
}

describe("fronts classification internals (ported from the reference tests)", () => {
  test("type changes share boundaries and short runs merge", () => {
    const points = [];
    for (let i = 0; i <= 12; i++) {
      points.push([180.0, -26.0 - i]);
    }
    const speeds = points.map((_, i) => (i < 6 ? 8.0 : -8.0));
    const runs = splitTypes(points, speeds, 1.5);
    assert.equal(runs.length, 2, JSON.stringify(runs));
    assert.equal(runs[0][0], "cold");
    assert.equal(runs[1][0], "warm");
    const last = runs[0][1][runs[0][1].length - 1];
    const first = runs[1][1][0];
    assert.ok(last[0] === first[0] && last[1] === first[1]);
    const short = points.map((_, i) => (i === 6 ? -8.0 : 8.0));
    const merged = splitTypes(points, short, 1.5);
    assert.equal(merged.length, 1);
    assert.equal(merged[0][0], "cold");
  });

  test("wind gaps do not join separate classification runs", () => {
    const points = [
      [180.0, -26.0],
      [180.0, -27.0],
      [180.0, -28.0],
      [180.0, -29.0],
      [180.0, -30.0],
    ];
    const runs = splitTypes(points, [8.0, 8.0, NaN, 8.0, 8.0], 1.5);
    assert.equal(runs.length, 2);
    assert.deepEqual(runs[0][1], points.slice(0, 2));
    assert.deepEqual(runs[1][1], points.slice(3));
  });

  test("mask roots clip a crossing inside a cell", () => {
    const roots = [];
    maskRoots([0.0, 2.0, 2.0, 0.0], [0.0, 0.5], [1.0, 0.5], 0.6, roots);
    assert.equal(roots.length, 1);
    assert.ok(Math.abs(roots[0] - 0.3) < 1e-10);
  });

  test("eigenvector sign seams do not manufacture contours", () => {
    const signs = orientation([-1.0, -1.0, 1.0, 1.0], [0.0, 0.0, 0.0, 0.0]);
    assert.ok(signs, "orientation failed");
    const rawG = [-2.0, -3.0, 3.0, 2.0];
    assert.ok(marching(rawG).length > 0);
    const aligned = rawG.map((v, i) => v * signs[i]);
    assert.deepEqual(marching(aligned), []);
  });

  test("classify shares endpoints and absorbs short runs into the longer neighbour", () => {
    const points = [
      [180.0, -20.0],
      [180.0, -22.0],
      [180.0, -24.0],
      [180.0, -26.0],
    ];
    const runs = splitTypes(points, [8.0, 0.0, -8.0, -8.0], 2.5);
    assert.equal(runs.length, 2, JSON.stringify(runs));
    assert.equal(runs[0][0], "cold");
    assert.equal(runs[1][0], "warm");
    // The type-change boundary is shared: the cold run ends where
    // the warm one begins.
    const coldEnd = runs[0][1][runs[0][1].length - 1];
    const warmStart = runs[1][1][0];
    assert.deepEqual(coldEnd, warmStart);
    assert.ok(Math.abs(coldEnd[1] + 21.375) < 0.01, JSON.stringify(coldEnd));
  });
});
