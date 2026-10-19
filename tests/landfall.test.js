const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const estimatorPromise = import("../public/landfall-estimator.mjs");
const tilesPromise = import("../public/landfall-tiles.mjs");
const mvtPromise = import("../public/vendor/mvt/pbf.js").then((mvt) =>
  import("../public/vendor/mvt/vector-tile.js").then((vt) => ({
    ...mvt,
    ...vt,
  })),
);

/** Southbound hourly track rows (6 kn) for the synthetic passages. */
function track({ startLat = -18, endLat = -22, lon = -173.98 } = {}) {
  const rows = [];
  for (let lat = startLat; lat > endLat; lat -= 0.1) {
    rows.push({
      hoursFromNow: rows.length,
      timestamp: new Date(
        Date.UTC(2026, 5, 21, 0, 0, 0) + rows.length * 3600000,
      ).toISOString(),
      lat: Math.round(lat * 1000) / 1000,
      lon,
      distanceFromStartNm: rows.length * 6,
    });
  }
  return rows;
}

/** Terrain profile builder: bands of land (meters) by latitude. */
function terrain(bands) {
  return async (lat, _lon) => {
    for (const [from, to, meters] of bands) {
      if (lat >= from && lat <= to) {
        return meters;
      }
    }
    return 0;
  };
}

/** Landfall config for fast synthetic tests: 40 nm corridor, 2 h gate. */
const FAST = {
  landfall_enabled: true,
  height_of_eye_m: 3,
  landfall_max_range_nm: 40,
  landfall_min_offshore_hours: 2,
};

describe("landfall estimator", () => {
  test("visual horizon follows 2.08·(√h_eye + √H)", async () => {
    const { visualHorizonNm } = await estimatorPromise;
    approx(visualHorizonNm(3, 0), 2.08 * Math.sqrt(3));
    approx(visualHorizonNm(3, 100), 2.08 * (Math.sqrt(3) + 10));
    approx(visualHorizonNm(0, 0), 0);
  });

  test("tile math hits the Vava'u ground truth", async () => {
    const { tileFor } = await estimatorPromise;
    // Neiafu, Vava'u: the dev machine's corridor archive covers it
    assert.deepEqual(tileFor(-18.65, -173.98, 12), { x: 68, y: 2264 });
    assert.deepEqual(tileFor(-18.65, -173.98, 8), { x: 4, y: 141 });
  });

  test("resample: step, bearing, timestamps and distance interpolate", async () => {
    const { resampleTrack } = await estimatorPromise;
    const rows = track({ startLat: -18, endLat: -18.5 });
    const samples = resampleTrack(rows);
    assert.ok(samples.length >= 49, `got ${samples.length} samples`);
    const first = samples[0];
    approx(first.lat, -18, 1e-9);
    approx(first.bearingDeg, 180, 1e-6);
    approx(first.hoursFromNow, 0, 1e-9);
    approx(first.distanceFromStartNm, 0, 1e-9);
    // Consecutive samples are ~0.5 nm apart, due south
    approx(samples[1].lat - samples[0].lat, -0.5 / 60, 0.01);
    // The last sample is the track's own end
    const last = samples[samples.length - 1];
    approx(last.lat, -18.4, 1e-9);
    approx(last.hoursFromNow, 4, 1e-9);
  });

  test("open sea: no land, no episodes", async () => {
    const { estimateLandfalls } = await estimatorPromise;
    const episodes = await estimateLandfalls({
      track: track(),
      elevation: terrain([]),
      config: FAST,
    });
    assert.deepEqual(episodes, []);
  });

  test("departure next to land: nothing reported until the initial land is gone and the gate ran", async () => {
    const { estimateLandfalls } = await estimatorPromise;
    // Headland south of the start (the departure land), then a long
    // offshore stretch, then the destination coast at -21
    const episodes = await estimateLandfalls({
      track: track({ endLat: -22 }),
      elevation: terrain([
        [-18.5, -18.3, 30],
        [-Infinity, -21, 50],
      ]),
      config: FAST,
    });
    assert.equal(
      episodes.length,
      1,
      JSON.stringify(episodes.map((e) => [e.hoursFromNow, e.lat])),
    );
    const [final] = episodes;
    assert.equal(final.final, true);
    // The sighting happens on the 50 m coast (horizon ≈ 18.3 nm),
    // well after the gate — never on the departure headland
    assert.ok(final.lat <= -21, `sighted at ${final.lat}`);
    // The gate ran: at least 2 h since the headland passed astern
    assert.ok(final.hoursFromNow >= 2, `sighted at +${final.hoursFromNow}h`);
    assert.equal(final.name, "land"); // No gazetteer wired
    assert.ok(
      final.advisory.includes("land visible at 180° True"),
      final.advisory,
    );
  });

  test("mid-ocean start: the first horizon break reports immediately", async () => {
    const { estimateLandfalls } = await estimatorPromise;
    // No initial land anywhere in the corridor — only the far coast
    const episodes = await estimateLandfalls({
      track: track({ endLat: -22 }),
      elevation: terrain([[-Infinity, -20.5, 50]]),
      config: FAST,
    });
    assert.equal(episodes.length, 1);
    // Sightable (≈18.3 nm horizon) from about -20.2, not gated further
    assert.ok(
      episodes[0].hoursFromNow < 24,
      `sighted at +${episodes[0].hoursFromNow}h`,
    );
    assert.ok(episodes[0].final);
  });

  test("island chain: two gated episodes, only the last is final", async () => {
    const { estimateLandfalls } = await estimatorPromise;
    // Island 1 at -18.5 (visible ≈15 nm), island 2 at -20.5 — 120 nm
    // apart, 2 h at 6 kn is 12 nm, so the gate separates them — and
    // the far coast past -22 is beyond the track end
    const episodes = await estimateLandfalls({
      track: track({ endLat: -21 }),
      elevation: terrain([
        [-18.55, -18.45, 30],
        [-20.55, -20.45, 30],
        [-Infinity, -21, 50],
      ]),
      config: FAST,
    });
    assert.ok(
      episodes.length >= 2,
      `got ${episodes.length}: ${JSON.stringify(episodes.map((e) => [e.hoursFromNow, e.lat]))}`,
    );
    assert.ok(!episodes[0].final);
    assert.ok(episodes[episodes.length - 1].final);
  });

  test("no DEM data is neither land nor open-water proof", async () => {
    const { estimateLandfalls } = await estimatorPromise;
    const episodes = await estimateLandfalls({
      track: track({ endLat: -19 }),
      elevation: async () => null,
      config: FAST,
    });
    assert.deepEqual(episodes, []);
  });

  test("land beyond the scan range never reports", async () => {
    const { estimateLandfalls } = await estimatorPromise;
    // Coast 80 nm west of the course — outside the 40 nm corridor
    const episodes = await estimateLandfalls({
      track: track({ endLat: -19 }),
      elevation: async (lat, lon) => (lon < -174.6 && lat < -18.5 ? 100 : 0),
      config: FAST,
    });
    assert.deepEqual(episodes, []);
  });

  test("advisory string", async () => {
    const { landfallAdvisory } = await estimatorPromise;
    assert.equal(
      landfallAdvisory({
        timestamp: "2026-06-21T14:30:00.000Z",
        name: "Neiafu",
        bearingTrue: 230,
      }),
      "At 14:30 assumed landfall, Neiafu visible at 230° True.",
    );
    assert.equal(
      landfallAdvisory(
        {
          timestamp: "2026-06-21T14:30:00.000Z",
          name: "Neiafu",
          bearingTrue: 230,
        },
        () => "03:30 +13",
      ),
      "At 03:30 +13 assumed landfall, Neiafu visible at 230° True.",
    );
  });

  test("configuration defaults exist", async () => {
    const { LANDFALL_DEFAULTS } = await estimatorPromise;
    assert.equal(LANDFALL_DEFAULTS.landfall_enabled, true);
    assert.equal(LANDFALL_DEFAULTS.height_of_eye_m, 3);
    assert.equal(LANDFALL_DEFAULTS.landfall_max_range_nm, 120);
    assert.equal(LANDFALL_DEFAULTS.landfall_min_offshore_hours, 12);
  });
});

