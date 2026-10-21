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
  await rename(tmp, path);
}

module.exports = { writeFileAtomic };
