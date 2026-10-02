const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { mockOpenMeteo } = require("./openmeteo-mock.js");
const {
  buildApiPayload,
  createWeatherApiFetcher,
  createWeatherFetcher,
  modelLabel,
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
    assert.equal(payload.waypoints.length, 2);
    assert.equal(payload.waypoints[0].distanceFromStartNm, 0);
    assert.equal(payload.waypoints[0].forecasts[0].surface.tws, 12);
    assert.equal(
      payload.waypoints[1].forecasts[0].timestamp,
      "2026-10-03T15:00:00.000Z",
    );
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
});
