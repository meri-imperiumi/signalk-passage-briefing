/**
 * Reentry watch (work doc #36): satellites about to reenter, gated to
 * the events a vessel can actually see.
 *
 * Predictions come from Space-Track's TIP (Trajectory Impact
 * Prediction) messages — the only machine-readable reentry-forecast
 * source, behind a free account whose credentials live in the plugin
 * configuration. Without credentials the source degrades to off, like
 * every other fetch source. For each predicted decay, the object's
 * current elements come from CelesTrak's per-catalog query
 * (unauthenticated) and the final ground track is propagated on board
 * with the same `satellite.js` SGP4 propagator the station passes
 * use. Space-Track rate-limits, so TIP responses are cached in the
 * plugin data directory and refreshed at a reasonable interval; a
 * stale cache still answers when the fetch fails.
 *
 * The visibility gate models the two regimes separately (backtested
 * against the Cluster II SAMBA/TANGO deorbits, work doc #36):
 *
 * - Night: the vehicle burns as a fireball, visible up to the
 *   geometric horizon of the burn altitude (~1000-1100 km).
 * - Daylight: no glow; the sight is a sunlit smoke trail, best at the
 *   twilight edge and readable in broad daylight only when close.
 *
 * Everything here is a watch-for heads-up: reentry epochs carry hours
 * of uncertainty, so descriptions never promise an instant.
 *
 * @file reentry-source.js
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const satellite = require("satellite.js");
const ephemeris = require("./celestial-ephemeris.js");
const { azimuthCompass } = require("./satellite-source.js");

const SPACETRACK_BASE = "https://www.space-track.org";
const SPACETRACK_LOGIN_PATH = "/ajaxauth/login";
const SPACETRACK_TIP_QUERY =
  "/basicspacedata/query/class/tip/MSG_EPOCH/%3E{iso}/format/json";
const CELESTRAK_CATNR_URL =
  "https://celestrak.org/NORAD/elements/gp.php?CATNR={cat}&FORMAT=tle";

/** TIP cache lifetime: Space-Track rate-limits, and predictions for a
 * given object refresh on the order of daily as the decay nears. */
const TIP_REFRESH_MS = 12 * 3600000;

/** How far ahead of `from` a predicted decay is still worth reporting:
 * a two-week passage plus margin, so the strategic outlook can name
 * the whole window. */
const REENTRY_HORIZON_DAYS = 30;

/** Altitude below which a propagated pass counts as the decaying
 * dip (the backtest's threshold — a 53-hour Cluster-style orbit only
 * reads as "reentering" near perigee). */
const LOW_PASS_ALT_KM = 500;

/** Ground-track propagation step. The reentry pass lasts minutes; one
 * minute resolves the corridor well inside the prediction window. */
const TRACK_STEP_MS = 60000;

/** Daylight smoke trails wash out against the bright sky beyond a
 * few hundred km; twilight-edge trails read further. Conservative
 * estimate, not a photometric model (work doc #36). */
const TRAIL_RANGE_KM = 800;
const DAYLIGHT_TRAIL_RANGE_KM = 300;

/** Sun elevation (degrees) splitting the regimes: below this the
 * burn glows as a fireball; above it the sight is the sunlit trail. */
const FIREBALL_SUN_DEG = -6;

/** Nominal event altitude (km) when no TLE refines the prediction —
 * the burn happens in the upper mesosphere/lower thermosphere. */
const NOMINAL_REENTRY_ALT_KM = 78;

const EARTH_RADIUS_KM = 6371;

/**
 * Parses a Space-Track epoch stamp ("2026-09-03 17:34:00" — space-
 * separated, no timezone marker; Space-Track speaks UTC).
 *
 * @param {string} value - Stamp or null
 * @returns {Date|null} Parsed instant
 */
