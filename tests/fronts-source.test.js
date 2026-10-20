/**
 * Unit tests for the fronts source (work doc #50): reading the
 * weather provider's grid caches, run selection, passage
 * computation against a schedule, and — above all — graceful
 * degradation: missing caches, missing variables, corrupt slices
 * and uncovered routes must narrow the result, never fail the
 * briefing.
 *
 * The fixture reuses the porting suite's GFS pressure-only analysis
 * (a real front) as synthetic cache slices, moved one grid row
 * north per step so a track forms and crosses a fixed position.
 *
 * @file fronts-source.test.js
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  readSlice,
  listCacheSlices,
  covers,
  selectRun,
  boatGateBbox,
  scheduleFromRows,
  defaultCacheRoot,
  attachFronts,
  FRONTS_SOURCE,
} = require("../plugin/fronts-source.js");
const { detect } = require("../plugin/fronts-detect.js");

const VECTORS = join(__dirname, "..", "front-detector", "porting", "vectors");

/** The porting suite's GFS pressure-only analysis. */
const VECTOR = JSON.parse(
  readFileSync(join(VECTORS, "gfs-2026100618-pressure-only.json"), "utf8"),
);

/**
 * The vector's decoded fields as f32 arrays, keyed by cache
 * variable name.
 *
 * @returns {{referenceTime: number, grid: object, fields: object}}
 */
function vectorField() {
  const fields = {};
  for (const f of VECTOR.input.fields) {
    fields[f.variable] = Float32Array.from(f.values);
  }
  return {
    referenceTime: VECTOR.input.reference_time,
    grid: VECTOR.input.fields[0].grid,
    fields,
  };
}

/**
 * A stable mid-line vertex of the vector's untyped wind-shift
 * front (the `front` line): the fixed test position sits 0.3° north
 * of it — south of the front the boat is *before* the passage — so
 * the front, moved north a row per step, passes the boat between
 * the first steps. A mid-line vertex stays clear of the grid-edge
 * artefacts the row-shifted fixture produces at the line's tips.
 *
 * @returns {{lat: number, lon: number}}
 */
const frontVertex = (() => {
  let cached = null;
  return () => {
    if (cached === null) {
      const step = {
        time: VECTOR.input.reference_time,
        fields: {},
      };
      for (const f of VECTOR.input.fields) {
        step.fields[f.variable] = {
          grid: { ...f.grid, isGlobalLon: f.grid.is_global_lon },
          values: Float64Array.from(f.values, (x) => Math.fround(x)),
        };
      }
      const out = detect(
        {
          label: "gfs test",
          referenceTime: VECTOR.input.reference_time,
          steps: [step],
        },
        null,
      );
      const front = out.steps[0].lines.find((l) => l.kind === "front");
      let best = front.points[0];
      for (const p of front.points) {
        if (Math.abs(p[1] + 33.5) < Math.abs(best[1] + 33.5)) {
          best = p;
        }
      }
      cached = { lat: best[1], lon: best[0] };
    }
    return cached;
  };
})();

/** The fixed test position: north of the front's mid-line vertex. */
function testPosition() {
  const vertex = frontVertex();
  return { lat: vertex.lat + 0.3, lon: vertex.lon };
}

/**
 * Encodes one `.gribcache` slice, byte-compatible with the
 * provider's writer (GRBC v2, JSON header, row-major
 * var-interleaved float32 LE).
 *
 * @param {object} params
 * @param {object} params.grid - The vector's grid (northernmost row
 *   first)
 * @param {string[]} params.vars - Cache variable names
 * @param {Record<string, Float32Array>} params.values - Per variable
 * @param {number} params.validAt - Unix seconds
 * @param {number} params.refTime - Unix seconds
 * @returns {Buffer}
 */
