/**
 * Visible-launch notes (work doc #36): rocket launches the vessel
 * could actually see from where it floats.
 *
 * Launch schedules come from Launch Library 2 (thespacedevs.com) —
 * free, unauthenticated JSON with pad coordinates — fetched during
 * the online window and cached in the plugin data directory. The gate
 * is the classic visible-launch geometry: the pad within range of the
 * vessel, and the launch time falling where the observer is in
 * twilight or darkness while the ascending vehicle climbs into
 * sunlight — the plume catches the sun. A launch the vessel cannot
 * see is not an event.
 *
 * Delays and scrubs are the norm; the note refreshes on every compile
 * and says so in its description.
 *
 * @file launch-source.js
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const { azimuthCompass } = require("./satellite-source.js");
const ephemeris = require("./celestial-ephemeris.js");

const LL2_UPCOMING_URL =
  "https://ll.thespacedevs.com/2.2.0/launch/upcoming/?mode=verbose&limit=25";

/** Launch schedule cache lifetime: windows slip on the order of
 * hours, so the schedule is re-fetched within the same day. */
const LAUNCH_REFRESH_MS = 6 * 3600000;

/** How far ahead the briefing tracks launches: a two-week passage. */
const LAUNCH_HORIZON_DAYS = 14;

/** Range (km) at which a twilight launch plume is worth naming: the
 * vehicle rises into sunlight well within this slant range. */
const LAUNCH_RANGE_KM = 1200;

/** Sun-elevation window (degrees) at the vessel for a visible launch:
 * dark enough that the plume stands out, bright enough overhead that
 * the ascending vehicle is still sunlit. */
const TWILIGHT_SUN_MIN_DEG = -12;
const TWILIGHT_SUN_MAX_DEG = 8;

/** Launch statuses that mean a real attempt may happen: LL2 abbrevs
 * "Go", "TBC" (to be confirmed) and "T-0" (in window). Holds, scrubs
 * and completed attempts are not watch-for material. */
const WATCHABLE_STATUS = new Set(["Go", "TBC", "T-0"]);

const EARTH_RADIUS_KM = 6371;

/**
 * Parses a Launch Library 2 upcoming-launch response down to the
 * fields the gate needs. Pad coordinates are strings in the API —
 * parsed defensively; launches without a pad position or a sane
 * launch time are dropped.
 *
 * @param {unknown} raw - Parsed LL2 JSON
 * @param {Date} now - Instant the window opens from
 * @returns {Array<{id: string, name: string, net: Date, status: string,
 *   rocket: string|null, lsp: string|null, padName: string|null,
 *   padLat: number, padLon: number, url: string|null}>}
 */
function parseLaunches(raw, now) {
  const results = raw?.results;
  if (!Array.isArray(results)) {
    return [];
  }
  const horizonEnd = now.getTime() + LAUNCH_HORIZON_DAYS * 86400000;
  const launches = [];
  for (const launch of results) {
    if (!launch || typeof launch !== "object") {
      continue;
    }
    const net = Date.parse(launch.net ?? "");
    if (!Number.isFinite(net) || net < now.getTime() || net > horizonEnd) {
      continue;
    }
    const status = launch.status?.abbrev ?? launch.status?.name ?? "";
    if (!WATCHABLE_STATUS.has(status)) {
      continue;
    }
    // Number(null) is 0, not NaN — guard the missing-pad case
    const padLat =
      launch.pad?.latitude == null ? NaN : Number(launch.pad.latitude);
    const padLon =
      launch.pad?.longitude == null ? NaN : Number(launch.pad.longitude);
    if (!Number.isFinite(padLat) || !Number.isFinite(padLon)) {
      continue;
    }
    launches.push({
      id: String(launch.id ?? launch.slug ?? ""),
      name: launch.name ?? "Launch",
      net: new Date(net),
      status,
      rocket:
        launch.rocket?.configuration?.full_name ??
        launch.rocket?.configuration?.name ??
        null,
      lsp: launch.launch_service_provider?.name ?? launch.lsp_name ?? null,
      padName: launch.pad?.name ?? launch.pad?.location?.name ?? null,
      padLat,
      padLon,
      url: typeof launch.url === "string" ? launch.url : null,
    });
  }
  return launches.sort((a, b) => a.net.getTime() - b.net.getTime());
}