function parseSpaceTrackStamp(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const ms = Date.parse(`${value.trim().replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * Normalizes TIP message rows: Space-Track longitudes run 0..360
 * east-positive, the briefing speaks -180..180; missing or unparseable
 * epochs drop the row. Rows for the same object are deduplicated,
 * keeping the latest message (TIP issues repeated reports per object
 * as the decay nears).
 *
 * @param {unknown} raw - Parsed TIP JSON (array of rows)
 * @returns {Array<{catnr: string, name: string|null, msgEpoch: Date|null,
 *   decayEpoch: Date, windowMin: number, lat: number|null,
 *   lon: number|null, direction: string|null}>}
 */
function parseTipMessages(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const rows = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const catnr = String(row.NORAD_CAT_ID ?? "").trim();
    const decayEpoch = parseSpaceTrackStamp(row.DECAY_EPOCH);
    if (!catnr || !decayEpoch) {
      continue;
    }
    let lon = Number(row.LON);
    lon = Number.isFinite(lon) ? (((lon % 360) + 540) % 360) - 180 : null;
    const lat = Number(row.LAT);
    const windowMin = Number(row.WINDOW);
    rows.push({
      catnr,
      name: typeof row.OBJECT_NAME === "string" ? row.OBJECT_NAME : null,
      msgEpoch: parseSpaceTrackStamp(row.MSG_EPOCH),
      decayEpoch,
      windowMin: Number.isFinite(windowMin) && windowMin > 0 ? windowMin : 0,
      lat: Number.isFinite(lat) ? lat : null,
      lon,
      direction: typeof row.DIRECTION === "string" ? row.DIRECTION : null,
    });
  }
  const latest = new Map();
  for (const row of rows) {
    const existing = latest.get(row.catnr);
    if (
      !existing ||
      (row.msgEpoch && (!existing.msgEpoch || row.msgEpoch > existing.msgEpoch))
    ) {
      latest.set(row.catnr, row);
    }
  }
  return [...latest.values()].sort(
    (a, b) => a.decayEpoch.getTime() - b.decayEpoch.getTime(),
  );
}

/**
 * Logs in to Space-Track and fetches recent TIP messages. Session
 * cookies stay in memory for the duration of the call only.
 *
 * @param {object} params
 * @param {string} params.identity - Space-Track username
 * @param {string} params.password - Space-Track password
 * @param {Date} params.since - Only messages issued after this instant
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<Array<object>|null>} Raw TIP rows, null on failure
 */
async function fetchTipMessages({
  identity,
  password,
  since,
  fetchImpl = fetch,
  timeoutMs = 30000,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const login = await fetchImpl(
      `${SPACETRACK_BASE}${SPACETRACK_LOGIN_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ identity, password }).toString(),
        signal: controller.signal,
      },
    );
    if (!login.ok) {
      return null;
    }
    // Node's fetch exposes set-cookie only via getSetCookie()
    const cookies = (login.headers.getSetCookie?.() ?? []).map(
      (cookie) => cookie.split(";")[0],
    );
    if (cookies.length === 0) {
      return null;
    }
    const query = SPACETRACK_TIP_QUERY.replace(
      "{iso}",
      since.toISOString().slice(0, 10),
    );
    const response = await fetchImpl(`${SPACETRACK_BASE}${query}`, {
      headers: { cookie: cookies.join("; ") },
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
 * Fetches the current element set for one catalog number from
 * CelesTrak. Decayed objects answer "No GP data found" — that is a
 * missing TLE, not a failure.
 *
 * @param {string} catnr - NORAD catalog number
 * @param {object} [params]
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{name: string, line1: string, line2: string}|null>}
 */
async function fetchCelesTrakTLE(
  catnr,
  { fetchImpl = fetch, timeoutMs = 15000 } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      CELESTRAK_CATNR_URL.replace("{cat}", encodeURIComponent(catnr)),
      { signal: controller.signal },
    );
    if (!response.ok) {
      return null;
    }
    const text = await response.text();
    if (text.includes("No GP data")) {
      return null;
    }
    const [name, line1, line2] = text
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim());
    if (!name || !line1?.startsWith("1 ") || !line2?.startsWith("2 ")) {
      return null;
    }
    return { name, line1, line2 };
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Propagates a ground track between two instants, stopping early when
 * SGP4 gives up (decayed orbit).
 *
 * @param {object} satrec - satellite.js record
 * @param {Date} start - Window start
 * @param {Date} end - Window end
 * @returns {Array<{t: number, lat: number, lon: number, altKm: number}>}
 */
