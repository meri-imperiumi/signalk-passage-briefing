/**
 * GMDSS zone resolution & bulletin sources (work doc #9): resolves
 * which NAVAREA/METAREA zones the vessel's position and route
 * intersect, and fetches exactly those, from the best available
 * source per zone.
 *
 * Zone resolution runs offline at zero bandwidth against the bundled
 * low-resolution polygons (`gmdss-zones.json`): point-in-polygon per
 * route waypoint (or single position in "here" mode), preferring the
 * smallest containing polygon so nested/overlapping approximations
 * resolve to the most specific zone. Antimeridian routes (Tonga →
 * Opua) work because the shared ray-cast unwraps the ring.
 *
 * Sources, per the doc's ladder:
 *
 * 1. NOAA TGFTP raw text when the zone's station is configured
 *    (`https://tgftp.nws.noaa.gov/data/raw/fq/fqps01.nffn..txt`) —
 *    tiny plain WMO text, the fast path.
 * 2. WMO GMDSS portal (`https://weather.gmdss.org/XIV.html`) —
 *    global METAREA coverage; the `<pre>` block feeds the cruft
 *    cutter.
 * 3. UKHO Admiralty Radio Navigational Warnings for NAVAREA I (the
 *    zone the UKHO coordinates; page HTML parsed into the structured
 *    warning shape — the old MSI JSON API is gone). Other zones skip
 *    this rung: the UKHO does not coordinate them.
 *
 * Division of labor: this module owns where bytes come from and
 * which zones are fetched; bulletin-engine owns everything that
 * happens to the text afterwards.
 *
 * @file zone-source.js
 */

const { features } = require("../public/gmdss-zones-min.json");
const { resolveBulletinSource, ringContains } = require("./bulletin-engine.js");

/** NAVTEX broadcast station letters per zone (radio fallback,
 * docs #4/#9: "Z = Wellington for XIV"). */
const NAVTEX_STATIONS = { 10: "O", 14: "Z" };

/** Fetch ladder label order (preferred first). */
const SOURCE_LADDER = ["tgftp", "gmdss", "ukho"];

/**
 * Loads the bundled zone polygons (GeoJSON FeatureCollection from
 * the repository, `public/gmdss-zones-min.json`): one entry per
 * zone, its outer rings flattened out of Polygon/MultiPolygon
 * geometry, with the roman-numeral label from the properties.
 *
 * @returns {Array<{zone: number, roman: string, name: string,
 *   polygons: number[][][]}>}
 */
function loadZones() {
  return features.map((feature) => {
    const geometry = feature.geometry;
    const polygons =
      geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [geometry.coordinates];
    return {
      zone: feature.properties.zone,
      roman: feature.properties.roman,
      name: feature.properties.name,
      polygons: polygons.map((polygon) => polygon[0]),
    };
  });
}

/**
 * NAVTEX broadcast station letter for a zone (radio fallback, doc
 * §4: "Z = Wellington for XIV").
 *
 * @param {number} zone
 * @returns {string|null}
 */
function navtexStation(zone) {
  return NAVTEX_STATIONS[zone] ?? null;
}

/**
 * Ring area via the shoelace formula (absolute, degrees²) — only
 * used to pick the most specific zone among overlapping
 * approximations, so the crude metric is fine.
 *
 * @param {number[][]} polygon - [[lon, lat], …]
 * @returns {number}
 */
function ringArea(polygon) {
  let total = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    total += (polygon[j][0] + polygon[i][0]) * (polygon[j][1] - polygon[i][1]);
  }
  return Math.abs(total / 2);
}

/**
 * Resolves the active zone integers for a set of positions (route
 * waypoints, or a single GPS position in here-mode). Each position
 * contributes its smallest containing zone (most specific wins when
 * approximations overlap); the union across positions yields the
 * targeted list — a route straddling a boundary returns both zones.
 *
 * @param {Array<[number, number]>} points - Track points
 *   [[lon, lat], …]
 * @param {Array} [zones] - Zone list (defaults to bundled data)
 * @returns {number[]} Sorted active zone integers
 */
function resolveZones(points, zones = loadZones()) {
  const active = new Set();
  for (const [lon, lat] of points ?? []) {
    let best = null;
    let bestArea = Infinity;
    for (const zone of zones) {
      for (const polygon of zone.polygons) {
        if (ringContains(polygon, lon, lat)) {
          const area = ringArea(polygon);
          if (area < bestArea) {
            best = zone.zone;
            bestArea = area;
          }
        }
      }
    }
    if (best != null) {
      active.add(best);
    }
  }
  return [...active].sort((a, b) => a - b);
}

/**
 * Arabic zone number → Roman numeral (14 → XIV).
 *
 * @param {number} n
 * @returns {string}
 */
