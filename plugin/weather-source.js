/**
 * Weather source selection (work doc #16).
 *
 * Passage Briefing and signalk-weather-router-plus serve different
 * roles on board — the router plans and visualizes, the briefing
 * walks the crew through the passage — and they should reason from
 * the same forecast. The router registers as a Signal K Weather API
 * provider backed by its decoded ECMWF run, so when the server has
 * the Weather API the briefing reads its waypoint forecasts from the
 * provider in-process (`app.weatherApi`): local reads against the
 * run already on disk instead of Open-Meteo round-trips on a metered
 * offshore link, and briefing numbers that match the router's plan.
 *
 * `createWeatherFetcher` returns the track-fetch function the
 * briefing windows call. `weather_source` selects:
 *
 * - `auto` (default): the Weather API when the server exposes
 *   `app.weatherApi` and a provider answers, Open-Meteo otherwise;
 *   a failed Weather API fetch falls back for that window
 * - `weather-api`: always the Weather API; failures fail the fetch
 * - `open-meteo`: never touch the Weather API
 *
 * Weather API responses arrive in Signal K units (m/s, rad, Pa) and
 * are mapped into the UnifiedWeatherPayload conventions (knots,
 * degrees true, hPa; wind and wave directions FROM, current set
 * TOWARDS). The provider carries combined sea only — swell and
 * wind-sea partitions map to null, as do the upper-air fields behind
 * the convective warnings, which degrade to absent rather than
 * inventing values.
 *
 * @file weather-source.js
 */

const { fetchWeatherAlongTrack } = require("./fetch-engine.js");

/**
 * Meters per second to knots.
 */
const MS_TO_KNOTS = 3600 / 1852;

/**
 * Radians to degrees.
 */
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Normalizes an angle to degrees true in [0, 360).
 *
 * @param {number} rad - Angle in radians
 * @returns {number} Degrees true
 */
function radToDeg(rad) {
  if (!Number.isFinite(rad)) {
    return null;
  }
  const deg =
    Math.round(((((rad * RAD_TO_DEG) % 360) + 360) % 360) * 100) / 100;
  return deg >= 360 ? 0 : deg;
}

/**
 * Converts m/s to knots, rounded to two decimals.
 *
 * @param {number|null} ms
 * @returns {number|null}
 */
function msToKn(ms) {
  return Number.isFinite(ms) ? Math.round(ms * MS_TO_KNOTS * 100) / 100 : null;
}

/**
 * Converts pascals to hPa, rounded to one decimal.
 *
 * @param {number|null} pa
 * @returns {number|null}
 */
function paToHpa(pa) {
  return Number.isFinite(pa) ? Math.round(pa / 10) / 10 : null;
}

/**
 * Maps one Weather API point entry (Signal K units) onto the
 * UnifiedWeatherPayload TimeStepForecast shape (SPEC §3.1).
 * Missing blocks degrade to null fields, matching the Open-Meteo
 * path's graceful degradation.
 *
 * @param {object} item - WeatherData entry, ascending-date order
 * @returns {object} TimeStepForecast
 */
function weatherDataToTimeStep(item) {
  return {
    timestamp: new Date(item.date).toISOString(),
    surface: {
      tws: msToKn(item.wind?.speedTrue),
      twd: radToDeg(item.wind?.directionTrue),
      mslp: paToHpa(item.outside?.pressure),
      gust: msToKn(item.wind?.gust),
      // The provider publishes no cloud cover; the celestial
      // visibility gate stays open (work doc #3 Phase 2)
      cloudCover: null,
    },
    marine: {
      hsCombined: Number.isFinite(item.water?.waveSignificantHeight)
        ? item.water.waveSignificantHeight
        : null,
      tpCombined: Number.isFinite(item.water?.wavePeriod)
        ? item.water.wavePeriod
        : null,
      dirCombined: radToDeg(item.water?.waveDirection),
      // The Weather API carries combined sea only
      hsSwell: null,
      tpSwell: null,
      dirSwell: null,
      hsWindSea: null,
      tpWindSea: null,
      dirWindSea: null,
    },
    // No provider publishes upper-air fields; convective and
    // K-index briefing blocks degrade to absent
    upperAir: {
      cape: null,
      kIndex: null,
      rh700: null,
      wind850kts: null,
    },
    current: {
      // Set: the direction the water flows TOWARDS (Signal K setTrue)
      drift: msToKn(item.water?.surfaceCurrentSpeed),
      set: radToDeg(item.water?.surfaceCurrentDirection),
    },
  };
}

/**
 * Extracts a short model label from the provider's step
 * descriptions ("ECMWF IFS 0.25° open data, cycle …, +3 h").
 *
 * @param {object[]} items - WeatherData entries
 * @returns {string} Label like `weather-api:ECMWF IFS 0.25° open data`
 */
function modelLabel(items) {
  const description = items.find(
    (i) => typeof i?.description === "string",
  )?.description;
  const prefix = description?.split(",")[0]?.trim();
  if (!prefix) {
    return items.length > 0 ? "weather-api:provider" : "weather-api";
  }
  return `weather-api:${prefix}`;
}

/**
 * Builds the UnifiedWeatherPayload from Weather API point forecasts
 * for each waypoint (SPEC §3.1).
 *
 * @param {Array<{lat: number, lon: number, distanceFromStartNm: number}>} waypoints
 * @param {Map<string, object[]>} forecastsByWaypoint - Keyed by
 *   `lat,lon`, WeatherData lists in ascending date order
 * @returns {object} UnifiedWeatherPayload with `source: "weather-api"`
 */