function groundTrack(satrec, start, end) {
  const points = [];
  for (let t = start.getTime(); t <= end.getTime(); t += TRACK_STEP_MS) {
    const date = new Date(t);
    let pv;
    try {
      pv = satellite.propagate(satrec, date);
    } catch (_error) {
      break;
    }
    if (!pv?.position) {
      break;
    }
    const gd = satellite.eciToGeodetic(pv.position, satellite.gstime(date));
    points.push({
      t,
      lat: gd.latitude * (180 / Math.PI),
      lon: ((gd.longitude * (180 / Math.PI) + 540) % 360) - 180,
      altKm: gd.height,
    });
  }
  return points;
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
 * Geometric horizon-limited sighting range for an event at a given
 * altitude above sea level, from sea level: (R+h)·arccos(R/(R+h)).
 * Beyond this the event is below the observer's horizon — no sky
 * condition changes that (the SAMBA/TANGO backtest's central fact).
 *
 * @param {number} altKm - Event altitude above sea level
 * @returns {number} Maximum sighting range in km
 */
function horizonCapKm(altKm) {
  const h = Math.min(Math.max(altKm, 0), 200);
  return (
    (EARTH_RADIUS_KM + h) * Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + h))
  );
}

/**
 * Finds the decaying pass (the low-altitude dip) nearest the predicted
 * decay epoch in a propagated track.
 *
 * @param {object} params
 * @param {object} params.satrec - satellite.js record
 * @param {Date} params.decayEpoch - Predicted reentry instant
 * @param {number} params.windowMin - Prediction uncertainty (±minutes)
 * @returns {{at: number, minAltKm: number, points: Array<object>}|null}
 *   The pass whose minimum altitude sits nearest the epoch, or null
 *   when no dip exists in the window
 */
function lowestPassNear({ satrec, decayEpoch, windowMin }) {
  // At least ±3 h either side: early TIP windows run wide, and sparse
  // end-of-life element sets drift (the backtest's SAMBA case)
  const windowMs = Math.max(windowMin, 180) * 60000;
  const track = groundTrack(
    satrec,
    new Date(decayEpoch.getTime() - windowMs),
    new Date(decayEpoch.getTime() + windowMs),
  );
  const passes = [];
  let current = null;
  for (const point of track) {
    if (point.altKm < LOW_PASS_ALT_KM) {
      if (!current) {
        current = { at: point.t, minAltKm: point.altKm, points: [] };
      }
      if (point.altKm < current.minAltKm) {
        current.at = point.t;
        current.minAltKm = point.altKm;
      }
      current.points.push(point);
    } else if (current) {
      if (current.points.length > 1) {
        passes.push(current);
      }
      current = null;
    }
  }
  if (current && current.points.length > 1) {
    passes.push(current);
  }
  if (passes.length === 0) {
    return null;
  }
  // The pass whose dip sits nearest the predicted decay epoch
  return passes.reduce((best, candidate) =>
    Math.abs(candidate.at - decayEpoch.getTime()) <
    Math.abs(best.at - decayEpoch.getTime())
      ? candidate
      : best,
  );
}

/**
 * Gates one reentry candidate and words its description for the regime
 * it falls in. Exported for direct gate testing.
 *
 * @param {object} params
 * @param {number} params.rangeKm - Closest approach to the vessel
 * @param {number} params.altKm - Event altitude at closest approach
 * @param {number} params.sunAltDeg - Sun elevation at the vessel
 * @param {boolean} params.cloudOk - Cloud gate verdict
 * @param {string} params.name - Object display name
 * @param {Date} params.at - Event instant
 * @param {number} params.windowMin - Prediction uncertainty (±minutes)
 * @param {number} [params.bearingDeg] - Bearing vessel → closest point
 * @returns {object|null} spaceEvent, or null when not observable
 */
