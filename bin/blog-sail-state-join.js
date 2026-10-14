#!/usr/bin/env node
/**
 * Sail-state join for the blog backtest dataset — the per-hour
 * sailing/motoring context the three-way slatting rule (work doc #38)
 * needs. One logentries fetch per day window; sail-state events are
 * parsed from the terse first-line logbook style:
 *
 *   "Motor stopped, sailing with Main, Genoa 1"
 *   "sailing with Main (1st reef), Staysail"
 *   "Sails down, motoring"
 *
 * The latest event at or before each hour carries forward, giving
 * each hour `sailState` ('sailing' | 'motoring' | null), the raw
 * event text, and its timestamp.
 *
 * Usage:
 *   node bin/blog-sail-state-join.js \
 *     --json ~/.cache/blog-backtest/blog-backtest-gust.ndjson [--force]
 *
 * Resume: days already carrying `sailState` (including null) are
 * skipped; `--force` clears the join and redoes every day.
 *
 * @file blog-sail-state-join.js
 */

const os = require("node:os");
const path = require("node:path");
const { open } = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { createInterface } = require("node:readline");

/** Signal K server base URL for the logentries resource API. */
const BASE_URL = "http://192.168.2.105";

/** Per-request timeout for the logentries fetch. */
const FETCH_TIMEOUT_MS = 30000;

/**
 * Sailing event: "sailing with <sails>", optionally preceded by
 * "Motor stopped,". The captured group keeps the canvas detail
 * (reef/furl annotations) for the later analysis.
 */
const SAILING_RE = /^(?:motor stopped,?\s*)?sail(?:ing)?\s+with\s+(.+)$/i;

/**
 * Canvas adjustment while sailing: "Sail(main) to 1st reef" —
 * the sail state is underway sailing with reduced canvas.
 */
const SAIL_ADJUST_RE = /^sail\s*\(([^)]+)\)/i;

/** Downwind sailing aids: "poled out jib" (may follow a watch note). */
const POLED_OUT_RE = /\bpoled out\b/i;

/**
 * Motoring events: sails down (with or without the trailing
 * "motoring"), or an explicit motoring statement.
 */
const SAILS_DOWN_RE = /^sails?\s+down\b/i;
const MOTORING_RE = /^(?:motor(?:ing)?\s+on|motoring)\b/i;
const SAILS_UP_RE = /^sails?\s+up\b/i;

/**
 * Parses the sail-state events from a day's log entries.
 *
 * @param {Array<object>} entries - Log entries ascending by datetime
 * @returns {Array<{iso: string, state: string, text: string}>} Events
 */
function sailEvents(entries) {
  const events = [];
  for (const entry of entries) {
    for (const rawLine of String(entry.text ?? "").split(/\r?\n/)) {
      const line = rawLine.trim();
      const sailing = SAILING_RE.exec(line);
      if (sailing) {
        events.push({
          iso: entry.datetime,
          state: "sailing",
          text: `sailing with ${sailing[1]}`,
        });
        continue;
      }
      const adjust = SAIL_ADJUST_RE.exec(line);
      if (adjust) {
        events.push({
          iso: entry.datetime,
          state: "sailing",
          text: `sailing with ${adjust[1]} (canvas adjusted)`,
        });
        continue;
      }
      if (POLED_OUT_RE.test(line)) {
        events.push({ iso: entry.datetime, state: "sailing", text: line });
        continue;
      }
      if (SAILS_DOWN_RE.test(line) || MOTORING_RE.test(line)) {
        events.push({ iso: entry.datetime, state: "motoring", text: line });
        continue;
      }
      if (SAILS_UP_RE.test(line)) {
        events.push({ iso: entry.datetime, state: "sailing", text: line });
      }
    }
  }
  return events.sort((a, b) => a.iso.localeCompare(b.iso));
}

