/**
 * Bright satellite passes (work doc #3, Phase 2).
 *
 * Fetches two-line elements for the crewed stations (ISS and the
 * Tiangong station) from CelesTrak during the online window, and
 * propagates their transits over the vessel's position locally with
 * `satellite.js`'s SGP4 implementation — the propagator call the work
 * document left open, resolved as an npm dependency (MIT, pure JS).
 *
 * A pass is reported when its peak clears the haze line (15°), the
 * peak moment falls in nautical night and the forecast sky is clear
 * enough — the same tactical visibility gate the other Phase-2 events
 * pass through. TLE fetch failure degrades to no satellite events,
 * never a failed briefing; the ephemeris still runs.
 *
 * @file satellite-source.js
 */

const satellite = require("satellite.js");
const ephemeris = require("./celestial-ephemeris.js");

/**
 * CelesTrak GP query for the crewed-stations group in TLE format.
 */
const CELESTRAK_STATIONS_URL =
  "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle";

/**
 * TLE name prefixes the module tracks: ISS and the Chinese station
 * (CelesTrak lists the Tiangong core as "CSS (TIANHE)" and later
 * modules "CSS (WENTIAN)" etc. — the display name is Tiangong for
 * all of them).
 */
const TRACKED_PREFIXES = ["ISS", "CSS"];

/**
 * Display names per tracked prefix.
 */
const DISPLAY_NAMES = { ISS: "ISS", CSS: "Tiangong" };

/**
 * Preferred module per display name (work doc #3): the CelesTrak
 * stations group lists several catalog entries per station — ISS
 * (ZARYA) and ISS (NAUKA), CSS (TIANHE), CSS (WENTIAN), CSS
 * (MENGTIAN) — all docked to the same hull and sharing its orbit.
 * Propagating every entry would report each pass two or three times,
 * so one element set per station is kept: the core module's when
 * listed, the first entry otherwise.
 */
const PREFERRED_MODULE = { ISS: "ZARYA", CSS: "TIANHE" };

/**
 * Pass search step (ms). 30 s resolves a 15° gate against a pass
 * moving about 1°/s at zenith well enough for a briefing alert.
 */
const PASS_STEP_MS = 30000;

/**
 * Range (km) at which the visual-magnitude estimate reads −1.0: the
 * ISS overhead at its typical orbit height.
 */
const MAGNITUDE_REFERENCE_RANGE_KM = 420;

/**
 * Parses a CelesTrak TLE text response down to the tracked stations.
 *
 * @param {string} text - TLE text (name line + line 1 + line 2 triples)
 * @param {object} [options]
 * @param {string[]} [options.prefixes] - Name prefixes to keep
 * @returns {Array<{name: string, displayName: string, line1: string,
 *   line2: string}>}
 */