function gateReentry({
  rangeKm,
  altKm,
  sunAltDeg,
  cloudOk,
  name,
  at,
  windowMin,
  bearingDeg: bearing = 0,
}) {
  if (!cloudOk) {
    return null;
  }
  const cap = horizonCapKm(altKm);
  const fireball = sunAltDeg < FIREBALL_SUN_DEG;
  const trailCap = sunAltDeg > 10 ? DAYLIGHT_TRAIL_RANGE_KM : TRAIL_RANGE_KM;
  const rangeCap = fireball ? cap : Math.min(cap, trailCap);
  if (rangeKm > rangeCap) {
    return null;
  }
  const clock = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}Z`;
  const windowText = windowMin > 0 ? ` (±${windowMin} min)` : "";
  const where = `${Math.round(rangeKm / 1.852)} nm ${azimuthCompass(bearing)}`;
  const description = fireball
    ? `${name} reentry — fireball watch: the track passes ${where} around ${clock}${windowText}`
    : `${name} reentry — watch for a sunlit smoke streak low toward ${azimuthCompass(bearing)} around ${clock}${windowText}`;
  return {
    kind: "reentry",
    timestamp: at.toISOString(),
    tactical: true,
    name,
    description,
  };
}

/**
 * Builds reentry events from parsed TIP messages, refined by the
 * objects' current element sets when CelesTrak has them.
 *
 * @param {object} params
 * @param {Array<object>} params.tips - Parsed TIP rows (parseTipMessages)
 * @param {Map<string, {name: string, line1: string, line2: string}>} params.tles
 *   Element sets by catalog number (missing entries fall back to the
 *   TIP message's own predicted point)
 * @param {number} params.lat - Vessel latitude
 * @param {number} params.lon - Vessel longitude (degrees east)
 * @param {Date} params.from - Window start
 * @param {((timestamp: string) => number|null)|undefined} [params.cloudCoverAt]
 * @param {(date: Date, lat: number, lon: number) => number} params.sunAltAt
 *   Sun elevation at a position (degrees)
 * @param {number} [params.horizonDays] - Report window (default 30)
 * @returns {Array<object>} spaceEvents
 */
function computeReentryEvents({
  tips,
  tles,
  lat,
  lon,
  from,
  cloudCoverAt,
  sunAltAt,
  horizonDays = REENTRY_HORIZON_DAYS,
}) {
  const events = [];
  const horizonEnd = from.getTime() + horizonDays * 86400000;
  const graceMs = 6 * 3600000; // already-decayed predictions stay quiet
  const vessel = { lat, lon };
  for (const tip of tips) {
    const decayMs = tip.decayEpoch.getTime();
    if (decayMs < from.getTime() - graceMs || decayMs > horizonEnd) {
      continue;
    }
    const tle = tles.get(tip.catnr);
    let satrec = null;
    if (tle) {
      try {
        satrec = satellite.twoline2satrec(tle.line1, tle.line2);
      } catch (_error) {
        satrec = null;
      }
    }
    const pass = satrec
      ? lowestPassNear({
          satrec,
          decayEpoch: tip.decayEpoch,
          windowMin: tip.windowMin,
        })
      : null;
    const cloudOk = ephemeris.passesCloudGate(
      new Date(pass?.at ?? decayMs).toISOString(),
      cloudCoverAt,
    );
    const at = new Date(pass?.at ?? decayMs);
    const sunAltDeg = sunAltAt(at, lat, lon);
    if (pass) {
      let closest = null;
      for (const point of pass.points) {
        const d = distanceKm(vessel, point);
        if (!closest || d < closest.rangeKm) {
          closest = {
            rangeKm: d,
            altKm: point.altKm,
            bearing: bearingDeg(vessel, point),
          };
        }
      }
      const event = gateReentry({
        rangeKm: closest.rangeKm,
        altKm: closest.altKm,
        sunAltDeg,
        cloudOk,
        name: tle?.name ?? tip.name ?? `Object ${tip.catnr}`,
        at,
        windowMin: tip.windowMin,
        bearingDeg: closest.bearing,
      });
      if (event) {
        event.provenance = tipProvenance(tip);
        events.push(event);
      }
      continue;
    }
    // No element set: the TIP message's own predicted point, capped at
    // the nominal burn altitude. The corridor is unknown — the
    // description stays honest about that.
    if (tip.lat == null || tip.lon == null) {
      continue;
    }
    const target = { lat: tip.lat, lon: tip.lon };
    const event = gateReentry({
      rangeKm: distanceKm(vessel, target),
      altKm: NOMINAL_REENTRY_ALT_KM,
      sunAltDeg,
      cloudOk,
      name: tip.name ?? `Object ${tip.catnr}`,
      at,
      windowMin: tip.windowMin,
      bearingDeg: bearingDeg(vessel, target),
    });
    if (event) {
      event.description += " — ground track uncertain, watch the whole horizon";
      event.provenance = tipProvenance(tip);
      events.push(event);
    }
  }
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Provenance record (work doc #31): the prediction is Space-Track's,
 * fetched under the vessel's own account.
 */
function tipProvenance(tip) {
  return {
    kind: "feed",
    label: "Space-Track TIP message",
    url: `${SPACETRACK_BASE}/basicspacedata/query/class/tip/NORAD_CAT_ID/${tip.catnr}`,
    viewerUrl: null,
    at: tip.msgEpoch ? tip.msgEpoch.toISOString() : null,
  };
}

/**
 * Loads the cached TIP response when fresh enough; a stale cache
 * still answers when the fetch fails (offline degradation).
 *
 * @param {string|undefined} dataDir - Plugin data directory
 * @returns {Promise<{rows: Array<object>, fetchedAt: string|null}|null>}
 */
async function loadTipCache(dataDir) {
  if (!dataDir) {
    return null;
  }
  try {
    const raw = await fs.readFile(
      path.join(dataDir, "reentry-tip.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.rows) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

/**
 * Persists the TIP cache; failures are silent (a briefing must not
 * fail because a cache write did).
 *
 * @param {string|undefined} dataDir
 * @param {Array<object>} rows - Raw TIP rows
 */
async function saveTipCache(dataDir, rows) {
  if (!dataDir) {
    return;
  }
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "reentry-tip.json"),
      `${JSON.stringify({ fetchedAt: new Date().toISOString(), rows })}\n`,
    );
  } catch (_error) {
    // Cache write failure degrades to refetching next time
  }
}

/**
 * Runs the whole reentry source for one briefing compile: cached or
 * fresh TIP messages, element sets for the named objects, and the
 * gated events. Never throws — every failure degrades to no events.
 *
 * @param {object} params
 * @param {string|undefined} params.identity - Space-Track username
 * @param {string|undefined} params.password - Space-Track password
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
async function fetchReentryEvents({
  identity,
  password,
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
  timeoutMs = 30000,
}) {
  if (!identity || !password) {
    return [];
  }
  let rawRows = null;
  let cachedAt = null;
  const cache = await loadTipCache(dataDir);
  if (cache) {
    cachedAt = cache.fetchedAt;
    const age = cachedAt ? Date.now() - Date.parse(cachedAt) : Infinity;
    if (Number.isFinite(age) && age < TIP_REFRESH_MS) {
      rawRows = cache.rows;
    }
  }
  if (!rawRows) {
    const since = new Date(Date.now() - 3 * 86400000);
    rawRows = await fetchTipMessages({
      identity,
      password,
      since,
      fetchImpl,
      timeoutMs,
    });
    if (rawRows) {
      await saveTipCache(dataDir, rawRows);
      cachedAt = new Date().toISOString();
    } else if (cache) {
      rawRows = cache.rows; // stale cache beats no prediction at all
    }
  }
  if (!Array.isArray(rawRows)) {
    return [];
  }
  const tips = parseTipMessages(rawRows).filter(
    (tip) =>
      tip.decayEpoch.getTime() >= from.getTime() - 6 * 3600000 &&
      tip.decayEpoch.getTime() <=
        from.getTime() + REENTRY_HORIZON_DAYS * 86400000,
  );
  const tles = new Map();
  await Promise.all(
    [...new Set(tips.map((tip) => tip.catnr))].map(async (catnr) => {
      const tle = await fetchCelesTrakTLE(catnr, { fetchImpl, timeoutMs });
      if (tle) {
        tles.set(catnr, tle);
      }
    }),
  );
  const events = computeReentryEvents({
    tips,
    tles,
    lat,
    lon,
    from,
    cloudCoverAt,
    sunAltAt,
  });
  if (cachedAt) {
    for (const event of events) {
      event.provenance = {
        ...event.provenance,
        at: event.provenance?.at ?? cachedAt,
      };
    }
  }
  return events;
}

module.exports = {
  SPACETRACK_BASE,
  SPACETRACK_LOGIN_PATH,
  SPACETRACK_TIP_QUERY,
  CELESTRAK_CATNR_URL,
  TIP_REFRESH_MS,
  REENTRY_HORIZON_DAYS,
  LOW_PASS_ALT_KM,
  TRAIL_RANGE_KM,
  DAYLIGHT_TRAIL_RANGE_KM,
  FIREBALL_SUN_DEG,
  NOMINAL_REENTRY_ALT_KM,
  parseSpaceTrackStamp,
  parseTipMessages,
  fetchTipMessages,
  fetchCelesTrakTLE,
  groundTrack,
  distanceKm,
  bearingDeg,
  horizonCapKm,
  lowestPassNear,
  gateReentry,
  computeReentryEvents,
  loadTipCache,
  saveTipCache,
  fetchReentryEvents,
};