/**
 * Great-circle distance between two {lat, lon} points, km.
 *
 * @param {{lat: number, lon: number}} a
 * @param {{lat: number, lon: number}} b
 * @returns {number} Distance in km
 */
function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Initial bearing from one point to another, degrees true.
 *
 * @param {{lat: number, lon: number}} from
 * @param {{lat: number, lon: number}} to
 * @returns {number} Bearing 0..360
 */
function bearingDeg(from, to) {
  const rad = Math.PI / 180;
  const dLon = (to.lon - from.lon) * rad;
  const y = Math.sin(dLon) * Math.cos(to.lat * rad);
  const x =
    Math.cos(from.lat * rad) * Math.sin(to.lat * rad) -
    Math.sin(from.lat * rad) * Math.cos(to.lat * rad) * Math.cos(dLon);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/**
 * Gates one launch and words its description. Exported for direct
 * gate testing.
 *
 * @param {object} params
 * @param {object} params.launch - One parsed launch
 * @param {{lat: number, lon: number}} params.vessel - Vessel position
 * @param {number} params.sunAltDeg - Sun elevation at the vessel at
 *   the launch instant
 * @param {boolean} params.cloudOk - Cloud gate verdict
 * @returns {object|null} spaceEvent, or null when not visible
 */
function gateLaunch({ launch, vessel, sunAltDeg, cloudOk }) {
  const pad = { lat: launch.padLat, lon: launch.padLon };
  const distance = distanceKm(vessel, pad);
  if (distance > LAUNCH_RANGE_KM) {
    return null;
  }
  if (sunAltDeg < TWILIGHT_SUN_MIN_DEG || sunAltDeg > TWILIGHT_SUN_MAX_DEG) {
    // Deeper night: the low-altitude plume sits in the Earth's shadow
    // too. Brighter: daylight washes the plume out.
    return null;
  }
  if (!cloudOk) {
    return null;
  }
  const bearing = bearingDeg(vessel, pad);
  const pieces = [
    launch.rocket ?? launch.name,
    `launch from ${launch.padName ?? "its pad"}`,
    `— twilight plume low toward ${azimuthCompass(bearing)}, ${Math.round(distance / 1.852)} nm away`,
  ];
  if (launch.lsp) {
    pieces.push(`(${launch.lsp})`);
  }
  pieces.push("launch windows slip — check again closer to the time");
  return {
    kind: "launch",
    timestamp: launch.net.toISOString(),
    tactical: true,
    name: launch.name,
    description: pieces.join(" "),
    provenance: {
      kind: "feed",
      label: "Launch Library 2",
      url: launch.url,
      viewerUrl: null,
      at: null,
    },
  };
}

/**
 * Builds launch events for a vessel position from parsed launches.
 *
 * @param {object} params
 * @param {Array<object>} params.launches - Parsed launches (parseLaunches)
 * @param {number} params.lat - Vessel latitude
 * @param {number} params.lon - Vessel longitude (degrees east)
 * @param {((timestamp: string) => number|null)|undefined} [params.cloudCoverAt]
 * @param {(date: Date, lat: number, lon: number) => number} params.sunAltAt
 *   Sun elevation at a position (degrees)
 * @returns {Array<object>} spaceEvents
 */
function computeLaunchEvents({ launches, lat, lon, cloudCoverAt, sunAltAt }) {
  const vessel = { lat, lon };
  const events = [];
  for (const launch of launches) {
    const cloudOk = ephemeris.passesCloudGate(
      launch.net.toISOString(),
      cloudCoverAt,
    );
    const event = gateLaunch({
      launch,
      vessel,
      sunAltDeg: sunAltAt(launch.net, lat, lon),
      cloudOk,
    });
    if (event) {
      events.push(event);
    }
  }
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Loads the cached launch schedule when fresh enough; a stale cache
 * still answers when the fetch fails.
 *
 * @param {string|undefined} dataDir - Plugin data directory
 * @returns {Promise<{payload: object, fetchedAt: string}|null>}
 */
async function loadLaunchCache(dataDir) {
  if (!dataDir) {
    return null;
  }
  try {
    const raw = await fs.readFile(path.join(dataDir, "launches.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.payload ? parsed : null;
  } catch (_error) {
    return null;
  }
}

/**
 * Persists the launch cache; failures are silent.
 *
 * @param {string|undefined} dataDir
 * @param {object} payload - Raw LL2 response
 */
async function saveLaunchCache(dataDir, payload) {
  if (!dataDir) {
    return;
  }
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "launches.json"),
      `${JSON.stringify({ fetchedAt: new Date().toISOString(), payload })}\n`,
    );
  } catch (_error) {
    // Cache write failure degrades to refetching next time
  }
}

/**
 * Fetches the upcoming-launch schedule from Launch Library 2. Any
 * failure answers null so the caller degrades to no events.
 *
 * @param {object} [params]
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<object|null>} Raw LL2 response
 */
async function fetchLaunches({ fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(LL2_UPCOMING_URL, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the whole launch source for one briefing compile. Never
 * throws — every failure degrades to no events.
 *
 * @param {object} params
 * @param {string|undefined} params.dataDir - Plugin data directory
 * @param {number} params.lat - Vessel latitude
 * @param {number} params.lon - Vessel longitude (degrees east)
 * @param {Date} [params.from] - Window start (default now)
 * @param {((timestamp: string) => number|null)|undefined} [params.cloudCoverAt]
 * @param {(date: Date, lat: number, lon: number) => number} [params.sunAltAt]
 *   Sun-elevation override (tests)
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<Array<object>>} spaceEvents
 */
async function fetchLaunchEvents({
  dataDir,
  lat,
  lon,
  from = new Date(),
  cloudCoverAt,
  sunAltAt = (date, nlat, nlon) =>
    require("./celestial-ephemeris.js").bodyAltitudeDeg(
      "Sun",
      date,
      nlat,
      nlon,
    ),
  fetchImpl = fetch,
  timeoutMs = 20000,
}) {
  let payload = null;
  const cache = await loadLaunchCache(dataDir);
  if (cache) {
    const age = Date.now() - Date.parse(cache.fetchedAt);
    if (Number.isFinite(age) && age < LAUNCH_REFRESH_MS) {
      payload = cache.payload;
    }
  }
  if (!payload) {
    payload = await fetchLaunches({ fetchImpl, timeoutMs });
    if (payload) {
      await saveLaunchCache(dataDir, payload);
    } else if (cache) {
      payload = cache.payload; // stale schedule beats no schedule
    }
  }
  if (!payload) {
    return [];
  }
  return computeLaunchEvents({
    launches: parseLaunches(payload, from),
    lat,
    lon,
    cloudCoverAt,
    sunAltAt,
  });
}

module.exports = {
  LL2_UPCOMING_URL,
  LAUNCH_REFRESH_MS,
  LAUNCH_HORIZON_DAYS,
  LAUNCH_RANGE_KM,
  TWILIGHT_SUN_MIN_DEG,
  TWILIGHT_SUN_MAX_DEG,
  WATCHABLE_STATUS,
  parseLaunches,
  distanceKm,
  bearingDeg,
  gateLaunch,
  computeLaunchEvents,
  loadLaunchCache,
  saveLaunchCache,
  fetchLaunches,
  fetchLaunchEvents,
};