function encodeSlice({ grid, vars, values, validAt, refTime }) {
  const meta = {
    latFirst: grid.lat0,
    lonFirst: grid.lon0,
    dLat: grid.dlat,
    dLon: grid.dlon,
    nLat: grid.nlat,
    nLon: grid.nlon,
    jScansPositively: false,
    validAt: new Date(validAt * 1000).toISOString(),
    refTime: new Date(refTime * 1000).toISOString(),
    vars,
    precipAccum: null,
  };
  const metaJson = Buffer.from(JSON.stringify(meta), "utf-8");
  const header = Buffer.alloc(9);
  header.write("GRBC", 0, "ascii");
  header.writeUInt8(2, 4);
  header.writeUInt32BE(metaJson.length, 5);
  const points = grid.nlat * grid.nlon;
  const data = Buffer.alloc(points * vars.length * 4);
  for (let p = 0; p < points; p++) {
    for (let v = 0; v < vars.length; v++) {
      data.writeFloatLE(values[vars[v]][p], (p * vars.length + v) * 4);
    }
  }
  return Buffer.concat([header, metaJson, data]);
}

/** Cache variable → detector field name. */
const CACHE_TO_DETECTOR = {
  pressure: "mslp",
  windU: "wind_u_10m",
  windV: "wind_v_10m",
  temp850: "temp_850hpa",
  windU850: "wind_u_850hpa",
  windV850: "wind_v_850hpa",
};

/**
 * Writes a synthetic run under `<root>/<source>/`: the vector's
 * fields moved one grid row further north at each step, 3-hourly.
 *
 * @param {string} root - Cache root
 * @param {object} [options]
 * @param {number} [options.steps] - Step count
 * @param {string[]} [options.vars] - Cache variables per slice
 * @param {string} [options.source] - Source directory name
 * @returns {string} The cache directory written
 */
function writeRun(
  root,
  {
    steps = 5,
    vars = ["pressure", "windU", "windV"],
    source = "gfs-0p25",
  } = {},
) {
  const dir = join(root, source);
  mkdirSync(dir, { recursive: true });
  const { referenceTime: refTime, grid, fields } = vectorField();
  const n = grid.nlat * grid.nlon;
  for (let i = 0; i < steps; i++) {
    const shifted = {};
    for (const cacheVar of vars) {
      const data = fields[CACHE_TO_DETECTOR[cacheVar]];
      if (!data) {
        continue;
      }
      const out = new Float32Array(n);
      for (let row = 0; row < grid.nlat; row++) {
        const sourceRow = Math.min(grid.nlat - 1, row + i);
        out.set(
          data.subarray(sourceRow * grid.nlon, (sourceRow + 1) * grid.nlon),
          row * grid.nlon,
        );
      }
      shifted[cacheVar] = out;
    }
    const validAt = refTime + i * 10800;
    const stamp = (t) =>
      new Date(t * 1000).toISOString().replace(/[-:T]/g, "").slice(0, 12);
    writeFileSync(
      join(
        dir,
        `gfs__${stamp(refTime)}__f${String(i * 3).padStart(3, "0")}.t${stamp(validAt)}.gribcache`,
      ),
      encodeSlice({ grid, vars, values: shifted, validAt, refTime }),
    );
  }
  return dir;
}

/** Route waypoints around the fixed test position (inside the grid). */
function routeAround(position) {
  return [
    { lat: position.lat - 0.2, lon: position.lon - 0.2 },
    { lat: position.lat + 0.2, lon: position.lon + 0.2 },
  ];
}

