/**
 * Synoptic surface-analysis chart source (work doc #11), following
 * the #9 zone-source pattern: the bundled map picks the chart per
 * resolved GMDSS zone (time-aware for agencies publishing 00Z/12Z
 * variants), downloads ride the online-transition gate, and charts
 * are normalized to grayscale PNG in the plugin data dir for offline
 * reading. Zones absent from the map are a logged no-op, never a
 * failure.
 *
 * @file synoptic-source.js
 */

const { readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { convertToPng } = require("./raster-convert.js");

/** @typedef {Record<string, {name: string, source: string, url?: string, hours?: Record<string, string>}>} SynopticMap */

function loadSynopticMap() {
  // eslint-disable-next-line import/no-unresolved -- bundled asset
  return require("./synoptic-map.json");
}

/**
 * Picks the chart URL for a zone at a moment: agencies overwriting a
 * single static filename skip the hour logic; otherwise before 12Z
 * fetches the 00Z chart, from 12Z the 12Z chart, falling back to
 * whichever variant exists.
 *
 * @param {SynopticMap} map
 * @param {number} zone
 * @param {Date} [now]
 * @returns {{urls: string[], validHour: string}|null}
 */
function chartUrlForZone(map, zone, now = new Date()) {
  const entry = map[String(zone)];
  if (!entry) {
    return null;
  }
  if (entry.url) {
    return { urls: toCandidates(entry.url), validHour: "static" };
  }
  const hours = entry.hours ?? {};
  const key = now.getUTCHours() < 12 ? "00" : "12";
  const chosen = hours[key] ?? hours["00"] ?? hours["12"];
  if (!chosen) {
    return null;
  }
  return {
    urls: toCandidates(chosen),
    validHour: hours[key] ? key : hours["00"] ? "00" : "12",
  };
}

/** Map entries carry a URL string or a candidate list (mirrors of
 * the same chart, tried in order). */
function toCandidates(url) {
  return Array.isArray(url) ? url : [url];
}

/**
 * Resolves the charts to fetch for a set of zones.
 *
 * @param {SynopticMap} map
 * @param {number[]} zones
 * @param {Date} [now]
 * @returns {Array<{zone: number, urls: string[], validHour: string}>}
 */
function chartsForZones(map, zones, now = new Date()) {
  const out = [];
  for (const zone of zones ?? []) {
    const pick = chartUrlForZone(map, zone, now);
    if (pick) {
      out.push({ zone, ...pick });
    }
  }
  return out;
}

const INDEX_FILE = "synoptic-index.json";

async function loadIndex(dataDir) {
  try {
    return JSON.parse(await readFile(join(dataDir, INDEX_FILE), "utf8"));
  } catch {
    return {};
  }
}

async function saveIndex(dataDir, index) {
  await writeFile(join(dataDir, INDEX_FILE), JSON.stringify(index, null, 2));
}

/**
 * Fetches and caches the resolved zones' charts. A chart is skipped
 * when the same url + valid hour is already cached (agencies overwrite
 * at most twice a day, so this keeps the daily download budget).
 *
 * @param {object} params
 * @param {string} params.dataDir - Plugin data directory
 * @param {number[]} params.zones - Resolved GMDSS zone integers
 * @param {Date} [params.now]
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{fetched: number[], skipped: number[],
 *   failed: Array<{zone: number, url: string, error: string}>}>}
 */
async function refreshSynoptics({
  dataDir,
  zones,
  now = new Date(),
  fetchImpl = fetch,
  timeoutMs = 20000,
}) {
  const map = loadSynopticMap();
  const index = await loadIndex(dataDir);
  const picked = chartsForZones(map, zones, now);
  const fetched = [];
  const skipped = [];
  const failed = [];
  for (const pick of picked) {
    const cached = index[pick.zone];
    const sameChart =
      cached &&
      cached.url === pick.urls[0] &&
      cached.validHour === pick.validHour;
    if (sameChart) {
      skipped.push(pick.zone);
      continue;
    }
    // Candidate mirrors of the same chart, tried in order (e.g. the
    // documented BoM anon host plus the legacy alias)
    for (const url of pick.urls) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
          response = await fetchImpl(url, { signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        const converted = convertToPng(bytes);
        if (!converted) {
          throw new Error("unsupported chart format");
        }
        const file = `synoptic-${pick.zone}.png`;
        await writeFile(join(dataDir, file), converted.png);
        index[pick.zone] = {
          url: pick.urls[0],
          fetchedFrom: url,
          validHour: pick.validHour,
          fetchedAt: new Date().toISOString(),
          file,
          width: converted.width,
          height: converted.height,
        };
        fetched.push(pick.zone);
        break;
      } catch (error) {
        // Chart unavailable this cycle: keep the cache, record why
        failed.push({ zone: pick.zone, url, error: error.message });
      }
    }
  }
  if (failed.length > 0) {
    index._lastFailures = index._lastFailures ?? {};
    for (const entry of failed) {
      index._lastFailures[entry.zone] = {
        url: entry.url,
        error: entry.error,
        at: new Date().toISOString(),
      };
    }
  }
  await saveIndex(dataDir, index);
  return { fetched, skipped, failed };
}

/**
 * The last recorded fetch failure for a zone, if any.
 *
 * @param {string} dataDir
 * @param {number} zone
 * @returns {Promise<{url: string, error: string, at: string}|null>}
 */
async function loadSynopticFailure(dataDir, zone) {
  const index = await loadIndex(dataDir);
  return index._lastFailures?.[zone] ?? null;
}

/**
 * Reads the cached chart for one zone.
 *
 * @param {string} dataDir
 * @param {number} zone
 * @returns {Promise<{png: Buffer, fetchedAt: string}|null>}
 */
async function loadSynoptic(dataDir, zone) {
  const index = await loadIndex(dataDir);
  const entry = index[zone];
  if (!entry) {
    return null;
  }
  try {
    const png = await readFile(join(dataDir, entry.file));
    return { png, fetchedAt: entry.fetchedAt };
  } catch {
    return null;
  }
}

module.exports = {
  loadSynopticMap,
  chartUrlForZone,
  chartsForZones,
  refreshSynoptics,
  loadSynoptic,
  loadSynopticFailure,
};
