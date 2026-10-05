#!/usr/bin/env node
/**
 * Logbook backfill & sail usage report.
 *
 * Runs the SPEC §4.2 sail preference backfill over the logbook
 * entries served by a Signal K server's `logentries` resource (the
 * signalk-logbook contract), using the wind snapshots written in the
 * log entries (no History API needed), then reports:
 *
 * 1. the learned sail preference matrix (SPEC §3.2);
 * 2. the conditions actually experienced per sail combination, next
 *    to the whole-sail wind limits configured in
 *    `@signalk/sailsconfiguration` (m/s converted to knots; the
 *    configuration has no limits per reefed configuration).
 *
 * Usage:
 *
 *   node bin/backfill-report.js [--url <server>] [--token <jwt>]
 *        [--sails <json>] [--from <iso>] [--to <iso>] [--db <sqlite-file>]
 *        [--json]
 *
 * Defaults: `--url http://localhost:3000` (a `readonly` token is
 * enough for reads), `--sails
 * ~/.signalk/plugin-config-data/sailsconfiguration.json`.
 *
 * Once on board, re-run the backfill through the plugin's
 * `POST /api/backfill?source=history&baseUrl=<server>` route to learn
 * from full-resolution History API wind instead of log snapshots.
 *
 * @file backfill-report.js
 */

const { mkdtempSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const { PassageDatabase } = require("../plugin/sqlite-db.js");
const {
  readLogbookEntriesRest,
  readLogbookSailEvents,
} = require("../plugin/logbook-source.js");
const {
  backfillSailEvents,
  createLogbookWindStats,
  summarizeSailUsage,
} = require("../plugin/history-backfill.js");
const {
  readSailsConfiguration,
  sailsMatchingStateKey,
} = require("../plugin/sails-configuration.js");

const SIGNALK_DIR = join(homedir(), ".signalk", "plugin-config-data");

/**
 * Server to read the logbook from when `--url` is not given.
 */
const DEFAULT_SERVER_URL = "http://localhost:3000";

/**
 * Parses argv into a `{flag: value}` map (`--flag value`, boolean
 * flags without value become true).
 *
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) {
      continue;
    }
    const key = flag.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const serverUrl =
    typeof args.url === "string" ? args.url : DEFAULT_SERVER_URL;
  const token = typeof args.token === "string" ? args.token : undefined;
  const sailsFile =
    typeof args.sails === "string"
      ? args.sails
      : join(SIGNALK_DIR, "sailsconfiguration.json");
  const from = typeof args.from === "string" ? args.from : undefined;
  const to = typeof args.to === "string" ? args.to : undefined;
  const asJson = args.json === true;

  const dataDir = mkdtempSync(
    join(process.env.TMPDIR || "/tmp", "passage-backfill-"),
  );
  const db = new PassageDatabase(dataDir);

  (async () => {
    try {
      const report = await collectReport({
        serverUrl,
        token,
        sailsFile,
        from,
        to,
        db,
      });
      if (asJson) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      printReport(report);
    } catch (error) {
      console.error(`backfill-report: ${error.message}`);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  })();
}

/**
 * Reads the logbook over the resources API and runs the backfill.
 *
 * @param {object} options
 * @param {string} options.serverUrl - Signal K server base URL
 * @param {string|undefined} options.token - Bearer token for reads
 * @param {string} options.sailsFile - Sails configuration JSON path
 * @param {string|undefined} options.from - Event window start
 * @param {string|undefined} options.to - Event window end
 * @param {object} options.db - Passage database
 * @returns {Promise<object>} Report for printReport/JSON output
 */
async function collectReport({ serverUrl, token, sailsFile, from, to, db }) {
  const entries = await readLogbookEntriesRest({
    baseUrl: serverUrl,
    token,
  });
  const sails = await readSailsConfiguration(sailsFile);
  const knownSailKeys =
    sails.length > 0 ? new Set(sails.map((sail) => sail.nameKey)) : undefined;
  const events = await readLogbookSailEvents({
    entries,
    from,
    to,
    knownSailKeys,
  });
  const summary = await backfillSailEvents({
    db,
    events,
    getWindStats: createLogbookWindStats(entries),
  });
  const matrix = db.getSailPreferenceMatrix();
  const usage = summarizeSailUsage(
    db.getSailEvents({ limit: 10000 }),
    db.getWindHistory("0000-01-01T00:00:00Z", "9999-12-31T23:59:59Z"),
  );
  return {
    logbook: serverUrl,
    entries: entries.length,
    events: events.length,
    summary,
    matrix,
    usage,
    sails,
  };
}

/**
 * Annotates a sail state with the configured wind limits of the sails
 * it mentions, in knots.
 *
 * @param {Array} sails - From readSailsConfiguration
 * @param {string} sailState
 * @returns {string} e.g. `Main 2..? kn, Genoa 1 ?..? kn`
 */
function configuredLimits(sails, sailState) {
  const matched = sailsMatchingStateKey(sails, sailState);
  if (matched.length === 0) {
    return "";
  }
  return matched
    .map((sail) => {
      const min =
        sail.minimumWindKnots != null ? sail.minimumWindKnots.toFixed(1) : "?";
      const max =
        sail.maximumWindKnots != null ? sail.maximumWindKnots.toFixed(1) : "?";
      return `${sail.name} ${min}–${max} kn`;
    })
    .join(", ");
}

/**
 * @param {object} report
 */
function printReport(report) {
  const { entries, events, summary, matrix, usage, sails } = report;
  console.log(`Logbook: ${report.logbook}`);
  console.log(
    `Entries: ${entries}, sail events in window: ${events}, learned now: ` +
      `${summary.learned} (cached: ${summary.skippedCached}, no wind: ${summary.skippedNoData})`,
  );

  console.log("\nConditions per sail combination (learned from logbook wind):");
  if (usage.length === 0) {
    console.log("  (no events with wind data)");
  }
  for (const row of usage) {
    const types = Object.entries(row.eventTypes)
      .map(([type, count]) => `${type}×${count}`)
      .join(" ");
    console.log(
      `  ${row.sailState}${row.night ? "  [night]" : "  [day]"}\n` +
        `    samples: ${row.samples} (${types})\n` +
        `    TWS avg ${row.twsAvgMin}–${row.twsAvgMax} kn (mean ${row.twsAvgMean}), ` +
        `peak up to ${row.twsPeakMax} kn\n` +
        `    TWA ${row.twaMin}–${row.twaMax}° (mean ${row.twaMean})`,
    );
    const limits = configuredLimits(sails, row.sailState);
    if (limits) {
      console.log(`    configured whole-sail limits: ${limits}`);
    }
  }

  console.log("\nLearned sail preference matrix (bins with data):");
  if (matrix.matrix.length === 0) {
    console.log("  (no bins learned)");
  }
  for (const cell of matrix.matrix) {
    console.log(
      `  TWS ${matrix.twsBinsKnots[cell.twsBin]}–${matrix.twsBinsKnots[cell.twsBin + 1] ?? "∞"} kn, ` +
        `TWA ${matrix.twaBinsDegrees[cell.twaBin]}–${matrix.twaBinsDegrees[cell.twaBin + 1] ?? 180}°, ` +
        `${cell.night ? "night" : "day"}: ` +
        `${cell.preferredSailState} ` +
        `(trigger ${cell.minTwsGustTrigger.toFixed(1)} kn, n=${cell.samplesCount})`,
    );
  }
}

main();
