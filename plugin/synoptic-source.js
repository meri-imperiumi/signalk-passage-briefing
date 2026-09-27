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
 * @returns {{url: string, validHour: string}|null}
 */
function chartUrlForZone(map, zone, now = new Date()) {
  const entry = map[String(zone)];
  if (!entry) {
    return null;
  }
  if (entry.url) {
    return { url: entry.url, validHour: "static" };
  }
  const hours = entry.hours ?? {};
  const key = now.getUTCHours() < 12 ? "00" : "12";
  const chosen = hours[key] ?? hours["00"] ?? hours["12"];
  if (!chosen) {
    return null;
  }
  return {
    url: chosen,
    validHour: hours[key] ? key : hours["00"] ? "00" : "12",
  };
}

/**
 * Resolves the charts to fetch for a set of zones.
 *
 * @param {SynopticMap} map
 * @param {number[]} zones
 * @param {Date} [now]
 * @returns {Array<{zone: number, url: string, validHour: string}>}
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
 * @returns {Promise<{fetched: number[], skipped: number[], failed: number[]}>}
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
    if (
      cached &&
      cached.url === pick.url &&
      cached.validHour === pick.validHour
    ) {
      skipped.push(pick.zone);
      continue;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(pick.url, { signal: controller.signal });
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
        url: pick.url,
        validHour: pick.validHour,
        fetchedAt: new Date().toISOString(),
        file,
        width: converted.width,
        height: converted.height,
      };
      fetched.push(pick.zone);
    } catch {
      failed.push(pick.zone); // Chart unavailable this cycle: keep the cache
    }
  }
  await saveIndex(dataDir, index);
  return { fetched, skipped, failed };
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
};
