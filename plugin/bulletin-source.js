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

const { mkdir, readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { writeFileAtomic } = require("./fs-atomic.js");
const { resolveBulletinSource } = require("./bulletin-engine.js");

/** Maximum cached bulletin entries across all URLs. */
const KEEP_BULLETINS = 20;

/**
 * Serialization for the cache's read-modify-write cycles (audit fix):
 * the fetch-window refresh and the ticker's spool ingest both run
 * load → merge → save on independent chains, and two interleaved
 * snapshots rename out of order, the stale one landing last — the
 * fetch's fresh entries lost for a day offshore. One writer at a
 * time, per module.
 *
 * @type {Promise<void>}
 */
let cacheWriteChain = Promise.resolve();

/**
 * Queues one cache read-modify-write cycle behind the previous one.
 *
 * @template T
 * @param {() => Promise<T>} run - The cycle to run
 * @returns {Promise<T>} The cycle's result
 */
function withCacheLock(run) {
  const next = cacheWriteChain.then(run, run);
  cacheWriteChain = next.catch(() => {});
  return next;
}

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
 * Persists the bulletin cache (newest first, pruned). Atomic: the
 * serve-time reads race the fetch-window writes on independent chains,
 * and a torn read once read as an empty cache — wiping every published
 * warning on the prune pass that followed.
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
  await writeFileAtomic(
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
 * @param {Function} [params.onFailure] - Called with `(url, error)`
 *   for every URL that failed this cycle (source status registry,
 *   work doc #23)
 * @returns {Promise<{fetched: string[], failed: string[], entries: BulletinEntry[]}>}
 *   Newly fetched URLs (failures listed separately) and the merged
 *   cache
 */
async function refreshBulletinsUnlocked({
  dataDir,
  urls,
  zoneBulletins = [],
  fetchImpl = fetch,
  timeoutMs,
  onFailure,
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
      ...(entry.format ? { format: entry.format } : {}),
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
    } catch (error) {
      onFailure?.(url, error);
      failed.push(url);
    }
  }
  await saveBulletinCache(dataDir, cached);
  return { fetched, failed, entries: cached };
}

/**
 * Merges spool-parsed bulletins into the cache: one entry per spool
 * file, keyed by its spool path (`spool:<file>`) so a re-dropped file
 * updates in place, the newer issue time winning. Lives beside the
 * fetched bulletins' entries and prunes through the same budget.
 *
 * @param {BulletinEntry[]} cached - Existing cache entries
 * @param {Array<{file: string, issuedAt: string, bulletinText: string}>}
 *   bulletins - Parsed spool files (newest first from the watcher)
 * @returns {BulletinEntry[]} Merged, newest first
 */
function mergeSpoolBulletins(cached, bulletins) {
  const byUrl = new Map();
  for (const entry of [...(cached ?? []), ...(bulletins ?? [])]) {
    const existing = byUrl.get(entry.url);
    if (
      !existing ||
      String(entry.fetchedAt ?? "").localeCompare(
        String(existing.fetchedAt ?? ""),
      ) > 0
    ) {
      byUrl.set(entry.url, entry);
    }
  }
  return [...byUrl.values()].sort((a, b) =>
    String(b.fetchedAt ?? "").localeCompare(String(a.fetchedAt ?? "")),
  );
}

/**
 * Ingests the spool watcher's parsed bulletins into the bulletin
 * cache (SPEC §2.2/§3.1). Each file becomes an entry keyed by its
 * spool path with the parsed issue time; the cache only rewrites when
 * the spool actually changed the picture, so the ticker can call this
 * every minute for free. The spool entries share the fetched
 * bulletins' pruning budget — the newest text wins, whatever path it
 * arrived by.
 *
 * @param {object} params
 * @param {string} params.dataDir - Plugin data directory
 * @param {Array<{file: string, issuedAt: string, bulletinText: string}>}
 *   [params.bulletins] - Parsed spool files
 * @returns {Promise<{changed: boolean, count: number}>} Whether the
 *   cache changed (the caller republishes the warnings when it did)
 *   and how many spool entries the cache now carries
 */
async function ingestSpoolBulletinsUnlocked({ dataDir, bulletins }) {
  const entries = (bulletins ?? []).map((bulletin) => ({
    url: `spool:${bulletin.file}`,
    fetchedAt: bulletin.issuedAt,
    text: bulletin.bulletinText,
    source: "spool",
  }));
  const cached = await loadBulletinCache(dataDir);
  const merged = mergeSpoolBulletins(cached, entries);
  // Identity of an entry for change detection: path, issue time and
  // the text's size — a same-length edit is the only blind spot, and
  // a re-dropped file usually moves the mtime fallback too
  const keyOf = (entry) =>
    `${entry.url}|${entry.fetchedAt}|${entry.text.length}`;
  const changed =
    merged.length !== cached.length ||
    merged.some((entry, index) => keyOf(entry) !== keyOf(cached[index]));
  if (changed) {
    await saveBulletinCache(dataDir, merged);
  }
  return {
    changed,
    count: merged.filter((entry) => entry.url.startsWith("spool:")).length,
  };
}

/**
 * Refreshes the configured feeds, serialized against the spool
 * ingest's cache cycles (see {@link withCacheLock}).
 *
 * @param {object} params - See {@link refreshBulletinsUnlocked}
 * @returns {Promise<{fetched: string[], failed: string[], entries: BulletinEntry[]}>}
 */
function refreshBulletins(params) {
  return withCacheLock(() => refreshBulletinsUnlocked(params));
}

/**
 * Ingests spool bulletins, serialized against the fetch window's
 * cache cycles (see {@link withCacheLock}).
 *
 * @param {object} params - See {@link ingestSpoolBulletinsUnlocked}
 * @returns {Promise<{changed: boolean, count: number}>}
 */
function ingestSpoolBulletins(params) {
  return withCacheLock(() => ingestSpoolBulletinsUnlocked(params));
}

module.exports = {
  KEEP_BULLETINS,
  cachePath,
  loadBulletinCache,
  saveBulletinCache,
  refreshBulletins,
  mergeSpoolBulletins,
  ingestSpoolBulletins,
};
