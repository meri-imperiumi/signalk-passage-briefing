/**
 * File spool watcher (SPEC §1.1/§2.2/§3.1): picks up METAREA text
 * bulletins dropped into the spool directory by the on-board HF
 * gateway (VARA HF / inReach fallback) and exposes the newest one to
 * the briefing pipeline while the boat is offline.
 *
 * Spool contract: plain text files (`*.txt`, `*.emc`) in
 * `spool_directory`. Each file is one bulletin; the first line is
 * taken as the header, a date-time is parsed out of the text (ISO
 * first, then the common `DDHHMMZ MON YYYY` NAVTEX style), and the
 * file modification time is the last-resort issue time. The newest
 * bulletin by issuedAt wins.
 *
 * `fs.watch` with a debounce rescan keeps this dependency-free; a
 * missed event self-heals on the next rescan tick.
 *
 * Pure parsing plus one watcher — unit-testable with a temp dir.
 *
 * @file spool-watcher.js
 */

const { readdir, readFile, stat } = require("node:fs/promises");
const { join } = require("node:path");

/** File extensions treated as bulletins. */
const BULLETIN_EXTENSIONS = new Set([".txt", ".emc", ".text"]);

/** Debounce window for the watch-triggered rescan (ms). */
const RESCAN_DEBOUNCE_MS = 500;

/** Keep at most this many parsed bulletins in memory. */
const KEEP_BULLETINS = 20;

/** Months for NAVTEX-style `DDHHMMZ MON YYYY` dates. */
const MONTHS = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

/**
 * Extracts an issue timestamp from bulletin text. Recognizes ISO
 * 8601 and the maritime `DDHHMMZ MON YYYY` form (day, hour, minute,
 * Zulu, month, year — e.g. `011200Z AUG 26`).
 *
 * @param {string} text
 * @returns {string|null} ISO timestamp, or null when none found
 */
