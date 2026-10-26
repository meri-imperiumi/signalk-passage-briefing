/**
 * Atomic, ordered file persistence: the payload lands in a uniquely
 * named temporary file first and is renamed over the target in one
 * step. A concurrent reader therefore sees either the previous
 * content or the complete new one — never a torn file.
 *
 * Writes to one path are also serialized: each rewrite carries a
 * whole-file snapshot, and two writes renaming out of order would let
 * the stale snapshot win — resurrecting ids another writer just
 * pruned (CI flake, publication track test, October 2026). Readers
 * that must observe their own process's latest mutation ride the same
 * chain via readFileAtomic, so a store load never races an in-flight
 * rename of the state it just mutated.
 *
 * The reason this exists is a race the stores cannot otherwise avoid:
 * the fetch-window writes and the serve-time publishes run on
 * independent chains, so a `bulletins.json` rewrite once landed under
 * a `bulletinForTrack` read — the read saw the truncated file, took
 * it for "no bulletins cached", and the pass that followed pruned
 * every published warning off the plotter (CI flake, publication
 * track test, October 2026). Plain `writeFile` truncates before it
 * writes; `rename` replaces atomically.
 *
 * @file fs-atomic.js
 */

const { randomBytes } = require("node:crypto");
const { rename, readFile, writeFile } = require("node:fs/promises");
const { dirname, join } = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");

// POSIX renames over a file that another handle holds open; Windows
// refuses and fails with EPERM or EACCES until every handle is
// closed. A reader that catches the target mid-swap (or an antivirus
// scan, or the search indexer) therefore makes a perfectly valid
// rename fail transiently. Retrying does not weaken the atomicity —
// the rename either replaces the target in one step or has not
// happened at all — so ride the contention out with backoff.
const RENAME_ATTEMPTS = 10;

/**
 * The settled tail of the write/read chain per target path. The
 * stored promise never rejects, so later operations chain onto a
 * settled state regardless of earlier failures.
 */
const chains = new Map();

/**
 * Renames the temporary file over the target, tolerating the
 * transient Windows refusals described above.
 *
 * @param {string} tmp - Temporary file holding the new payload
 * @param {string} path - Final destination path
 * @returns {Promise<void>}
 */
async function renameOver(tmp, path) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      if (
        attempt >= RENAME_ATTEMPTS ||
        (err.code !== "EPERM" && err.code !== "EACCES")
      ) {
        throw err;
      }
      await sleep(10 * 2 ** attempt);
    }
  }
}

/**
 * The path's chain tail: resolves once every earlier write and read
 * on the path settled. Never rejects.
 *
 * @param {string} path - Target path key
 * @returns {Promise<void>}
 */
function chainTail(path) {
  return chains.get(path) ?? Promise.resolve();
}

/**
 * Installs the path's new chain tail. Failure-swallowing, so one
 * failed operation never poisons the chain for later ones.
 *
 * @param {string} path - Target path key
 * @param {Promise<unknown>} run - The operation's promise
 * @returns {void}
 */
function followChain(path, run) {
  chains.set(
    path,
    run.catch(() => {}),
  );
}

/**
 * Writes data to a temporary file beside the target, then renames it
 * over the target. Serialized per path against other writes and
 * readFileAtomic reads, so whole-file snapshots reach the disk in the
 * order their mutations were made.
 *
 * @param {string} path - Final destination path
 * @param {string|Buffer} data - Content to persist
 * @returns {Promise<void>}
 */
async function writeFileAtomic(path, data) {
  const run = chainTail(path).then(async () => {
    const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(tmp, data);
    await renameOver(tmp, path);
  });
  followChain(path, run);
  await run;
}

/**
 * Reads the target after every write queued before this call reached
 * the disk, riding the same per-path chain as writeFileAtomic. A
 * store whose whole-file snapshots must not be observed mid-swap
 * loads through this instead of a bare readFile.
 *
 * @param {string} path - File to read
 * @returns {Promise<string>} File content
 */
async function readFileAtomic(path) {
  const run = chainTail(path).then(() => readFile(path, "utf8"));
  followChain(path, run);
  return run;
}

module.exports = { writeFileAtomic, readFileAtomic };
