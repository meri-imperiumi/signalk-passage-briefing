/**
 * Celestial & space weather source (work doc #3, Phase 1):
 * ultra-lightweight fetch-driven events with coarse gating —
 *
 * - Aurora: NOAA SWPC 3-day planetary K-index forecast; an alert is
 *   emitted when the predicted Kp reaches storm level (≥ 5) and the
 *   vessel's magnetic latitude is far enough south/north for that Kp
 *   to be observable.
 * - Naked-eye comets: JPL Small-Body Database query for comets with
 *   predicted apparent magnitude brighter than 6.0.
 *
 * Everything else (twilight, moon, planets, meteors, satellite
 * passes) is Phase 2 and deliberately not attempted here.
 *
 * Both endpoints degrade independently: a failure nulls its half, so
 * a blocked JPL host never costs the aurora alert.
 *
 * @file celestial-source.js
 */

/**
 * Kp at which a geomagnetic storm (and mid-latitude aurora chance)
 * begins (NOAA G-scale G1).
 */
const STORM_KP = 5;

/**
 * Naked-eye visibility limit for comets.
 */
const NAKED_EYE_MAGNITUDE = 6.0;

/**
 * Position of the geomagnetic north pole (2025 epoch approximation).
 * Good enough for coarse aurora gating; not for navigation.
 */
const GEOMAGNETIC_POLE = { lat: 80.0, lon: -72.0 };

/**
 * Coarse equatorward magnetic-latitude reach of the auroral oval for
 * a given Kp: about 65° at Kp 5, stretching to ~45° at Kp 9.
 *
 * @param {number} kp
 * @returns {number} Absolute magnetic-latitude threshold in degrees
 */
function auroraMagLatThreshold(kp) {
  return Math.max(40, 90 - 5 * kp);
}

/**
 * Magnetic (dipole) latitude for a geographic position, using a
 * fixed geomagnetic pole approximation.
 *
 * @param {number} lat - Geographic latitude, degrees
 * @param {number} lon - Geographic longitude, degrees east
 * @returns {number} Magnetic latitude, degrees
 */
function magneticLatitudeDeg(lat, lon) {
  const toRad = Math.PI / 180;
  const φ = lat * toRad;
  const λ = lon * toRad;
  const φ0 = GEOMAGNETIC_POLE.lat * toRad;
  const λ0 = GEOMAGNETIC_POLE.lon * toRad;
  return (
    Math.asin(
      Math.sin(φ) * Math.sin(φ0) +
        Math.cos(φ) * Math.cos(φ0) * Math.cos(λ - λ0),
    ) / toRad
  );
}

/**
 * Parses an SWPC planetary K-index forecast product and returns the
 * entries inside the forward window, sorted by time.
 *
 * @param {Array<{time_tag: string, kp: number, observed?: string}>|
 *   null} json - Parsed SWPC product (3-hour steps)
 * @param {object} [options]
 * @param {Date} [options.from] - Window start (default now)
 * @param {number} [options.hours=24] - Window length
 * @returns {Array<{timestamp: string, kp: number, predicted: boolean}>}
 */
