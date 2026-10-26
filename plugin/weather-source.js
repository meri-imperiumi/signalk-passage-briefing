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
 * The Weather API is a local read over the decoded run on disk, so it
 * also serves offline compiles (work doc #55); Open-Meteo attempts
 * are skipped while the boat is offline. Thin provider coverage — a
 * run answering far short of the requested horizon — falls back like
 * a failure while online, and rides with the shortfall recorded in
 * `metadata.forecastHorizonShortfallHours` when offline.
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

const {
  fetchWeatherAlongTrack,
  throttleWaypointForecasts,
} = require("./fetch-engine.js");

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
      // The provider publishes fractional cloud cover (0..1) when its
      // run carries total cloud cover — the celestial visibility gate
      // needs it; absence keeps the gate open (work doc #3 Phase 2)
      cloudCover: Number.isFinite(item.outside?.cloudCover)
        ? item.outside.cloudCover
        : null,
      // No precipitation fields; rain-shower episodes degrade
      // to absent rather than being invented
      precip: null,
      precipProbability: null,
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
 * The decoded run's cycle instant, from the provider's step
 * descriptions ("… cycle 2026-10-17T12:00:00.000Z, valid …") — the
 * freshness anchor the run-refresh scheduling reads (work doc #47
 * session: a briefing compiled minutes before the next GRIB cycle
 * decoded should say so, and recompile when the newer run lands).
 * Null when the wording carries no cycle.
 *
 * @param {object[]} items - WeatherData entries
 * @returns {string|null} ISO instant of the decoded run's cycle
 */
function modelCycleTime(items) {
  const description = items.find(
    (i) => typeof i?.description === "string",
  )?.description;
  const match = description?.match(
    /cycle (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/,
  );
  const ms = match ? Date.parse(match[1]) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
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
  let cycleTime = null;
  const payloadWaypoints = waypoints.map((waypoint) => {
    const items = forecastsByWaypoint.get(`${waypoint.lat},${waypoint.lon}`);
    if (models === null && items?.length > 0) {
      models = modelLabel(items);
      cycleTime = modelCycleTime(items);
    }
    return {
      lat: waypoint.lat,
      lon: waypoint.lon,
      distanceFromStartNm: waypoint.distanceFromStartNm,
      forecasts: (items ?? []).map(weatherDataToTimeStep),
    };
  });
  const fetchedAt = new Date().toISOString();
  throttleWaypointForecasts(payloadWaypoints, fetchedAt);
  return {
    metadata: {
      fetchedAt,
      source: "weather-api",
      models: [models ?? "weather-api"],
      // The decoded GRIB run's cycle instant, when the provider's
      // wording carries it — the run-refresh scheduler anchors to it
      cycleTime,
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
 * Shortfall in hours beyond which the Weather API's coverage counts
 * as thin (work doc #55): a provider answering one day of steps for a
 * week-long request would otherwise masquerade as the forecast while
 * the plan sails the rest on the clamped last step. A full day of
 * missing horizon is a coverage gap, not cycle lag.
 */
const SHORTFALL_FALLBACK_HOURS = 24;

/**
 * Records the payload's real forecast horizon against the requested
 * one (work doc #55). The horizon is the last step any waypoint
 * carries; the shortfall is how far that sits behind the requested
 * `forecastDays`. Both land in `metadata` so the crew (and the
 * fallback logic) can see what the run actually covers.
 *
 * @param {object} payload - UnifiedWeatherPayload, mutated in place
 * @param {number} forecastDays - Requested horizon, days
 * @returns {number} Shortfall in hours (0 when coverage is full)
 */
function recordForecastHorizon(payload, forecastDays) {
  const fetchedMs = Date.parse(payload?.metadata?.fetchedAt ?? "");
  let lastMs = NaN;
  for (const waypoint of payload?.waypoints ?? []) {
    const steps = waypoint?.forecasts;
    if (!Array.isArray(steps) || steps.length === 0) {
      continue;
    }
    const ms = Date.parse(steps[steps.length - 1].timestamp);
    if (Number.isFinite(ms) && !(ms <= lastMs)) {
      lastMs = ms;
    }
  }
  if (!Number.isFinite(fetchedMs)) {
    return 0;
  }
  const horizonHours = Number.isFinite(lastMs)
    ? Math.max(0, Math.round(((lastMs - fetchedMs) / 3600000) * 10) / 10)
    : 0;
  const shortfallHours = Number.isFinite(lastMs)
    ? Math.max(0, Math.round((forecastDays * 24 - horizonHours) * 10) / 10)
    : forecastDays * 24;
  payload.metadata.forecastHorizonHours = horizonHours;
  if (shortfallHours > 0) {
    payload.metadata.forecastHorizonShortfallHours = shortfallHours;
  }
  return shortfallHours;
}

/**
 * Creates the track-weather fetch the briefing windows use, applying
 * the `weather_source` selection (module docstring).
 *
 * The Weather API is a local read — the provider decodes the GRIB run
 * already on disk — so it answers with the internet link down (work
 * doc #55). Open-Meteo is an internet service: when `isOnline`
 * reports offline it is never attempted, and thin Weather API
 * coverage cannot send the window online either.
 *
 * @param {object} params
 * @param {object} [params.weatherApi] - `app.weatherApi` when the
 *   server has the Weather API
 * @param {"auto"|"weather-api"|"open-meteo"} [params.weatherSource]
 * @param {typeof fetch} [params.fetchImpl] - Open-Meteo fetch
 *   implementation (tests); defaults to the global fetch, resolved
 *   at call time
 * @param {() => boolean} [params.isOnline] - Internet link state;
 *   absent means assume online
 * @returns {function({waypoints: Array, forecastDays?: number}):
 *   Promise<object>}
 */
function createWeatherFetcher({
  weatherApi,
  weatherSource = "auto",
  fetchImpl,
  isOnline,
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
  const offline = () =>
    typeof isOnline === "function" ? isOnline() === false : false;
  return async function fetchTrackWeather({ waypoints, forecastDays } = {}) {
    if (weatherApiFetcher !== null) {
      try {
        const payload = await weatherApiFetcher({ waypoints, forecastDays });
        const shortfall = recordForecastHorizon(payload, forecastDays);
        // Thin coverage (work doc #55): a provider answering one day
        // for a week-long request falls back like a failure — but
        // only while online, where the fallback can actually answer.
        if (
          shortfall > SHORTFALL_FALLBACK_HOURS &&
          !offline() &&
          weatherSource === "auto"
        ) {
          throw new Error(
            `Weather API coverage short by ${Math.round(shortfall)} h`,
          );
        }
        return payload;
      } catch (error) {
        if (weatherSource === "weather-api" || offline()) {
          throw error;
        }
        // auto, online: this window falls back to Open-Meteo; the
        // next one tries the Weather API again (self-heals once the
        // provider has loaded its forecast)
      }
    } else if (offline()) {
      // No local source and no link: nothing to fetch (work doc #55)
      throw new Error("Offline: no local weather source available");
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
  modelCycleTime,
  buildApiPayload,
  recordForecastHorizon,
  SHORTFALL_FALLBACK_HOURS,
};