/**
 * Fetches the log entries for a window.
 *
 * @param {string} fromIso - Window start
 * @param {string} toIso - Window end
 * @returns {Promise<Array<object>>} Entries ascending by datetime
 */
async function fetchLogEntries(fromIso, toIso) {
  const url = new URL("/signalk/v2/api/resources/logentries", BASE_URL);
  url.searchParams.set("from", fromIso);
  url.searchParams.set("to", toIso);
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Logentries API ${response.status}: ${response.statusText}`,
    );
  }
  const payload = await response.json();
  return Object.values(payload ?? {}).sort((a, b) =>
    String(a.datetime ?? "").localeCompare(String(b.datetime ?? "")),
  );
}

/**
 * Joins the sail events onto a day's hours. Each underway hour gets
 * the state of the latest event at or before it — events fetched with
 * lookback from before the window carry the prior day's state in, so
 * only hours with genuinely no prior event stay null. Stopped hours
 * are skipped — they are irrelevant to the underway comfort
 * evaluation.
 *
 * @param {object} day - Day record
 * @param {Array<object>} entries - Log entries for the window
 * @returns {object} The mutated day record
 */
function joinSailState(day, entries) {
  const events = sailEvents(entries);
  for (const hour of day.hours ?? []) {
    if (hour.sailState !== undefined) {
      continue; // already joined
    }
    if (!hour.underway) {
      continue;
    }
    const hourMs = Date.parse(hour.hourIso);
    let current = null;
    for (const event of events) {
      if (Date.parse(event.iso) <= hourMs) {
        current = event;
      } else {
        break;
      }
    }
    hour.sailState = current?.state ?? null;
    hour.sailText = current?.text ?? null;
    hour.sailEventIso = current?.iso ?? null;
  }
  return day;
}

/**
 * CLI entry point.
 */
async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const jsonFile = option(
    "json",
    path.join(
      os.homedir(),
      ".cache",
      "blog-backtest",
      "blog-backtest-gust.ndjson",
    ),
  );
  const outFile = option("out", `${jsonFile}.sails`);
  const limit = Number(option("limit", "0"));
  const force = args.includes("--force");

  const handle = await open(outFile, "w");
  const stream = handle.createWriteStream();
  const lines = createInterface({ input: createReadStream(jsonFile) });
  let done = 0;
  let skipped = 0;
  let failures = 0;
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let day;
    try {
      day = JSON.parse(line);
    } catch {
      continue;
    }
    if (force) {
      for (const hour of day.hours ?? []) {
        delete hour.sailState;
        delete hour.sailText;
        delete hour.sailEventIso;
      }
    }
    const needsJoin = (day.hours ?? []).some(
      (hour) => hour.underway && hour.sailState === undefined,
    );
    if (!needsJoin || (limit > 0 && done >= limit)) {
      skipped++;
      stream.write(`${JSON.stringify(day)}\n`);
      continue;
    }
    // A day's sailing usually started the day before; look back a
    // full day so the prior last sail event carries into early hours
    const lookbackIso = new Date(
      Date.parse(day.window.from) - 24 * 3600000,
    ).toISOString();
    let entries = null;
    for (let attempt = 1; attempt <= 3 && !entries; attempt++) {
      try {
        entries = await fetchLogEntries(lookbackIso, day.window.to);
      } catch (error) {
        if (attempt === 3) {
          failures++;
          console.error(`-- ${day.date}: ${error.message}`);
        } else {
          await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
        }
      }
    }
    if (entries) {
      done++;
      joinSailState(day, entries);
      if (done % 25 === 0) {
        console.error(`${done} days joined`);
      }
    }
    stream.write(`${JSON.stringify(day)}\n`);
  }
  await new Promise((resolve) => stream.end(resolve));
  await handle.close();
  console.error(`done: ${done} joined, ${skipped} skipped, ${failures} failed`);
  console.error(`output: ${outFile}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Sail-state join failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { sailEvents, joinSailState };
