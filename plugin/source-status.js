/**
 * Per-source status registry (work doc #23): every ingest path —
 * the weather fetch engine, the bulletin and synoptic pulls, the
 * GDACS hazard feed, the local ephemeris and the Signal K sources
 * the plugin depends on — records the outcome of its latest cycle
 * here, and the webapp renders the registry as a checklist.
 *
 * The point is diagnosability mid-passage: a moved URL shows up as
 * `http-404` on a source that used to work, a dead host as
 * `network`, and a skipped cycle while the boat is offline as
 * `offline-skipped` — instead of the crew only seeing *absence of
 * data* with no way to tell plugin breakage from source breakage.
 *
 * Error classification is coarse and stable on purpose: the class is
 * what the checklist brackets on, the message is detail for the
 * expandable row. `offline-skipped` is recorded, never counted as a
 * failure — an offline boat shows a wall of [ SKIP ], which is
 * correct information, not an error state.
 *
 * The registry persists in the plugin data directory so a restart
 * does not erase the "this URL broke yesterday" evidence.
 *
 * @file source-status.js
 */

const { readFile, writeFile, mkdir } = require("node:fs/promises");
const { join } = require("node:path");

/**
 * Stable error classes (work doc #23). The first six bucket HTTP and
 * transport failures; `parse` covers malformed payloads; the SK
 * sources record `unavailable` when a subscribed path or resource
 * never shows up.
 */
const ERROR_CLASSES = [
  "http-404",
  "http-429",
  "http-5xx",
  "http-4xx",
  "timeout",
  "network",
  "parse",
  "unavailable",
];

/**
 * Last-cycle outcomes. `skip` marks a cycle the online gate skipped
 * (boat offline); `absent` marks an optional Signal K source that is
 * simply not there (plugin not installed) — information, not failure.
 */
const STATUSES = ["ok", "fail", "skip", "absent"];

/**
 * Buckets an error into one of the stable classes from its message
 * shape. Built against the error strings this plugin's sources
 * actually produce ("… returned 404: not found" from the fetch
 * engine's describe(), "503 Service Unavailable" from the plain
 * fetchers, AbortError from the timeout controllers, "fetch failed"
 * from undici, "unsupported chart format" from the raster converter).
 *
 * @param {Error|string|null} error
 * @returns {string} One of {@link ERROR_CLASSES}
 */
function classifyError(error) {
  if (error == null) {
    return "network";
  }
  const message = `${error?.name ?? ""} ${error?.message ?? error}`;
  const bucketCode = (code) =>
    code === "404"
      ? "http-404"
      : code === "429"
        ? "http-429"
        : code[0] === "5"
          ? "http-5xx"
          : code[0] === "4"
            ? "http-4xx"
            : null;
  // The fetch engine's describe() shape: "<url> returned <status>: …"
  const returned = message.match(/returned\s+(\d{3})/);
  if (returned) {
    const bucket = bucketCode(returned[1]);
    if (bucket) {
      return bucket;
    }
  }
  // Bare status lines ("404 Not Found") — but not IP addresses,
  // ports or other numbers that merely look like a status code
  const bare = message.match(/(?<![\d.])(\d{3})(?=:\s|\s+[A-Za-z])/);
  if (bare) {
    const bucket = bucketCode(bare[1]);
    if (bucket) {
      return bucket;
    }
  }
  if (/abort|timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(message)) {
    return "timeout";
  }
  if (
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPROTO|certificate|SSL|TLS|getaddrinfo|fetch failed/i.test(
      message,
    )
  ) {
    return "network";
  }
  if (/parse|unsupported|invalid|unexpected|malformed/i.test(message)) {
    return "parse";
  }
  return "network";
}

/**
 * Registry file path under the plugin data directory (alongside the
 * other caches).
 *
 * @param {string} dataDir
 * @returns {string}
 */
function statusPath(dataDir) {
  return join(dataDir, "source-status.json");
}

