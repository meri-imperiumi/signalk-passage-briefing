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
 * Downwind sail families the proactive recommendations know (work doc
 * #41): the sails that hold pressure when the working canvas slats.
 * Matched case-insensitively against both the configured `type` and
 * the human `name`. The `type` field is the sailsconfiguration
 * plugin's fixed enum (staysail, headsail, jib, genoa, spinnaker,
 * gennaker, mainsail, lug, mizzen, steadying sail) — of which
 * spinnaker and gennaker are downwind; code zeros get typed
 * headsail/genoa and rely on their name, as do parasailors.
 */
const DOWNWIND_FAMILIES = [
  [/PARASAILOR/, "parasailor"],
  [/GENNAKER/, "gennaker"],
  [/CODE\s*Z(ERO)?/, "code zero"],
  [/(ASYM|SPINNAKER)/, "spinnaker"],
];

/**
 * Classifies one sail into a downwind family, from its configured
 * `type` and human `name`.
 *
 * @param {{type: ?string, name: string}} sail
 * @returns {{family: string}|null} Family label, null for working
 *   sails and unclassifiable entries
 */
function classifySail({ type, name }) {
  const hay = `${type ?? ""} ${name ?? ""}`.toUpperCase();
  for (const [pattern, family] of DOWNWIND_FAMILIES) {
    if (pattern.test(hay)) {
      return { family };
    }
  }
  return null;
}

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
    .map((sail) => {
      const family = classifySail(sail);
      return {
        id:
          typeof sail.id === "string" ? sail.id : normalizeSailName(sail.name),
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
        // Downwind classification (work doc #41): the proactive
        // recommendations deploy these when the working canvas would
        // slat
        sailFamily: family?.family ?? null,
        downwind: family != null,
      };
    });
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

/**
 * The downwind sail inventory shaped for the deployment advisor (work
 * doc #41): family, the measured-vs-drive claim, the configured wind
 * limits in knots, and the class's TWA floor. The Parasailor-class
 * carries the comfort claim — its stabilizing effect is the measured
 * 0.78 a_z ratio (work doc #38/#41 session) — the reaching families
 * claim drive. TWA floors: the Parasailor 130° (bergie, and the
 * logged deployments agree at p10 142°), gennaker/spinnaker 110°, the
 * code zero's reaching band from 60°.
 *
 * @param {Array} sails - From {@link readSailsConfiguration}
 * @returns {Array<{name: string, family: string, claim: string,
 *   minTwsKnots?: number, maxTwsKnots?: number, minTwaDeg: number}>}
 */
function downwindAdvisorSails(sails) {
  const TWA_FLOORS = {
    parasailor: 130,
    gennaker: 110,
    spinnaker: 110,
    "code zero": 60,
  };
  const CLAIMS = { parasailor: "comfort" };
  return (Array.isArray(sails) ? sails : [])
    .filter((sail) => sail.downwind)
    .map((sail) => {
      const advisor = {
        name: sail.name,
        family: sail.sailFamily,
        claim: CLAIMS[sail.sailFamily] ?? "drive",
        minTwaDeg: TWA_FLOORS[sail.sailFamily] ?? 110,
      };
      if (sail.minimumWindKnots != null) {
        advisor.minTwsKnots = sail.minimumWindKnots;
      }
      if (sail.maximumWindKnots != null) {
        advisor.maxTwsKnots = sail.maximumWindKnots;
      }
      return advisor;
    });
}

module.exports = {
  MS_TO_KNOTS,
  DOWNWIND_FAMILIES,
  normalizeSailName,
  readSailsConfiguration,
  sailsMatchingStateKey,
  classifySail,
  downwindAdvisorSails,
};