function extractIssuedAt(text) {
  const iso = text.match(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?Z?)/);
  if (iso) {
    const parsed = new Date(iso[0].replace(" ", "T"));
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  const navtex = text.match(
    /\b(\d{2})(\d{2})(\d{2})Z\s+([A-Z]{3})\s+(\d{2,4})\b/,
  );
  if (navtex) {
    const [, day, hour, minute, mon, year] = navtex;
    const month = MONTHS[mon];
    if (month != null) {
      const fullYear = Number(year) < 100 ? 2000 + Number(year) : Number(year);
      const parsed = new Date(
        Date.UTC(fullYear, month, Number(day), Number(hour), Number(minute)),
      );
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
  }
  // NHC High Seas style: "0430 UTC SAT OCT 3 2026" (weekday optional;
  // month case varies between the wire feeds, "Oct" on the WMO sets)
  const nhc = text.match(
    /\b(\d{4})\s+UTC\s+(?:[A-Za-z]{3}\s+)?([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{4})\b/,
  );
  if (nhc) {
    const [, hhmm, mon, day, year] = nhc;
    const month = MONTHS[mon.toUpperCase().slice(0, 3)];
    if (month != null) {
      const parsed = new Date(
        Date.UTC(
          Number(year),
          month,
          Number(day),
          Number(hhmm.slice(0, 2)),
          Number(hhmm.slice(2, 4)),
        ),
      );
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
  }
  // Fiji/MetService style: "ISSUED BY FIJI METEOROLOGICAL SERVICE OCT
  // 022000 UTC." ("Oct 022000 UTC" on the WMO bulletin sets) — month,
  // day+hhmm, UTC. No year on the wire: the current year is assumed,
  // and a stale year-end bulletin shows as stale in the UI anyway.
  const fiji = text.match(/\b([A-Za-z]{3,9})\s+(\d{2})(\d{2})(\d{2})\s+UTC\b/);
  if (fiji) {
    const [, mon, day, hour, minute] = fiji;
    const month = MONTHS[mon.toUpperCase().slice(0, 3)];
    if (month != null) {
      const parsed = new Date(
        Date.UTC(
          new Date().getUTCFullYear(),
          month,
          Number(day),
          Number(hour),
          Number(minute),
        ),
      );
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
  }
  // MetService New Zealand style: "Wellington issued at 021856UTC Valid
  // until 031200UTC." — day+hhmm, UTC, no month and no year on the
  // wire; the parsed day lands in the current month
  const nzkl = text.match(/\bISSUED AT\s+(\d{2})(\d{2})(\d{2})Z?UTC/i);
  if (nzkl) {
    const [, day, hour, minute] = nzkl;
    const now = new Date();
    const parsed = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        Number(day),
        Number(hour),
        Number(minute),
      ),
    );
    return parsed.toISOString();
  }
  // Australian BoM style: "For 24 hours commencing 2300 UTC 2 October
  // 2026"
  const bom = text.match(
    /\bcommencing\s+(\d{2})(\d{2})\s+UTC\s+(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b/i,
  );
  if (bom) {
    const [, hour, minute, day, mon, year] = bom;
    const month = MONTHS[mon.toUpperCase().slice(0, 3)];
    if (month != null) {
      const parsed = new Date(
        Date.UTC(
          Number(year),
          month,
          Number(day),
          Number(hour),
          Number(minute),
        ),
      );
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
  }
  return null;
}

/**
 * Parses one spool file into a bulletin (SPEC §3.1
 * `metareaBulletin` shape).
 *
 * @param {string} filename - Basename (used when no header line)
 * @param {string} text - Raw bulletin text
 * @param {Date} mtime - File modification time
 * @returns {{header: string, issuedAt: string, bulletinText: string}}
 */
function parseBulletin(filename, text, mtime) {
  const trimmed = text.trim();
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const header = firstLine.length > 0 ? firstLine : filename;
  const issuedAt = extractIssuedAt(trimmed) ?? mtime.toISOString();
  return {
    header,
    issuedAt,
    bulletinText: text,
  };
}

/**
 * Lists the bulletin files currently in the spool directory.
 *
 * @param {string} dir
 * @returns {Promise<string[]>} Basenames, sorted
 */
async function listBulletinFiles(dir) {
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return []; // Directory missing: no bulletins, not an error
  }
  return entries
    .filter((name) =>
      BULLETIN_EXTENSIONS.has(name.slice(name.lastIndexOf(".")).toLowerCase()),
    )
    .sort();
}

/**
 * Reads and parses every bulletin file in the directory.
 *
 * @param {string} dir
 * @returns {Promise<Array<{header: string, issuedAt: string,
 *   bulletinText: string, file: string}>>} Newest first
 */
async function readBulletins(dir) {
  const files = await listBulletinFiles(dir);
  const bulletins = [];
  for (const file of files) {
    try {
      const fullPath = join(dir, file);
      const [text, stats] = await Promise.all([
        readFile(fullPath, "utf8"),
        stat(fullPath),
      ]);
      bulletins.push({
        ...parseBulletin(file, text, stats.mtime),
        file,
      });
    } catch {
      // File vanished mid-scan or unreadable: skip it
    }
  }
  bulletins.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  return bulletins;
}

/**
 * Creates the spool watcher. Reads the directory immediately, then
 * re-reads on `fs.watch` events (debounced) and on demand via
 * `refresh()`.
 *
 * @param {object} params
 * @param {string} params.dir - Spool directory (may not exist yet)
 * @param {Function} [params.onChange] - Called with the latest
 *   bulletin (or null) after every rescan that changed it
 * @returns {{latest: () => object|null, all: () => Array, refresh:
 *   () => Promise<object|null>, close: () => void}}
 */
function createSpoolWatcher({ dir, onChange }) {
  let bulletins = [];
  let watcher = null;
  let debounce = null;
  let lastNotified = null;

  const rescan = async () => {
    const next = await readBulletins(dir);
    bulletins = next.slice(0, KEEP_BULLETINS);
    const latest = bulletins[0] ?? null;
    const changed =
      (latest?.issuedAt ?? null) !== (lastNotified?.issuedAt ?? null) ||
      (latest?.file ?? null) !== (lastNotified?.file ?? null);
    if (changed) {
      lastNotified = latest;
      onChange?.(latest);
    }
    return latest;
  };

  try {
    watcher = require("node:fs").watch(dir, () => {
      clearTimeout(debounce);
      debounce = setTimeout(rescan, RESCAN_DEBOUNCE_MS);
    });
    watcher.on("error", () => {
      // Directory deleted while watched: keep polling on demand
    });
  } catch {
    // Directory does not exist yet: no live watch; refresh() still works
  }

  return {
    latest: () => bulletins[0] ?? null,
    all: () => bulletins,
    refresh: rescan,
    close: () => {
      clearTimeout(debounce);
      watcher?.close();
    },
  };
}

module.exports = {
  BULLETIN_EXTENSIONS,
  RESCAN_DEBOUNCE_MS,
  extractIssuedAt,
  parseBulletin,
  listBulletinFiles,
  readBulletins,
  createSpoolWatcher,
};
