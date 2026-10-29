const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, existsSync, readdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  forecastFixture,
  mockOpenMeteo,
  TIMES,
} = require("./openmeteo-mock.js");

const {
  KEEP_SNAPSHOTS,
  sampleRoutePoints,
  routeDistanceNm,
  dewpointC,
  kIndex,
  normalizeLocations,
  fetchWeatherAlongTrack,
  throttleWaypointForecasts,
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

describe("throttleWaypointForecasts", () => {
  const HOUR = 3600000;
  const FETCH = "2026-10-16T00:00:00.000Z";

  /** Builds one hourly step. */
  const step = (h) => ({
    timestamp: new Date(Date.parse(FETCH) + h * HOUR).toISOString(),
    surface: { tws: h },
  });

  test("keeps the whole horizon at every waypoint", () => {
    const waypoints = [
      {
        distanceFromStartNm: 0,
        forecasts: Array.from({ length: 168 }, (_, h) => step(h)),
      },
      {
        distanceFromStartNm: 210,
        forecasts: Array.from({ length: 168 }, (_, h) => step(h)),
      },
    ];
    throttleWaypointForecasts(waypoints);
    for (const [index, waypoint] of waypoints.entries()) {
      const stamps = waypoint.forecasts.map((f) =>
        Math.round((Date.parse(f.timestamp) - Date.parse(FETCH)) / HOUR),
      );
      // No ETA-window cropping (work doc #55 session safety pass): a
      // departure-day variant re-anchors the simulation to hours the
      // old windows never covered, and the plan then read weather
      // interpolated silently across the multi-day gap to the lone
      // tail step. Every waypoint spans its whole fetched horizon.
      assert.equal(stamps[0], 0, `waypoint ${index} starts at fetch`);
      assert.equal(
        stamps[stamps.length - 1],
        167,
        `waypoint ${index} spans to the horizon`,
      );
      for (let i = 1; i < stamps.length; i++) {
        assert.ok(
          stamps[i] - stamps[i - 1] <= 3,
          `waypoint ${index} bracket ${stamps[i - 1]}→${stamps[i]} stays tight`,
        );
      }
    }
  });

  test("hourly steps collapse to 3-hourly past the first day", () => {
    const waypoints = [
      {
        distanceFromStartNm: 0,
        forecasts: Array.from({ length: 168 }, (_, h) => step(h)),
      },
    ];
    throttleWaypointForecasts(waypoints);
    const stamps = waypoints[0].forecasts.map((f) =>
      Math.round((Date.parse(f.timestamp) - Date.parse(FETCH)) / HOUR),
    );
    // 24 hourly steps, then every third hour, then the horizon's last
    // step always rides along
    assert.equal(stamps.length, 24 + (165 - 24) / 3 + 1 + 1);
    assert.equal(stamps[stamps.length - 1], 167);
    for (let i = 24; i < stamps.length - 1; i++) {
      assert.equal(stamps[i] % 3, 0);
    }
  });

  test("decimation never invents steps: a hole in the answer stays a hole", () => {
    // A provider answer with a 12-hour hole (failed GRIB slices, say):
    // the throttle must not fill it — the sim flags the blend instead
    const forecasts = Array.from({ length: 168 }, (_, h) => step(h)).filter(
      (_f, h) => h < 30 || h > 42,
    );
    const waypoints = [{ distanceFromStartNm: 0, forecasts }];
    throttleWaypointForecasts(waypoints);
    const inputStamps = new Set(
      forecasts.map((f) => new Date(Date.parse(f.timestamp)).toISOString()),
    );
    for (const forecast of waypoints[0].forecasts) {
      assert.ok(
        inputStamps.has(forecast.timestamp),
        "every kept step was in the answer",
      );
    }
    // The hole survives: no invented step appears inside 30..42
    const stamps = waypoints[0].forecasts.map((f) =>
      Math.round((Date.parse(f.timestamp) - Date.parse(FETCH)) / HOUR),
    );
    assert.ok(!stamps.some((h) => h > 30 && h < 42), "hole preserved");
  });

  test("short fixtures pass through unchanged", () => {
    const forecasts = [step(0), step(1)];
    const waypoints = [{ distanceFromStartNm: 0, forecasts }];
    throttleWaypointForecasts(waypoints);
    assert.equal(waypoints[0].forecasts.length, 2);
  });

  test("less than half of the original payload remains on a week-long route", () => {
    // 15 waypoints, 30 nm apart, 7-day horizon: the shape behind the
    // 1.3 MB briefing
    const waypoints = Array.from({ length: 15 }, (_, i) => ({
      distanceFromStartNm: i * 30,
      forecasts: Array.from({ length: 168 }, (_, h) => step(h)),
    }));
    const before = waypoints.reduce((sum, wp) => sum + wp.forecasts.length, 0);
    throttleWaypointForecasts(waypoints);
    const after = waypoints.reduce((sum, wp) => sum + wp.forecasts.length, 0);
    assert.ok(after <= before * 0.5, `${after} of ${before} steps remain`);
    for (const wp of waypoints) {
      assert.ok(wp.forecasts.length > 0, "no waypoint stripped bare");
    }
  });
});

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
    // Weather provenance (work doc #31): the canonical per-position
    // Open-Meteo page for the first waypoint, fetch-stamped
    assert.equal(payload.metadata.provenance.kind, "forecast");
    assert.match(payload.metadata.provenance.label, /Open-Meteo/);
    assert.equal(
      payload.metadata.provenance.url,
      `https://open-meteo.com/en/docs?latitude=${WAYPOINTS[0].lat}&longitude=${WAYPOINTS[0].lon}`,
    );
    assert.equal(
      new Date(payload.metadata.provenance.at).toISOString(),
      payload.metadata.fetchedAt,
    );
    assert.equal(payload.waypoints.length, 5);
    const [step] = payload.waypoints[0].forecasts;
    // First step is the fixture's current hour: asserted against the
    // fixture's own stamp rather than a recomputed one — a clock step
    // between the two reads, or an hour boundary falling between mock
    // load and assertion, made this flake on CI (CI, 2026-10-21)
    assert.equal(step.timestamp, `${TIMES[0]}:00.000Z`);
    assert.deepEqual(step.surface, {
      tws: 12,
      twd: 45,
      mslp: 1013,
      gust: 18,
      cloudCover: 25,
      precip: 0,
      precipProbability: 10,
    });
    // Second step carries the wet hour of the fixture
    assert.equal(payload.waypoints[0].forecasts[1].surface.precip, 2.4);
    assert.equal(
      payload.waypoints[0].forecasts[1].surface.precipProbability,
      80,
    );
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

  test("falls back to mean wave period when the model publishes no peak", async () => {
    // GFS-Wave on Open-Meteo returns wave_peak_period as all-null
    // (verified October 2026) — the comfort model needs a period, so
    // the mean-period series steps in
    const noPeak = {
      waves: {
        hourly: {
          time: TIMES,
          wave_height: [1.2, 1.4],
          wave_direction: [160, 165],
          wave_peak_period: [null, null],
          wave_period: [6.9, 7.2],
          wind_wave_height: [0.5, 0.6],
          wind_wave_period: [4, 4.2],
          wind_wave_direction: [170, 172],
          swell_wave_height: [0.9, 1.0],
          swell_wave_period: [9, 9.1],
          swell_wave_direction: [150, 152],
        },
      },
    };
    const payload = await fetchWeatherAlongTrack({
      waypoints: WAYPOINTS,
      fetchImpl: mockOpenMeteo(noPeak),
    });
    assert.equal(payload.waypoints[0].forecasts[0].marine.tpCombined, 6.9);
    assert.equal(payload.waypoints[0].forecasts[1].marine.tpCombined, 7.2);
    // hsCombined unaffected
    assert.equal(payload.waypoints[0].forecasts[0].marine.hsCombined, 1.2);
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

  test("a permanent 4xx answers once instead of burning the retry budget", async () => {
    // The retry ladder is for 429/5xx/network errors; a 400 (an
    // Open-Meteo parameter rejection, say) will not heal — retrying
    // it three times cost ~12 s of a metered online window (audit
    // fix). One request, then the classified error.
    let attempts = 0;
    const refusing = async (url) => {
      attempts += 1;
      if (String(url).includes("/v1/forecast")) {
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          text: async () => JSON.stringify({ reason: "bad parameter" }),
        };
      }
      return mockOpenMeteo()(url);
    };
    await assert.rejects(
      fetchWeatherAlongTrack({ waypoints: WAYPOINTS, fetchImpl: refusing }),
      /returned 400: bad parameter/,
    );
    assert.equal(attempts, 1);
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
