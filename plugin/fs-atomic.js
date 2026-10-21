/**
 * Atomic file persistence: the payload lands in a uniquely named
 * temporary file first and is renamed over the target in one step. A
 * concurrent reader therefore sees either the previous content or the
 * complete new one — never a torn file.
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
const { rename, writeFile } = require("node:fs/promises");
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
 * Writes data to a temporary file beside the target, then renames it
 * over the target.
 *
 * @param {string} path - Final destination path
 * @param {string|Buffer} data - Content to persist
 * @returns {Promise<void>}
 */
async function writeFileAtomic(path, data) {
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmp, data);
  await renameOver(tmp, path);
}

module.exports = { writeFileAtomic };