describe("fronts source: cache reading", () => {
  test("reads a provider-format slice back", async () => {
    const root = mkdtempSync(join(tmpdir(), "fronts-"));
    try {
      writeRun(root, { steps: 1 });
      const slices = await listCacheSlices(root);
      assert.equal(slices.length, 1);
      const parsed = await readSlice(slices[0].path);
      assert.ok(parsed, "slice unreadable");
      assert.equal(parsed.fields.mslp.values.length, 103 * 103);
      assert.ok(parsed.fields.wind_u_10m.values);
      assert.ok(parsed.fields.wind_v_10m.values);
      assert.equal(parsed.fields.temp_850hpa, undefined);
      assert.equal(parsed.fields.mslp.grid, parsed.grid);
      assert.ok(Math.abs(parsed.time - VECTOR.input.reference_time) < 1);
      assert.equal(parsed.grid.isGlobalLon, false);
      assert.ok(Math.abs(parsed.grid.lat0 - -19.75) < 1e-9);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unreadable files degrade to null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fronts-"));
    try {
      const file = join(dir, "bad.gribcache");
      writeFileSync(file, Buffer.from("not a cache file"));
      assert.equal(await readSlice(file), null);
      assert.equal(await readSlice(join(dir, "missing.gribcache")), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fronts source: run selection", () => {
  test("picks the covering run", async () => {
    const root = mkdtempSync(join(tmpdir(), "fronts-root-"));
    try {
      writeRun(root, { steps: 5 });
      const selected = await selectRun(
        await listCacheSlices(root),
        boatGateBbox(routeAround(testPosition())),
      );
      assert.ok(selected, "no run selected");
      assert.equal(selected.source, "gfs-0p25");
      assert.equal(selected.steps.length, 5);
      assert.equal(selected.method, "trough-wind-shift");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a run without pressure is skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "fronts-root-"));
    try {
      writeRun(root, { steps: 5, vars: ["windU", "windV"] });
      const selected = await selectRun(
        await listCacheSlices(root),
        boatGateBbox(routeAround(testPosition())),
      );
      assert.equal(selected, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a run not covering the boat is skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "fronts-root-"));
    try {
      writeRun(root, { steps: 5 });
      const farAway = { south: 10, north: 20, west: -30, east: -20 };
      assert.equal(await selectRun(await listCacheSlices(root), farAway), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a boat-centered run counts as covering: the boat gate is the route start, not the whole route", () => {
    // The downloader's default area is boat-centered: mid-passage
    // the freshest run reaches the boat's surroundings, while the
    // route runs on for hundreds of miles. The gate must be the
    // route's start (the boat), not the route bbox — the Tonga–New
    // Zealand case that shipped broken.
    const waypoints = [
      { lat: -26.5, lon: 190 },
      { lat: -30.0, lon: 187 },
      { lat: -35.3, lon: 174.1 },
    ];
    const gate = boatGateBbox(waypoints);
    assert.deepEqual(gate, {
      south: -27.5,
      north: -25.5,
      west: 189,
      east: 191,
    });
    // A grid reaching the boat but not the rest of the route:
    const grid = {
      lat0: -23,
      lon0: 183.5,
      dlat: 0.25,
      dlon: 0.25,
      nlat: 29,
      nlon: 83,
    };
    assert.equal(covers(grid, gate), true);
    // The whole-route bbox would have failed it:
    assert.equal(
      covers(grid, { south: -35.5, north: -18.5, west: 174.0, east: 191 }),
      false,
    );
    // A gate with no usable start is no gate at all.
    assert.equal(boatGateBbox([]), null);
    assert.equal(boatGateBbox([{ lat: NaN, lon: 0 }]), null);
  });
});

describe("fronts source: route schedule", () => {
  test("interpolates between hourly rows", () => {
    const positionAt = scheduleFromRows([
      { time: 1000, lat: -30, lon: 175 },
      { time: 4000, lat: -31, lon: 176 },
    ]);
    assert.ok(positionAt);
    const [lat, lon] = positionAt(2500);
    assert.ok(Math.abs(lat - -30.5) < 1e-9);
    assert.ok(Math.abs(lon - 175.5) < 1e-9);
    assert.equal(positionAt(1000), null);
    assert.equal(positionAt(4000), null);
  });

  test("too few rows give no schedule", () => {
    assert.equal(scheduleFromRows([{ time: 1, lat: 0, lon: 0 }]), null);
    assert.equal(scheduleFromRows([]), null);
  });
});

describe("fronts source: attachFronts degradation (work doc #50)", () => {
  test("no caches at all: absent, no block, checklist absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "fronts-empty-"));
    try {
      const payload = {};
      const records = [];
      const result = await attachFronts(payload, {
        waypoints: [{ lat: -30, lon: 175 }],
        cacheRoot: root,
        dataDir: root,
        app: {},
        config: {},
        recordSource: (r) => records.push(r),
      });
      assert.equal(result.attached, false);
      assert.equal(payload.fronts, undefined);
      assert.equal(records.length, 1);
      assert.equal(records[0].id, FRONTS_SOURCE.id);
      assert.equal(records[0].absent, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing cache root: absent", async () => {
    const payload = {};
    const records = [];
    const result = await attachFronts(payload, {
      waypoints: [{ lat: -30, lon: 175 }],
      cacheRoot: join(tmpdir(), "fronts-does-not-exist-xyz"),
      dataDir: tmpdir(),
      app: {},
      config: {},
      recordSource: (r) => records.push(r),
    });
    assert.equal(result.attached, false);
    assert.equal(records[0].absent, true);
  });

  test("no waypoints: absent without reading anything", async () => {
    const payload = {};
    const records = [];
    const result = await attachFronts(payload, {
      waypoints: [],
      cacheRoot: tmpdir(),
      dataDir: tmpdir(),
      app: {},
      config: {},
      recordSource: (r) => records.push(r),
    });
    assert.equal(result.reason, "no-route");
    assert.equal(records[0].absent, true);
  });

  test("a corrupt slice among good ones drops out, the run continues", async () => {
    const root = mkdtempSync(join(tmpdir(), "fronts-corrupt-"));
    try {
      const dir = writeRun(root, { steps: 5 });
      writeFileSync(
        join(dir, "broken.t20261006000000.gribcache"),
        Buffer.from("junk"),
      );
      const position = testPosition();
      const payload = {};
      const records = [];
      const result = await attachFronts(payload, {
        waypoints: routeAround(position),
        cacheRoot: root,
        dataDir: root,
        app: {},
        config: {},
        schedule: () => [position.lat, position.lon],
        recordSource: (r) => records.push(r),
      });
      assert.equal(
        result.attached,
        true,
        JSON.stringify(result.reason ?? result.error),
      );
      assert.ok(payload.fronts, "no fronts block");
      assert.equal(payload.fronts.model, "gfs-0p25");
      assert.equal(payload.fronts.method, "trough-wind-shift");
      assert.ok(payload.fronts.caveat.length > 20);
      // The broken file contributed nothing; the good steps remain.
      assert.ok(payload.fronts.steps.length >= 4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pressure-only run with a crossing schedule publishes passages", async () => {
    const root = mkdtempSync(join(tmpdir(), "fronts-pass-"));
    try {
      writeRun(root, { steps: 5 });
      const position = testPosition();
      const payload = {};
      const result = await attachFronts(payload, {
        waypoints: routeAround(position),
        cacheRoot: root,
        dataDir: root,
        app: {},
        config: {},
        schedule: () => [position.lat, position.lon],
      });
      assert.equal(
        result.attached,
        true,
        JSON.stringify(result.reason ?? result.error),
      );
      assert.equal(
        result.passageCount,
        1,
        JSON.stringify(payload.fronts?.passages),
      );
      const passage = payload.fronts.passages[0];
      assert.equal(passage.kind, "front");
      assert.ok(passage.trackId >= 1);
      assert.ok(Math.abs(passage.lat - position.lat) < 0.01);
      assert.ok(Math.abs(passage.lon - position.lon) < 0.01);
      assert.ok(passage.shiftDeg >= 60, `shift ${passage.shiftDeg}`);
      assert.ok(passage.time.endsWith("Z"));
      // Per-step lines ride along for later map rendering; centres
      // stay out.
      assert.ok(payload.fronts.steps[0].lines.length > 0);
      assert.equal(payload.fronts.steps[0].centres, undefined);
      assert.ok(payload.fronts.provenance.label.includes("gfs-0p25"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no schedule: steps publish, passages stay empty", async () => {
    const root = mkdtempSync(join(tmpdir(), "fronts-nosched-"));
    try {
      writeRun(root, { steps: 5 });
      const payload = {};
      const result = await attachFronts(payload, {
        waypoints: routeAround(frontVertex()),
        cacheRoot: root,
        dataDir: root,
        app: {},
        config: {},
      });
      assert.equal(result.attached, true);
      assert.equal(result.passageCount, 0);
      assert.deepEqual(payload.fronts.passages, []);
      assert.ok(payload.fronts.steps.length >= 4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fronts source: helpers", () => {
  test("default cache root sits beside the provider's data dir", () => {
    assert.equal(
      defaultCacheRoot("/data/plugin-data/signalk-passage-briefing"),
      "/data/plugin-data/signalk-grib-weather-provider/cache",
    );
  });
});
