/**
 * Territorial waters transitions along the route (work doc #17):
 * where the planned track crosses the boundaries that change the
 * practical picture on board — entering or leaving a country's
 * internal, archipelagic or 12 NM waters is where metered satellite
 * data rules begin, customs and discharge rules change, and the
 * marine-zones answers start to apply.
 *
 * Data: `@openwaters/maritime-zones` (MIT) over the Marine Regions
 * Maritime Boundaries Geodatabase (VLIZ, CC-BY 4.0). The data is
 * "not for navigation" and "has no legal value whatsoever" — the
 * disclaimer is a display requirement and rides the payload
 * (`zoneDisclaimer`) wherever zones do.
 *
 * Tiles (10° FlatGeobuf, seekable zstd) download from the package's
 * release during the online window into the plugin data directory and
 * answer offline afterwards. The package needs Node >= 24 while this
 * plugin allows 22.5, so the import is dynamic and guarded: without
 * it, on older Node, or without tiles, the briefing renders without
 * zone events — never fails.
 *
 * @file maritime-zones-source.js
 */

const { join } = require("node:path");

/**
 * The sovereign waters the transitions watch: internal, archipelagic
 * and 12 NM layers (the package's "sovereign waters" default). EEZ
 * and beyond are deliberately not events — the boundary that matters
 * on board is the 12 NM line.
 */
const SOVEREIGN_LAYERS = ["internal", "archipelagic", "12nm"];

/**
 * The attribution and no-navigation disclaimer that must render
 * wherever Marine Regions-derived zones do (CC-BY 4.0 requirement).
 */
const ZONE_DISCLAIMER =
  "Maritime boundaries from the Marine Regions Maritime Boundaries " +
  "Geodatabase (VLIZ), CC-BY 4.0 — not for navigation, no legal value.";

/** Distance between consecutive samples of the route resample (nm). */
const SAMPLE_INTERVAL_NM = 1;

/**
 * Minimum stint (nm) a territory must be continuously present for the
 * boundary crossing to count (work doc #17, bergie session feedback):
 * a route grazing the 12 NM line around islands and reefs otherwise
 * reads as a ping-pong of enter/leave events. Presence stints shorter
 * than this — about an hour of passage sailing, and not actionable
 * anyway — merge into the surrounding state, the same "must hold"
 * guard the sail-work queue uses.
 */
const MIN_STINT_NM = 10;

/**
 * Maximum absence gap (nm) that reads as boundary wobble rather than
 * a genuine exit: a route ducking out of territorial waters for a
 * couple of miles around a reef is still "in territorial waters" for
 * every practical purpose on board. Gaps shorter than this fill back
 * in; longer absences are real departures.
 */
const MIN_ABSENCE_NM = 5;

/**
 * Loads the zones reader, pointed at the plugin's own tile cache. The
 * dynamic import keeps Node < 24 installations alive (the package
 * requires >= 24); failure answers null and the callers degrade.
 *
 * @param {string} dataDir - Plugin data directory (tile cache root)
 * @returns {Promise<object|null>} The package module, null when
 *   unavailable
 */
async function loadMaritimeZones({ dataDir }) {
  try {
    const mz = await import("@openwaters/maritime-zones");
    mz.configure({ cacheDir: join(dataDir, "maritime-zones-tiles") });
    return mz;
  } catch {
    return null;
  }
}

/**
 * Downloads the tiles the route corridor needs into the cache, so the
 * queries answer offline afterwards. A failure (offline, GitHub
 * unreachable, older Node) degrades to nothing — detection without
 * tiles returns no transitions by itself.
 *
 * @param {object} params
 * @param {string} params.dataDir
 * @param {Array<{lat: number, lon: number}>} params.waypoints
 * @param {number} [params.marginDeg=1] - Box margin around the route
 *   (a point query near a tile edge can need the neighbouring tile)
 * @param {object} [params.zonesApi] - Injected reader (tests)
 * @returns {Promise<{tiles: number, bytes: number}|null>} Download
 *   report, null when unavailable
 */
