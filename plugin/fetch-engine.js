/**
 * Multi-endpoint weather & METAREA aggregation (SPEC §3.1).
 *
 * Builds the UnifiedWeatherPayload along a route's waypoints from
 * Open-Meteo, the same source SV Sabado's passage-weather vetted
 * against raw ECMWF/NOAA GRIB:
 *
 * - forecast API: surface wind (kn), gusts, MSL pressure, CAPE, and
 *   the pressure-layer fields behind the K-index (computed here from
 *   T850/T700/T500 and dewpoints via Magnus);
 * - marine API (`ncep_gfswave025`): combined sea plus wind sea and
 *   swell partitions (the SPEC §3.1 marine block needs the split;
 *   ECMWF's split fields come back empty per passage-weather's
 *   2026-09 checks);
 * - marine API currents: Météo-France SMOC surface current.
 *
 * The marine and current endpoints degrade gracefully — a failure
 * nulls their fields — while a forecast failure fails the fetch.
 *
 * Everything fetched is cached to the plugin data directory
 * (`weather/latest-<route>.json` plus dated snapshots, newest kept):
 * on passage the boat is online for about an hour per day, so the
 * last payload must survive restarts and serve offline reads.
 *
 * Conventions: wind directions are the direction the wind blows FROM
 * (degrees true, matching Signal K), waves likewise FROM; speeds in
 * knots; pressure hPa; timestamps ISO UTC.
 *
 * @file fetch-engine.js
 */

const {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} = require("node:fs/promises");
const path = require("node:path");

/**
 * Earth radius in nautical miles.
 */
const EARTH_RADIUS_NM = 3440.065;

/**
 * Default route sampling interval.
 */
const DEFAULT_SAMPLE_INTERVAL_NM = 30;

/**
 * Default forecast horizon.
 */
const DEFAULT_FORECAST_DAYS = 7;

/**
 * Snapshots kept per route in the cache.
 */
const KEEP_SNAPSHOTS = 8;

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";

const FORECAST_HOURLY = [
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "pressure_msl",
  "cape",
  "temperature_850hPa",
  "temperature_700hPa",
  "temperature_500hPa",
  "relative_humidity_850hPa",
  "relative_humidity_700hPa",
  "wind_speed_850hPa",
].join(",");

const WAVE_HOURLY = [
  "wave_height",
  "wave_direction",
  "wave_peak_period",
  "wind_wave_height",
  "wind_wave_period",
  "wind_wave_direction",
  "swell_wave_height",
  "swell_wave_period",
  "swell_wave_direction",
].join(",");

const CURRENT_HOURLY = [
  "ocean_current_velocity",
  "ocean_current_direction",
].join(",");

/**
 * Parses a timestamp that carries no explicit offset as UTC
 * (Open-Meteo returns naive ISO strings under `timezone=GMT`).
 *
 * @param {string} time
 * @returns {Date}
 */
function parseUtcTimestamp(time) {
  const hasOffset = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(time);
  return new Date(hasOffset ? time : `${time}Z`);
}

/**
 * Great-circle distance between two positions.
 *
 * @param {number} lat1 - Degrees
 * @param {number} lon1 - Degrees
 * @param {number} lat2 - Degrees
 * @param {number} lon2 - Degrees
 * @returns {number} Distance in nautical miles
 */
function distanceNm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const φ1 = lat1 * toRad;
  const φ2 = lat2 * toRad;
  const dφ = (lat2 - lat1) * toRad;
  const dλ = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Great-circle interpolation between two positions (spherical linear
 * interpolation), fraction `f` along the great circle.
 *
 * @param {number} lat1 - Degrees
 * @param {number} lon1 - Degrees
 * @param {number} lat2 - Degrees
 * @param {number} lon2 - Degrees
 * @param {number} f - Fraction 0..1
 * @returns {{lat: number, lon: number}}
 */
function interpolatePosition(lat1, lon1, lat2, lon2, f) {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const φ1 = lat1 * toRad;
  const λ1 = lon1 * toRad;
  const φ2 = lat2 * toRad;
  const λ2 = lon2 * toRad;
  const d =
    2 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin((φ2 - φ1) / 2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2,
        ),
      ),
    );
  if (d < 1e-9) {
    return { lat: lat1, lon: lon1 };
  }
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return {
    lat: Math.atan2(z, Math.sqrt(x * x + y * y)) * toDeg,
    lon: Math.atan2(y, x) * toDeg,
  };
}

