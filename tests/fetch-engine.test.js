const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, existsSync, readdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { forecastFixture, mockOpenMeteo } = require("./openmeteo-mock.js");

const {
  KEEP_SNAPSHOTS,
  sampleRoutePoints,
  routeDistanceNm,
  dewpointC,
  kIndex,
  normalizeLocations,
  fetchWeatherAlongTrack,
  savePayload,
  loadPayload,
  listCachedRoutes,
} = require("../plugin/fetch-engine.js");

const approx = (actual, expected, epsilon = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} ≈ ${expected} (±${epsilon})`,
  );

describe("route sampling", () => {
  test("divides a 90 nm meridian leg into even ≤30 nm steps", () => {
    const points = sampleRoutePoints(
      [
        [0, 0],
        [0, 1.5],
      ],
      30,
    );
    // 90.06 nm total → 4 steps of 22.5 nm
    assert.equal(points.length, 5);
    approx(points[0].distanceFromStartNm, 0);
    approx(points[1].distanceFromStartNm, 22.5, 0.1);
    approx(points[2].distanceFromStartNm, 45, 0.1);
    approx(
      points[4].distanceFromStartNm,
      routeDistanceNm([
        [0, 0],
        [0, 1.5],
      ]),
      0.1,
    );
    approx(points[2].lat, 0.75, 0.01);
    assert.equal(points[0].lon, 0);
  });

  test("keeps spacing uniform across multi-leg routes", () => {
    // 60 nm + 60 nm legs
    const points = sampleRoutePoints(
      [
        [0, 0],
        [0, 1],
        [1, 1],
      ],
      30,
    );
    const distances = points.map((p) => p.distanceFromStartNm);
    assert.equal(distances[0], 0);
    for (let i = 1; i < distances.length; i++) {
      approx(distances[i] - distances[i - 1], distances[1], 0.3);
    }
    approx(
      distances[distances.length - 1],
      routeDistanceNm([
        [0, 0],
        [0, 1],
        [1, 1],
      ]),
      0.1,
    );
  });

  test("single-point route and empty input", () => {
    assert.equal(sampleRoutePoints([[5, 55]]).length, 1);
    assert.deepEqual(sampleRoutePoints([]), []);
  });

  test("route distance", () => {
    approx(
      routeDistanceNm([
        [0, 0],
        [0, 1.5],
      ]),
      90,
      0.1,
    );
  });
});

describe("k-index", () => {
  test("dew point via Magnus", () => {
    approx(dewpointC(15, 80), 11.57, 0.01);
    approx(dewpointC(5, 60), -2.13, 0.01);
  });

  test("K = (T850−T500) + Td850 − (T700−Td700)", () => {
    const k = kIndex({ t850: 15, t700: 5, t500: -10, rh850: 80, rh700: 60 });
    approx(k, 29.44, 0.01);
  });

  test("null on missing inputs", () => {
    assert.equal(
      kIndex({ t850: 15, t700: 5, t500: null, rh850: 80, rh700: 60 }),
      null,
    );
  });
});

describe("normalizeLocations", () => {
  test("single object, array and null responses", () => {
    assert.deepEqual(normalizeLocations({ a: 1 }, 2), [{ a: 1 }, null]);
    assert.deepEqual(normalizeLocations([{ a: 1 }, { a: 2 }], 2), [
      { a: 1 },
      { a: 2 },
    ]);
    assert.deepEqual(normalizeLocations(null, 1), [null]);
  });
});

const WAYPOINTS = sampleRoutePoints([
  [0, 0],
  [0, 1.5],
]);

describe("fetchWeatherAlongTrack", () => {
  test("builds the SPEC §3.1 payload with unit conversions", async () => {
    const payload = await fetchWeatherAlongTrack({
      waypoints: WAYPOINTS,
      fetchImpl: mockOpenMeteo(),
    });
    assert.equal(payload.metadata.source, "api");
    assert.deepEqual(payload.metadata.models, [
      "forecast:best_match",
      "marine:ncep_gfswave025",
      "marine:smoc_currents",
    ]);
    assert.equal(payload.waypoints.length, 5);
    const [step] = payload.waypoints[0].forecasts;
    // First step is the current hour (fixture times are relative)
    const firstTimestamp = new Date(
      Date.now() - (Date.now() % 3600000),
    ).toISOString();
    assert.equal(step.timestamp, firstTimestamp);
    assert.deepEqual(step.surface, {
      tws: 12,
      twd: 45,
      mslp: 1013,
      gust: 18,
      cloudCover: 25,
    });
    assert.deepEqual(step.marine, {
      hsCombined: 1.2,
      tpCombined: 7,
      dirCombined: 160,
      hsSwell: 0.9,
      tpSwell: 9,
      dirSwell: 150,
      hsWindSea: 0.5,
      tpWindSea: 4,
      dirWindSea: 170,
    });
    assert.equal(step.upperAir.cape, 200);
    assert.equal(step.upperAir.kIndex, 29.4);
    assert.equal(step.upperAir.rh700, 60);
    assert.equal(step.upperAir.wind850kts, 20);
    // 1.852 km/h → 1 kn
    assert.equal(step.current.drift, 1);
    assert.equal(step.current.set, 45);
    assert.equal(
      payload.waypoints[4].distanceFromStartNm,
      routeDistanceNm([
        [0, 0],
        [0, 1.5],
      ]),
    );
  });

  test("aligns multi-location responses in request order", async () => {
    const waypoints = sampleRoutePoints([
      [0, 0],
      [0, 0.5],
    ]); // 30 nm → 3 points
    const multiForecast = [
      forecastFixture(),
      forecastFixture(),
      forecastFixture(),
    ];
    const payload = await fetchWeatherAlongTrack({
      waypoints,
      fetchImpl: mockOpenMeteo({ forecast: multiForecast }),
    });
    assert.equal(payload.waypoints.length, 3);
    assert.equal(payload.waypoints[0].forecasts[0].surface.tws, 12);
    assert.equal(payload.waypoints[2].forecasts[0].surface.tws, 12);
  });

  test("marine failure degrades gracefully", async () => {
    const payload = await fetchWeatherAlongTrack({
      waypoints: WAYPOINTS,
      fetchImpl: mockOpenMeteo({ throw: "ncep_gfswave025" }),
    });
    assert.deepEqual(payload.metadata.models, [
      "forecast:best_match",
      "marine:smoc_currents",
    ]);
    assert.equal(payload.waypoints[0].forecasts[0].marine.hsCombined, null);
    assert.equal(payload.waypoints[0].forecasts[0].surface.tws, 12);
  });

  test("forecast failure fails the fetch", async () => {
    await assert.rejects(
      fetchWeatherAlongTrack({
        waypoints: WAYPOINTS,
        fetchImpl: mockOpenMeteo({ throw: "/v1/forecast" }),
      }),
      /returned 500|network down/,
    );
  });

  test("retries a 500 before succeeding", async () => {
    let attempts = 0;
    const flaky = async (url) => {
      const u = String(url);
      if (u.includes("/v1/forecast") && attempts++ === 0) {
        return { ok: false, status: 500, statusText: "boom" };
      }
      return mockOpenMeteo()(url);
    };
    const payload = await fetchWeatherAlongTrack({
      waypoints: WAYPOINTS,
      fetchImpl: flaky,
    });
    assert.equal(payload.metadata.source, "api");
  });

  test("empty waypoints rejected", async () => {
    await assert.rejects(
      fetchWeatherAlongTrack({ waypoints: [], fetchImpl: mockOpenMeteo() }),
      /No waypoints/,
    );
  });
});

describe("payload cache", () => {
  test("save, load round-trip and snapshot pruning", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "passage-cache-"));
    const makePayload = (fetchedAt) => ({
      metadata: { fetchedAt, source: "api", models: ["forecast:best_match"] },
      waypoints: [],
    });

    for (let i = 0; i < KEEP_SNAPSHOTS + 3; i++) {
      await savePayload(
        dataDir,
        "route 1",
        makePayload(`2026-09-27T${String(i).padStart(2, "0")}:00:00Z`),
      );
    }

    const latest = await loadPayload(dataDir, "route 1");
    assert.equal(
      latest.payload.metadata.fetchedAt,
      `2026-09-27T${String(KEEP_SNAPSHOTS + 2).padStart(2, "0")}:00:00Z`,
    );
    assert.equal(
      latest.cachedAt,
      `2026-09-27T${String(KEEP_SNAPSHOTS + 2).padStart(2, "0")}:00:00Z`,
    );

    const snapshots = readdirSync(join(dataDir, "weather")).filter(
      (f) => f.startsWith("route%201-") && f.endsWith(".json"),
    );
    assert.equal(snapshots.length, KEEP_SNAPSHOTS);
    // Newest snapshot carries the same content as latest
    assert.ok(existsSync(join(dataDir, "weather", "latest-route%201.json")));

    const cached = await listCachedRoutes(dataDir);
    assert.deepEqual(cached, [
      {
        routeId: "route 1",
        cachedAt: `2026-09-27T${String(KEEP_SNAPSHOTS + 2).padStart(2, "0")}:00:00Z`,
      },
    ]);
  });

  test("missing cache reads null", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "passage-cache-"));
    assert.equal(await loadPayload(dataDir, "nope"), null);
    assert.deepEqual(await listCachedRoutes(dataDir), []);
  });
});
