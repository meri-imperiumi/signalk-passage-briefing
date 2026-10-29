const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { mockOpenMeteo } = require("./openmeteo-mock.js");
const {
  buildApiPayload,
  createWeatherApiFetcher,
  createWeatherFetcher,
  modelCycleTime,
  modelLabel,
  recordForecastHorizon,
  weatherDataToTimeStep,
} = require("../plugin/weather-source.js");

const RAD = Math.PI / 180;

/**
 * Builds a WeatherData entry the way providers (weather-router-plus)
 * emit them: Signal K units, ascending date.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function weatherDataEntry(overrides = {}) {
  return {
    date: "2026-10-03T12:00:00.000Z",
    type: "point",
    description: "ECMWF IFS 0.25° open data, cycle 2026-10-03T00:00:00Z, +12 h",
    wind: {
      speedTrue: 6.173, // ≈ 12 kn
      directionTrue: 45 * RAD,
      gust: 9.26, // ≈ 18 kn
    },
    outside: {
      pressure: 101300,
    },
    water: {
      waveSignificantHeight: 1.2,
      wavePeriod: 7,
      waveDirection: 160 * RAD,
      surfaceCurrentSpeed: 0.514,
      surfaceCurrentDirection: Math.PI / 4,
    },
    ...overrides,
  };
}

describe("weatherDataToTimeStep", () => {
  test("maps Signal K units onto the payload conventions", () => {
    const step = weatherDataToTimeStep(weatherDataEntry());
    assert.equal(step.timestamp, "2026-10-03T12:00:00.000Z");
    assert.equal(step.surface.tws, 12);
    assert.equal(step.surface.twd, 45);
    assert.equal(step.surface.mslp, 1013);
    assert.equal(step.surface.gust, 18);
    // Provider mode carries no precipitation fields — degrade, never invent
    assert.equal(step.surface.precip, null);
    assert.equal(step.surface.precipProbability, null);
    assert.equal(step.marine.hsCombined, 1.2);
    assert.equal(step.marine.tpCombined, 7);
    assert.equal(step.marine.dirCombined, 160);
    assert.equal(step.current.drift, 1);
    assert.equal(step.current.set, 45);
  });

  test("partitions and upper air stay absent", () => {
    const step = weatherDataToTimeStep(weatherDataEntry());
    for (const key of [
      "hsSwell",
      "tpSwell",
      "dirSwell",
      "hsWindSea",
      "tpWindSea",
      "dirWindSea",
    ]) {
      assert.equal(step.marine[key], null, key);
    }
    for (const key of ["cape", "kIndex", "rh700", "wind850kts"]) {
      assert.equal(step.upperAir[key], null, key);
    }
  });

  test("the provider's fractional cloud cover maps through", () => {
    // The router publishes total cloud cover 0..1 — the celestial
    // visibility gate reads it (work doc #3 Phase 2; the mapping
    // used to hardcode null back when the provider carried none)
    const step = weatherDataToTimeStep(
      weatherDataEntry({ outside: { pressure: 101300, cloudCover: 0.88 } }),
    );
    assert.equal(step.surface.cloudCover, 0.88);
    // Absent cover degrades to null, never invented
    assert.equal(
      weatherDataToTimeStep(weatherDataEntry()).surface.cloudCover,
      null,
    );
  });

  test("missing blocks degrade to nulls", () => {
    const step = weatherDataToTimeStep({
      date: "2026-10-03T12:00:00.000Z",
      wind: { speedTrue: 5.14 },
    });
    assert.equal(step.surface.tws, 9.99);
    assert.equal(step.surface.twd, null);
    assert.equal(step.surface.gust, null);
    assert.equal(step.marine.hsCombined, null);
    assert.equal(step.current.drift, null);
  });

  test("normalizes negative and beyond-2π directions", () => {
    assert.equal(
      weatherDataToTimeStep({
        date: "2026-10-03T12:00:00.000Z",
        wind: { directionTrue: -90 * RAD },
      }).surface.twd,
      270,
    );
    assert.equal(
      weatherDataToTimeStep({
        date: "2026-10-03T12:00:00.000Z",
        wind: { directionTrue: 370 * RAD },
      }).surface.twd,
      10,
    );
  });
});

describe("modelLabel", () => {
  test("derives the model prefix from step descriptions", () => {
    assert.equal(
      modelLabel([weatherDataEntry()]),
      "weather-api:ECMWF IFS 0.25° open data",
    );
  });

  test("falls back when descriptions are absent", () => {
    assert.equal(
      modelLabel([{ date: "2026-10-03T12:00:00.000Z" }]),
      "weather-api:provider",
    );
    assert.equal(modelLabel([]), "weather-api");
  });
});

describe("modelCycleTime", () => {
  test("extracts the decoded run's cycle from the step description", () => {
    assert.equal(
      modelCycleTime([weatherDataEntry()]),
      "2026-10-03T00:00:00.000Z",
    );
    // Millisecond-precision wording degrades fine
    assert.equal(
      modelCycleTime([
        weatherDataEntry({
          description:
            "ECMWF IFS 0.25° open data, cycle 2026-10-17T12:00:00.000Z, valid 2026-10-17T21:00:00.000Z",
        }),
      ]),
      "2026-10-17T12:00:00.000Z",
    );
    assert.equal(modelCycleTime([{ date: "2026-10-03T12:00:00Z" }]), null);
    assert.equal(modelCycleTime([]), null);
  });
});

describe("buildApiPayload", () => {
  test("assembles the UnifiedWeatherPayload", () => {
    const waypoints = [
      { lat: 60.1, lon: 25.1, distanceFromStartNm: 0 },
      { lat: 59.9, lon: 24.9, distanceFromStartNm: 15 },
    ];
    const forecasts = new Map([
      ["60.1,25.1", [weatherDataEntry()]],
      ["59.9,24.9", [weatherDataEntry({ date: "2026-10-03T15:00:00.000Z" })]],
    ]);
    const payload = buildApiPayload(waypoints, forecasts);
    assert.equal(payload.metadata.source, "weather-api");
    assert.deepEqual(payload.metadata.models, [
      "weather-api:ECMWF IFS 0.25° open data",
    ]);
    // The decoded run's cycle instant rides the metadata — the
    // run-refresh scheduler anchors to it (work doc #47 session)
    assert.equal(payload.metadata.cycleTime, "2026-10-03T00:00:00.000Z");
    // Provenance (work doc #31): label-only — the provider publishes
    // no human page per point; the viewer link attaches at compile
    assert.equal(payload.metadata.provenance.kind, "forecast");
    assert.match(payload.metadata.provenance.label, /ECMWF IFS/);
    assert.equal(payload.metadata.provenance.url, null);
    assert.equal(payload.metadata.provenance.viewerBase, null);
    assert.equal(
      new Date(payload.metadata.provenance.at).toISOString(),
      payload.metadata.fetchedAt,
    );
    assert.equal(payload.waypoints.length, 2);
    assert.equal(payload.waypoints[0].distanceFromStartNm, 0);
    assert.equal(payload.waypoints[0].forecasts[0].surface.tws, 12);
    assert.equal(
      payload.waypoints[1].forecasts[0].timestamp,
      "2026-10-03T15:00:00.000Z",
    );
  });
});

describe("recordForecastHorizon", () => {
  test("the mosaic reads shortfall from the worst waypoint, not the best", () => {
    const fetchedMs = Date.parse("2026-10-28T09:42:00.000Z");
    const waypoint = (lat, lastHours) => ({
      lat,
      lon: 174,
      forecasts: lastHours
        ? [
            {
              timestamp: new Date(
                fetchedMs + lastHours * 3600000,
              ).toISOString(),
            },
          ]
        : [],
    });
    const payload = {
      metadata: { fetchedAt: new Date(fetchedMs).toISOString() },
      waypoints: [waypoint(-18.5, 362), waypoint(-19.2, 69)],
    };
    const shortfall = recordForecastHorizon(payload, 14);
    // Both truths land in metadata…
    assert.ok(payload.metadata.forecastHorizonHours > 360, "freshest waypoint");
    assert.ok(payload.metadata.forecastHorizonMinHours < 70, "worst waypoint");
    // …but the shortfall (and the fallback decision) reads the worst:
    // the plan sails over the waypoint that stops inside day 3, so a
    // 14-day request is 267 h short no matter how far the best reaches
    assert.equal(shortfall, 336 - 69);
    assert.equal(payload.metadata.forecastHorizonShortfallHours, 336 - 69);
  });

  test("uniform coverage keeps the shortfall inside the fallback threshold", () => {
    const fetchedMs = Date.parse("2026-10-28T09:42:00.000Z");
    const payload = {
      metadata: { fetchedAt: new Date(fetchedMs).toISOString() },
      waypoints: [
        {
          lat: -18.5,
          forecasts: [
            { timestamp: new Date(fetchedMs + 334 * 3600000).toISOString() },
          ],
        },
        {
          lat: -19.2,
          forecasts: [
            { timestamp: new Date(fetchedMs + 330 * 3600000).toISOString() },
          ],
        },
      ],
    };
    const shortfall = recordForecastHorizon(payload, 14);
    // Cycle quantization leaves a few hours short: recorded honestly,
    // but inside the fallback threshold — no Open-Meteo trip
    assert.equal(shortfall, 6);
    assert.equal(payload.metadata.forecastHorizonShortfallHours, 6);
  });
});

describe("createWeatherApiFetcher", () => {
  test("queries each waypoint and maps the answer", async () => {
    const calls = [];
    const weatherApi = {
      getForecasts: async (position, type, options) => {
        calls.push({ position, type, options });
        return [weatherDataEntry()];
      },
    };
    const fetchTrack = createWeatherApiFetcher({ weatherApi });
    const payload = await fetchTrack({
      waypoints: [{ lat: 60.1, lon: 25.1, distanceFromStartNm: 0 }],
      forecastDays: 7,
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].position, { latitude: 60.1, longitude: 25.1 });
    assert.equal(calls[0].type, "point");
    assert.ok(calls[0].options.maxCount >= 64);
    assert.equal(payload.metadata.source, "weather-api");
    assert.equal(payload.waypoints[0].forecasts[0].surface.tws, 12);
  });

  test("rejects when the provider answers empty", async () => {
    const fetchTrack = createWeatherApiFetcher({
      weatherApi: { getForecasts: async () => [] },
    });
    await assert.rejects(
      fetchTrack({
        waypoints: [{ lat: 60.1, lon: 25.1, distanceFromStartNm: 0 }],
      }),
      /no forecasts/,
    );
  });

  test("rejects when the provider is slow", async () => {
    const fetchTrack = createWeatherApiFetcher({
      weatherApi: { getForecasts: () => new Promise(() => {}) },
      timeoutMs: 10,
    });
    await assert.rejects(
      fetchTrack({
        waypoints: [{ lat: 60.1, lon: 25.1, distanceFromStartNm: 0 }],
      }),
      /timed out/,
    );
  });
});

describe("createWeatherFetcher", () => {
  const waypoints = [{ lat: 60.1, lon: 25.1, distanceFromStartNm: 0 }];

  test("auto prefers the Weather API when it answers", async () => {
    const fetchTrack = createWeatherFetcher({
      weatherApi: {
        getForecasts: async () => [weatherDataEntry()],
      },
    });
    const payload = await fetchTrack({ waypoints });
    assert.equal(payload.metadata.source, "weather-api");
    // A provider answer carries no fallback marker: the checklist
    // note only fires when the window actually degraded
    assert.equal(payload.metadata.weatherApiFallback, undefined);
  });

  test("auto falls back to Open-Meteo on failure", async () => {
    const fetchTrack = createWeatherFetcher({
      weatherApi: {
        getForecasts: async () => {
          throw new Error("no forecast loaded yet");
        },
      },
      fetchImpl: mockOpenMeteo(),
    });
    const payload = await fetchTrack({ waypoints });
    assert.equal(payload.metadata.source, "api");
    assert.ok(payload.metadata.models.includes("forecast:best_match"));
    // The degradation is visible, not a clean [ OK ] (audit fix): the
    // payload carries why the window fell back, and the plugin's
    // compile records it as the checklist row's note
    assert.equal(payload.metadata.weatherApiFallback, "no forecast loaded yet");
  });

  test("auto falls back when no server Weather API exists", async () => {
    const fetchTrack = createWeatherFetcher({
      weatherApi: undefined,
      fetchImpl: mockOpenMeteo(),
    });
    const payload = await fetchTrack({ waypoints });
    assert.equal(payload.metadata.source, "api");
  });

  test("forced weather-api fails loudly without fallback", async () => {
    const fetchTrack = createWeatherFetcher({
      weatherApi: {
        getForecasts: async () => {
          throw new Error("no forecast loaded yet");
        },
      },
      weatherSource: "weather-api",
    });
    await assert.rejects(fetchTrack({ waypoints }), /no forecast loaded yet/);
  });

  test("forced weather-api without a server API rejects at creation", () => {
    assert.throws(
      () =>
        createWeatherFetcher({
          weatherApi: undefined,
          weatherSource: "weather-api",
        }),
      /no Weather API/,
    );
  });

  test("open-meteo never touches the Weather API", async () => {
    let queried = false;
    const fetchTrack = createWeatherFetcher({
      weatherApi: {
        getForecasts: async () => {
          queried = true;
          return [weatherDataEntry()];
        },
      },
      weatherSource: "open-meteo",
      fetchImpl: mockOpenMeteo(),
    });
    const payload = await fetchTrack({ waypoints });
    assert.equal(queried, false);
    assert.equal(payload.metadata.source, "api");
  });

  /** A provider answer whose steps stop `hours` past the fetch:
   * simulates a GRIB corridor that only partly covers the route. */
  function thinProvider(hours = 24) {
    const fetchedMs = Date.now();
    return {
      getForecasts: async () =>
        [0, 3, 6, 9, hours].map((step) =>
          weatherDataEntry({
            date: new Date(fetchedMs + step * 3600000).toISOString(),
          }),
        ),
    };
  }

  test("thin coverage falls back to Open-Meteo while online (doc #55)", async () => {
    const fetchTrack = createWeatherFetcher({
      weatherApi: thinProvider(24),
      fetchImpl: mockOpenMeteo(),
      isOnline: () => true,
    });
    const payload = await fetchTrack({ waypoints, forecastDays: 7 });
    // The fallback answered, not the thin provider
    assert.equal(payload.metadata.source, "api");
  });

  test("thin coverage rides offline with the shortfall recorded", async () => {
    let openMeteoCalled = false;
    const fetchTrack = createWeatherFetcher({
      weatherApi: thinProvider(24),
      fetchImpl: async (...args) => {
        openMeteoCalled = true;
        return mockOpenMeteo()(...args);
      },
      isOnline: () => false,
    });
    const payload = await fetchTrack({ waypoints, forecastDays: 7 });
    assert.equal(payload.metadata.source, "weather-api");
    assert.equal(openMeteoCalled, false);
    assert.ok(payload.metadata.forecastHorizonHours < 30);
    assert.ok(payload.metadata.forecastHorizonShortfallHours > 140);
  });

  test("full coverage records no shortfall and never falls back", async () => {
    const fetchedMs = Date.now();
    const fetchTrack = createWeatherFetcher({
      weatherApi: {
        getForecasts: async () =>
          [0, 72, 144, 166].map((step) =>
            weatherDataEntry({
              date: new Date(fetchedMs + step * 3600000).toISOString(),
            }),
          ),
      },
      fetchImpl: async () => {
        throw new Error("Open-Meteo must not be called");
      },
      isOnline: () => true,
    });
    // A waypoint deep into the route: the ETA-window throttle keeps
    // its whole window, horizon steps included
    const far = [{ lat: 60.1, lon: 25.1, distanceFromStartNm: 400 }];
    const payload = await fetchTrack({ waypoints: far, forecastDays: 7 });
    assert.equal(payload.metadata.source, "weather-api");
    // Cycle quantization may leave an hour or two short of the
    // request — inside the fallback threshold, so no Open-Meteo trip
    assert.ok(payload.metadata.forecastHorizonShortfallHours <= 24);
    assert.ok(payload.metadata.forecastHorizonHours > 160);
  });

  test("offline with no local source rejects instead of going online", async () => {
    const fetchTrack = createWeatherFetcher({
      weatherApi: undefined,
      fetchImpl: async () => {
        throw new Error("Open-Meteo must not be called");
      },
      isOnline: () => false,
    });
    await assert.rejects(fetchTrack({ waypoints }), /Offline/);
  });

  /** A mosaic corridor: the point near the boat rides the fresh run's
   * full slice set while a waypoint mid-route stops early — the sea
   * trial shape that passed the old max-based horizon check and left
   * the plan clamping between the tiles (work doc #55 session). */
  function mosaicProvider() {
    const fetchedMs = Date.now();
    const steps = (from, to) =>
      Array.from({ length: (to - from) / 3 + 1 }, (_, i) =>
        weatherDataEntry({
          date: new Date(fetchedMs + (from + i * 3) * 3600000).toISOString(),
        }),
      );
    return {
      // Point A: near the boat, full grid (14 days of 3-h slices)
      // Point B: mid-route tile generation, stops inside day 3
      getForecasts: async (point) =>
        point.latitude === -18.5 ? steps(0, 336) : steps(0, 69),
    };
  }

  test("mosaic coverage falls back while online: worst waypoint wins", async () => {
    const route = [
      { lat: -18.5, lon: 174.0, distanceFromStartNm: 0 },
      { lat: -19.2, lon: 174.6, distanceFromStartNm: 45 },
    ];
    const fetchTrack = createWeatherFetcher({
      weatherApi: mosaicProvider(),
      fetchImpl: mockOpenMeteo(),
      isOnline: () => true,
    });
    const payload = await fetchTrack({ waypoints: route, forecastDays: 14 });
    // The fallback answered, not the mosaic
    assert.equal(payload.metadata.source, "api");
  });

  test("mosaic coverage rides offline, shortfall read from the worst waypoint", async () => {
    let openMeteoCalled = false;
    const route = [
      { lat: -18.5, lon: 174.0, distanceFromStartNm: 850 },
      { lat: -19.2, lon: 174.6, distanceFromStartNm: 500 },
    ];
    const fetchTrack = createWeatherFetcher({
      weatherApi: mosaicProvider(),
      fetchImpl: async (...args) => {
        openMeteoCalled = true;
        return mockOpenMeteo()(...args);
      },
      isOnline: () => false,
    });
    const payload = await fetchTrack({ waypoints: route, forecastDays: 14 });
    assert.equal(payload.metadata.source, "weather-api");
    assert.equal(openMeteoCalled, false);
    // The freshest waypoint reaches the full grid; the worst stops
    // inside day 3 — both truths land in metadata, the shortfall
    // reads the worst
    assert.ok(payload.metadata.forecastHorizonHours > 300);
    assert.ok(payload.metadata.forecastHorizonMinHours < 70);
    assert.ok(payload.metadata.forecastHorizonShortfallHours > 260);
  });

  test("a waypoint with no steps counts as no coverage", async () => {
    const fetchedMs = Date.now();
    const payload = {
      metadata: { fetchedAt: new Date(fetchedMs).toISOString() },
      waypoints: [
        {
          lat: 1,
          lon: 1,
          forecasts: [
            {
              timestamp: new Date(fetchedMs + 320 * 3600000).toISOString(),
            },
          ],
        },
        { lat: 2, lon: 2, forecasts: [] },
      ],
    };
    const shortfall = recordForecastHorizon(payload, 14);
    // The empty waypoint stops now: the full request reads as missing
    assert.equal(shortfall, 14 * 24);
    assert.ok(payload.metadata.forecastHorizonHours > 300);
    assert.equal(payload.metadata.forecastHorizonMinHours, 0);
  });
});