function parseKpForecast(json, { from = new Date(), hours = 24 } = {}) {
  if (!Array.isArray(json)) {
    return [];
  }
  const start = from.getTime();
  const end = start + hours * 3600000;
  const entries = [];
  for (const row of json) {
    const t = new Date(row?.time_tag).getTime();
    const kp = row?.kp;
    if (!Number.isFinite(t) || typeof kp !== "number" || !Number.isFinite(kp)) {
      continue;
    }
    if (t < start || t >= end) {
      continue;
    }
    entries.push({
      timestamp: new Date(t).toISOString(),
      kp,
      predicted: row.observed !== "observed",
    });
  }
  return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Apparent magnitude of a comet from the standard total-magnitude
 * formula m = M1 + 5·log10(Δ) + K1·log10(r).
 *
 * @param {object} p
 * @param {number} p.M1 - Total magnitude parameter
 * @param {number} p.K1 - Brightness slope parameter
 * @param {number} p.r - Heliocentric distance, au
 * @param {number} p.delta - Geocentric distance, au
 * @returns {number|null}
 */
function cometApparentMagnitude({ M1, K1, r, delta }) {
  if (
    [M1, K1, r, delta].some(
      (v) => typeof v !== "number" || !Number.isFinite(v),
    ) ||
    r <= 0 ||
    delta <= 0
  ) {
    return null;
  }
  return M1 + 5 * Math.log10(delta) + K1 * Math.log10(r);
}

/**
 * Parses an SBDB query response down to the naked-eye comets.
 *
 * @param {{fields?: string[], rows?: Array<Array<string|number>>}|
 *   null} json - Parsed SBDB query API response
 * @param {object} [options]
 * @param {number} [options.maxMagnitude] - Brightness limit
 * @returns {Array<{name: string, magnitude: number, M1: number,
 *   K1: number, r: number, delta: number}>}
 */
function parseComets(json, { maxMagnitude = NAKED_EYE_MAGNITUDE } = {}) {
  const fields = json?.fields;
  const rows = json?.rows;
  if (!Array.isArray(fields) || !Array.isArray(rows)) {
    return [];
  }
  const index = (name) =>
    fields.findIndex((f) => String(f).toLowerCase() === name);
  const iName = index("full_name");
  const iM1 = index("m1");
  const iK1 = index("k1");
  const iR = index("r");
  const iDelta = index("dist");
  const iQ = index("q");
  const iTpCal = index("tp_cal");
  if (iName < 0 || iM1 < 0 || iK1 < 0) {
    return [];
  }
  const comets = [];
  for (const row of rows) {
    const M1 = Number(row[iM1]);
    const K1 = Number(row[iK1]);
    const name = row[iName];
    if (
      ![M1, K1].every((v) => Number.isFinite(v)) ||
      typeof name !== "string"
    ) {
      continue;
    }
    if (iR >= 0 && iDelta >= 0) {
      // Current distances available: apparent magnitude now
      const r = Number(row[iR]);
      const delta = Number(row[iDelta]);
      const magnitude = cometApparentMagnitude({ M1, K1, r, delta });
      if (magnitude == null) {
        continue;
      }
      if (magnitude <= maxMagnitude) {
        comets.push({
          name: name.trim(),
          magnitude: Math.round(magnitude * 10) / 10,
          estimate: "now",
          M1,
          K1,
          r,
          delta,
        });
      }
      continue;
    }
    // No current distances from this endpoint: screen on the
    // perihelion brightness instead (r = delta = q is the comet at
    // its brightest). The result is a peak-brightness estimate, not
    // a now-cast — flagged so the display can say so.
    if (iQ < 0) {
      continue;
    }
    const q = Number(row[iQ]);
    if (!Number.isFinite(q) || q <= 0) {
      continue;
    }
    const magnitude = cometApparentMagnitude({ M1, K1, r: q, delta: q });
    if (magnitude == null) {
      continue;
    }
    if (magnitude <= maxMagnitude) {
      comets.push({
        name: name.trim(),
        magnitude: Math.round(magnitude * 10) / 10,
        estimate: "perihelion",
        perihelion: iTpCal >= 0 ? row[iTpCal] : null,
        M1,
        K1,
        q,
      });
    }
  }
  return comets.sort((a, b) => a.magnitude - b.magnitude);
}

const SWPC_KP_URL =
  "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json";

/** Field list the SBDB comet query is attempted with. The API rejects
 * unknown/unsupported fields one at a time (400 "invalid field
 * specified: 'x'"), so fetchComets negotiates the list down to what
 * the live endpoint accepts. `r`/`dist` (current heliocentric and
 * geocentric distance) are not documented query fields for comets —
 * `q` (perihelion distance) is, and powers the fallback estimate. */
const SBDB_COMET_FIELDS = ["full_name", "M1", "K1", "r", "dist", "q", "tp_cal"];

function sbdbCometsUrl(fields) {
  return `https://ssd-api.jpl.nasa.gov/sbdb_query.api?fields=${fields.join(",")}&sb-kind=c`;
}

/**
 * Builds the space-event list from parsed inputs (all gating that
 * needs no network happens here).
 *
 * @param {object} params
 * @param {Array<{timestamp: string, kp: number}>} [params.kpEntries]
 * @param {Array<{name: string, magnitude: number}>} [params.comets]
 * @param {number} params.lat - Vessel latitude
 * @param {number} params.lon - Vessel longitude
 * @param {Date} [params.now]
 * @param {(date: Date, lat: number, lon: number) => boolean} [params.isNightFn]
 *   Night test (default: the shared Sereno solar geometry)
 * @returns {Array<{kind: string, timestamp: string, tactical: boolean, description: string, kp?: number, name?: string, magnitude?: number}>}
 */
async function buildSpaceEvents({
  kpEntries = [],
  comets = [],
  lat,
  lon,
  now = new Date(),
  isNightFn,
}) {
  const isNight =
    isNightFn ?? (await import("../public/sereno-physics.mjs")).isNight;
  const events = [];

  // Aurora: strongest predicted Kp in the window, gated by magnetic
  // latitude and a local-night check at the vessel
  const peak = kpEntries.reduce(
    (best, e) => (best == null || e.kp > best.kp ? e : best),
    null,
  );
  if (peak && peak.kp >= STORM_KP) {
    const magLat = magneticLatitudeDeg(lat, lon);
    if (Math.abs(magLat) >= auroraMagLatThreshold(peak.kp)) {
      const look = lat >= 0 ? "north" : "south";
      if (isNight(new Date(peak.timestamp), lat, lon)) {
        events.push({
          kind: "aurora",
          timestamp: peak.timestamp,
          tactical: true,
          kp: peak.kp,
          description: `Aurora possible: Kp ${peak.kp.toFixed(0)} predicted tonight. Look ${look}.`,
        });
      }
    }
  }

  // Naked-eye comets: strategic items, no precision claimed
  for (const comet of comets) {
    events.push({
      kind: "comet",
      timestamp: now.toISOString(),
      tactical: false,
      name: comet.name,
      magnitude: comet.magnitude,
      description:
        comet.estimate === "perihelion"
          ? `Comet ${comet.name} peaks near mag ${comet.magnitude.toFixed(1)} at perihelion${comet.perihelion ? ` (${comet.perihelion})` : ""} — ephemeris check advised`
          : `Naked-eye comet ${comet.name} (mag ${comet.magnitude.toFixed(1)}) in range`,
    });
  }
  return events;
}

/**
 * Fetches both sources and builds the event list. Each source fails
 * independently; a total failure yields an empty list.
 *
 * @param {object} params
 * @param {number} params.lat
 * @param {number} params.lon
 * @param {Date} [params.now]
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.timeoutMs]
 * @param {(date: Date, lat: number, lon: number) => boolean} [params.isNightFn]
 *   Night test override (tests)
 * @returns {Promise<Array<object>>} Space events (possibly empty)
 */
/**
 * Fetches the SBDB comet query, negotiating the field list against
 * the live endpoint: each 400 names one invalid field, which is
 * dropped and the query retried until it answers or the fields run
 * out.
 *
 * @param {object} params
 * @param {typeof fetch} params.fetchImpl
 * @param {number} params.timeoutMs
 * @returns {Promise<object|null>} Parsed `{fields, rows}` response,
 *   null when every attempt failed
 */
async function fetchComets({ fetchImpl, timeoutMs }) {
  let fields = [...SBDB_COMET_FIELDS];
  while (fields.length >= 2) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(sbdbCometsUrl(fields), {
        signal: controller.signal,
      });
    } catch (_error) {
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const invalid = detail.match(/invalid field specified: '(\w+)'/);
      if (response.status === 400 && invalid) {
        fields = fields.filter(
          (field) => field.toLowerCase() !== invalid[1].toLowerCase(),
        );
        continue;
      }
      return null;
    }
    return await response.json();
  }
  return null;
}

async function fetchSpaceEvents({
  lat,
  lon,
  now = new Date(),
  fetchImpl = fetch,
  timeoutMs = 15000,
  isNightFn,
}) {
  const grab = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        return null;
      }
      return await response.json();
    } catch (_error) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const [kpJson, cometJson] = await Promise.all([
    grab(SWPC_KP_URL),
    fetchComets({ fetchImpl, timeoutMs }),
  ]);
  const kpEntries = kpJson ? parseKpForecast(kpJson, { from: now }) : [];
  const comets = cometJson ? parseComets(cometJson) : [];
  if (kpEntries.length === 0 && comets.length === 0) {
    return [];
  }
  try {
    return await buildSpaceEvents({
      kpEntries,
      comets,
      lat,
      lon,
      now,
      isNightFn,
    });
  } catch (_error) {
    return [];
  }
}

module.exports = {
  STORM_KP,
  NAKED_EYE_MAGNITUDE,
  auroraMagLatThreshold,
  magneticLatitudeDeg,
  parseKpForecast,
  cometApparentMagnitude,
  parseComets,
  fetchComets,
  sbdbCometsUrl,
  buildSpaceEvents,
  fetchSpaceEvents,
};