/**
 * Samples a route geometry into waypoints at most `intervalNm` apart
 * (passage-weather's scheme: the route is divided into
 * `ceil(total/interval)` even steps, so spacing is uniform and both
 * ends are included), recording each waypoint's distance from the
 * start (SPEC §3.1 waypoints shape).
 *
 * @param {number[][]} coordinates - Route GeoJSON coordinates
 *   ([[lon, lat], ...], Signal K convention)
 * @param {number} [intervalNm] - Maximum sampling interval
 * @returns {Array<{lat: number, lon: number, distanceFromStartNm: number}>}
 */
function sampleRoutePoints(
  coordinates,
  intervalNm = DEFAULT_SAMPLE_INTERVAL_NM,
) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    return [];
  }
  if (coordinates.length === 1) {
    return [
      {
        lat: coordinates[0][1],
        lon: coordinates[0][0],
        distanceFromStartNm: 0,
      },
    ];
  }
  const legs = [];
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const leg = distanceNm(
      coordinates[i - 1][1],
      coordinates[i - 1][0],
      coordinates[i][1],
      coordinates[i][0],
    );
    legs.push({
      lat1: coordinates[i - 1][1],
      lon1: coordinates[i - 1][0],
      lat2: coordinates[i][1],
      lon2: coordinates[i][0],
      start: total,
      length: leg,
    });
    total += leg;
  }
  const steps = Math.max(1, Math.ceil(total / intervalNm));
  const stepLength = total / steps;
  const waypoints = [];
  for (let i = 0; i <= steps; i++) {
    const d = i * stepLength;
    const pos = positionAt(legs, d);
    waypoints.push({
      lat: pos.lat,
      lon: pos.lon,
      distanceFromStartNm: Math.round(d * 10) / 10,
    });
  }
  return waypoints;
}

/**
 * Position at distance `d` along a leg list.
 *
 * @param {Array<{lat1: number, lon1: number, lat2: number, lon2: number, start: number, length: number}>} legs
 * @param {number} d - Distance from the route start (nm)
 * @returns {{lat: number, lon: number}}
 */
function positionAt(legs, d) {
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (d <= leg.start + leg.length || i === legs.length - 1) {
      const f = leg.length < 1e-9 ? 0 : (d - leg.start) / leg.length;
      return interpolatePosition(leg.lat1, leg.lon1, leg.lat2, leg.lon2, f);
    }
  }
  const last = legs[legs.length - 1];
  return { lat: last.lat2, lon: last.lon2 };
}

/**
 * Total length of a route geometry.
 *
 * @param {number[][]} coordinates - [[lon, lat], ...]
 * @returns {number} Distance in nautical miles
 */
function routeDistanceNm(coordinates) {
  let total = 0;
  for (let i = 1; i < (coordinates?.length ?? 0); i++) {
    total += distanceNm(
      coordinates[i - 1][1],
      coordinates[i - 1][0],
      coordinates[i][1],
      coordinates[i][0],
    );
  }
  return Math.round(total * 10) / 10;
}

/**
 * Dew point from temperature and relative humidity (Magnus formula,
 * a=17.62 b=243.12 — accurate enough for the K-index).
 *
 * @param {number} tempC
 * @param {number} rhPercent
 * @returns {number} Dew point (°C)
 */
function dewpointC(tempC, rhPercent) {
  const a = 17.62;
  const b = 243.12;
  const gamma =
    Math.log(Math.max(rhPercent, 1) / 100) + (a * tempC) / (b + tempC);
  return (b * gamma) / (a - gamma);
}

/**
 * K-index from pressure-layer temperatures and humidities:
 * K = (T850 − T500) + Td850 − (T700 − Td700). Thunderstorm potential
 * grows above ~28 (SPEC §6.2 convective warnings use 28).
 *
 * @param {object} levels
 * @param {number} levels.t850 - °C
 * @param {number} levels.t700 - °C
 * @param {number} levels.t500 - °C
 * @param {number} levels.rh850 - %
 * @param {number} levels.rh700 - %
 * @returns {number|null} K-index, null on missing inputs
 */
function kIndex({ t850, t700, t500, rh850, rh700 }) {
  if (
    [t850, t700, t500, rh850, rh700].some(
      (v) => typeof v !== "number" || !Number.isFinite(v),
    )
  ) {
    return null;
  }
  return t850 - t500 + dewpointC(t850, rh850) - (t700 - dewpointC(t700, rh700));
}

