#!/usr/bin/env node
/**
 * Backtest CLI (SPEC §7.1): replays the vessel's history through the
 * Sereno motion model, tunes (k_heel, k_pitch) with Nelder-Mead and
 * prints the comfort confusion matrix.
 *
 * Usage:
 *   node bin/backtest-cli.js \
 *     --history-url http://localhost:3000 \
 *     --start 2026-08-01T00:00:00Z \
 *     --end 2026-08-03T12:00:00Z \
 *     --output ./backtest-report.json
 *
 * Options beyond the SPEC example:
 *   --resolution <sec>    History bucket size (default 10)
 *   --window-minutes <m>  Sliding window span (default 15)
 *   --chunk-hours <h>     History query chunk (default 24)
 *   --provider <id>       History provider ID
 *   --k-heel / --k-pitch  Starting guesses (default plugin values)
 *   --waterline <m>       Waterline length override
 *   --hull-beam <m>       Hull beam (work doc #56 kernel comparison)
 *   --hull-draft <m>      Canoe-body draught
 *   --hull-displacement <kg>  Displacement
 *   --hull-gm <m>         Metacentric height (enables roll figures)
 *   --hull-type <form>    monohull | catamaran | trimaran
 *
 * With a complete hull (--hull-beam/draft/displacement), the report
 * compares the spectral motion kernel (work doc #56) against the
 * legacy calibration: MAE and per-band residuals against the same
 * attitude-reconstructed series.
 *
 * The auth token is read from SIGNALK_TOKEN. The JSON report is
 * written to --output (default ./backtest-report.json).
 *
 * @file backtest-cli.js
 */

const { writeFile } = require("node:fs/promises");
const { runBacktest, resolveHullForOptions } = require("../plugin/backtest.js");

/**
 * Parses the command line into options.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {object} Parsed flags
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) {
      continue;
    }
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/**
 * Renders the confusion matrix as an ASCII table.
 *
 * @param {{tiers: string[], matrix: number[][]}} confusion
 * @returns {string}
 */
function renderMatrix(confusion) {
  const { tiers, matrix } = confusion;
  if (tiers.length === 0) {
    return "No windows evaluated — nothing to classify.";
  }
  const header =
    "pred\\meas ".padEnd(11) + tiers.map((t) => t.padStart(8)).join("");
  const rows = matrix.map(
    (row, i) =>
      tiers[i].padEnd(10) + row.map((n) => String(n).padStart(8)).join(""),
  );
  return [header, ...rows].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args["history-url"] ?? args.url;
  const start = args.start;
  const end = args.end;
  if (!baseUrl || !start || !end) {
    console.error(
      "Usage: node bin/backtest-cli.js --history-url <server> " +
        "--start <ISO> --end <ISO> [--output <file>]",
    );
    process.exit(1);
  }

  console.error(`Backtesting ${start} → ${end} against ${baseUrl} …`);
  const report = await runBacktest({
    baseUrl,
    from: new Date(start),
    to: new Date(end),
    options: {
      resolution: args.resolution ? Number(args.resolution) : undefined,
      windowMinutes: args["window-minutes"]
        ? Number(args["window-minutes"])
        : undefined,
      chunkHours: args["chunk-hours"] ? Number(args["chunk-hours"]) : undefined,
      provider: args.provider,
      waterline_length_m: args.waterline ? Number(args.waterline) : undefined,
      kHeel: args["k-heel"] ? Number(args["k-heel"]) : undefined,
      kPitch: args["k-pitch"] ? Number(args["k-pitch"]) : undefined,
      hull:
        args["hull-beam"] || args["hull-displacement"]
          ? await resolveHullForOptions({
              beam_m: args["hull-beam"] ? Number(args["hull-beam"]) : undefined,
              canoe_draft_m: args["hull-draft"]
                ? Number(args["hull-draft"])
                : undefined,
              displacement_kg: args["hull-displacement"]
                ? Number(args["hull-displacement"])
                : undefined,
              gm_m: args["hull-gm"] ? Number(args["hull-gm"]) : undefined,
              accel_point_m: args["hull-accel-point"]
                ? Number(args["hull-accel-point"])
                : undefined,
              type:
                typeof args["hull-type"] === "string"
                  ? args["hull-type"]
                  : undefined,
              lwl_m: args.waterline ? Number(args.waterline) : undefined,
            })
          : null,
    },
  });

  const output = args.output ?? "./backtest-report.json";
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);

  console.error(
    `${report.samples} samples → ${report.windowsEvaluated} windows evaluated`,
  );
  if (report.tuned.mae != null) {
    console.error(
      `k_heel ${report.start.kHeel} → ${report.tuned.kHeel}, ` +
        `k_pitch ${report.start.kPitch} → ${report.tuned.kPitch}`,
    );
    console.error(
      `MAE ${(report.start.mae ?? 0).toFixed(4)} → ${report.tuned.mae.toFixed(4)} m/s²`,
    );
  }
  console.log(renderMatrix(report.confusionMatrix));
  if (report.kernels?.jmo?.available) {
    console.error(
      `Kernel comparison: legacy MAE ${report.kernels.legacy.mae} vs ` +
        `spectral MAE ${report.kernels.jmo.mae} m/s² ` +
        `(${report.kernels.jmo.windows} windows)`,
    );
    for (const band of report.kernels.jmo.perBandResidual) {
      console.error(
        `  ${band.tier.padEnd(10)} n=${String(band.windows).padStart(5)} ` +
          `residual ${band.meanResidual == null ? "—" : band.meanResidual}`,
      );
    }
  }
  console.error(`Report written to ${output}`);
}

module.exports = { parseArgs, renderMatrix, resolveHullForOptions };

if (require.main === module) {
  main().catch((error) => {
    console.error(`Backtest failed: ${error.message}`);
    process.exit(1);
  });
}
