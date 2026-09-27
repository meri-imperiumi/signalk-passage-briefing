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
 * 3. UKHO Admiralty MSI JSON for NAVAREA navigational warnings
 *    (structured coordinates skip the regex geography entirely —
 *    consumed as raw JSON text by the cache for now).
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
 * UKHO Admiralty MSI REST URL for a zone's NAVAREA warnings.
 *
 * @param {number} zone
 * @returns {string}
 */
function ukhoWarningsUrl(zone) {
  return `https://msi.admiralty.co.uk/api/Warnings/Area/${romanNumeral(zone)}`;
}

/**
 * NOAA TGFTP raw-text URL for a WMO id + station pair (e.g.
 * `fqps01` / `NFFN` → `.../raw/fq/fqps01.nffn..txt`).
 *
 * @param {string} wmoId - Lowercase WMO header id (e.g. "fqps01")
 * @param {string} station - Station CCCC (e.g. "NFFN")
 * @returns {string}
 */
function tgftpUrl(wmoId, station) {
  return `https://tgftp.nws.noaa.gov/data/raw/${wmoId
    .slice(0, 2)
    .toLowerCase()}/${wmoId.toLowerCase()}.${station.toLowerCase()}..txt`;
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
 * @returns {Promise<Array<{url: string, text: string, source: string,
 *   zone: number}>>}
 */
async function fetchZoneBulletins({
  zones,
  tgftpStations = [],
  fetchImpl = fetch,
  timeoutMs,
}) {
  const out = [];
  for (const zone of zones ?? []) {
    const station = (tgftpStations ?? []).find((s) => s.zone === zone);
    if (station) {
      const url = tgftpUrl(station.wmoId, station.station);
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
    } catch {
      // Zone unavailable this cycle: skip, next refresh retries
    }
  }
  return out;
}

module.exports = {
  SOURCE_LADDER,
  loadZones,
  navtexStation,
  resolveZones,
  romanNumeral,
  gmdssBulletinUrl,
  ukhoWarningsUrl,
  tgftpUrl,
  extractGmdssPre,
  fetchZoneBulletins,
};