function buildApiPayload(waypoints, forecastsByWaypoint) {
  let models = null;
  const payloadWaypoints = waypoints.map((waypoint) => {
    const items = forecastsByWaypoint.get(`${waypoint.lat},${waypoint.lon}`);
    if (models === null && items?.length > 0) {
      models = modelLabel(items);
    }
    return {
      lat: waypoint.lat,
      lon: waypoint.lon,
      distanceFromStartNm: waypoint.distanceFromStartNm,
      forecasts: (items ?? []).map(weatherDataToTimeStep),
    };
  });
  const fetchedAt = new Date().toISOString();
  return {
    metadata: {
      fetchedAt,
      source: "weather-api",
      models: [models ?? "weather-api"],
      // Where this forecast came from (work doc #31): the provider
      // publishes no human-readable page per point, so the record
      // stays label-only — the on-board viewer link (weather-map
      // webapp) is attached at compile when that sibling is installed
      provenance: {
        kind: "forecast",
        label: models ?? "Weather API provider",
        url: null,
        viewerBase: null,
        at: fetchedAt,
      },
    },
    waypoints: payloadWaypoints,
  };
}

/**
 * Rejects when the promise does not settle within the timeout.
 *
 * @param {Promise<object>} promise
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Weather API timed out")),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Creates a track-weather fetch function backed by the server's
 * Weather API (`app.weatherApi`), served by whichever provider the
 * server answers with — signalk-weather-router-plus when installed.
 *
 * @param {object} params
 * @param {object} params.weatherApi - `app.weatherApi` (the
 *   WeatherProviderRegistry's Weather API handle)
 * @param {number} [params.timeoutMs] - Per-waypoint timeout
 * @returns {function({waypoints: Array, forecastDays?: number}):
 *   Promise<object>} UnifiedWeatherPayload fetch, same contract as
 *   fetch-engine's Open-Meteo fetch
 */
function createWeatherApiFetcher({ weatherApi, timeoutMs = 30000 } = {}) {
  if (typeof weatherApi?.getForecasts !== "function") {
    throw new Error("weatherApi.getForecasts is not available");
  }
  return async function fetchWeatherApiAlongTrack({
    waypoints,
    forecastDays = 7,
  } = {}) {
    if (!Array.isArray(waypoints) || waypoints.length === 0) {
      throw new Error("No waypoints to fetch weather for");
    }
    // Step ceiling generous enough for 3 h steps over the horizon
    // (the 6 h tail beyond 144 h only shrinks the count)
    const maxCount = Math.max(8, Math.ceil((forecastDays * 24) / 3) + 8);
    const forecastsByWaypoint = new Map();
    await Promise.all(
      waypoints.map(async (waypoint) => {
        const items = await withTimeout(
          weatherApi.getForecasts(
            { latitude: waypoint.lat, longitude: waypoint.lon },
            "point",
            { maxCount },
          ),
          timeoutMs,
        );
        if (!Array.isArray(items) || items.length === 0) {
          throw new Error(
            `Weather API returned no forecasts at ${waypoint.lat.toFixed(2)}, ${waypoint.lon.toFixed(2)}`,
          );
        }
        forecastsByWaypoint.set(`${waypoint.lat},${waypoint.lon}`, items);
      }),
    );
    return buildApiPayload(waypoints, forecastsByWaypoint);
  };
}

/**
 * Creates the track-weather fetch the briefing windows use, applying
 * the `weather_source` selection (module docstring).
 *
 * @param {object} params
 * @param {object} [params.weatherApi] - `app.weatherApi` when the
 *   server has the Weather API
 * @param {"auto"|"weather-api"|"open-meteo"} [params.weatherSource]
 * @param {typeof fetch} [params.fetchImpl] - Open-Meteo fetch
 *   implementation (tests); defaults to the global fetch, resolved
 *   at call time
 * @returns {function({waypoints: Array, forecastDays?: number}):
 *   Promise<object>}
 */
function createWeatherFetcher({
  weatherApi,
  weatherSource = "auto",
  fetchImpl,
} = {}) {
  const wantsWeatherApi = weatherSource !== "open-meteo";
  const weatherApiFetcher =
    wantsWeatherApi && typeof weatherApi?.getForecasts === "function"
      ? createWeatherApiFetcher({ weatherApi })
      : null;
  if (weatherSource === "weather-api" && weatherApiFetcher === null) {
    throw new Error(
      "weather_source is weather-api but this server has no Weather API",
    );
  }
  return async function fetchTrackWeather({ waypoints, forecastDays } = {}) {
    if (weatherApiFetcher !== null) {
      try {
        return await weatherApiFetcher({ waypoints, forecastDays });
      } catch (error) {
        if (weatherSource === "weather-api") {
          throw error;
        }
        // auto: this window falls back to Open-Meteo; the next one
        // tries the Weather API again (self-heals once the provider
        // has loaded its forecast)
      }
    }
    // Bare `fetch` resolves at call time, so test and runtime
    // overrides of globalThis.fetch after plugin start still apply
    return fetchWeatherAlongTrack({
      waypoints,
      forecastDays,
      fetchImpl: fetchImpl ?? fetch,
    });
  };
}

module.exports = {
  createWeatherApiFetcher,
  createWeatherFetcher,
  weatherDataToTimeStep,
  modelLabel,
  buildApiPayload,
};
