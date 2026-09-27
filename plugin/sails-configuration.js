/**
 * Sail inventory reader: the `@signalk/sailsconfiguration` plugin store.
 *
 * The configuration lives at
 * `<configPath>/plugin-config-data/sailsconfiguration.json` and holds
 * the vessel's sail inventory with Signal K internal units:
 *
 * - `minimumWind` / `maximumWind` — m/s, present only for some sails;
 * - `reefs` — remaining sail **areas in m²** for each reefed
 *   configuration (NOT wind triggers), e.g. Main 21 m² full with
 *   `[17, 10, 5]` for its three reefs;
 * - `continuousReefing` — furler sails reduce by `reducedState.furledRatio`
 *   instead of fixed reef points.
 *
 * Notably there are no wind limits *per reefed configuration* — the
 * learned sail preference matrix (SPEC §3.2) is what fills that gap.
 * Until the learned matrix has data, the configured whole-sail wind
 * limits are the only priors available.
 *
 * @file sails-configuration.js
 */

const { readFile } = require("node:fs/promises");

/**
 * Normalizes a sail name the same way the logbook sail-state keys do,
 * so logbook components (`MAIN`, `GENOA_1`) can be matched against
 * configured sail names (`Main`, `Genoa 1`).
 *
 * @param {string} name - Human sail name
 * @returns {string} Normalized key (uppercase, `_` separators)
 */
function normalizeSailName(name) {
  return String(name)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
}

/**
 * Meters per second per knot, for displaying configured wind limits in
 * the logbook's human-friendly knots.
 */
const MS_TO_KNOTS = 1.943844;

/**
 * Loads and normalizes the sail inventory.
 *
 * @param {string} filename - Path to `sailsconfiguration.json`
 * @returns {Promise<Array<{id: string, name: string, nameKey: string,
 *   type: ?string, areaM2: ?number, minimumWindKnots: ?number,
 *   maximumWindKnots: ?number, reefAreasM2: number[],
 *   continuousReefing: boolean, active: boolean}>>}
 *   Empty when the file is missing or malformed
 */
async function readSailsConfiguration(filename) {
  let raw;
  try {
    raw = JSON.parse(await readFile(filename, "utf8"));
  } catch (_error) {
    return [];
  }
  const sails = raw?.configuration?.sails;
  if (!Array.isArray(sails)) {
    return [];
  }
  return sails
    .filter((sail) => sail && typeof sail.name === "string")
    .map((sail) => ({
      id: typeof sail.id === "string" ? sail.id : normalizeSailName(sail.name),
      name: sail.name,
      nameKey: normalizeSailName(sail.name),
      type: typeof sail.type === "string" ? sail.type : null,
      areaM2: typeof sail.area === "number" ? sail.area : null,
      minimumWindKnots:
        typeof sail.minimumWind === "number"
          ? sail.minimumWind * MS_TO_KNOTS
          : null,
      maximumWindKnots:
        typeof sail.maximumWind === "number"
          ? sail.maximumWind * MS_TO_KNOTS
          : null,
      reefAreasM2: Array.isArray(sail.reefs)
        ? sail.reefs.filter((area) => typeof area === "number")
        : [],
      continuousReefing: sail.continuousReefing === true,
      active: sail.active !== false,
    }));
}

/**
 * Finds the configured sails referenced by a learned sail-state key
 * (e.g. `GENOA_1_MAIN_1_REEF` mentions both the `Genoa 1` and `Main`
 * inventories). A configured sail matches when its normalized name
 * appears as a whole component run in the key.
 *
 * @param {Array} sails - From {@link readSailsConfiguration}
 * @param {string} sailStateKey - e.g. `GENOA_1_MAIN_1_REEF`
 * @returns {Array} Matched sail entries, in configuration order
 */
function sailsMatchingStateKey(sails, sailStateKey) {
  const padded = `_${sailStateKey}_`;
  return sails.filter((sail) => padded.includes(`_${sail.nameKey}_`));
}

module.exports = {
  MS_TO_KNOTS,
  normalizeSailName,
  readSailsConfiguration,
  sailsMatchingStateKey,
};