/**
 * Fetch helper with per-attempt timeout and retry with backoff on
 * 429/5xx/network errors (an uplink that blackholes or rate-limits
 * must not wedge a fetch window).
 *
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @param {number} timeoutMs
 * @param {number} [tries=3]
 * @returns {Promise<object>} Parsed JSON
 */
async function fetchJson(url, fetchImpl, timeoutMs, tries = 3) {
  let lastError;
  // Non-ok bodies often carry the actionable part (Open-Meteo 400s
  // carry a `reason`); surface a snippet in the error so the plugin
  // status says WHY, not just which URL
  const describe = async (response) => {
    let detail = "";
    try {
      const body = await response.text();
      const parsed = JSON.parse(body);
      detail = parsed.reason ?? parsed.message ?? body;
    } catch {
      detail = "";
    }
    detail = String(detail).slice(0, 200);
    return `${url} returned ${response.status}${detail ? `: ${detail}` : ""}`;
  };
  for (let attempt = 0; attempt < tries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(await describe(response));
      } else if (!response.ok) {
        throw new Error(await describe(response));
      } else {
        return await response.json();
      }
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
  }
  throw lastError;
}

/**
 * Normalizes an Open-Meteo response covering one location per
 * requested coordinate (a single object for one location, an array
 * in request order for several) into an array aligned with the
 * request.
 *
 * @param {object|object[]} response
 * @param {number} count - Number of requested locations
 * @returns {Array<object|null>}
 */
function normalizeLocations(response, count) {
  if (response == null) {
    return Array(count).fill(null);
  }
  const blocks = Array.isArray(response) ? response : [response];
  return Array.from({ length: count }, (_, i) => blocks[i] ?? null);
}

/**
 * Aligns one location's hourly arrays into a time → value lookup.
 *
 * @param {object|null} block - Open-Meteo location block
 * @param {string[]} keys - Hourly variable names
 * @returns {Map<string, Object<string, number|null>>}
 */
function hourlyLookup(block, keys) {
  const map = new Map();
  if (!block?.hourly?.time) {
    return map;
  }
  const { time } = block.hourly;
  for (let i = 0; i < time.length; i++) {
    const row = {};
    for (const key of keys) {
      const values = block.hourly[key];
      row[key] = values ? (values[i] ?? null) : null;
    }
    map.set(parseUtcTimestamp(time[i]).toISOString(), row);
  }
  return map;
}

/**
 * Number-like passthrough (Open-Meteo uses null for missing hours).
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Builds the SPEC §3.1 TimeStepForecast for one waypoint by merging
 * the aligned forecast, wave and current lookups.
 *
 * @param {Map<string, object>} surfaceMap
 * @param {Map<string, object>} marineMap
 * @param {Map<string, object>} currentMap
 * @returns {Array<object>} TimeStepForecast list
 */
function buildTimeSteps(surfaceMap, marineMap, currentMap) {
  const times = new Set([...surfaceMap.keys(), ...marineMap.keys()]);
  const steps = [];
  for (const time of [...times].sort()) {
    const surface = surfaceMap.get(time) ?? {};
    const marine = marineMap.get(time) ?? {};
    const currents = currentMap.get(time) ?? {};
    const gust = num(surface.wind_gusts_10m);
    const kIndexValue = kIndex({
      t850: num(surface.temperature_850hPa),
      t700: num(surface.temperature_700hPa),
      t500: num(surface.temperature_500hPa),
      rh850: num(surface.relative_humidity_850hPa),
      rh700: num(surface.relative_humidity_700hPa),
    });
    // Ocean current direction convention: SMOC reports the direction
    // the water sets TOWARD; velocity arrives in km/h.
    const driftKmh = num(currents.ocean_current_velocity);
    steps.push({
      timestamp: time,
      surface: {
        tws: num(surface.wind_speed_10m),
        twd: num(surface.wind_direction_10m),
        mslp: num(surface.pressure_msl),
        gust,
      },
      marine: {
        hsCombined: num(marine.wave_height),
        tpCombined: num(marine.wave_peak_period),
        dirCombined: num(marine.wave_direction),
        hsSwell: num(marine.swell_wave_height),
        tpSwell: num(marine.swell_wave_period),
        dirSwell: num(marine.swell_wave_direction),
        hsWindSea: num(marine.wind_wave_height),
        tpWindSea: num(marine.wind_wave_period),
        dirWindSea: num(marine.wind_wave_direction),
      },
      upperAir: {
        cape: num(surface.cape),
        kIndex: kIndexValue != null ? Math.round(kIndexValue * 10) / 10 : null,
        rh700: num(surface.relative_humidity_700hPa),
        wind850kts: num(surface.wind_speed_850hPa),
      },
      current: {
        drift:
          driftKmh != null ? Math.round((driftKmh / 1.852) * 100) / 100 : null,
        set: num(currents.ocean_current_direction),
      },
    });
  }
  return steps;
}