/**
 * Creates the source status registry. Entries live in memory and
 * persist through a write-after-every-record chain; a fresh registry
 * in the same data directory picks the file back up (restart-safe).
 *
 * record() fields:
 * - `id` (required): stable source id
 * - `label`, `kind`, `url`, `expectedRefreshMs`: metadata, recorded
 *   on first sight and refreshed whenever passed
 * - `error`: Error or string — the cycle failed
 * - `errorClass`: override for the classified error class (the SK
 *   sources record `unavailable` for paths with no value)
 * - `skip`: true — the cycle was skipped by the online gate
 * - `absent`: true — optional source not present at all
 * - `now`: Date override (tests)
 *
 * @param {object} [params]
 * @param {string} [params.dataDir] - Plugin data directory; omit for
 *   a memory-only registry (tests)
 * @returns {{record: Function, define: Function, list: Function,
 *   flush: Function}}
 */
function createSourceStatus({ dataDir } = {}) {
  /** @type {Map<string, object>} */
  const entries = new Map();
  let saveChain = Promise.resolve();

  if (dataDir) {
    saveChain = readFile(statusPath(dataDir), "utf8")
      .then((raw) => {
        const parsed = JSON.parse(raw);
        for (const entry of Array.isArray(parsed) ? parsed : []) {
          // In-memory records made while the read was in flight win:
          // a cycle that ran during startup must not be lost
          if (entry && typeof entry.id === "string" && !entries.has(entry.id)) {
            entries.set(entry.id, entry);
          }
        }
      })
      .catch(() => {}); // First run or corrupt file: start clean
  }

  const scheduleSave = () => {
    if (!dataDir) {
      return;
    }
    // A failed save must not break the chain for the next record,
    // so the catch keeps the chain itself resolved
    saveChain = saveChain
      .then(async () => {
        await mkdir(dataDir, { recursive: true });
        await writeFile(
          statusPath(dataDir),
          `${JSON.stringify([...entries.values()], null, 2)}\n`,
        );
      })
      .catch(() => {});
  };

  /**
   * Ensures an entry exists without touching its recorded state —
   * the checklist shows configured sources even before the first
   * cycle runs.
   *
   * @param {object} meta - id plus label/kind/url/expectedRefreshMs
   * @returns {object} The entry
   */
  const define = (meta) => {
    let entry = entries.get(meta.id);
    if (!entry) {
      entry = {
        id: meta.id,
        label: meta.label ?? meta.id,
        kind: meta.kind ?? null,
        url: meta.url ?? null,
        expectedRefreshMs: meta.expectedRefreshMs ?? null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastError: null,
        consecutiveFailures: 0,
        lastStatus: null,
      };
      entries.set(meta.id, entry);
      scheduleSave();
    }
    // Metadata may drift with configuration (label, url); state never
    // gets clobbered by define()
    for (const key of ["label", "kind", "url", "expectedRefreshMs"]) {
      if (meta[key] != null) {
        entry[key] = meta[key];
      }
    }
    return entry;
  };

  /**
   * Records one cycle's outcome for a source.
   *
   * @param {object} params - See {@link createSourceStatus}
   * @returns {object} The updated entry
   */
  const record = ({
    id,
    label,
    kind,
    url,
    expectedRefreshMs,
    error,
    errorClass,
    skip,
    absent,
    now = new Date(),
  }) => {
    const entry = define({ id, label, kind, url, expectedRefreshMs });
    const stamp = (now instanceof Date ? now : new Date(now)).toISOString();
    if (absent) {
      // Optional source not installed: information, not a failure —
      // lastSuccessAt is kept so a later return reads as a recovery
      entry.lastStatus = "absent";
      entry.lastError = null;
      entry.consecutiveFailures = 0;
      scheduleSave();
      return entry;
    }
    entry.lastAttemptAt = stamp;
    if (skip) {
      // Not attempted (boat offline): neither success nor failure —
      // the failure count and last success stay frozen
      entry.lastStatus = "skip";
      scheduleSave();
      return entry;
    }
    if (error == null) {
      entry.lastSuccessAt = stamp;
      entry.lastError = null;
      entry.consecutiveFailures = 0;
      entry.lastStatus = "ok";
    } else {
      entry.lastError = {
        class: errorClass ?? classifyError(error),
        message: String(error?.message ?? error).slice(0, 300),
      };
      entry.consecutiveFailures += 1;
      entry.lastStatus = "fail";
    }
    scheduleSave();
    return entry;
  };

  return {
    record,
    define,
    /** All entries, stable order (by id) for the checklist. */
    list: () => [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)),
    /** Resolves once the pending persistence write completes. */
    flush: () => saveChain,
  };
}

module.exports = {
  ERROR_CLASSES,
  STATUSES,
  classifyError,
  statusPath,
  createSourceStatus,
};