describe("landfall tile readers", () => {
  test("terrarium decode: sea is zero, land rises", async () => {
    const { terrariumElevation } = await tilesPromise;
    approx(terrariumElevation(128, 0, 0), 0, 1e-9);
    approx(terrariumElevation(128, 8, 0), 8, 1e-9);
    approx(terrariumElevation(132, 150, 0), 1174, 1e-9);
  });

  test("chart picking: the Mapterhorn elevation and the Shortbread base", async () => {
    const { pickLandfallCharts } = await tilesPromise;
    const { elevation, base } = pickLandfallCharts([
      { name: "Signal K Corridor Cache", format: "pbf" },
      { name: "Signal K Corridor Cache — seascape-dem", format: "webp" },
      {
        name: "Signal K Corridor Cache — elevation",
        format: "webp",
        url: "/e/{z}/{x}/{y}.webp",
      },
      {
        name: "Signal K Corridor Cache — versatiles-shortbread",
        format: "pbf",
        url: "/b/{z}/{x}/{y}.pbf",
      },
      { name: "Signal K Corridor Cache — seascape-vector", format: "pbf" },
    ]);
    assert.equal(elevation?.url, "/e/{z}/{x}/{y}.webp");
    assert.equal(base?.url, "/b/{z}/{x}/{y}.pbf");
    // Missing sources come back null, not thrown
    assert.deepEqual(pickLandfallCharts([]).elevation, null);
  });

  test("elevation reader: URL, zoom fallback, cache and pixel math", async () => {
    const { createElevationReader } = await tilesPromise;
    const layer = {
      name: "elevation",
      url: "/tiles/elevation-{z}-{x}-{y}.webp",
      minZoom: 0,
      maxZoom: 12,
      format: "webp",
    };
    const requested = [];
    const fetchImpl = async (url) => {
      requested.push(String(url));
      // The corridor's top zoom has the tile; everything below 404s
      if (url.includes("elevation-12-68-2264")) {
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
      }
      return { ok: false, status: 404 };
    };
    // A raster that encodes its own pixel address
    const decodeTile = async () => ({
      width: 256,
      height: 256,
      elevationAt: (x, y) => y * 256 + x,
    });
    const elevation = createElevationReader(layer, { fetchImpl, decodeTile });
    const value = await elevation(-18.65, -173.98);
    assert.ok(
      requested[0].includes("elevation-12-68-2264"),
      `first fetch should hit the z12 Vava'u tile, got ${requested[0]}`,
    );
    // The value comes from the pixel the Web-Mercator math selects
    const px = Math.round((((-173.98 + 180) / 360) * 4096 - 68) * 256);
    const py = Math.round(
      (((1 - Math.asinh(Math.tan((-18.65 * Math.PI) / 180)) / Math.PI) / 2) *
        4096 -
        2264) *
        256,
    );
    assert.equal(value, py * 256 + px);
    // Cached: a second read costs no fetch
    await elevation(-18.65, -173.98);
    assert.equal(requested.length, 1);
  });

  test("elevation reader: missing tiles walk down to the coarse zooms, then null", async () => {
    const { createElevationReader } = await tilesPromise;
    const layer = {
      name: "elevation",
      url: "/t/{z}/{x}/{y}",
      minZoom: 6,
      maxZoom: 12,
    };
    const requested = [];
    const fetchImpl = async (url) => {
      requested.push(String(url));
      if (String(url).includes("/t/10/")) {
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
      }
      return { ok: false, status: 404 };
    };
    const decodeTile = async () => ({
      width: 64,
      height: 64,
      elevationAt: () => 42,
    });
    const elevation = createElevationReader(layer, { fetchImpl, decodeTile });
    assert.equal(await elevation(-18.65, -173.98), 42);
    assert.ok(requested[0].includes("/t/12/"), requested[0]);
    assert.ok(requested[1].includes("/t/11/"), requested[1]);
    assert.ok(requested[2].includes("/t/10/"), requested[2]);
    // Nothing anywhere: all zooms tried, null returned
    const exhausted = createElevationReader(
      { ...layer, maxZoom: 6 },
      { fetchImpl: async () => ({ ok: false, status: 404 }), decodeTile },
    );
    assert.equal(await exhausted(-18.65, -173.98), null);
  });

  test("nearest named place in a hand-built MVT place tile", async () => {
    const { nearestPlaceInLayer } = await tilesPromise;
    const { PbfWriter, PbfReader, VectorTile } = await mvtPromise;
    const zig = (n) => (n << 1) ^ (n >> 31);
    // MVT proto field numbers: Layer name=1, features=2, keys=3,
    // values=4, extent=5, version=15; Feature tags=2, type=3,
    // geometry=4. Message fields are length-delimited bytes, so
    // sub-messages embed as bytes.
    const feature = (px, py, valueIndex) => {
      const w = new PbfWriter();
      w.writeVarintField(3, 1); // type POINT
      w.writePackedVarint(2, [0, valueIndex, 1, 1]); // name=<v>, kind=town
      w.writePackedVarint(4, [9, zig(px), zig(py)]); // MoveTo
      return w.finish();
    };
    const value = (text) => {
      const w = new PbfWriter();
      w.writeStringField(1, text);
      return w.finish();
    };
    const layer = new PbfWriter();
    layer.writeVarintField(15, 2); // version
    layer.writeStringField(1, "place_labels");
    layer.writeBytesField(2, feature(2024, 597, 0));
    layer.writeBytesField(2, feature(800, 3000, 2));
    layer.writeStringField(3, "name");
    layer.writeStringField(3, "kind");
    layer.writeBytesField(4, value("Neiafu"));
    layer.writeBytesField(4, value("town"));
    layer.writeBytesField(4, value("Faleolo"));
    layer.writeVarintField(5, 4096); // extent
    const tile = new PbfWriter();
    tile.writeBytesField(3, layer.finish());
    const mvt = new VectorTile(new PbfReader(tile.finish()));
    const mvtLayer = mvt.layers["place_labels"];
    assert.ok(mvtLayer, "place_labels layer present");
    // Query Neiafu's own pixel: z12 tile 68/2264
    const place = nearestPlaceInLayer(mvtLayer, 12, 68, 2264, -18.673, -173.98);
    assert.equal(place?.name, "Neiafu");
    assert.equal(place?.kind, "town");
  });
});

function approx(actual, expected, epsilon = 1e-4) {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} ≈ ${expected} (±${epsilon})`,
  );
}