function parseTLEs(text, { prefixes = TRACKED_PREFIXES } = {}) {
  if (typeof text !== "string") {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const tles = [];
  for (let i = 0; i < lines.length - 2; i++) {
    const name = lines[i].trim();
    const line1 = lines[i + 1]?.trim() ?? "";
    const line2 = lines[i + 2]?.trim() ?? "";
    if (!name || !line1.startsWith("1 ") || !line2.startsWith("2 ")) {
      continue;
    }
    const prefix = prefixes.find((p) => name.startsWith(p));
    if (prefix) {
      tles.push({
        prefix,
        name,
        displayName: DISPLAY_NAMES[prefix] ?? name,
        line1,
        line2,
      });
    }
  }
  // One element set per station: the core module's when present,
  // the first entry otherwise
  const preferred = new Map();
  for (const tle of tles) {
    const core = PREFERRED_MODULE[tle.prefix];
    const existing = preferred.get(tle.displayName);
    if (!existing || (core && tle.name.includes(core))) {
      preferred.set(tle.displayName, tle);
    }
  }
  return [...preferred.values()].map(({ prefix: _prefix, ...tle }) => tle);
}

/**
 * Coarse visual magnitude of a crewed station at a slant range:
 * −1.0 at the reference range (overhead ISS), +5 magnitudes per
 * decade of distance. An estimate for the briefing line, not a
 * photometric model.
 *
 * @param {number} rangeKm - Slant range (km)
 * @returns {number} Estimated magnitude, clamped to [−1, 4]
 */
function magnitudeEstimate(rangeKm) {
  if (!(rangeKm > 0)) {
    return 4;
  }
  const magnitude =
    -1.0 + 5 * Math.log10(rangeKm / MAGNITUDE_REFERENCE_RANGE_KM);
  return Math.min(4, Math.max(-1, magnitude));
}

/**
 * Compass point for an azimuth in degrees (8-point rose).
 *
 * @param {number} azDeg - Azimuth in degrees
 * @returns {string} N, NE, E, SE, S, SW, W or NW
 */
function azimuthCompass(azDeg) {
  const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.floor(((((azDeg % 360) + 360) % 360) + 22.5) / 45) % 8;
  return points[index];
}

/**
 * Peak of every pass of the given elements over a position inside the
 * window, gated by peak elevation. Ungated by night, cloud or
 * moonlight — `computeSatelliteEvents` applies the visibility gate.
 *
 * @param {object} params
 * @param {Array<{name: string, displayName: string, line1: string,
 *   line2: string}>} params.tles
 * @param {number} params.lat - Degrees
 * @param {number} params.lon - Degrees east
 * @param {Date} params.from - Window start
 * @param {number} params.hours - Window length
 * @returns {Array<{satellite: string, rise: {timestamp: string,
 *   azimuthDeg: number}, peak: {timestamp: string, elevationDeg:
 *   number, rangeKm: number}}>}
 */
function computePasses({ tles, lat, lon, from, hours }) {
  const observer = {
    longitude: (lon * Math.PI) / 180,
    latitude: (lat * Math.PI) / 180,
    height: 0,
  };
  const passes = [];
  const end = from.getTime() + hours * 3600000;
  for (const tle of tles) {
    let satrec;
    try {
      satrec = satellite.twoline2satrec(tle.line1, tle.line2);
    } catch (_error) {
      continue;
    }
    const lookAngles = (date) => {
      const pv = satellite.propagate(satrec, date);
      if (!pv?.position) {
        return null; // Decayed or bad elements
      }
      const ecf = satellite.eciToEcf(pv.position, satellite.gstime(date));
      return satellite.ecfToLookAngles(observer, ecf);
    };
    let above = null;
    for (let t = from.getTime(); t < end; t += PASS_STEP_MS) {
      const date = new Date(t);
      const look = lookAngles(date);
      const elevationDeg = look ? (look.elevation * 180) / Math.PI : -90;
      if (elevationDeg > 0) {
        if (!above) {
          // Pass risen: remember where it came over the horizon
          above = {
            satellite: tle.displayName,
            line1: tle.line1,
            rise: {
              timestamp: date.toISOString(),
              azimuthDeg: look != null ? (look.azimuth * 180) / Math.PI : 0,
            },
            peak: {
              timestamp: date.toISOString(),
              elevationDeg,
              rangeKm: look != null ? look.rangeSat : Infinity,
            },
          };
        } else if (elevationDeg > above.peak.elevationDeg) {
          above.peak = {
            timestamp: date.toISOString(),
            elevationDeg,
            rangeKm: look != null ? look.rangeSat : Infinity,
          };
        }
      } else if (above) {
        // Pass ended below the horizon
        passes.push(above);
        above = null;
      }
    }
    // A pass still above the horizon when the window closes
    if (above) {
      passes.push(above);
    }
  }
  return passes;
}

/**
 * NORAD catalog number from a TLE line 1 (columns 3–7): the key
 * tracker pages key on (work doc #31 provenance).
 *
 * @param {string} line1 - TLE line 1
 * @returns {string|null} Catalog number, null when unparseable
 */
function catalogNumber(line1) {
  if (typeof line1 !== "string" || line1.length < 7) {
    return null;
  }
  const value = line1.slice(2, 7).trim();
  return /^[A-Z0-9]+$/.test(value) ? value : null;
}

/**
 * Builds the satellite-pass events for a position and window, with
 * the full tactical visibility gate: peak over 15° (the haze line),
 * nautical night at the peak, forecast sky clear enough. Each event
 * carries its provenance (work doc #31): the TLE data origin is the
 * CelesTrak stations file, the verification link a live tracker page
 * for the catalog number.
 *
 * @param {object} params
 * @param {Array<{name: string, displayName: string, line1: string,
 *   line2: string}>} params.tles
 * @param {number} params.lat - Degrees
 * @param {number} params.lon - Degrees east
 * @param {Date} params.from - Window start
 * @param {number} [params.hours=24] - Window length
 * @param {((timestamp: string) => number|null)|undefined} [params.cloudCoverAt]
 * @param {(date: Date, lat: number, lon: number) => boolean} [params.nightFn]
 *   Nautical-night test override (tests)
 * @returns {Array<{kind: string, timestamp: string, tactical: boolean,
 *   name: string, maxElevationDeg: number, magnitude: number,
 *   description: string}>}
 */
function computeSatelliteEvents({
  tles,
  lat,
  lon,
  from,
  hours = 24,
  cloudCoverAt,
  nightFn,
}) {
  const isNight =
    nightFn ??
    ((date, nlat, nlon) => ephemeris.isNauticalNight(date, nlat, nlon));
  const events = [];
  for (const pass of computePasses({ tles, lat, lon, from, hours })) {
    const peakDate = new Date(pass.peak.timestamp);
    if (pass.peak.elevationDeg < ephemeris.MIN_ALTITUDE_DEG) {
      continue;
    }
    if (!isNight(peakDate, lat, lon)) {
      continue;
    }
    if (!ephemeris.passesCloudGate(pass.peak.timestamp, cloudCoverAt)) {
      continue;
    }
    const magnitude = magnitudeEstimate(pass.peak.rangeKm);
    const catalog = catalogNumber(pass.line1);
    events.push({
      kind: "satellite",
      timestamp: pass.peak.timestamp,
      tactical: true,
      name: pass.satellite,
      catalogNumber: catalog,
      maxElevationDeg: Math.round(pass.peak.elevationDeg),
      magnitude: Math.round(magnitude * 10) / 10,
      description: `${pass.satellite} pass: approaching from ${azimuthCompass(pass.rise.azimuthDeg)}, peaks ${Math.round(pass.peak.elevationDeg)}° up (mag ${magnitude >= 0 ? "+" : "−"}${Math.abs(magnitude).toFixed(1)})`,
      provenance: catalog
        ? {
            kind: "feed",
            label: "CelesTrak TLE · live tracker",
            url: `https://www.n2yo.com/satellite/?s=${catalog}`,
            viewerUrl: null,
            at: null,
          }
        : undefined,
    });
  }
  return events;
}

/**
 * Fetches the tracked stations' TLEs from CelesTrak. Any failure —
 * network, HTTP, empty body — answers null so the caller degrades to
 * no satellite events.
 *
 * @param {object} [params]
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<Array<object>|null>}
 */
async function fetchTrackedTLEs({ fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(CELESTRAK_STATIONS_URL, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const text = await response.text();
    const tles = parseTLEs(text);
    return tles.length > 0 ? tles : null;
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  CELESTRAK_STATIONS_URL,
  TRACKED_PREFIXES,
  PASS_STEP_MS,
  parseTLEs,
  catalogNumber,
  magnitudeEstimate,
  azimuthCompass,
  computePasses,
  computeSatelliteEvents,
  fetchTrackedTLEs,
};
