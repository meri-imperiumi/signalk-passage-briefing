/**
 * Bulletin source: internet ingestion of high-seas text bulletins
 * (work doc #4 §1) with the same offline constraints as the weather
 * fetches — internet only while the link is up, everything cached on
 * disk so the briefing survives the other 23 offline hours.
 *
 * The configured URLs are pulled verbatim (plain text or RSS/XML —
 * anything text-shaped runs through the same filtering pipeline).
 * Raw texts persist in `weather/bulletins.json` keyed by URL; the
 * newest entry per URL wins, and the cache keeps the freshest
 * `KEEP_BULLETINS` entries overall.
 *
 * The radio paths (VARA HF spool files, Winlink chunks) plug into
 * the same pipeline later via the spool watcher.
 *
 * @file bulletin-source.js
 */

const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { resolveBulletinSource } = require("./bulletin-engine.js");

/** Maximum cached bulletin entries across all URLs. */
const KEEP_BULLETINS = 20;

/**
 * @typedef {{url: string, fetchedAt: string, text: string, source?: "api"|"spool"}} BulletinEntry
 */

/**
 * The cache file path under the plugin data directory.
 *
 * @param {string} dataDir
 * @returns {string}
 */
function cachePath(dataDir) {
  return join(dataDir, "weather", "bulletins.json");
}

/**
 * Loads the bulletin cache. Missing or corrupt file → empty cache
 * (the next online refresh repopulates it).
 *
 * @param {string} dataDir
 * @returns {Promise<BulletinEntry[]>} Newest first
 */
async function loadBulletinCache(dataDir) {
  try {
    const raw = JSON.parse(await readFile(cachePath(dataDir), "utf8"));
    const entries = Array.isArray(raw.entries) ? raw.entries : [];
    return entries
      .filter(
        (e) =>
          e &&
          typeof e.url === "string" &&
          typeof e.fetchedAt === "string" &&
          typeof e.text === "string",
      )
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  } catch {
    return [];
  }
}

/**
 * Persists the bulletin cache (newest first, pruned).
 *
 * @param {string} dataDir
 * @param {BulletinEntry[]} entries
 * @returns {Promise<void>}
 */
async function saveBulletinCache(dataDir, entries) {
  const pruned = [...entries]
    .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))
    .slice(0, KEEP_BULLETINS);
  await mkdir(join(dataDir, "weather"), { recursive: true });
  await writeFile(
    cachePath(dataDir),
    `${JSON.stringify({ entries: pruned }, null, 2)}\n`,
  );
}

/**
 * Fetches every configured bulletin URL and merges the results into
 * the cache. Per-URL failures skip that URL without failing the
 * batch — a 404 on one source must not lose the others. Callers
 * gate on the online state (SPEC §2.2), exactly like the weather
 * fetches. Pre-fetched zone bulletins (from zone-source's ladder)
 * merge without a second fetch.
 *
 * @param {object} params
 * @param {string} params.dataDir - Plugin data directory
 * @param {string[]} params.urls - Bulletin source URLs
 * @param {Array<{url: string, text: string, source: string, zone: number}>}
 *   [params.zoneBulletins] - Already-fetched zone bulletins
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{fetched: string[], failed: string[], entries: BulletinEntry[]}>}
 *   Newly fetched URLs (failures listed separately) and the merged
 *   cache
 */
async function refreshBulletins({
  dataDir,
  urls,
  zoneBulletins = [],
  fetchImpl = fetch,
  timeoutMs,
}) {
  const cached = await loadBulletinCache(dataDir);
  const fetched = [];
  const failed = [];
  for (const entry of zoneBulletins) {
    cached.unshift({
      url: entry.url,
      fetchedAt: new Date().toISOString(),
      text: entry.text,
      source: entry.source,
      zone: entry.zone,
    });
    fetched.push(entry.url);
  }
  for (const url of urls) {
    try {
      const { text, source } = await resolveBulletinSource(url, {
        fetchImpl,
        ...(timeoutMs != null ? { timeoutMs } : {}),
      });
      cached.unshift({
        url,
        fetchedAt: new Date().toISOString(),
        text,
        source,
      });
      fetched.push(url);
    } catch {
      failed.push(url);
    }
  }
  await saveBulletinCache(dataDir, cached);
  return { fetched, failed, entries: cached };
}

module.exports = {
  KEEP_BULLETINS,
  cachePath,
  loadBulletinCache,
  saveBulletinCache,
  refreshBulletins,
};