/**
 * Fetches weather along the route waypoints and assembles the
 * UnifiedWeatherPayload (SPEC §3.1).
 *
 * @param {object} params
 * @param {Array<{lat: number, lon: number, distanceFromStartNm: number}>} params.waypoints
 *   From {@link sampleRoutePoints}
 * @param {number} [params.forecastDays] - Forecast horizon (default
 *   {@link DEFAULT_FORECAST_DAYS})
 * @param {number} [params.timeoutMs] - Per-attempt timeout
 * @param {typeof fetch} [params.fetchImpl] - Fetch implementation (tests)
 * @returns {Promise<object>} UnifiedWeatherPayload
 */
async function fetchWeatherAlongTrack({
  waypoints,
  forecastDays = DEFAULT_FORECAST_DAYS,
  timeoutMs = 30000,
  fetchImpl = fetch,
}) {
  if (!Array.isArray(waypoints) || waypoints.length === 0) {
    throw new Error("No waypoints to fetch weather for");
  }
  const lats = waypoints.map((w) => w.lat.toFixed(3)).join(",");
  const lons = waypoints.map((w) => w.lon.toFixed(3)).join(",");

  const forecastUrl =
    `${FORECAST_URL}?latitude=${lats}&longitude=${lons}` +
    `&hourly=${FORECAST_HOURLY}&forecast_days=${forecastDays}&timezone=GMT&wind_speed_unit=kn`;
  const wavesUrl =
    `${MARINE_URL}?latitude=${lats}&longitude=${lons}` +
    `&hourly=${WAVE_HOURLY}&forecast_days=${forecastDays}&timezone=GMT&models=ncep_gfswave025`;
  const currentsUrl =
    `${MARINE_URL}?latitude=${lats}&longitude=${lons}` +
    `&hourly=${CURRENT_HOURLY}&forecast_days=${forecastDays}&timezone=GMT`;

  // The forecast is the core; sea and current degrade gracefully.
  const forecastResponse = await fetchJson(forecastUrl, fetchImpl, timeoutMs);
  const [wavesResponse, currentsResponse] = await Promise.all([
    fetchJson(wavesUrl, fetchImpl, timeoutMs).catch(() => null),
    fetchJson(currentsUrl, fetchImpl, timeoutMs).catch(() => null),
  ]);

  const forecastBlocks = normalizeLocations(forecastResponse, waypoints.length);
  const waveBlocks = normalizeLocations(wavesResponse, waypoints.length);
  const currentBlocks = normalizeLocations(currentsResponse, waypoints.length);

  const payloadWaypoints = waypoints.map((waypoint, index) => {
    const surfaceMap = hourlyLookup(forecastBlocks[index], [
      "wind_speed_10m",
      "wind_direction_10m",
      "wind_gusts_10m",
      "pressure_msl",
      "cape",
      "temperature_850hPa",
      "temperature_700hPa",
      "temperature_500hPa",
      "relative_humidity_850hPa",
      "relative_humidity_700hPa",
      "wind_speed_850hPa",
    ]);
    const marineMap = hourlyLookup(waveBlocks[index], [
      "wave_height",
      "wave_direction",
      "wave_peak_period",
      "wind_wave_height",
      "wind_wave_period",
      "wind_wave_direction",
      "swell_wave_height",
      "swell_wave_period",
      "swell_wave_direction",
    ]);
    const currentMap = hourlyLookup(currentBlocks[index], [
      "ocean_current_velocity",
      "ocean_current_direction",
    ]);
    return {
      lat: waypoint.lat,
      lon: waypoint.lon,
      distanceFromStartNm: waypoint.distanceFromStartNm,
      forecasts: buildTimeSteps(surfaceMap, marineMap, currentMap),
    };
  });

  const models = ["forecast:best_match"];
  if (wavesResponse != null) {
    models.push("marine:ncep_gfswave025");
  }
  if (currentsResponse != null) {
    models.push("marine:smoc_currents");
  }
  return {
    metadata: {
      fetchedAt: new Date().toISOString(),
      source: "api",
      models,
    },
    waypoints: payloadWaypoints,
  };
}