async function prefetchCorridor({
  dataDir,
  waypoints,
  marginDeg = 1,
  zonesApi,
}) {
  const lats = waypoints.map((w) => w.lat).filter(Number.isFinite);
  const lons = waypoints.map((w) => w.lon).filter(Number.isFinite);
  if (lats.length === 0 || lons.length === 0) {
    return null;
  }
  const mz = zonesApi ?? (await loadMaritimeZones({ dataDir }));
  if (!mz) {
    return null;
  }
  try {
    return await mz.download({
      minLat: Math.min(...lats) - marginDeg,
      maxLat: Math.max(...lats) + marginDeg,
      minLon: Math.min(...lons) - marginDeg,
      maxLon: Math.max(...lons) + marginDeg,
    });
  } catch {
    return null;
  }
}

/**
 * The sovereign territories a position sits in (work doc #17's
 * internal / archipelagic / 12 NM layers only), keyed by ISO code with
 * the display name as value.
 *
 * @param {Array<{layer: string, iso_ter: string|null, territory:
 *   string|null}>} zones - `whereAmI` output, innermost first
 * @returns {Map<string, string>} ISO 3166-1 alpha-3 code → territory
 *   name, possibly empty (high seas, or land — a point on land is in
 *   no zone)
 */
function sovereignTerritories(zones) {
  const map = new Map();
  for (const zone of zones ?? []) {
    if (SOVEREIGN_LAYERS.includes(zone?.layer) && zone?.iso_ter) {
      map.set(zone.iso_ter, zone.territory ?? zone.iso_ter);
    }
  }
  return map;
}

/**
 * Detects where the route crosses territorial-waters boundaries.
 *
 * The route is resampled at about 1 nm (not the 30 nm weather
 * sampling) so a short territorial hop is not missed; each sample's
 * sovereign territories are queried and diffed against the previous
 * sample's. Enter and leave events carry the crossing position, the
 * distance from start, and the territory (`name`, `iso_ter`). The
 * initial state comes from the first sample — a route that starts
 * inside Tongan waters announces no "entering".
 *
 * A query failure mid-route (tile missing, Node too old) stops the
 * walk and keeps the transitions found so far; a failure at the very
 * first sample answers null, meaning no data rather than "all high
 * seas" — the caller omits the payload field either way.
 *
 * @param {object} params
 * @param {string} params.dataDir
 * @param {Array<{lat: number, lon: number, distanceFromStartNm:
 *   number}>} params.waypoints - 1 nm-resampled route
 * @param {object} [params.zonesApi] - Injected reader (tests)
 * @returns {Promise<Array<{kind: "enter"|"leave", territory: {name:
 *   string, iso_ter: string}, lat: number, lon: number,
 *   distanceFromStartNm: number, connectivity?: "ocean"}>|null>}
 */
async function detectTransitions({ dataDir, waypoints, zonesApi }) {
  const samples = (waypoints ?? []).filter(
    (w) =>
      Number.isFinite(w?.lat) &&
      Number.isFinite(w?.lon) &&
      Number.isFinite(w?.distanceFromStartNm),
  );
  if (samples.length < 2) {
    return null;
  }
  const mz = zonesApi ?? (await loadMaritimeZones({ dataDir }));
  if (!mz) {
    return null;
  }
  // Per-sample territory state (ISO → display name)
  const perSample = [];
  for (const sample of samples) {
    let territories;
    try {
      territories = sovereignTerritories(
        await mz.whereAmI(sample.lat, sample.lon),
      );
    } catch {
      if (perSample.length === 0) {
        return null; // No data at all, not "all high seas"
      }
      break; // Keep what the walk found before it lost the tiles
    }
    perSample.push(territories);
  }
  if (perSample.length < 2) {
    return null;
  }
  const smoothed = smoothStints(perSample, samples);
  const transitions = [];
  for (let i = 1; i < smoothed.length; i++) {
    for (const [iso, name] of smoothed[i]) {
      if (!smoothed[i - 1].has(iso)) {
        transitions.push(build("enter", iso, samples[i], name));
      }
    }
    for (const [iso, name] of smoothed[i - 1]) {
      if (!smoothed[i].has(iso)) {
        transitions.push(build("leave", iso, samples[i], name));
      }
    }
  }
  return transitions;
}

/**
 * Removes grazing stints from per-sample territory state: any run of
 * samples where a territory is continuously present (or continuously
 * absent) that spans less than {@link MIN_STINT_NM} of route distance
 * flips to the surrounding state, iterated to a fixed point.
 *
 * @param {Map<string, string>[]} perSample - Territory state per sample
 * @param {Array<{distanceFromStartNm: number}>} samples - For spans
 * @returns {Map<string, string>[]} Smoothed copies
 */
