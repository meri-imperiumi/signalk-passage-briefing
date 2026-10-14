#!/usr/bin/env node
/**
 * Blog backtest (pilot): replays sailed days from the Lille Ø blog
 * through the Sereno comfort model and sets the result against the
 * crew's own words.
 *
 * For every requested blog entry (one file per sailing day in the log
 * repository) the tool
 *
 * 1. resolves the day window from the previous entry's `created` stamp
 *    to this entry's `created` stamp (UTC handles ship's clock changes),
 * 2. pulls the crewed log entries from the logbook resource API (sail
 *    states, manual notes, and the crew's own sea-state observations),
 * 3. pulls onboard history (wind, speed, heading, attitude, log) at the
 *    stored 10 s resolution and aggregates it per UTC hour,
 * 4. fetches historical waves (ERA5) from the Open-Meteo Marine
 *    archive at four track points of the day, falling back to the
 *    Pierson-Moskowitz wind-sea approximation when the archive is
 *    silent,
 * 5. runs `serenoComfort` per hour — measured wind and speed, archive
 *    waves — and reports both the archive-wave and the PM-approximation
 *    tier so the two briefing modes can be told apart, and
 * 6. prints the hourly table, day statistics, crew observations, and
 *    the blog text side by side for a manual language-mapping review.
 *
 * Usage:
 *   node bin/blog-backtest.js --server http://192.168.2.105 \
 *     --logs ../log/_logs --dates 2026-09-12,2026-09-14
 *
 * Options:
 *   --server <url>   Signal K server base URL (default http://localhost:3000)
 *   --logs <dir>     Blog entry directory (default ../log/_logs)
 *   --dates <list>   Comma-separated entry dates (YYYY-MM-DD)
 *   --no-marine      Skip the Open-Meteo Marine archive (PM approximation only)
 *
 * @file blog-backtest.js
 */

const path = require("node:path");
const os = require("node:os");
const { readFile, readdir } = require("node:fs/promises");

const backtest = require("../plugin/backtest.js");

/**
 * Loads the shared physics module (ESM in `public/`, consumed from
 * CJS via dynamic import).
 *
 * @returns {Promise<object>} sereno-physics module
 */
const loadPhysics = () => import("../public/sereno-physics.mjs");

/** Server-side plugin defaults (plugin/index.js). */
const K_HEEL = 0.35;
const K_PITCH = 0.4;
const WATERLINE_M = 9.4;

/** Onboard history paths for the hour aggregation, with units. */
const BLOG_HISTORY_PATHS = [
  "navigation.speedOverGround",
  "navigation.speedThroughWater",
  "navigation.headingTrue",
  "navigation.log",
  "environment.wind.speedTrue",
  "environment.wind.angleTrueGround",
  "environment.wind.speedApparent",
  "environment.wind.angleApparent",
  "environment.wind.gust",
  "environment.current.drift",
  "environment.current.setTrue",
  "environment.depth.belowSurface",
  "environment.depth.belowKeel",
  "navigation.attitude.roll",
  "navigation.attitude.pitch",
  "navigation.position",
];

/** Stopped navigation.state values — anchor/moored hours don't count. */
const STOPPED_STATES = new Set(["anchored", "moored"]);

/** Every network request fails after this, one day at a time. */
const FETCH_TIMEOUT_MS = 30000;

/** Seconds per hour, for bucketing. */
const HOUR_MS = 3600 * 1000;

/** Hourly mean SOG at or above which the boat counts as underway. */
const UNDERWAY_SOG_KNOTS = 1.5;

/** Window cap: blog gaps of weeks must not stretch a 'day' over them. */
const WINDOW_CAP_MS = 48 * HOUR_MS;

/**
 * Narrative condition vocabulary: word → the comfort tier the crew's
 * language describes. Applied to the blog prose; the most severe tier
 * with a hit becomes the day's narrative tier. Regular expressions,
 * case-insensitive.
 */
const TIER_WORDS = {
  miserable: [
    /\bgales?\b/,
    /(?<!thunder)storms?\b/,
    /\bhowling\b/,
    /\bscreaming\b/,
    /\bbrutal\b/,
    /\bterrifying\b/,
    /\bsurvival\b/,
    /\bwashing machine\b/,
  ],
  rough: [
    /\brough\b/,
    /\bbashing\b/,
    /\bbanging\b/,
    /\bslamming\b/,
    /\buncomfortable\b/,
    /\bmiserable\b/,
    /\bpunishing\b/,
    /\bwet and\b/,
    // Slatting vocabulary — the crew describing the light-air
    // flapping regime; also tracked separately as narrativeSlatting
    /\bflapping\b/,
    /\bflopping\b/,
    /\bslapping\b/,
  ],
  sporty: [
    /\blumpy\b/,
    /\bsqualls?\b/,
    /\bsqually\b/,
    /\bbrisk\b/,
    /\bchoppy\b/,
    /\bchop\b/,
    /\blively\b/,
    /\bsporty\b/,
    /\bpunchy\b/,
    /\bblustery\b/,
    /\bthunderstorm\b/,
    /\bfresh winds?\b/,
    /\bwaves started\b/,
    // Proxy words the crew uses for lively-but-manageable conditions
    /\bbouncy\b/,
    /\bsplashy\b/,
  ],
  easy: [
    /\bsmooth\b/,
    /\bpleasant\b/,
    /\bgentle\b/,
    /\bflat seas?\b/,
    /\beasy\b/,
    /\bpleasurable\b/,
    /\bgood conditions\b/,
  ],
  champagne: [
    /\bmillpond\b/,
    /\bglassy\b/,
    /\bghosting\b/,
    /\bmirror\b/,
    /\bbecalmed\b/,
    /\bcalms?\b/,
    /\blight air\b/,
    /\bfickle\b/,
    /\bslow going\b/,
    /\bwind died\b/,
    /\bwind dropped\b/,
    /\bno wind\b/,
  ],
};

const KN_TO_MS = 0.514444;

/** WMO state-of-sea labels, indexed by Douglas code. */
const DOUGLAS_LABELS = [
  "calm (glassy)",
  "calm (rippled)",
  "smooth",
  "slight",
  "moderate",
  "rough",
  "very rough",
  "high",
  "very high",
  "phenomenal",
];

/** WMO Douglas↔Beaufort correspondence (signalk-logbook telemetry.js). */
const BEAUFORT_TO_DOUGLAS = [0, 1, 2, 3, 3, 4, 5, 5, 6, 7, 8, 8, 9];

/**
 * Parses a blog entry's YAML front matter and body.
 *
 * Supports the subset the log repository uses: scalar `key: value`
 * lines plus the two-level `position:` / `lon:` / `lat:` block.
 *
 * @param {string} raw - Full file content
 * @returns {{meta: Record<string, any>, body: string}}
 */
function parseEntry(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) {
    return { meta: {}, body: raw };
  }
  const meta = {};
  let position = null;
  for (const line of match[1].split(/\r?\n/)) {
    const scalar = /^\s*(\w[\w-]*):\s*(.*)$/.exec(line);
    if (!scalar) {
      continue;
    }
    const [, key, value] = scalar;
    if (key === "position") {
      position = { lon: null, lat: null };
    } else if (position && (key === "lon" || key === "lat")) {
      position[key] = Number(value);
    } else {
      meta[key] = value;
    }
  }
  if (position) {
    meta.position = position;
  }
  return { meta, body: match[2].trim() };
}

/**
 * Strips image embeds and collapses the body to prose lines for the
 * report quote.
 *
 * @param {string} body - Markdown body
 * @returns {string}
 */