/**
 * Cache directory for a data dir.
 *
 * @param {string} dataDir
 * @returns {string}
 */
function cacheDir(dataDir) {
  return path.join(dataDir, "weather");
}

/**
 * Sanitizes a route id for use as a cache file name.
 *
 * @param {string} routeId
 * @returns {string}
 */
function routeFileId(routeId) {
  return encodeURIComponent(String(routeId)).replace(/[.']/g, "_");
}

/**
 * Persists a briefing payload: `latest-<route>.json` (atomic rename,
 * always the one offline reads hit) plus a dated snapshot so the crew
 * can see how forecasts evolve between fetch windows. Older
 * snapshots beyond {@link KEEP_SNAPSHOTS} are pruned.
 *
 * @param {string} dataDir - Plugin data directory
 * @param {string} routeId
 * @param {object} payload - UnifiedWeatherPayload
 * @returns {Promise<void>}
 */
async function savePayload(dataDir, routeId, payload) {
  const dir = cacheDir(dataDir);
  await mkdir(dir, { recursive: true });
  const fileId = routeFileId(routeId);
  const stamp = String(payload?.metadata?.fetchedAt ?? Date.now()).replace(
    /[:.]/g,
    "-",
  );
  await writeFile(
    path.join(dir, `latest-${fileId}.json`),
    JSON.stringify(payload),
  );
  const tmp = path.join(dir, `.tmp-${fileId}-${stamp}.json`);
  await writeFile(tmp, JSON.stringify(payload));
  await rename(tmp, path.join(dir, `${fileId}-${stamp}.json`));

  const files = (await readdir(dir))
    .filter((f) => f.startsWith(`${fileId}-`) && f.endsWith(".json"))
    .sort();
  for (const old of files.slice(
    0,
    Math.max(0, files.length - KEEP_SNAPSHOTS),
  )) {
    await rm(path.join(dir, old));
  }
}

/**
 * Removes a cache file (fs.rm promise helper).
 *
 * @param {string} file
 * @returns {Promise<void>}
 */
function rm(file) {
  const { unlink } = require("node:fs/promises");
  return unlink(file).catch(() => {});
}

/**
 * Loads the latest cached payload for a route.
 *
 * @param {string} dataDir - Plugin data directory
 * @param {string} routeId
 * @returns {Promise<object|null>} {payload, cachedAt} or null when
 *   nothing is cached
 */
async function loadPayload(dataDir, routeId) {
  try {
    const file = path.join(
      cacheDir(dataDir),
      `latest-${routeFileId(routeId)}.json`,
    );
    const payload = JSON.parse(await readFile(file, "utf8"));
    return { payload, cachedAt: payload?.metadata?.fetchedAt ?? null };
  } catch (_error) {
    return null;
  }
}

/**
 * Lists the routes that have a cached briefing.
 *
 * @param {string} dataDir - Plugin data directory
 * @returns {Promise<Array<{routeId: string, cachedAt: string|null}>>}
 */
async function listCachedRoutes(dataDir) {
  let files = [];
  try {
    files = await readdir(cacheDir(dataDir));
  } catch (_error) {
    return [];
  }
  return files
    .filter((f) => f.startsWith("latest-") && f.endsWith(".json"))
    .map(async (f) => {
      const routeId = decodeURIComponent(
        f.slice("latest-".length, -".json".length),
      );
      try {
        const payload = JSON.parse(
          await readFile(path.join(cacheDir(dataDir), f), "utf8"),
        );
        return { routeId, cachedAt: payload?.metadata?.fetchedAt ?? null };
      } catch (_error) {
        return { routeId, cachedAt: null };
      }
    })
    .reduce(
      async (acc, promise) => [...(await acc), await promise],
      Promise.resolve([]),
    );
}

module.exports = {
  DEFAULT_FORECAST_DAYS,
  DEFAULT_SAMPLE_INTERVAL_NM,
  KEEP_SNAPSHOTS,
  FORECAST_URL,
  MARINE_URL,
  distanceNm,
  interpolatePosition,
  sampleRoutePoints,
  routeDistanceNm,
  dewpointC,
  kIndex,
  parseUtcTimestamp,
  normalizeLocations,
  buildTimeSteps,
  fetchWeatherAlongTrack,
  savePayload,
  loadPayload,
  listCachedRoutes,
};