function romanNumeral(n) {
  const table = [
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let rest = n;
  let out = "";
  for (const [value, symbol] of table) {
    while (rest >= value) {
      out += symbol;
      rest -= value;
    }
  }
  return out;
}

/**
 * WMO GMDSS portal URL for a zone's METAREA weather text.
 *
 * @param {number} zone
 * @returns {string}
 */
function gmdssBulletinUrl(zone) {
  return `https://weather.gmdss.org/${romanNumeral(zone)}.html`;
}

/**
 * UKHO Admiralty MSI page for the Radio Navigational Warnings the
 * UKHO coordinates. The UKHO is the NAVAREA I coordinator (plus UK
 * coastal WZ warnings), so only zone 1 has a source here — other
 * zones get null and are skipped instead of guaranteed-404 fetches
 * (the old `/api/Warnings/Area/{XIV}` JSON endpoint is gone; the
 * site is server-rendered HTML now, parsed by {@link parseRnwHtml}).
 *
 * @param {number} zone
 * @returns {string|null} Page URL, null when the UKHO has no source
 *   for this zone
 */
function ukhoWarningsUrl(zone) {
  return zone === 1
    ? "https://msi.admiralty.co.uk/RadioNavigationalWarnings"
    : null;
}

/** Months for the RNW date-time group (`021011 UTC Oct 26`). */
const RNW_MONTHS = {
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
 * Parses the RNW page's date-time group (`DDHHMM UTC Mon YY`, full
 * month names and 4-digit years tolerated) into an ISO timestamp.
 *
 * @param {string} dtg - e.g. "021011 UTC Oct 26"
 * @returns {string|null}
 */
function parseRnwDateTime(dtg) {
  const match = String(dtg ?? "").match(
    /\b(\d{2})(\d{2})(\d{2})\s+UTC\s+([A-Za-z]{3,9})\s+(\d{2,4})\b/,
  );
  if (!match) {
    return null;
  }
  const [, day, hour, minute, mon, year] = match;
  const month = RNW_MONTHS[mon.toUpperCase().slice(0, 3)];
  if (month == null) {
    return null;
  }
  const fullYear = Number(year) < 100 ? 2000 + Number(year) : Number(year);
  const parsed = new Date(
    Date.UTC(fullYear, month, Number(day), Number(hour), Number(minute)),
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Decodes the HTML entities the RNW page uses in warning text. */
function decodeRnwText(text) {
  return String(text ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Parses the UKHO Radio Navigational Warnings page into the warning
 * shape the cache consumes (same shape `parseUkhoWarnings` emits:
 * `text`, `issuedAt`, `coordinates`). Each detail section carries a
 * reference heading (`NAVAREA I 220/26`), a date-time group and a
 * `<pre class="warning-description">` with the full text; the
 * reference and DTG are prepended so the console reads like a
 * bulletin. Warnings without a parseable DTG still pass with a null
 * `issuedAt`.
 *
 * @param {string} html - The RNW page HTML
 * @returns {Array<{text: string, issuedAt: string|null,
 *   coordinates: number[][]}>}
 */
function parseRnwHtml(html) {
  const warnings = [];
  const sectionRe =
    /<h2[^>]*class="warning-reference"[^>]*>([\s\S]*?)<\/h2>[\s\S]*?<h3[^>]*class="warning-date-time"[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<pre[^>]*class="warning-description"[^>]*>([\s\S]*?)<\/pre>/g;
  for (const [, reference, dtg, body] of html.matchAll(sectionRe)) {
    const text = decodeRnwText(body).trim();
    if (!text) {
      continue;
    }
    const ref = decodeRnwText(reference)
      .replace(/<[^>]+>/g, "")
      .trim();
    const stamp = parseRnwDateTime(decodeRnwText(dtg));
    warnings.push({
      text: `${ref}\n${decodeRnwText(dtg).trim()}\n\n${text}`,
      issuedAt: stamp,
      coordinates: [],
    });
  }
  return warnings;
}

/**
 * NOAA TGFTP raw-text URL for a WMO id + station pair (e.g.
 * `fqps01` / `NFFN` → `.../raw/fq/fqps01.nffn..txt`).
 *
 * @param {string} wmoId - Lowercase WMO header id (e.g. "fqps01")
 * @param {string} station - Station CCCC (e.g. "NFFN")
 * @returns {string}
 */
function tgftpUrl(header, station) {
  return `https://tgftp.nws.noaa.gov/data/raw/${header
    .slice(0, 2)
    .toLowerCase()}/${header.toLowerCase()}.${station.toLowerCase()}..txt`;
}

/**
 * Extracts the `<pre>` block from a GMDSS portal page (the bulletin
 * body; everything else is chrome).
 *
 * @param {string} html
 * @returns {string|null} Decoded bulletin text, null when absent
 */
function extractGmdssPre(html) {
  const match = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (!match) {
    return null;
  }
  return match[1]
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Fetches zone bulletins through the doc #9 ladder. For each active
 * zone: the configured TGFTP station when present, then the GMDSS
 * portal. Per-zone failures skip that zone (the next refresh
 * retries); nothing is fetched for zones not in the list.
 *
 * @param {object} params
 * @param {number[]} params.zones - Active zone integers
 * @param {Array<{zone: number, wmoId: string, station: string}>}
 *   [params.tgftpStations] - Configured TGFTP fast paths
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.timeoutMs]
 * @param {Function} [params.onFailure] - Called with `(zone, url,
 *   error)` when a zone's whole ladder (TGFTP fast path + GMDSS
 *   portal) failed; per-step fallbacks inside the ladder stay silent
 * @returns {Promise<Array<{url: string, text: string, source: string,
 *   zone: number}>>}
 */
async function fetchZoneBulletins({
  zones,
  tgftpStations = [],
  fetchImpl = fetch,
  timeoutMs,
  onFailure,
}) {
  const out = [];
  for (const zone of zones ?? []) {
    const station = (tgftpStations ?? []).find((s) => s.zone === zone);
    if (station) {
      const url = tgftpUrl(station.header, station.station);
      try {
        const { text } = await resolveBulletinSource(url, {
          fetchImpl,
          timeoutMs,
        });
        out.push({ url, text, source: "api", zone });
        continue;
      } catch {
        // Ladder: fall through to the portal
      }
    }
    const url = gmdssBulletinUrl(zone);
    try {
      const { text } = await resolveBulletinSource(url, {
        fetchImpl,
        timeoutMs,
      });
      out.push({ url, text, source: "api", zone });
    } catch (error) {
      // Zone unavailable this cycle: skip, next refresh retries
      onFailure?.(zone, url, error);
    }
  }
  return out;
}

/**
 * Normalizes the UKHO MSI JSON into the warning shape the bulletin
 * engine filters (work doc #9: structured geometry bypasses the regex
 * engine entirely for navigational hazards).
 *
 * The live response shape could not be verified from the dev sandbox
 * (msi.admiralty.co.uk is IPv4-only) — the parser accepts the
 * documented description (array of warnings with text, issue date,
 * geometry coordinates) tolerantly: the list under `warnings`, `items`
 * or `results`, text under `text`/`message`/`body`/`title`, dates under
 * `issuedAt`/`issued`/`issueDate`/`created`, coordinate arrays under
 * `coordinates`/`positions`/`geometry.coordinates`. Coordinate pairs
 * are assumed [lat, lon] and normalized to GeoJSON [lon, lat]; verify
 * both on the first live fetch.
 *
 * @param {unknown} payload - Parsed UKHO JSON response
 * @returns {Array<{text: string, issuedAt: string|null,
 *   coordinates: number[][]}>}
 */
function parseUkhoWarnings(payload) {
  const list = Array.isArray(payload)
    ? payload
    : (["warnings", "items", "results"]
        .map((key) =>
          payload && typeof payload === "object" ? payload[key] : null,
        )
        .find(Array.isArray) ?? []);
  const out = [];
  for (const warning of list) {
    if (warning == null || typeof warning !== "object") {
      continue;
    }
    const text =
      warning.text ?? warning.message ?? warning.body ?? warning.title;
    if (typeof text !== "string" || text.trim() === "") {
      continue;
    }
    const issuedRaw =
      warning.issuedAt ??
      warning.issued ??
      warning.issueDate ??
      warning.created;
    const issued = typeof issuedRaw === "string" ? new Date(issuedRaw) : null;
    const rawCoords =
      [
        warning.coordinates,
        warning.positions,
        warning.geometry?.coordinates,
      ].find(Array.isArray) ?? [];
    out.push({
      text: text.trim(),
      issuedAt:
        issued && !Number.isNaN(issued.getTime()) ? issued.toISOString() : null,
      coordinates: rawCoords
        .filter(
          (point) =>
            Array.isArray(point) &&
            point.length >= 2 &&
            point.every(Number.isFinite),
        )
        .map(([lat, lon]) => [lon, lat]),
    });
  }
  return out;
}

module.exports = {
  SOURCE_LADDER,
  loadZones,
  navtexStation,
  resolveZones,
  parseUkhoWarnings,
  romanNumeral,
  gmdssBulletinUrl,
  ukhoWarningsUrl,
  parseRnwDateTime,
  parseRnwHtml,
  tgftpUrl,
  extractGmdssPre,
  fetchZoneBulletins,
};