function smoothStints(perSample, samples) {
  const smoothed = perSample.map((m) => new Map(m));
  const isos = new Set();
  for (const map of smoothed) {
    for (const iso of map.keys()) {
      isos.add(iso);
    }
  }
  const spanNm = (from, to) =>
    Math.abs(
      samples[Math.min(to, samples.length - 1)].distanceFromStartNm -
        samples[Math.min(from, samples.length - 1)].distanceFromStartNm,
    );
  let changed = true;
  for (let guard = 0; changed && guard < 10; guard++) {
    changed = false;
    for (const iso of isos) {
      // Fill short absence gaps between two present runs
      let presentStart = null;
      for (let i = 0; i <= smoothed.length; i++) {
        const present = i < smoothed.length && smoothed[i].has(iso);
        if (present && presentStart === null) {
          presentStart = i;
        } else if (!present && presentStart !== null) {
          const gapStart = i;
          let gapEnd = gapStart;
          while (gapEnd < smoothed.length && !smoothed[gapEnd].has(iso)) {
            gapEnd++;
          }
          if (
            gapEnd < smoothed.length &&
            spanNm(gapStart, gapEnd) < MIN_ABSENCE_NM
          ) {
            for (let j = gapStart; j < gapEnd; j++) {
              smoothed[j].set(iso, smoothed[presentStart].get(iso) ?? iso);
            }
            changed = true;
          }
          presentStart = null;
        }
      }
      // Remove short presence stints
      let runStart = null;
      for (let i = 0; i <= smoothed.length; i++) {
        const present = i < smoothed.length && smoothed[i].has(iso);
        if (present && runStart === null) {
          runStart = i;
        } else if (!present && runStart !== null) {
          if (spanNm(runStart, i) < MIN_STINT_NM) {
            for (let j = runStart; j < i; j++) {
              smoothed[j].delete(iso);
            }
            changed = true;
          }
          runStart = null;
        }
      }
    }
  }
  return smoothed;
}

/**
 * Builds one transition event. Leaving territorial waters carries the
 * connectivity note: beyond the 12 NM line the metered-ocean data
 * rules apply — the boundary the package's own `metered` internet
 * state usually reflects.
 *
 * @param {"enter"|"leave"} kind
 * @param {string} iso - Territory ISO code
 * @param {{lat: number, lon: number, distanceFromStartNm: number}}
 *   sample - Crossing sample
 * @param {string} [name] - Territory display name
 * @returns {object}
 */
function build(kind, iso, sample, name) {
  const event = {
    kind,
    territory: { name: name ?? iso, iso_ter: iso },
    lat: Math.round(sample.lat * 1e4) / 1e4,
    lon: Math.round(sample.lon * 1e4) / 1e4,
    distanceFromStartNm: Math.round(sample.distanceFromStartNm * 10) / 10,
  };
  if (kind === "leave") {
    event.connectivity = "ocean";
  }
  return event;
}

/**
 * The sovereign zones at one position (here mode, work doc #17):
 * what waters the vessel is in right now, innermost first.
 *
 * @param {object} params
 * @param {string} params.dataDir
 * @param {number} params.lat
 * @param {number} params.lon
 * @param {object} [params.zonesApi] - Injected reader (tests)
 * @returns {Promise<Array<{layer: string, name: string, iso_ter:
 *   string, territory: string}>|null>} Sovereign zones, null when
 *   unavailable (no tiles, older Node)
 */
async function positionZones({ dataDir, lat, lon, zonesApi }) {
  const mz = zonesApi ?? (await loadMaritimeZones({ dataDir }));
  if (!mz) {
    return null;
  }
  try {
    const zones = await mz.whereAmI(lat, lon);
    return (zones ?? [])
      .filter((z) => SOVEREIGN_LAYERS.includes(z?.layer) && z?.iso_ter)
      .map((z) => ({
        layer: z.layer,
        name: z.name ?? z.territory ?? z.iso_ter,
        iso_ter: z.iso_ter,
        territory: z.territory ?? z.iso_ter,
      }));
  } catch {
    return null;
  }
}

module.exports = {
  SOVEREIGN_LAYERS,
  ZONE_DISCLAIMER,
  SAMPLE_INTERVAL_NM,
  MIN_STINT_NM,
  MIN_ABSENCE_NM,
  loadMaritimeZones,
  prefetchCorridor,
  sovereignTerritories,
  detectTransitions,
  positionZones,
};