function proseOf(body) {
  return body
    .split(/\r?\n/)
    .filter((line) => !/!\[/.test(line))
    .join("\n")
    .trim();
}

/**
 * Loads every blog entry, parsed, sorted by `created` timestamp.
 *
 * @param {string} logsDir - Directory containing YYYY-MM-DD*.md files
 * @returns {Promise<Array<{file: string, date: string, meta: object,
 *   body: string, createdMs: number|null}>>}
 */
async function loadEntries(logsDir) {
  const names = (await readdir(logsDir)).filter((n) =>
    /^\d{4}-\d{2}-\d{2}.*\.md$/.test(n),
  );
  const entries = [];
  for (const file of names) {
    const raw = await readFile(path.join(logsDir, file), "utf8");
    const { meta, body } = parseEntry(raw);
    const createdMs = meta.created ? Date.parse(meta.created) : null;
    entries.push({ file, date: file.slice(0, 10), meta, body, createdMs });
  }
  return entries.sort(
    (a, b) =>
      (a.createdMs ?? Date.parse(a.date)) - (b.createdMs ?? Date.parse(b.date)),
  );
}

/**
 * Circular mean of signed angle samples (radians).
 *
 * @param {number[]} angles
 * @returns {number|null}
 */
function circularMean(angles) {
  let sin = 0;
  let cos = 0;
  let n = 0;
  for (const a of angles) {
    if (a == null || !Number.isFinite(a)) {
      continue;
    }
    sin += Math.sin(a);
    cos += Math.cos(a);
    n++;
  }
  return n === 0 ? null : Math.atan2(sin / n, cos / n);
}

/**
 * Arithmetic mean over non-null finite samples.
 *
 * @param {number[]} values
 * @returns {number|null}
 */
function mean(values) {
  const finite = values.filter((v) => v != null && Number.isFinite(v));
  if (finite.length === 0) {
    return null;
  }
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

/**
 * Loads the maritime-zones reader for the inshore/offshore
 * classification. Tiles cache under the session temp dir and download
 * on demand; failure answers null and the bands fall back to
 * sounding-only classification.
 *
 * @returns {Promise<object|null>} The package module
 */
let zonesModule = null;
async function loadMaritimeZones() {
  if (zonesModule !== null) {
    return zonesModule;
  }
  try {
    const mz = await import("@openwaters/maritime-zones");
    mz.configure({
      cacheDir: path.join(os.tmpdir(), "blog-backtest-mz-tiles"),
    });
    zonesModule = mz;
  } catch {
    zonesModule = false;
  }
  return zonesModule || null;
}

/**
 * Distance to and bearing of the nearest land (nm/deg), null when
 * unavailable.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<{distanceNm: number, bearingRad: number}|null>}
 */
async function distanceToLandInfo(lat, lon) {
  const mz = await loadMaritimeZones();
  if (!mz) {
    return null;
  }
  try {
    const result = await mz.distanceToLand(lat, lon);
    if (!Number.isFinite(result?.distanceNm)) {
      return null;
    }
    return {
      distanceNm: result.distanceNm,
      bearingRad: Number.isFinite(result?.bearingDeg)
        ? (result.bearingDeg * Math.PI) / 180
        : null,
    };
  } catch {
    return null;
  }
}

/**
 * Lee-shelter geometry: how far the nearest land sits from dead
 * upwind of the arriving waves. 0° = land directly to windward (the
 * fetch is cut — sheltered), 180° = land to leeward (full fetch).
 * Null when either direction is unknown.
 *
 * @param {number|null} waveTravelRad - Wave travel direction (TO)
 * @param {number|null} landBearingRad - Bearing to nearest land (TO)
 * @returns {number|null} Degrees 0–180
 */
function leeShelterDeg(waveTravelRad, landBearingRad) {
  if (waveTravelRad == null || landBearingRad == null) {
    return null;
  }
  const waveFromRad = (waveTravelRad + Math.PI) % (2 * Math.PI);
  let rel = landBearingRad - waveFromRad;
  if (rel > Math.PI) rel -= 2 * Math.PI;
  if (rel < -Math.PI) rel += 2 * Math.PI;
  return Math.round((Math.abs(rel * 180) / Math.PI) * 10) / 10;
}

/**
 * Inshore/offshore band for one hour, combining the sounding (read
 * only to ~100 m, null in deep water, sporadic false shallow echoes)
 * with the maritime-zones distance to land. Enclosed seas sit close
 * to land yet sail offshore — the deep-water signal decides there.
 *
 * @param {{depthMeters: number|null, depthShallowFraction: number|null,
 *   distanceToLandNm: number|null}} sample - Hour record
 * @returns {"archipelago"|"coastal"|"offshore"} Regime band
 */
function regimeBandOf(sample) {
  const { depthMeters, depthShallowFraction, distanceToLandNm } = sample;
  if (depthMeters == null && distanceToLandNm == null) {
    // Neither signal — sounder off or data absent: unknown, never
    // silently offshore
    return "unknown";
  }
  const inArchipelago =
    (distanceToLandNm != null && distanceToLandNm < 3) ||
    (distanceToLandNm == null &&
      depthMeters != null &&
      depthMeters < 20 &&
      depthShallowFraction >= 0.8);
  if (inArchipelago) {
    return "archipelago";
  }
  const deepWater =
    depthMeters == null ||
    depthMeters >= 100 ||
    (distanceToLandNm != null && distanceToLandNm >= 25);
  return deepWater ? "offshore" : "coastal";
}

/**
 * Circular spread (deg) of heading samples — the angular standard
 * deviation around the mean heading. Maneuvering hours tack through
 * it.
 *
 * @param {number[]} angles - Signed radians
 * @returns {number|null}
 */
function headingSpreadDeg(angles) {
  let sin = 0;
  let cos = 0;
  let n = 0;
  for (const a of angles) {
    if (a == null || !Number.isFinite(a)) {
      continue;
    }
    sin += Math.sin(a);
    cos += Math.cos(a);
    n++;
  }
  if (n === 0) {
    return null;
  }
  const r = Math.hypot(sin / n, cos / n);
  return (
    Math.round(
      ((Math.sqrt(-2 * Math.log(Math.max(r, 1e-12))) * 180) / Math.PI) * 10,
    ) / 10
  );
}

/**
 * Median over non-null finite samples — robust to sporadic false
 * sounder echoes.
 *
 * @param {number[]} values
 * @returns {number|null}
 */
function median(values) {
  const finite = values.filter((v) => v != null && Number.isFinite(v));
  if (finite.length === 0) {
    return null;
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Maximum over non-null finite samples.
 *
 * @param {number[]} values
 * @returns {number|null}
 */
function max(values) {
  const finite = values.filter((v) => v != null && Number.isFinite(v));
  return finite.length === 0 ? null : Math.max(...finite);
}

/**
 * Fetches one History API slice (single hour keeps responses under the
 * server's row cap) and returns the raw `{values, data}` payload.
 *
 * @param {string} baseUrl - Signal K server base URL
 * @param {Date} from - Slice start (inclusive)
 * @param {Date} to - Slice end (exclusive)
 * @returns {Promise<object>} History API response
 */
async function fetchHistorySlice(baseUrl, from, to) {
  const url = new URL("/signalk/v2/api/history/values", baseUrl);
  url.searchParams.set("paths", BLOG_HISTORY_PATHS.join(","));
  url.searchParams.set("from", from.toISOString());
  url.searchParams.set("to", to.toISOString());
  // Server-side downsampling: the early years record at 0.6 s and the
  // hour aggregation never needed better than ~10 s
  url.searchParams.set("resolution", "10");
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`History API ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Fetches navigation.state samples for a window (string telemetry is
 * sparse — one cheap request pins down the anchor/underway periods).
 *
 * @param {string} baseUrl - Signal K server base URL
 * @param {Date} from - Window start
 * @param {Date} to - Window end
 * @returns {Promise<Array<{tMs: number, state: string}>>}
 */
async function fetchStateSamples(baseUrl, from, to) {
  const url = new URL("/signalk/v2/api/history/values", baseUrl);
  url.searchParams.set("paths", "navigation.state");
  url.searchParams.set("from", from.toISOString());
  url.searchParams.set("to", to.toISOString());
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    return [];
  }
  const payload = await response.json();
  return (payload.data ?? [])
    .filter((row) => typeof row[1] === "string")
    .map((row) => ({ tMs: Date.parse(row[0]), state: row[1] }));
}

/**
 * Fetches onboard history for a window in hour-sized slices.
 *
 * @param {string} baseUrl - Signal K server base URL
 * @param {Date} from - Window start
 * @param {Date} to - Window end
 * @returns {Promise<object[]>} Chronological rows `[iso, ...cells]`
 */
async function fetchHistory(baseUrl, from, to) {
  // Two-hour slices at the 10 s resolution stay under the server's
  // response cap; four in flight keep a day fetch in seconds
  const sliceMs = 2 * HOUR_MS;
  const slices = [];
  for (let t = from.getTime(); t < to.getTime(); t += sliceMs) {
    slices.push(t);
  }
  const rows = [];
  let cursor = 0;
  async function worker() {
    while (cursor < slices.length) {
      const t = slices[cursor++];
      const slice = await fetchHistorySlice(
        baseUrl,
        new Date(t),
        new Date(Math.min(t + sliceMs, to.getTime())),
      );
      rows.push(...(slice.data ?? []));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(4, slices.length) }, () => worker()),
  );
  return rows.sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
}

/**
 * Column lookup for a History API response.
 *
 * @param {object} slice - First slice response (`values` descriptor)
 * @returns {Map<string, number>} Path → data column index
 */
function columnMap(slice) {
  const columns = new Map();
  (slice?.values ?? []).forEach((spec, index) => {
    if (spec?.path) {
      columns.set(spec.path, index);
    }
  });
  return columns;
}

/**
 * Aggregates history rows into per-UTC-hour means.
 *
 * Angles use circular means; the log (distance) and gust keep max /
 * first-last semantics per hour. Position uses the first fix of the
 * hour — the wave-archive lookup point.
 *
 * @param {object[]} rows - Chronological `[iso, ...cells]` rows
 * @param {Map<string, number>} columns - Path → column index
 * @returns {Array<{hourIso: string, sogKnots: number, stwKnots: number,
 *   headingRad: number, twsKnots: number, twaRad: number, awsKnots: number,
 *   awaRad: number, gustKnots: number, lat: number, lon: number,
 *   logStartM: number, logEndM: number, samples: number,
 *   rollRad: number[], pitchRad: number[]}>}
 */
function hourlyAggregate(rows, columns) {
  const col = (name) => columns.get(name);
  const cell = (row, name) => {
    const index = col(name);
    const raw = index == null ? null : row[index + 1];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  };
  const buckets = new Map();
  for (const row of rows) {
    const tMs = Date.parse(row[0]);
    const hourKey = new Date(Math.floor(tMs / HOUR_MS) * HOUR_MS)
      .toISOString()
      .slice(0, 13);
    if (!buckets.has(hourKey)) {
      buckets.set(hourKey, {
        hourIso: `${hourKey}:00:00Z`,
        sog: [],
        stw: [],
        headings: [],
        tws: [],
        twas: [],
        aws: [],
        awas: [],
        gust: [],
        rolls: [],
        pitches: [],
        currents: [],
        currentSets: [],
        depths: [],
        lat: null,
        lon: null,
        logStart: null,
        logEnd: null,
        samples: 0,
      });
    }
    const b = buckets.get(hourKey);
    b.samples++;
    b.sog.push(cell(row, "navigation.speedOverGround"));
    b.stw.push(cell(row, "navigation.speedThroughWater"));
    b.headings.push(cell(row, "navigation.headingTrue"));
    b.tws.push(cell(row, "environment.wind.speedTrue"));
    b.twas.push(cell(row, "environment.wind.angleTrueGround"));
    b.aws.push(cell(row, "environment.wind.speedApparent"));
    b.awas.push(cell(row, "environment.wind.angleApparent"));
    b.gust.push(cell(row, "environment.wind.gust"));
    const roll = cell(row, "navigation.attitude.roll");
    if (roll != null) {
      b.rolls.push({ tMs, rollRad: roll });
    }
    const pitch = cell(row, "navigation.attitude.pitch");
    if (pitch != null) {
      b.pitches.push({ tMs, pitchRad: pitch });
    }
    b.currents.push(cell(row, "environment.current.drift"));
    b.currentSets.push(cell(row, "environment.current.setTrue"));
    // Sounding is the inshore/offshore stratifier. The sounder reads
    // only to ~100 m — null in deep water, with occasional false
    // sub-10 m echoes from fish and water layers — so the hour carries
    // the median plus the shallow fraction; sporadic spikes cannot
    // move a median, and a true archipelago hour reads shallow
    // nearly continuously.
    const depth =
      cell(row, "environment.depth.belowSurface") ??
      cell(row, "environment.depth.belowKeel");
    if (depth != null) {
      b.depths.push(depth);
    }
    const position = col("navigation.position");
    if (position != null && b.lat == null) {
      const value = row[position + 1];
      // History stores positions as [lon, lat] pairs
      const lat = Array.isArray(value) ? value[1] : value?.latitude;
      const lon = Array.isArray(value) ? value[0] : value?.longitude;
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        b.lat = lat;
        b.lon = lon;
      }
    }
    const logM = cell(row, "navigation.log");
    if (logM != null) {
      if (b.logStart == null) {
        b.logStart = logM;
      }
      b.logEnd = logM;
    }
  }
  return [...buckets.values()].map((b) => ({
    hourIso: b.hourIso,
    sogKnots: mean(b.sog) == null ? null : mean(b.sog) / KN_TO_MS,
    stwKnots: mean(b.stw) == null ? null : mean(b.stw) / KN_TO_MS,
    headingRad: circularMean(b.headings),
    // Heading spread separates steady hours (measured attitude
    // acceleration is meaningful) from maneuvering ones (tacks,
    // wakes and channel turns dominate the reconstruction)
    headingSpreadDeg: headingSpreadDeg(b.headings),
    twsKnots: mean(b.tws) == null ? null : mean(b.tws) / KN_TO_MS,
    twaRad: circularMean(b.twas),
    awsKnots: mean(b.aws) == null ? null : mean(b.aws) / KN_TO_MS,
    awaRad: circularMean(b.awas),
    gustKnots: max(b.gust) == null ? null : max(b.gust) / KN_TO_MS,
    currentKnots: mean(b.currents) == null ? null : mean(b.currents) / KN_TO_MS,
    currentSetRad: circularMean(b.currentSets),
    depthMeters: median(b.depths),
    depthShallowFraction:
      b.depths.length === 0
        ? null
        : b.depths.filter((d) => d < 25).length / b.depths.length,
    lat: b.lat,
    lon: b.lon,
    logStartM: b.logStart,
    logEndM: b.logEnd,
    samples: b.samples,
    rollSamples: b.rolls.map((r) => ({
      tMs: r.tMs,
      rollRad: r.rollRad,
      pitchRad: null,
    })),
    pitchSamples: b.pitches.map((r) => ({
      tMs: r.tMs,
      rollRad: null,
      pitchRad: r.pitchRad,
    })),
  }));
}

/**
 * Fetches historical waves (ERA5) from the Open-Meteo Marine archive
 * for one point and day.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} date - YYYY-MM-DD (UTC day of the point's hour)
 * @returns {Promise<object|null>} `{time: string[], hs: number[], tp: number[],
 *   dirFromDeg: number[]}` or null when the archive has no data
 */
async function fetchMarine(lat, lon, date) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
    hourly:
      "wave_height,wave_peak_period,wave_period,wave_direction,ocean_current_velocity,ocean_current_direction",
    start_date: date,
    end_date: date,
  });
  const url = `https://marine-api.open-meteo.com/v1/marine?${params}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    return null;
  }
  // The free archive tier asks for gentle pacing
  await new Promise((resolve) => setTimeout(resolve, 200));
  const payload = await response.json();
  const hourly = payload?.hourly;
  if (!hourly?.time || !Array.isArray(hourly.wave_height)) {
    return null;
  }
  return {
    time: hourly.time,
    hs: hourly.wave_height,
    // Archive models expose mean period; peak period may exist as a
    // null array — merge per value so each hour uses the best available
    tp: hourly.time.map(
      (_, i) => hourly.wave_peak_period?.[i] ?? hourly.wave_period?.[i],
    ),
    dirFromDeg: hourly.wave_direction,
    // Open-Meteo speaks km/h for currents; converted to knots on read
    currentVelocityKmh: hourly.ocean_current_velocity,
    // Oceanographic convention: the direction the current travels TO —
    // same convention as the boat's environment.current.setTrue
    currentDirDeg: hourly.ocean_current_direction,
  };
}

/**
 * Looks up the archive wave at one timestamp, interpolating between
 * the surrounding hourly archive values.
 *
 * @param {object|null} marine - {@link fetchMarine} payload
 * @param {number} tMs - Lookup time
 * @returns {{hsMeters: number|null, tpSeconds: number|null,
 *   dirFromRad: number|null, archiveCurrentKnots: number|null,
 *   archiveCurrentRad: number|null}}
 */
function marineAt(marine, tMs) {
  if (!marine) {
    return {
      hsMeters: null,
      tpSeconds: null,
      dirFromRad: null,
      archiveCurrentKnots: null,
      archiveCurrentRad: null,
    };
  }
  const times = marine.time.map((iso) => Date.parse(`${iso}Z`));
  let index = times.findIndex((t) => t >= tMs);
  if (index < 0) {
    index = times.length - 1;
  }
  if (index === 0) {
    return {
      hsMeters: marine.hs[0],
      tpSeconds: marine.tp?.[0] ?? null,
      dirFromRad:
        marine.dirFromDeg?.[0] == null
          ? null
          : (marine.dirFromDeg[0] * Math.PI) / 180,
      archiveCurrentKnots:
        marine.currentVelocityKmh?.[0] == null
          ? null
          : marine.currentVelocityKmh[0] / 1.852,
      archiveCurrentRad:
        marine.currentDirDeg?.[0] == null
          ? null
          : (marine.currentDirDeg[0] * Math.PI) / 180,
    };
  }
  const a = index - 1;
  const span = times[index] - times[a];
  // Clamp to the archive range — outside it, hold the edge value
  const frac = span > 0 ? Math.min(1, Math.max(0, (tMs - times[a]) / span)) : 0;
  const lerp = (series) => {
    const va = series?.[a];
    const vb = series?.[index];
    return va == null ? vb : vb == null ? va : va + (vb - va) * frac;
  };
  const dirFrom = (() => {
    const da = marine.dirFromDeg?.[a];
    const db = marine.dirFromDeg?.[index];
    if (da == null) {
      return db;
    }
    if (db == null) {
      return da;
    }
    let delta = db - da;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    return da + delta * frac;
  })();
  // Archive current: vector-lerped through east/north components so
  // the direction wraps the short way and slow currents weigh less
  const east =
    (marine.currentVelocityKmh?.[a] ?? 0) *
      Math.sin(((marine.currentDirDeg?.[a] ?? 0) * Math.PI) / 180) *
      (1 - frac) +
    (marine.currentVelocityKmh?.[index] ?? 0) *
      Math.sin(((marine.currentDirDeg?.[index] ?? 0) * Math.PI) / 180) *
      frac;
  const north =
    (marine.currentVelocityKmh?.[a] ?? 0) *
      Math.cos(((marine.currentDirDeg?.[a] ?? 0) * Math.PI) / 180) *
      (1 - frac) +
    (marine.currentVelocityKmh?.[index] ?? 0) *
      Math.cos(((marine.currentDirDeg?.[index] ?? 0) * Math.PI) / 180) *
      frac;
  const currentKmh = lerp(marine.currentVelocityKmh);
  return {
    hsMeters: lerp(marine.hs),
    tpSeconds: lerp(marine.tp),
    dirFromRad: dirFrom == null ? null : (dirFrom * Math.PI) / 180,
    archiveCurrentKnots: currentKmh == null ? null : currentKmh / 1.852,
    archiveCurrentRad:
      currentKmh == null || (east === 0 && north === 0)
        ? null
        : Math.atan2(east, north),
  };
}

/**
 * Fetches the crewed log entries for a window from the logbook
 * resource API.
 *
 * @param {string} baseUrl - Signal K server base URL
 * @param {Date} from - Window start
 * @param {Date} to - Window end
 * @returns {Promise<Array<object>>} Entries ascending by datetime
 */
async function fetchLogEntries(baseUrl, from, to) {
  const url = new URL("/signalk/v2/api/resources/logentries", baseUrl);
  url.searchParams.set("from", from.toISOString());
  url.searchParams.set("to", to.toISOString());
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
 * Extracts the crew's sea-state observations from log entries.
 *
 * @param {object[]} entries - Log entries
 * @returns {Array<{iso: string, beaufort: number, label: string, text: string}>}
 */
function crewSeaStates(entries) {
  const states = [];
  for (const entry of entries) {
    for (const pathvalue of entry.telemetry ?? []) {
      if (pathvalue.path === "environment.water.seaStateValue") {
        const beaufort = Math.round(pathvalue.value);
        const douglas = BEAUFORT_TO_DOUGLAS[beaufort] ?? beaufort;
        states.push({
          iso: entry.datetime,
          beaufort,
          douglas,
          label: DOUGLAS_LABELS[douglas] ?? `sea state ${douglas}`,
          text: entry.text ?? "",
        });
      }
    }
  }
  return states;
}

/**
 * Engine hours over the window from the cumulative main-engine
 * runtime in log-entry telemetry.
 *
 * @param {object[]} entries - Log entries
 * @returns {number|null} Hours, null when no runtime samples exist
 */
function engineHours(entries) {
  const samples = [];
  for (const entry of entries) {
    for (const pathvalue of entry.telemetry ?? []) {
      if (/^propulsion\..*\.runTime$/.test(pathvalue.path)) {
        samples.push({
          tMs: Date.parse(entry.datetime),
          seconds: pathvalue.value,
        });
      }
    }
  }
  if (samples.length < 2) {
    return null;
  }
  samples.sort((a, b) => a.tMs - b.tMs);
  const delta = samples[samples.length - 1].seconds - samples[0].seconds;
  return delta > 0 ? delta / 3600 : 0;
}

/**
 * Merges roll and pitch samples into combined attitude samples for
 * the measured-acceleration reconstruction.
 *
 * @param {Array<{tMs: number, rollRad: number, pitchRad: number}>} rollSamples
 * @param {Array<{tMs: number, pitchRad: number}>} pitchSamples
 * @returns {Array<{tMs: number, rollRad: number, pitchRad: number}>}
 *   Samples carrying both values within one second
 */
function mergeAttitude(rollSamples, pitchSamples) {
  const pitches = new Map(
    pitchSamples.map((p) => [Math.round(p.tMs / 1000), p.pitchRad]),
  );
  return rollSamples
    .map((r) => {
      const pitchRad = pitches.get(Math.round(r.tMs / 1000));
      return pitchRad == null
        ? null
        : { tMs: r.tMs, rollRad: r.rollRad, pitchRad };
    })
    .filter(Boolean);
}

/**
 * Measured RMS vertical acceleration over one hour of attitude
 * samples, using the shared window reconstruction.
 *
 * @param {Array<{tMs: number, rollRad: number, pitchRad: number}>} attitude
 * @returns {number|null} Hourly measured a_z (m/s²), null when the
 *   attitude record is too sparse
 */
function measuredHourlyAz(attitude) {
  return backtest.measuredAz(attitude);
}

/**
 * Maps blog prose onto the comfort vocabulary.
 *
 * @param {string} prose - Blog body text
 * @returns {{tier: string|null, hits: string[]}} The most severe tier
 *   with at least one hit, plus the matched words
 */
/** Slatting mechanism words — light-air sail flapping rather than
 * wave-driven roughness. */
const SLATTING_WORDS = [
  /\bflapping\b/,
  /\bflopping\b/,
  /\bslapping\b/,
  /\bslatting\b/,
];

/**
 * Fatigue words — tiredness and broken sleep often indicate rougher
 * conditions than the prose states outright (non-weather tiredness
 * exists, so this is a flag for review, not an automatic tier bump).
 * Positive rest mentions are excluded so "well slept" days don't flag.
 */
const FATIGUE_WORDS = [
  /\btired\b/,
  /\bexhaust(?:ed|ion)\b/,
  /\bworn out\b/,
  /\bsleep(?:y|less|deprived)\b/,
  /\blittle sleep\b/,
  /\bno sleep\b/,
  /\bnot much sleep\b/,
  /\bslept (?:badly|poorly|bad|little)\b/,
  /\bcouldn't sleep\b/,
  /\brough night\b/,
  /\bsleepless night\b/,
];

/**
 * Maps blog prose onto the comfort vocabulary.
 *
 * @param {string} prose - Blog body text
 * @returns {{tier: string|null, hits: string[], slatting: boolean}}
 *   The most severe tier with at least one hit, the matched words,
 *   and whether slatting-mechanism language appears
 */
function keywordTierOf(prose) {
  const hits = [];
  let slatting = false;
  for (const pattern of SLATTING_WORDS) {
    if (pattern.test(prose.toLowerCase())) {
      slatting = true;
      break;
    }
  }
  const fatigue = FATIGUE_WORDS.some((pattern) =>
    pattern.test(prose.toLowerCase()),
  );
  for (const tier of ["miserable", "rough", "sporty", "easy", "champagne"]) {
    for (const pattern of TIER_WORDS[tier]) {
      const match = pattern.exec(prose.toLowerCase());
      if (match) {
        hits.push(match[0]);
      }
    }
    if (hits.length > 0) {
      return { tier, hits, slatting, fatigue };
    }
  }
  return { tier: null, hits, slatting, fatigue };
}

/**
 * Bands a crew Douglas sea-state estimate into a comfort tier.
 *
 * @param {number} douglas - WMO state-of-sea code 0–9
 * @returns {string} Comfort tier
 */
function douglasBand(douglas) {
  if (douglas <= 1) return "champagne";
  if (douglas <= 3) return "easy";
  if (douglas === 4) return "sporty";
  if (douglas === 5) return "rough";
  return "miserable";
}

/**
 * Pairs each underway hour with the crew's nearest sea-state
 * observation in time.
 *
 * @param {Array<object>} hours - Evaluated underway hours
 * @param {Array<{iso: string, douglas: number}>} seaStates - Crew observations
 * @param {number} [toleranceMs] - Pairing tolerance (default ±2 h)
 * @returns {Array<{hourIso: string, comfort: string, slatting: boolean,
 *   twsKnots: number, awsKnots: number, twaDeg: number, waveRelDeg: number,
 *   hsMeters: number, crewDouglas: number, crewTier: string}>}
 */
function pairCrewSamples(hours, seaStates, toleranceMs = 2 * HOUR_MS) {
  const samples = [];
  for (const hour of hours) {
    if (!hour.underway) {
      continue;
    }
    const tMs = Date.parse(hour.hourIso);
    let best = null;
    for (const state of seaStates) {
      const delta = Math.abs(Date.parse(state.iso) - tMs);
      if (delta <= toleranceMs && (best == null || delta < best.delta)) {
        best = { delta, state };
      }
    }
    if (!best) {
      continue;
    }
    samples.push({
      hourIso: hour.hourIso,
      comfort: hour.comfort,
      slatting: hour.slatting,
      awsTier: hour.awsTier,
      motionTier: hour.motionTier,
      twsKnots: hour.twsKnots,
      awsKnots: hour.awsKnots,
      twaDeg: hour.twaRad == null ? null : (hour.twaRad * 180) / Math.PI,
      waveRelDeg: hour.waveRelDeg,
      hsMeters: hour.hsMeters,
      tpSeconds: hour.tpSeconds,
      currentKnots: hour.currentKnots,
      currentRelDeg: hour.currentRelDeg,
      depthMeters: hour.depthMeters,
      distanceToLandNm: hour.distanceToLandNm ?? null,
      landUpwindDeg: hour.landUpwindDeg ?? null,
      regime: hour.regime,
      measuredAz: hour.measuredAz,
      crewDouglas: best.state.douglas,
      crewTier: douglasBand(best.state.douglas),
    });
  }
  return samples;
}

/**
 * Formats an hour row of the report table.
 *
 * @param {object} row - Evaluated hour
 * @returns {string}
 */
function formatHourRow(row) {
  const kt = (v) => (v == null ? "  — " : v.toFixed(1).padStart(4));
  const underwayMark = row.underway ? " " : "-";
  const deg = (rad) =>
    rad == null
      ? "  — "
      : `${Math.round(((rad * 180) / Math.PI + 360) % 360)
          .toString()
          .padStart(3)}°`;
  const m = (v) => (v == null ? "  — " : v.toFixed(1).padStart(4));
  // Relative sea angle: 0° following … 90° beam … 180° head seas
  const waveRel = (row) => {
    if (row.waveTravelRad == null || row.headingRad == null) {
      return "  — ";
    }
    let rel = row.waveTravelRad - row.headingRad;
    if (rel > Math.PI) rel -= 2 * Math.PI;
    if (rel < -Math.PI) rel += 2 * Math.PI;
    return (
      `${Math.round(Math.abs((rel * 180) / Math.PI) / 10) * 10}`.padStart(3) +
      "°"
    );
  };
  const parts = [
    underwayMark,
    row.hourIso.slice(11, 16),
    kt(row.twsKnots),
    kt(row.gustKnots),
    kt(row.awsKnots),
    deg(row.twaRad),
    kt(row.sogKnots),
    m(row.hsMeters),
    m(row.tpSeconds),
    waveRel(row),
    (row.slatting ? "*" : " ") + row.comfort.slice(0, 4).padEnd(4),
    `${row.pmComfort.slice(0, 4).padEnd(4)}${row.pmSlatting ? "*" : " "}`,
    row.measuredAz == null ? "  —   " : row.measuredAz.toFixed(3).padStart(6),
  ];
  return parts.join(" ");
}

const HOUR_HEADER =
  "   UTC   TWS  gust  AWS  TWA   SOG   Hs    Tp  wΔ   tier   PM    a_z";

/**
 * Renders one day's full report.
 *
 * @param {object} report - Day report payload
 * @returns {string}
 */
function renderDay(report) {
  const lines = [];
  lines.push(`== ${report.date} — ${report.title} ==`);
  lines.push(
    `window ${report.window.from} → ${report.window.to} (${report.window.hours.toFixed(1)}h), ` +
      `distance ${report.distanceNm == null ? "?" : report.distanceNm.toFixed(0)}NM, ` +
      `engine ${report.engineHours == null ? "?" : report.engineHours.toFixed(1)}h`,
  );
  if (report.crewSeaStates.length > 0) {
    lines.push(
      "crew sea state: " +
        report.crewSeaStates
          .map(
            (s) =>
              `${s.iso.slice(11, 16)}Z B${s.beaufort}/D${s.douglas} ${s.label}`,
          )
          .join(", "),
    );
  }
  lines.push("");
  lines.push(HOUR_HEADER);
  for (const row of report.hours) {
    lines.push(formatHourRow(row));
  }
  lines.push("");
  lines.push(
    `day (underway ${report.underwayHours}h, '-' rows are stopped): ` +
      report.histogram.map(([tier, n]) => `${tier} ${n}h`).join(", ") +
      `, maxTWS ${report.maxTwsKnots?.toFixed(0) ?? "—"}kt, maxGust ${report.maxGustKnots?.toFixed(0) ?? "—"}kt, ` +
      `maxHs ${report.maxHsMeters?.toFixed(1) ?? "—"}m, slatting ${report.slattingHours}h, ` +
      `pm: ${report.pmHistogram.map(([tier, n]) => `${tier} ${n}h`).join(", ")}`,
  );
  lines.push(
    `measured a_z (attitude reconstruction, steady hours only): p50 ${report.measuredAzP50?.toFixed(3) ?? "—"}, ` +
      `p95 ${report.measuredAzP95?.toFixed(3) ?? "—"} m/s²`,
  );
  lines.push("");
  lines.push("blog:");
  for (const line of report.prose.split("\n")) {
    lines.push(`> ${line}`);
  }
  return lines.join("\n");
}

/**
 * Evaluates one blog day end to end.
 *
 * @param {object} params
 * @param {object} params.entry - Parsed blog entry
 * @param {object|null} params.previous - Previous blog entry
 * @param {string} params.server - Signal K server base URL
 * @param {boolean} params.marine - Use the Open-Meteo Marine archive
 * @returns {Promise<object>} Day report payload
 */
async function evaluateDay({ entry, previous, server, marine }) {
  const from = previous?.createdMs
    ? new Date(previous.createdMs)
    : new Date(`${entry.date}T00:00:00Z`);
  const to = entry.createdMs
    ? new Date(entry.createdMs)
    : new Date(`${entry.date}T23:59:59Z`);
  // A blog gap of weeks must not stretch a 'day' window over it
  const windowFrom =
    to.getTime() - from.getTime() > WINDOW_CAP_MS
      ? new Date(to.getTime() - WINDOW_CAP_MS)
      : from;
  const [entries, firstSlice, stateSamples] = await Promise.all([
    fetchLogEntries(server, windowFrom, to),
    fetchHistorySlice(
      server,
      windowFrom,
      new Date(Math.min(windowFrom.getTime() + HOUR_MS, to.getTime())),
    ),
    fetchStateSamples(server, windowFrom, to),
  ]);
  const rows = await fetchHistory(server, windowFrom, to);
  const hours = hourlyAggregate(rows, columnMap(firstSlice));
  // Nearest navigation.state sample per hour (±45 min) — the durable
  // underway/anchor record
  for (const hour of hours) {
    const midMs = Date.parse(hour.hourIso) + HOUR_MS / 2;
    let best = null;
    for (const sample of stateSamples) {
      const delta = Math.abs(sample.tMs - midMs);
      if (delta <= 45 * 60000 && (best == null || delta < best.delta)) {
        best = { delta, state: sample.state };
      }
    }
    hour.state = best?.state ?? null;
  }
  // Distance to land per hour — the maritime-zones reader with tiles
  // cached in the session temp dir; failure leaves it null and the
  // regime band falls back to sounding-only
  const withPosition = hours.filter(
    (h) => h.lat != null && Number.isFinite(h.lat),
  );
  const mz = await loadMaritimeZones();
  if (mz && withPosition.length > 0) {
    try {
      await mz.download({
        minLat: Math.min(...withPosition.map((h) => h.lat)) - 1,
        maxLat: Math.max(...withPosition.map((h) => h.lat)) + 1,
        minLon: Math.min(...withPosition.map((h) => h.lon)) - 1,
        maxLon: Math.max(...withPosition.map((h) => h.lon)) + 1,
      });
    } catch {
      // Tile download failure degrades to null distances
    }
    await Promise.all(
      withPosition.map(async (h) => {
        const info = await distanceToLandInfo(h.lat, h.lon);
        h.distanceToLandNm = info?.distanceNm ?? null;
        h.landBearingRad = info?.bearingRad ?? null;
      }),
    );
  }

  // Wave archive at four track points; PM fallback per hour. Hours
  // map to the nearest sampled point in time — the payloads are keyed
  // by sample index, not coordinates, since rounding would make
  // per-hour key lookups miss.
  const pointKeys = [];
  const points = hours.filter((h) => h.lat != null && Number.isFinite(h.lat));
  if (marine && points.length > 0) {
    const picks = [
      0,
      Math.floor(points.length / 3),
      Math.floor((2 * points.length) / 3),
      points.length - 1,
    ]
      .map((i) => points[i])
      .filter((p, i, all) => p && all.indexOf(p) === i);
    const payloads = await Promise.all(
      picks.map((point) =>
        fetchMarine(point.lat, point.lon, point.hourIso.slice(0, 10)),
      ),
    );
    picks.forEach((point, i) => {
      if (payloads[i]) {
        pointKeys.push({
          hourMs: Date.parse(point.hourIso),
          payload: payloads[i],
        });
      }
    });
  }

  const physics = await loadPhysics();
  const evaluated = [];
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
    const waves = nearest
      ? marineAt(nearest.payload, tMs)
      : {
          hsMeters: null,
          tpSeconds: null,
          dirFromRad: null,
          archiveCurrentKnots: null,
          archiveCurrentRad: null,
        };
    // Measured onboard current wins; archive surface current fills gaps
    const currentKnots = hour.currentKnots ?? waves.archiveCurrentKnots;
    const currentSetRad = hour.currentSetRad ?? waves.archiveCurrentRad;
    const twsKnots = hour.twsKnots ?? 0;
    const twaRad = hour.twaRad ?? Math.PI;
    const vessel = {
      sogKnots: hour.sogKnots ?? 0,
      headingRad: hour.headingRad ?? 0,
      waterlineLengthM: WATERLINE_M,
      kHeel: K_HEEL,
      kPitch: K_PITCH,
    };
    const wind = { twsKnots, twaRad };

    let comfort = null;
    if (waves.hsMeters != null && waves.tpSeconds != null) {
      comfort = physics.serenoComfort(
        {
          hsMeters: waves.hsMeters,
          tpSeconds: waves.tpSeconds,
          waveTravelDirectionRad:
            waves.dirFromRad == null
              ? null
              : (waves.dirFromRad + Math.PI) % (2 * Math.PI),
        },
        vessel,
        wind,
      );
    }
    const pm = backtest.waveFromWind(hour.awsKnots ?? twsKnots);
    const pmComfort = physics.serenoComfort(
      {
        hsMeters: pm.hsMeters,
        tpSeconds: pm.tpSeconds,
        waveTravelDirectionRad:
          hour.headingRad == null || hour.awaRad == null
            ? 0
            : (hour.headingRad + hour.awaRad + Math.PI) % (2 * Math.PI),
      },
      vessel,
      wind,
    );
    const attitude = mergeAttitude(hour.rollSamples, hour.pitchSamples);
    // Current vs waves: 0° with, 180° against — the steepness dial
    const waveTravelRad =
      waves.dirFromRad == null
        ? null
        : (waves.dirFromRad + Math.PI) % (2 * Math.PI);
    let currentRelDeg = null;
    if (waveTravelRad != null && currentSetRad != null) {
      let rel = waveTravelRad - currentSetRad;
      if (rel > Math.PI) rel -= 2 * Math.PI;
      if (rel < -Math.PI) rel += 2 * Math.PI;
      currentRelDeg = Math.round((Math.abs(rel * 180) / Math.PI) * 10) / 10;
    }
    evaluated.push({
      ...hour,
      hsMeters: waves.hsMeters,
      tpSeconds: waves.tpSeconds,
      waveTravelRad,
      currentKnots,
      currentSetRad,
      currentRelDeg,
      landBearingRad: hour.landBearingRad ?? null,
      landUpwindDeg: leeShelterDeg(waveTravelRad, hour.landBearingRad),
      comfort: comfort?.comfort ?? pmComfort.comfort,
      awsTier: (comfort ?? pmComfort).awsComfort,
      motionTier: (comfort ?? pmComfort).motionComfort,
      slatting: comfort?.slatting ?? false,
      waveSource: comfort ? "archive" : "pm",
      pmComfort: pmComfort.comfort,
      pmSlatting: pmComfort.slatting,
      measuredAz: measuredHourlyAz(attitude),
    });
  }

  // Only hours actually underway describe sailing conditions; the
  // anchored/moored evening tail of a day window would dilute the
  // histogram with harbor calm. SOG is the primary signal — recorded
  // densely and independent of state-machine quirks — with the sparse
  // navigation.state record overriding it when it says stopped.
  for (const row of evaluated) {
    const sogUnderway = (row.sogKnots ?? 0) >= UNDERWAY_SOG_KNOTS;
    if (row.state == null) {
      row.underway = sogUnderway;
    } else if (STOPPED_STATES.has(row.state)) {
      row.underway = false;
    } else {
      row.underway = row.sogKnots == null ? true : sogUnderway;
    }
    row.regime = regimeBandOf(row);
  }
  const underway = evaluated.filter((r) => r.underway);
  const countTiers = (key) => {
    const counts = new Map();
    for (const row of underway) {
      counts.set(row[key], (counts.get(row[key]) ?? 0) + 1);
    }
    return physics.COMFORT_TIERS.filter((t) => counts.has(t)).map((t) => [
      t,
      counts.get(t),
    ]);
  };
  const measured = underway
    .filter((r) => r.headingSpreadDeg == null || r.headingSpreadDeg <= 15)
    .map((r) => r.measuredAz)
    .filter((v) => v != null);
  const percentile = (values, p) => {
    if (values.length === 0) {
      return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  };
  // Relative sea angle per hour for the slatting analysis
  for (const row of evaluated) {
    if (row.waveTravelRad != null && row.headingRad != null) {
      let rel = row.waveTravelRad - row.headingRad;
      if (rel > Math.PI) rel -= 2 * Math.PI;
      if (rel < -Math.PI) rel += 2 * Math.PI;
      row.waveRelDeg = Math.round((Math.abs(rel * 180) / Math.PI) * 10) / 10;
    } else {
      row.waveRelDeg = null;
    }
  }
  const keywords = keywordTierOf(proseOf(entry.body));

  return {
    date: entry.date,
    title: entry.meta.title ?? entry.file,
    window: {
      from: windowFrom.toISOString().slice(0, 16) + "Z",
      to: to.toISOString().slice(0, 16) + "Z",
      hours: (to.getTime() - windowFrom.getTime()) / HOUR_MS,
    },
    distanceNm:
      evaluated.at(0)?.logStartM != null && evaluated.at(-1)?.logEndM != null
        ? (evaluated.at(-1).logEndM - evaluated.at(0).logStartM) / 1852
        : null,
    engineHours: engineHours(entries),
    crewSeaStates: crewSeaStates(entries),
    hours: evaluated,
    underwayHours: underway.length,
    histogram: countTiers("comfort"),
    pmHistogram: countTiers("pmComfort"),
    slattingHours: underway.filter((r) => r.slatting).length,
    maxTwsKnots: max(underway.map((r) => r.twsKnots)),
    maxGustKnots: max(underway.map((r) => r.gustKnots)),
    maxAwsKnots: max(underway.map((r) => r.awsKnots)),
    maxHsMeters: max(underway.map((r) => r.hsMeters)),
    keywordTier: keywords.tier,
    keywordHits: keywords.hits,
    narrativeSlatting: keywords.slatting,
    narrativeFatigue: keywords.fatigue,
    crewSamples: pairCrewSamples(underway, crewSeaStates(entries)),
    measuredAzP50: percentile(measured, 0.5),
    measuredAzP95: percentile(measured, 0.95),
    prose: proseOf(entry.body),
  };
}

/**
 * Aggregates an NDJSON day-report file into the calibration summary:
 * narrative-keyword vs model tiers, per-hour model vs crew sea-state
 * bands, and the slatting × AWS × wave-angle × sea-state buckets that
 * test whether apparent wind (not true wind) drives the washboard
 * regime.
 *
 * @param {string} file - NDJSON file of day reports
 */
async function summarize(file) {
  const { createReadStream } = require("node:fs");
  const { createInterface } = require("node:readline");
  const labelsFile = option("labels", null);
  const labels = new Map();
  if (labelsFile) {
    const labelLines = createInterface({
      input: createReadStream(labelsFile),
    });
    for await (const line of labelLines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const label = JSON.parse(line);
        labels.set(label.date, label);
      } catch {
        // Skip corrupt label lines
      }
    }
    console.error(`${labels.size} LLM labels loaded from ${labelsFile}`);
  }
  const days = [];
  const lines = createInterface({ input: createReadStream(file) });
  for await (const line of lines) {
    if (line.trim()) {
      days.push(JSON.parse(line));
    }
  }
  const minUnderway = Number(option("min-underway-hours", "6"));
  const sailed = days.filter((d) => d.underwayHours >= minUnderway);
  console.error(
    `${days.length} days, ${sailed.length} sailing days (≥${minUnderway}h underway)`,
  );

  // Day scale: model dominant tier vs narrative keyword tier
  const tiers = ["champagne", "easy", "sporty", "rough", "miserable"];
  const rankOf = new Map(tiers.map((t, i) => [t, i]));
  const dayMatrix = new Map(
    tiers.map((t) => [t, new Map(tiers.map((t2) => [t2, 0]))]),
  );
  let dayBoth = 0;
  for (const day of sailed) {
    if (!day.keywordTier || day.histogram.length === 0) {
      continue;
    }
    const dominant = day.histogram.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    dayMatrix
      .get(dominant)
      .set(day.keywordTier, dayMatrix.get(dominant).get(day.keywordTier) + 1);
    dayBoth++;
  }
  console.log("\n== day model-vs-narrative (rows model, columns narrative) ==");
  console.log(
    "model       ".padEnd(12) +
      tiers.map((t) => t.slice(0, 9).padStart(10)).join(""),
  );
  for (const row of tiers) {
    console.log(
      row.padEnd(12) +
        tiers
          .map((col) => String(dayMatrix.get(row).get(col)).padStart(10))
          .join(""),
    );
  }
  console.log(
    `(${dayBoth} days with both labels; keyword day counts: ` +
      [...tiers]
        .map((t) => `${t} ${sailed.filter((d) => d.keywordTier === t).length}`)
        .join(", ") +
      ")",
  );

  // Hour scale: model tier vs the crew's nearest sea-state band
  const hourMatrix = new Map(
    tiers.map((t) => [t, new Map(tiers.map((t2) => [t2, 0]))]),
  );
  let hoursBoth = 0;
  const slatCells = new Map();
  let slatHours = 0;
  let slatDisputes = 0;
  for (const day of sailed) {
    for (const sample of day.crewSamples ?? []) {
      hourMatrix
        .get(sample.comfort)
        .set(
          sample.crewTier,
          hourMatrix.get(sample.comfort).get(sample.crewTier) + 1,
        );
      hoursBoth++;
      const crewRank = tiers.indexOf(sample.crewTier);
      const roughRank = tiers.indexOf("rough");
      if (sample.slatting) {
        slatHours++;
        // A slatting-flagged hour disputes the penalty when the crew
        // logged a calmer band than the forced-at-least-Rough tier
        if (crewRank < roughRank) {
          slatDisputes++;
        }
        const awsBin =
          sample.awsKnots == null
            ? "?"
            : sample.awsKnots < 5
              ? "<5"
              : sample.awsKnots < 7
                ? "5-7"
                : sample.awsKnots < 10
                  ? "7-10"
                  : "10+";
        const relBin =
          sample.waveRelDeg == null
            ? "?"
            : sample.waveRelDeg < 45
              ? "follow<45"
              : sample.waveRelDeg < 90
                ? "quarter45-90"
                : sample.waveRelDeg < 135
                  ? "beam90-135"
                  : "head>135";
        const key = `${awsBin}kt AWS | ${relBin}`;
        const cell = slatCells.get(key) ?? { n: 0, disputed: 0, d: [] };
        cell.n++;
        if (crewRank < roughRank) {
          cell.disputed++;
        }
        cell.d.push(sample.crewDouglas);
        slatCells.set(key, cell);
      }
    }
  }
  console.log(
    "\n== hour model-vs-crew sea state (rows model, columns crew band) ==",
  );
  console.log(
    "model       ".padEnd(12) +
      tiers.map((t) => t.slice(0, 9).padStart(10)).join(""),
  );
  for (const row of tiers) {
    console.log(
      row.padEnd(12) +
        tiers
          .map((col) => String(hourMatrix.get(row).get(col)).padStart(10))
          .join(""),
    );
  }
  console.log(`(${hoursBoth} paired hours)`);

  console.log("\n== slatting-flagged hours by AWS and sea angle ==");
  console.log("cell                       n   crew-calmer  meanD");
  for (const [key, cell] of [...slatCells.entries()].sort()) {
    const meanD = cell.d.reduce((a, b) => a + b, 0) / cell.d.length;
    console.log(
      key.padEnd(26) +
        String(cell.n).padStart(4) +
        String(cell.disputed).padStart(13) +
        meanD.toFixed(1).padStart(7),
    );
  }
  console.log(
    `\nslatting flagged ${slatHours}h, crew logged calmer-than-Rough in ${slatDisputes}h`,
  );
  const noSlat = sailed.flatMap((d) =>
    (d.crewSamples ?? []).filter((s) => !s.slatting),
  );
  const noSlatRough = noSlat.filter(
    (s) =>
      tiers.indexOf(s.crewTier) >= tiers.indexOf("rough") &&
      tiers.indexOf(s.comfort) < tiers.indexOf("rough"),
  ).length;
  console.log(
    `unflagged hours ${noSlat.length}h, crew Rough-or-worse AND model calmer in ${noSlatRough}h (true misses)`,
  );

  // Which axis drives the model's harshness: of the paired hours where
  // the model outranks the crew, count whether the AWS band or the
  // motion band is the harsher of the two
  const harsher = { aws: 0, motion: 0, both: 0 };
  let harsherHours = 0;
  for (const day of sailed) {
    for (const sample of day.crewSamples ?? []) {
      if (rankOf.get(sample.comfort) <= rankOf.get(sample.crewTier)) {
        continue;
      }
      harsherHours++;
      const awsRank = rankOf.get(sample.awsTier ?? sample.comfort);
      const motionRank = rankOf.get(sample.motionTier ?? sample.comfort);
      if (
        awsRank > rankOf.get(sample.crewTier) &&
        motionRank > rankOf.get(sample.crewTier)
      ) {
        harsher.both++;
      } else if (awsRank > rankOf.get(sample.crewTier)) {
        harsher.aws++;
      } else if (motionRank > rankOf.get(sample.crewTier)) {
        harsher.motion++;
      }
    }
  }
  console.log(
    `\n== of ${harsherHours} model-harsher hours: AWS-band ${harsher.aws}, motion-band ${harsher.motion}, both ${harsher.both} ==`,
  );

  // LLM-labeled day comparison: the structured reading beats the
  // regex vocabulary (scope-aware: anchored/storm-sat-out days leave
  // the sailing matrix; mitigation and fatigue are first-class)
  if (labels.size > 0) {
    const llmTiers = [...tiers, null];
    const llmMatrix = new Map(
      tiers.map((t) => [t, new Map(tiers.map((t2) => [t2, 0]))]),
    );
    let llmDays = 0;
    const scopeCounts = {};
    let slatDaysMentioned = 0;
    let slatDaysMitigated = 0;
    let modelFlagsOnMentionDays = 0;
    let llmFatigueDays = 0;
    for (const day of sailed) {
      const label = labels.get(day.date);
      if (!label) {
        continue;
      }
      scopeCounts[label.scope] = (scopeCounts[label.scope] ?? 0) + 1;
      if (label.slatting_mentioned) {
        slatDaysMentioned++;
        if (label.slatting_mitigated) {
          slatDaysMitigated++;
        }
        if (day.slattingHours > 0) {
          modelFlagsOnMentionDays++;
        }
      }
      if (label.fatigue) {
        llmFatigueDays++;
      }
      if (
        !llmTiers.includes(label.comfort_tier) ||
        day.histogram.length === 0
      ) {
        continue;
      }
      // Keep pre-2022-style scope filtering out of the statistics:
      // anchored/land narratives don't describe sailing conditions
      if (label.scope === "anchored" || label.scope === "land") {
        continue;
      }
      const dominant = day.histogram.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
      llmMatrix
        .get(dominant)
        .set(
          label.comfort_tier,
          llmMatrix.get(dominant).get(label.comfort_tier) + 1,
        );
      llmDays++;
    }
    console.log(
      `\n== day model-vs-LLM reading (rows model, columns LLM; scope sailing+mixed) ==`,
    );
    console.log(
      "model       ".padEnd(12) +
        tiers.map((t) => t.slice(0, 9).padStart(10)).join(""),
    );
    for (const row of tiers) {
      console.log(
        row.padEnd(12) +
          tiers
            .map((col) => String(llmMatrix.get(row).get(col)).padStart(10))
            .join(""),
      );
    }
    console.log(
      `(${llmDays} days; LLM scopes: ${Object.entries(scopeCounts)
        .map(([s, n]) => `${s} ${n}`)
        .join(", ")})`,
    );
    console.log(
      `slatting: mentioned on ${slatDaysMentioned} days, mitigated ${slatDaysMitigated}, model flagged hours on ${modelFlagsOnMentionDays} of them; LLM fatigue on ${llmFatigueDays} days`,
    );
    // Where LLM and regex disagree day-level, one line each
    let disagreements = 0;
    for (const day of sailed) {
      const label = labels.get(day.date);
      if (!label || label.scope === "anchored" || label.scope === "land") {
        continue;
      }
      if (
        day.keywordTier &&
        llmTiers.includes(label.comfort_tier) &&
        label.comfort_tier !== day.keywordTier &&
        disagreements < 10
      ) {
        console.log(
          `disagree ${day.date}: regex ${day.keywordTier} vs LLM ${label.comfort_tier} [${(label.sea_state_words ?? []).slice(0, 3).join(", ")}] ${label.notes?.slice(0, 80) ?? ""}`,
        );
        disagreements++;
      }
    }
  }

  // Worst day-level disagreements for the crew review session: the
  // model's dominant tier against the narrative keyword tier, widest
  // gap first
  const disputes = sailed
    .filter((d) => d.keywordTier && d.histogram.length > 0)
    .map((d) => ({
      day: d,
      dominant: d.histogram.reduce((a, b) => (b[1] > a[1] ? b : a))[0],
      gap:
        rankOf.get(d.histogram.reduce((a, b) => (b[1] > a[1] ? b : a))[0]) -
        rankOf.get(d.keywordTier),
    }))
    .sort((a, b) => b.gap - a.gap);
  console.log(`\n== worst day disagreements (model vs narrative) ==`);
  for (const { day, dominant, gap } of disputes.slice(0, 15)) {
    if (gap === 0) {
      break;
    }
    console.log(
      `${day.date}  model ${dominant.padEnd(10)} narrative ${day.keywordTier.padEnd(10)} ` +
        `gap ${gap > 0 ? "+" : ""}${gap}  [${day.keywordHits.slice(0, 4).join(", ")}]  ${day.title}`,
    );
  }
  const perfect = disputes.filter((d) => d.gap === 0).length;
  console.log(
    `(${perfect} days agree exactly, ${disputes.length} labeled in total)`,
  );

  // Inshore/offshore stratification by regime band — sounding (read
  // only to ~100 m, null in deep water, sporadic false shallow echoes)
  // combined with maritime-zones distance to land. Old day records
  // predate the regime field and classify via the same pure helper on
  // the sounding alone; hours with neither signal are 'unknown'.
  const regimeBands = ["archipelago", "coastal", "offshore", "unknown"].map(
    (label) => ({
      label,
      matrix: new Map(
        tiers.map((t) => [t, new Map(tiers.map((t2) => [t2, 0]))]),
      ),
      harsherHours: 0,
      awsHarsher: 0,
      motionHarsher: 0,
    }),
  );
  for (const day of sailed) {
    for (const sample of day.crewSamples ?? []) {
      const label =
        sample.regime ??
        regimeBandOf({
          depthMeters: sample.depthMeters ?? null,
          depthShallowFraction: null,
          distanceToLandNm: sample.distanceToLandNm ?? null,
        });
      const band = regimeBands.find((b) => b.label === label);
      if (!band) {
        continue;
      }
      band.matrix
        .get(sample.comfort)
        .set(
          sample.crewTier,
          band.matrix.get(sample.comfort).get(sample.crewTier) + 1,
        );
      if (rankOf.get(sample.comfort) > rankOf.get(sample.crewTier)) {
        band.harsherHours++;
        const awsRank = rankOf.get(sample.awsTier ?? sample.comfort);
        const motionRank = rankOf.get(sample.motionTier ?? sample.comfort);
        if (awsRank > rankOf.get(sample.crewTier)) {
          band.awsHarsher++;
        }
        if (motionRank > rankOf.get(sample.crewTier)) {
          band.motionHarsher++;
        }
      }
    }
  }
  for (const band of regimeBands) {
    const n = [...band.matrix.values()].reduce(
      (sum, col) => sum + [...col.values()].reduce((a, b) => a + b, 0),
      0,
    );
    if (n === 0) {
      continue;
    }
    console.log(`\n== depth band ${band.label} (${n} paired hours) ==`);
    console.log(
      "model       ".padEnd(12) +
        tiers.map((t) => t.slice(0, 9).padStart(10)).join(""),
    );
    for (const row of tiers) {
      console.log(
        row.padEnd(12) +
          tiers
            .map((col) => String(band.matrix.get(row).get(col)).padStart(10))
            .join(""),
      );
    }
    console.log(
      `model-harsher ${band.harsherHours}h (AWS axis ${band.awsHarsher}, motion axis ${band.motionHarsher})`,
    );
  }

  // Sea legs: passage-day streaks (consecutive mostly-underway days)
  // against the model-vs-crew rank gap — the sliding-threshold test
  const streakBuckets = [
    { label: "day 1-2", min: 1, max: 2 },
    { label: "day 3-5", min: 3, max: 5 },
    { label: "day 6-10", min: 6, max: 10 },
    { label: "day 11-20", min: 11, max: 20 },
    { label: "day 21+", min: 21, max: Infinity },
  ].map((b) => ({ ...b, modelRanks: [], crewRanks: [] }));
  let streak = 0;
  for (const day of sailed) {
    streak = day.underwayHours >= 6 ? streak + 1 : 0;
    const bucket = streakBuckets.find(
      (b) => streak >= b.min && streak <= b.max,
    );
    if (!bucket) {
      continue;
    }
    for (const sample of day.crewSamples ?? []) {
      if (sample.comfort == null || sample.crewTier == null) {
        continue;
      }
      bucket.modelRanks.push(rankOf.get(sample.comfort));
      bucket.crewRanks.push(rankOf.get(sample.crewTier));
    }
  }
  console.log("\n== sea legs: model vs crew rank gap by passage day ==");
  console.log(
    "bucket      hours  model-rank  crew-rank  gap (+: model harsher)",
  );
  for (const bucket of streakBuckets) {
    if (bucket.modelRanks.length === 0) {
      continue;
    }
    const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const gap = avg(bucket.modelRanks) - avg(bucket.crewRanks);
    console.log(
      bucket.label.padEnd(10) +
        String(bucket.modelRanks.length).padStart(6) +
        avg(bucket.modelRanks).toFixed(2).padStart(11) +
        avg(bucket.crewRanks).toFixed(2).padStart(11) +
        `${gap >= 0 ? "+" : ""}${gap.toFixed(2)}`.padStart(8),
    );
  }

  // Current vs waves: the steepness dial, binned by opposition
  const currentBins = [
    { label: "with<30", min: 0, max: 30 },
    { label: "oblique30-90", min: 30, max: 90 },
    { label: "quarter90-150", min: 90, max: 150 },
    { label: "against>=150", min: 150, max: 181 },
  ].map((b) => ({ ...b, n: 0, crewD: [], hs: [], harsher: 0, calmer: 0 }));
  for (const day of sailed) {
    for (const sample of day.crewSamples ?? []) {
      if (sample.currentRelDeg == null) {
        continue;
      }
      const bin = currentBins.find(
        (b) => sample.currentRelDeg >= b.min && sample.currentRelDeg < b.max,
      );
      if (!bin) {
        continue;
      }
      bin.n++;
      if (sample.crewDouglas != null) {
        bin.crewD.push(sample.crewDouglas);
      }
      if (sample.hsMeters != null) {
        bin.hs.push(sample.hsMeters);
      }
      const drift = rankOf.get(sample.comfort) - rankOf.get(sample.crewTier);
      if (drift > 0) {
        bin.harsher++;
      } else if (drift < 0) {
        bin.calmer++;
      }
    }
  }
  console.log(
    "\n== current vs waves: opposition bins (0° with … 180° against) ==",
  );
  console.log(
    "bin                 n   meanD  meanHs  model-harsher  model-calmer",
  );
  for (const bin of currentBins) {
    if (bin.n === 0) {
      continue;
    }
    const meanD = bin.crewD.length
      ? bin.crewD.reduce((a, b) => a + b, 0) / bin.crewD.length
      : null;
    const meanHs = bin.hs.length
      ? bin.hs.reduce((a, b) => a + b, 0) / bin.hs.length
      : null;
    console.log(
      bin.label.padEnd(18) +
        String(bin.n).padStart(4) +
        (meanD == null ? "      —" : meanD.toFixed(1).padStart(7)) +
        (meanHs == null ? "      —" : `${meanHs.toFixed(1)}m`.padStart(8)) +
        String(bin.harsher).padStart(15) +
        String(bin.calmer).padStart(14),
    );
  }
}

/**
 * Rescores the comfort tiers on stored day records without any
 * network traffic: recomputes `serenoComfort` per hour from the
 * stored inputs (wind, waves, vessel state) and refreshes the
 * hour-tier fields plus the day aggregates that derive from them.
 * The fast arm of the #38 regression harness — a physics change
 * re-evaluates the whole 470-day corpus in seconds.
 *
 * @param {string} inputFile - Baseline day records
 * @param {string} outputFile - Rescored day records
 */
async function rescoreFile(inputFile, outputFile) {
  const { open } = require("node:fs/promises");
  const { createReadStream } = require("node:fs");
  const { createInterface } = require("node:readline");
  const physics = await loadPhysics();
  const handle = await open(outputFile, "w");
  const stream = handle.createWriteStream();
  const lines = createInterface({ input: createReadStream(inputFile) });
  let days = 0;
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const day = JSON.parse(line);
    for (const hour of day.hours ?? []) {
      const vessel = {
        sogKnots: hour.sogKnots ?? 0,
        headingRad: hour.headingRad ?? 0,
        waterlineLengthM: WATERLINE_M,
        kHeel: K_HEEL,
        kPitch: K_PITCH,
        sailState: hour.sailState ?? null,
      };
      const wind = {
        twsKnots: hour.twsKnots ?? 0,
        twaRad: hour.twaRad ?? Math.PI,
      };
      const comfort =
        hour.hsMeters != null && hour.tpSeconds != null
          ? physics.serenoComfort(
              {
                hsMeters: hour.hsMeters,
                tpSeconds: hour.tpSeconds,
                waveTravelDirectionRad: hour.waveTravelRad ?? null,
              },
              vessel,
              wind,
            )
          : null;
      const pm = backtest.waveFromWind(hour.awsKnots ?? hour.twsKnots ?? 0);
      const pmComfort = physics.serenoComfort(
        {
          hsMeters: pm.hsMeters,
          tpSeconds: pm.tpSeconds,
          waveTravelDirectionRad:
            hour.headingRad == null || hour.awaRad == null
              ? 0
              : (hour.headingRad + hour.awaRad + Math.PI) % (2 * Math.PI),
        },
        vessel,
        wind,
      );
      hour.comfort = comfort?.comfort ?? pmComfort.comfort;
      hour.awsTier = (comfort ?? pmComfort).awsComfort;
      hour.motionTier = (comfort ?? pmComfort).motionComfort;
      hour.slatting = comfort?.slatting ?? false;
      hour.pmComfort = pmComfort.comfort;
      hour.pmSlatting = pmComfort.slatting;
      if (comfort) {
        hour.encounterPeriod = comfort.acceleration.encounterPeriod;
        hour.encounterPeriodFloor = comfort.acceleration.encounterPeriodFloor;
        hour.effectivePeriod = comfort.acceleration.effectivePeriod;
      }
    }
    const underway = (day.hours ?? []).filter((hour) => hour.underway);
    const countTiers = (key) => {
      const counts = new Map();
      for (const row of underway) {
        counts.set(row[key], (counts.get(row[key]) ?? 0) + 1);
      }
      return physics.COMFORT_TIERS.filter((t) => counts.has(t)).map((t) => [
        t,
        counts.get(t),
      ]);
    };
    day.underwayHours = underway.length;
    day.histogram = countTiers("comfort");
    day.pmHistogram = countTiers("pmComfort");
    day.slattingHours = underway.filter((row) => row.slatting).length;
    days++;
    stream.write(`${JSON.stringify(day)}\n`);
  }
  await new Promise((resolve) => stream.end(resolve));
  await handle.close();
  console.error(`rescored ${days} days -> ${outputFile}`);
}

/**
 * Compares two day-record files (baseline vs candidate model run):
 * per-regime harsher-rate deltas, the protected-set check (gale days
 * and crew-D5+ hours must not get calmer), and the headline day/hour
 * matrix deltas. The regression harness for work doc #38 changes.
 *
 * @param {string} baselineFile - Baseline day records
 * @param {string} candidateFile - Candidate-model day records
 */
async function compareRuns(baselineFile, candidateFile) {
  const { createReadStream } = require("node:fs");
  const { createInterface } = require("node:readline");
  const load = async (file) => {
    const days = [];
    const lines = createInterface({ input: createReadStream(file) });
    for await (const line of lines) {
      if (line.trim()) {
        days.push(JSON.parse(line));
      }
    }
    return new Map(days.map((d) => [d.date, d]));
  };
  const base = await load(baselineFile);
  const cand = await load(candidateFile);
  const tiers = ["champagne", "easy", "sporty", "rough", "miserable"];
  const rank = new Map(tiers.map((t, i) => [t, i]));
  const shared = [...base.keys()].filter((date) => cand.has(date));
  console.error(`${shared.length} shared days`);

  // Protected set: gale-ish days and crew-D5+ hours must not calm down
  const protectedDates = new Set();
  for (const date of shared) {
    const d = base.get(date);
    if ((d.maxTwsKnots ?? 0) >= 24 || (d.maxHsMeters ?? 0) >= 3) {
      protectedDates.add(date);
    }
    if ((d.crewSamples ?? []).some((s) => (s.crewDouglas ?? 0) >= 5)) {
      protectedDates.add(date);
    }
  }
  let protectedViolations = 0;
  const hourDeltas = { softer: 0, harsher: 0, unchanged: 0 };
  for (const date of protectedDates) {
    const before = base.get(date);
    const after = cand.get(date);
    for (
      let i = 0;
      i < Math.min(before.hours.length, after.hours.length);
      i++
    ) {
      const a = before.hours[i];
      const b = after.hours[i];
      if (!a.underway) {
        continue;
      }
      const drift = rank.get(b.comfort) - rank.get(a.comfort);
      if (drift < 0) {
        hourDeltas.softer++;
        if (rank.get(b.comfort) < tiers.indexOf("sporty")) {
          protectedViolations++;
          console.log(
            `PROTECTED VIOLATION ${date} ${a.hourIso.slice(11, 16)}Z ${a.comfort} → ${b.comfort} (TWS ${(a.twsKnots ?? 0).toFixed(0)}kt Hs ${(a.hsMeters ?? 0).toFixed(1)}m)`,
          );
        }
      } else if (drift > 0) {
        hourDeltas.harsher++;
      } else {
        hourDeltas.unchanged++;
      }
    }
  }
  console.log(
    `\n== protected set (${protectedDates.size} gale/D5 days): ${hourDeltas.softer}h softer, ${hourDeltas.harsher}h harsher, ${protectedViolations} violations ==`,
  );

  // Regime harsher-rate deltas: model rank above the crew's observed
  // sea-state band, per regime band, baseline vs candidate
  const regimeStats = new Map();
  const addHours = (record, key) => {
    for (const hour of record.hours ?? []) {
      if (!hour.underway) {
        continue;
      }
      const regime = hour.regime ?? "unknown";
      const stats = regimeStats.get(regime) ?? {
        baseN: 0,
        candN: 0,
        baseHarsher: 0,
        candHarsher: 0,
      };
      stats[`${key}N`]++;
      const sample = (record.crewSamples ?? []).find(
        (s) => s.hourIso === hour.hourIso,
      );
      if (sample && hour.comfort != null) {
        if (rank.get(hour.comfort) > rank.get(sample.crewTier)) {
          stats[`${key}Harsher`]++;
        }
      }
      regimeStats.set(regime, stats);
    }
  };
  for (const date of shared) {
    addHours(base.get(date), "base");
    addHours(cand.get(date), "cand");
  }
  console.log(
    "\n== regime harsher rates (model rank > crew sea-state band) ==",
  );
  console.log("regime                 base-n  base-%   cand-n  cand-%   delta");
  for (const [regime, stats] of [...regimeStats.entries()].sort()) {
    const basePct = stats.baseN ? (100 * stats.baseHarsher) / stats.baseN : 0;
    const candPct = stats.candN ? (100 * stats.candHarsher) / stats.candN : 0;
    console.log(
      regime.padEnd(20) +
        String(stats.baseN).padStart(8) +
        `${basePct.toFixed(0)}%`.padStart(8) +
        String(stats.candN).padStart(8) +
        `${candPct.toFixed(0)}%`.padStart(8) +
        `${candPct - basePct >= 0 ? "+" : ""}${(candPct - basePct).toFixed(0)}pp`.padStart(
          8,
        ),
    );
  }

  // Day-level dominant-tier movement against the LLM labels
  const labelsFile = option("labels", null);
  const labels = new Map();
  if (labelsFile) {
    const labelLines = createInterface({ input: createReadStream(labelsFile) });
    for await (const line of labelLines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const label = JSON.parse(line);
        labels.set(label.date, label);
      } catch {
        // Skip corrupt lines
      }
    }
  }
  const agreeDelta = { improved: 0, regressed: 0, unchanged: 0 };
  let meanImproved = 0;
  let meanRegressed = 0;
  for (const date of shared) {
    const label = labels.get(date);
    if (!label || label.scope === "anchored" || label.scope === "land") {
      continue;
    }
    if (!tiers.includes(label.comfort_tier)) {
      continue;
    }
    const dom = (record) =>
      record.histogram?.length
        ? record.histogram.reduce((a, b) => (b[1] > a[1] ? b : a))[0]
        : null;
    const baseDom = dom(base.get(date));
    const candDom = dom(cand.get(date));
    if (!baseDom || !candDom) {
      continue;
    }
    const baseGap = Math.abs(rank.get(baseDom) - rank.get(label.comfort_tier));
    const candGap = Math.abs(rank.get(candDom) - rank.get(label.comfort_tier));
    if (candGap < baseGap) {
      agreeDelta.improved++;
    } else if (candGap > baseGap) {
      agreeDelta.regressed++;
    } else {
      agreeDelta.unchanged++;
    }
    // Dominant-tier flips can be histogram tie-break artifacts; the
    // per-day mean severity is the honest movement metric
    const meanSeverity = (record) => {
      const underway = (record.hours ?? []).filter((hour) => hour.underway);
      if (underway.length === 0) {
        return null;
      }
      return (
        underway.reduce((sum, hour) => sum + (rank.get(hour.comfort) ?? 0), 0) /
        underway.length
      );
    };
    const baseMean = meanSeverity(base.get(date));
    const candMean = meanSeverity(cand.get(date));
    if (baseMean != null && candMean != null) {
      if (candMean < baseMean - 1e-9) {
        meanImproved++;
      } else if (candMean > baseMean + 1e-9) {
        meanRegressed++;
      }
    }
  }
  console.log(
    `\n== LLM-label day agreement: ${agreeDelta.improved} improved, ${agreeDelta.regressed} regressed, ${agreeDelta.unchanged} unchanged ==`,
  );
  console.log(
    `== mean-severity movement: ${meanImproved} days softened, ${meanRegressed} days harshened ==`,
  );
}

/**
 * Strips the bulky intermediate fields from a day report before it is
 * written to the NDJSON file: the attitude sample arrays only exist to
 * derive `measuredAz`, and the log columns only feed the distance.
 *
 * @param {object} report - Day report payload
 * @returns {object} Slimmed copy safe for storage
 */
function slimDayReport(report) {
  const hours = report.hours.map((hour) => {
    const slim = { ...hour };
    delete slim.rollSamples;
    delete slim.pitchSamples;
    delete slim.logStartM;
    delete slim.logEndM;
    return slim;
  });
  return { ...report, hours };
}

/**
 * CLI entry point.
 */
/** Reads a CLI option value from the global argv. */
function option(name, fallback) {
  const args = process.argv.slice(2);
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

async function main() {
  const server = option("server", "http://localhost:3000");
  const logsDir = option(
    "logs",
    path.join(__dirname, "..", "..", "log", "_logs"),
  );
  const marine = !process.argv.slice(2).includes("--no-marine");
  const jsonFile = option("json", null);
  const summarizeFile = option("summarize", null);
  const rescoreFile_ = option("rescore", null);
  if (rescoreFile_) {
    await rescoreFile(rescoreFile_, option("out", `${rescoreFile_}.rescored`));
    return;
  }
  const compareArgs = (() => {
    const index = process.argv.indexOf("--compare");
    return index >= 0 ? process.argv.slice(index + 1, index + 3) : null;
  })();
  if (compareArgs && compareArgs.length >= 2) {
    await compareRuns(compareArgs[0], compareArgs[1]);
    return;
  }
  if (summarizeFile) {
    await summarize(summarizeFile);
    return;
  }
  const showDate = option("show", null);
  const showFile = option("json-file", null);
  if (showDate) {
    if (!showFile) {
      console.error("--show needs --json-file <ndjson>");
      process.exit(1);
    }
    const { createReadStream } = require("node:fs");
    const { createInterface } = require("node:readline");
    const lines = createInterface({ input: createReadStream(showFile) });
    let found = false;
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const day = JSON.parse(line);
      if (day.date === showDate) {
        console.log(renderDay(day));
        found = true;
        break;
      }
    }
    if (!found) {
      console.error(`-- ${showDate}: not in ${showFile}`);
      process.exit(1);
    }
    return;
  }
  const dates = (option("dates", "") ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  const since = option("since", null);
  if (dates.length === 0 && !since) {
    console.error(
      "Usage: node bin/blog-backtest.js --dates 2026-09-12[,…] | --since 2022-01-01 [--json file.ndjson] [--server url] [--logs dir] [--no-marine]",
    );
    process.exit(1);
  }

  const entries = await loadEntries(logsDir);
  const byDate = new Map(entries.map((e) => [e.date, e]));
  let targets = [];
  if (since) {
    targets = entries.filter((e) => e.date >= since);
  } else {
    for (const date of dates) {
      const entry = byDate.get(date);
      if (!entry) {
        console.error(`-- ${date}: no blog entry found in ${logsDir}`);
        continue;
      }
      targets.push(entry);
    }
  }

  let outputStream = null;
  if (jsonFile) {
    const { open, readFile } = require("node:fs/promises");
    const handle = await open(jsonFile, "a");
    outputStream = handle.createWriteStream();
    // Resume: skip dates the file already carries
    try {
      const { createReadStream } = require("node:fs");
      const { createInterface } = require("node:readline");
      const doneDates = new Set();
      const existing = createInterface({ input: createReadStream(jsonFile) });
      for await (const line of existing) {
        if (!line.trim()) {
          continue;
        }
        try {
          doneDates.add(JSON.parse(line).date);
        } catch {
          // Skip corrupt lines — partial writes from a killed run
        }
      }
      targets = targets.filter((e) => !doneDates.has(e.date));
      console.error(
        `resuming: ${doneDates.size} days already fetched, ${targets.length} to go`,
      );
    } catch {
      // New file, nothing to resume
    }
  }

  let index = 0;
  for (const entry of targets) {
    index++;
    const previous = entries[entries.indexOf(entry) - 1] ?? null;
    try {
      const report = await evaluateDay({ entry, previous, server, marine });
      if (jsonFile) {
        outputStream.write(`${JSON.stringify(slimDayReport(report))}\n`);
        console.error(
          `[${index}/${targets.length}] ${report.date} ok (${report.underwayHours}h underway)`,
        );
      } else {
        console.log(renderDay(report));
        console.log("");
      }
    } catch (error) {
      console.error(
        `[${index}/${targets.length}] -- ${entry.date}: ${error.message}`,
      );
    }
  }
  if (outputStream) {
    await new Promise((resolve) => outputStream.end(resolve));
  }
}

module.exports = {
  parseEntry,
  proseOf,
  loadEntries,
  circularMean,
  headingSpreadDeg,
  mean,
  max,
  hourlyAggregate,
  marineAt,
  crewSeaStates,
  engineHours,
  mergeAttitude,
  slimDayReport,
  keywordTierOf,
  douglasBand,
  pairCrewSamples,
  regimeBandOf,
  leeShelterDeg,
  compareRuns,
  evaluateDay,
  renderDay,
  summarize,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`Blog backtest failed: ${error.message}`);
    process.exit(1);
  });
}
