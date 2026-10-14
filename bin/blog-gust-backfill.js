#!/usr/bin/env node
/**
 * Archive gust backfill for the blog backtest dataset — the gust-peak
 * ground truth (work doc #38's optimism guard) that the onboard gust
 * column cannot provide for the early years.
 *
 * Reads the blog backtest NDJSON, fetches ERA5 `wind_speed_10m` and
 * `wind_gusts_10m` from the Open-Meteo archive at each day's four
 * track points (the same picks the wave fetch uses), maps them onto
 * the day's hours (hour-aligned, no interpolation needed), and writes
 * the enriched day records out. Adds per hour:
 *
 * - `archiveWindKnots` / `archiveGustKnots` — the ERA5 wind and gust,
 *   knots, from the nearest track point
 * - `gustFactor` — gust/mean ratio when both exist (onboard gust
 *   wins when recorded; archive fills the gap)
 *
 * Usage:
 *   node bin/blog-gust-backfill.js --json ~/.cache/blog-backtest/blog-backtest-full.ndjson
 *
 * Resume: days already carrying `archiveGustKnots` are skipped.
 *
 * @file blog-gust-backfill.js
 */

const os = require("node:os");
const path = require("node:path");
const { open } = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { createInterface } = require("node:readline");

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

/** Online pacing for the free archive tier. */
const PACING_MS = 150;

/**
 * Fetches ERA5 wind and gusts for one point and date.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<{speedMs: number[], gustMs: number[]}|null>}
 */
async function fetchArchiveWind(lat, lon, date) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
    hourly: "wind_speed_10m,wind_gusts_10m",
    wind_speed_unit: "kn",
    start_date: date,
    end_date: date,
  });
  const response = await fetch(`${ARCHIVE_URL}?${params}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    return null;
  }
  await new Promise((resolve) => setTimeout(resolve, PACING_MS));
  const payload = await response.json();
  const hourly = payload?.hourly;
  if (!hourly?.time || !Array.isArray(hourly.wind_gusts_10m)) {
    return null;
  }
  return { speedMs: hourly.wind_speed_10m, gustMs: hourly.wind_gusts_10m };
}

/**
 * Processes one day: fetches archive wind at the track points and
 * attaches per-hour values. Returns the mutated day record or null
 * when the day should be skipped (already enriched, no hours, no
 * positions, or fetch failed after retries).
 *
 * @param {object} day - Day record
 * @returns {Promise<object|null>}
 */
async function enrichDay(day) {
  const hours = day.hours ?? [];
  if (hours.length === 0) {
    return null;
  }
  if (hours.some((h) => h.archiveGustKnots != null)) {
    return null; // already enriched
  }
  const withPosition = hours.filter(
    (h) => h.lat != null && Number.isFinite(h.lat),
  );
  if (withPosition.length === 0) {
    return null;
  }
  const picks = [
    0,
    Math.floor(withPosition.length / 3),
    Math.floor((2 * withPosition.length) / 3),
    withPosition.length - 1,
  ]
    .map((i) => withPosition[i])
    .filter((p, i, all) => p && all.indexOf(p) === i);
  const payloads = await Promise.all(
    picks.map((point) =>
      fetchArchiveWind(point.lat, point.lon, point.hourIso.slice(0, 10)),
    ),
  );
  const pointKeys = picks
    .map((point, i) => ({
      hourMs: Date.parse(point.hourIso),
      payload: payloads[i],
    }))
    .filter((p) => p.payload);

  let enriched = 0;
  for (const hour of hours) {
    const tMs = Date.parse(hour.hourIso);
    let nearest = null;
    for (const point of pointKeys) {
      if (
        nearest == null ||
        Math.abs(point.hourMs - tMs) < Math.abs(nearest.hourMs - tMs)
      ) {
        nearest = point;
      }
    }
    if (!nearest) {
      continue;
    }
    // The archive series is hour-aligned to the point's UTC date
    const dayStartMs = Date.parse(
      `${nearest.hourMs ? new Date(nearest.hourMs).toISOString().slice(0, 10) : hour.hourIso.slice(0, 10)}T00:00:00Z`,
    );
    const hourIndex = Math.floor((tMs - dayStartMs) / 3600000);
    const speedMs = nearest.payload.speedMs?.[hourIndex];
    const gustMs = nearest.payload.gustMs?.[hourIndex];
    // The archive serves knots directly (wind_speed_unit=kn)
    if (speedMs != null) {
      hour.archiveWindKnots = speedMs;
    }
    if (gustMs != null) {
      hour.archiveGustKnots = gustMs;
    }
    // Gust factor: onboard gust wins when recorded, archive fills
    const gust = hour.gustKnots ?? hour.archiveGustKnots;
    const mean = hour.twsKnots ?? hour.archiveWindKnots;
    if (gust != null && mean != null && mean > 1) {
      hour.gustFactor = Math.round((gust / mean) * 100) / 100;
    }
    enriched++;
  }
  return enriched > 0 ? day : null;
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
      "blog-backtest-full.ndjson",
    ),
  );
  const outFile = option("out", `${jsonFile}.gust`);
  const limit = Number(option("limit", "0"));

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
    if (limit > 0 && done >= limit) {
      stream.write(`${JSON.stringify(day)}\n`);
      continue;
    }
    let enriched = null;
    for (let attempt = 1; attempt <= 3 && !enriched; attempt++) {
      try {
        enriched = await enrichDay(day);
      } catch (error) {
        if (attempt === 3) {
          failures++;
          console.error(`-- ${day.date}: ${error.message}`);
        } else {
          await new Promise((r) => setTimeout(r, attempt * 2000));
        }
      }
    }
    if (enriched) {
      done++;
      if (done % 25 === 0) {
        console.error(`${done} days enriched`);
      }
      stream.write(`${JSON.stringify(enriched)}\n`);
    } else {
      skipped++;
      stream.write(`${JSON.stringify(day)}\n`);
    }
  }
  await new Promise((resolve) => stream.end(resolve));
  await handle.close();
  console.error(
    `done: ${done} enriched, ${skipped} skipped, ${failures} failed`,
  );
  console.error(`output: ${outFile}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Gust backfill failed: ${error.message}`);
    process.exit(1);
  });
}
