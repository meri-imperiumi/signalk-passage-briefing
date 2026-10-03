/**
 * GDACS hazard event feed (work doc #22): earthquakes, tropical
 * cyclones, floods and volcanic activity as a machine-readable RSS
 * feed from the EU JRC's Global Disaster Alert and Coordination
 * System — free, no authentication, low daily volume.
 *
 * Ingestion follows the established source patterns (bulletin-source):
 * fetch only while the link is up, persist parsed events in
 * `weather/hazards.json`, deduplicate on the GDACS event id so
 * repolls update in place. The RSS format is stable and regular
 * enough for a small targeted extractor — no XML dependency.
 *
 * Route-relative filtering keeps events whose alert level reaches the
 * configured minimum (default Orange) and whose position sits near
 * the vessel or the active route corridor; everything else is dropped
 * before the briefing sees it.
 *
 * @file hazard-source.js
 */

const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");

/** The GDACS worldwide RSS feed (all event classes, all METAREAs). */
const GDACS_RSS_URL = "https://www.gdacs.org/xml/rss.xml";

/** Maximum cached events across repolls (bounded cache). */
const KEEP_HAZARDS = 200;

/**
 * Alert-level ranking: Green informational, Orange severe, Red
 * extreme. The briefing's minimum level compares against this rank.
 */
const ALERT_LEVEL_RANK = { green: 0, orange: 1, red: 2 };

/** Earth radius in nautical miles. */
const EARTH_RADIUS_NM = 3440.065;

/**
 * Unescapes the XML entities the feed uses in titles and
 * descriptions (&amp; &lt; &gt; &quot; &apos; and numeric forms).
 *
 * @param {string} text
 * @returns {string}
 */
function unescapeXml(text) {
  return String(text ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * First element value for a tag inside an item block, namespace
 * prefix agnostic (`<gdacs:alertlevel>` and `<alertlevel>` both
 * match), case-sensitive per the feed's own casing.
 *
 * @param {string} block - Raw `<item>` XML
 * @param {string} tag - Local tag name
 * @returns {string|null} Raw inner text, null when absent
 */
function tagValue(block, tag) {
  const match = block.match(
    new RegExp(
      `<(?:[A-Za-z0-9]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${tag}>`,
    ),
  );
  return match ? match[1].trim() : null;
}

/**
 * Parses the GDACS RSS feed into hazard events.
 *
 * Every item carries its type (`EQ`, `TC`, `FL`, `VO`, `DR`, `WF`),
 * an alert level (Green/Orange/Red), a title and description, and a
 * geolocated position (`georss:point`, fallback `geo:Point`). Items
 * without an id, a type or parseable coordinates are skipped — a
 * malformed entry must not cost the feed.
 *
 * @param {string} xml - Raw RSS text
 * @param {object} [options]
 * @param {Date} [options.now] - Reference instant for year-less
 *   comparisons (unused today; the feed carries full dates)
 * @returns {Array<{id: string, type: string, alertLevel: string,
 *   title: string, description: string, timestamp: string, lat:
 *   number, lon: number, link: string|null}>} Newest first
 */
function parseHazardsXml(xml) {
  if (typeof xml !== "string") {
    return [];
  }
  const events = [];
  for (const block of xml.split("<item>").slice(1)) {
    const item = block.split("</item>")[0];
    const id = tagValue(item, "guid");
    const type = tagValue(item, "eventtype");
    const event = {
      id: id ?? null,
      type: type ?? null,
      alertLevel: (tagValue(item, "alertlevel") ?? "").toLowerCase() || null,
      title: unescapeXml(tagValue(item, "title")),
      description: unescapeXml(tagValue(item, "description")),
      timestamp: null,
      lat: null,
      lon: null,
      link: tagValue(item, "link"),
    };
    if (!event.id || !event.type) {
      continue;
    }
    // Position: georss:point ("lat lon") preferred, geo:Point fallback
    const pointText = tagValue(item, "point");
    if (pointText) {
      const [pLat, pLon] = pointText.split(/\s+/).map(Number.parseFloat);
      if (Number.isFinite(pLat) && Number.isFinite(pLon)) {
        event.lat = pLat;
        event.lon = pLon;
      }
    } else {
      const geoLat = Number.parseFloat(tagValue(item, "lat") ?? "");
      const geoLon = Number.parseFloat(tagValue(item, "long") ?? "");
      if (Number.isFinite(geoLat) && Number.isFinite(geoLon)) {
        event.lat = geoLat;
        event.lon = geoLon;
      }
    }
    if (!Number.isFinite(event.lat) || !Number.isFinite(event.lon)) {
      continue; // A placeless event cannot be route-filtered
    }
    // Freshness: the feed updates in place (datemodified moves with
    // the event), so the newer of the two stamps ages the event
    const stamps = [tagValue(item, "datemodified"), tagValue(item, "pubDate")]
      .map((s) => (s ? new Date(s).getTime() : NaN))
      .filter(Number.isFinite);
    if (stamps.length > 0) {
      event.timestamp = new Date(Math.max(...stamps)).toISOString();
    }
    events.push(event);
  }
  return events.sort((a, b) =>
    String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")),
  );
}

/**
 * Merges parsed events into the cache: one entry per GDACS event id,
 * the fresher stamp winning, bounded to {@link KEEP_HAZARDS}.
 *
 * @param {Array<object>} cached - Existing events
 * @param {Array<object>} incoming - Parsed feed events
 * @returns {Array<object>} Merged, newest first
 */
function mergeHazards(cached, incoming) {
  const byId = new Map();
  for (const event of [...(cached ?? []), ...(incoming ?? [])]) {
    const existing = byId.get(event.id);
    if (
      !existing ||
      String(event.timestamp ?? "").localeCompare(
        String(existing.timestamp ?? ""),
      ) > 0
    ) {
      byId.set(event.id, event);
    }
  }
  return [...byId.values()]
    .sort((a, b) =>
      String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")),
    )
    .slice(0, KEEP_HAZARDS);
}

/**
 * Cache path under the plugin data directory.
 *
 * @param {string} dataDir
 * @returns {string}
 */
function hazardsCachePath(dataDir) {
  return join(dataDir, "weather", "hazards.json");
}

/**
 * Loads the hazard event cache. Missing or corrupt file → empty cache.
 *
 * @param {string} dataDir
 * @returns {Promise<Array<object>>}
 */
async function loadHazards(dataDir) {
  try {
    const raw = JSON.parse(await readFile(hazardsCachePath(dataDir), "utf8"));
    return Array.isArray(raw.events) ? raw.events : [];
  } catch {
    return [];
  }
}

/**
 * Persists the hazard event cache (newest first, pruned).
 *
 * @param {string} dataDir
 * @param {Array<object>} events
 * @returns {Promise<void>}
 */
async function saveHazards(dataDir, events) {
  await mkdir(join(dataDir, "weather"), { recursive: true });
  await writeFile(
    hazardsCachePath(dataDir),
    `${JSON.stringify({ events }, null, 2)}\n`,
  );
}

/**
 * Fetches the GDACS feed and merges it into the cache. A fetch or
 * parse failure keeps the cached events — the briefing degrades to
 * the last known picture, never fails.
 *
 * @param {object} params
 * @param {string} params.dataDir - Plugin data directory
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.timeoutMs]
 * @param {Function} [params.onFailure] - Called with the failure
 *   (transport error or HTTP status error) when the feed could not
 *   be fetched this cycle (source status registry, work doc #23)
 * @returns {Promise<{fetched: boolean, events: Array<object>}>}
 */
async function refreshHazards({
  dataDir,
  fetchImpl = fetch,
  timeoutMs = 15000,
  onFailure,
}) {
  const cached = await loadHazards(dataDir);
  let incoming = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(GDACS_RSS_URL, {
      signal: controller.signal,
    });
    if (response.ok) {
      incoming = parseHazardsXml(await response.text());
    } else {
      onFailure?.(
        new Error(`${response.status} ${response.statusText}`.trim()),
      );
    }
  } catch (error) {
    onFailure?.(error);
    incoming = null;
  } finally {
    clearTimeout(timer);
  }
  if (incoming == null) {
    return { fetched: false, events: cached };
  }
  const events = mergeHazards(cached, incoming);
  await saveHazards(dataDir, events);
  return { fetched: true, events };
}

/**
 * Great-circle distance between two positions (nm), antimeridian-safe
 * by construction (the haversine cosine folds the longitude delta).
 * Reused rather than reimplemented where the route simulation needs
 * the same number.
 *
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} Distance in nautical miles
 */
function distanceNm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const φ1 = lat1 * toRad;
  const φ2 = lat2 * toRad;
  const dφ = (lat2 - lat1) * toRad;
  const dλ = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Initial bearing (degrees true) from a reference position towards a
 * target.
 *
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} Bearing 0..360 degrees true
 */
function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const φ1 = lat1 * toRad;
  const φ2 = lat2 * toRad;
  const dλ = (lon2 - lon1) * toRad;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (((Math.atan2(y, x) / toRad) % 360) + 360) % 360;
}

/**
 * Filters cached events down to what the briefing should surface:
 * alert level at or above the configured minimum, recent enough, and
 * geographically relevant — within the off-route radius of the route
 * corridor or within the ahead radius of the vessel itself (work doc
 * #22: 500 nm off-route / 1000 nm off the boat).
 *
 * Surviving events carry the distance and bearing from the reference
 * that admitted them (the vessel, else the nearest route point).
 *
 * @param {object} params
 * @param {Array<object>} params.events - Cached hazard events
 * @param {{lat: number, lon: number}|null} params.vessel - Vessel
 *   position (null in route-only contexts)
 * @param {Array<{lat: number, lon: number, distanceFromStartNm?:
 *   number}>} [params.waypoints] - Route samples (vessel position
 *   first when the vessel is on route)
 * @param {string} [params.minAlertLevel] - "green"|"orange"|"red"
 * @param {number} [params.offRouteRadiusNm=500]
 * @param {number} [params.aheadRadiusNm=1000]
 * @param {number} [params.maxAgeHours=72]
 * @param {Date} [params.now]
 * @returns {Array<object>} Surviving events with `distanceNm` and
 *   `bearingDeg`, newest first
 */
function filterHazards({
  events,
  vessel,
  waypoints = [],
  minAlertLevel = "orange",
  offRouteRadiusNm = 500,
  aheadRadiusNm = 1000,
  maxAgeHours = 72,
  now = new Date(),
}) {
  const minRank = ALERT_LEVEL_RANK[String(minAlertLevel).toLowerCase()] ?? 1;
  const cutoff = now.getTime() - maxAgeHours * 3600000;
  const route = (waypoints ?? []).filter(
    (w) => Number.isFinite(w?.lat) && Number.isFinite(w?.lon),
  );
  const surviving = [];
  for (const event of events ?? []) {
    if (!Number.isFinite(event.lat) || !Number.isFinite(event.lon)) {
      continue;
    }
    if (event.timestamp && new Date(event.timestamp).getTime() < cutoff) {
      continue;
    }
    const rank = ALERT_LEVEL_RANK[String(event.alertLevel ?? "").toLowerCase()];
    if (rank == null || rank < minRank) {
      continue;
    }
    // Distance and bearing from the vessel, then from the nearest
    // route sample — the better (closer) reference admits the event
    let best = null;
    if (vessel && Number.isFinite(vessel.lat) && Number.isFinite(vessel.lon)) {
      best = {
        distanceNm: distanceNm(vessel.lat, vessel.lon, event.lat, event.lon),
        bearingDeg: bearingDeg(vessel.lat, vessel.lon, event.lat, event.lon),
        from: "vessel",
      };
    }
    for (const point of route) {
      const d = distanceNm(point.lat, point.lon, event.lat, event.lon);
      if (!best || d < best.distanceNm) {
        best = {
          distanceNm: d,
          bearingDeg: bearingDeg(point.lat, point.lon, event.lat, event.lon),
          from: "route",
        };
      }
    }
    if (!best) {
      continue;
    }
    const within =
      (best.from === "vessel" && best.distanceNm <= aheadRadiusNm) ||
      (best.from === "route" && best.distanceNm <= offRouteRadiusNm);
    if (!within) {
      continue;
    }
    surviving.push({
      ...event,
      distanceNm: Math.round(best.distanceNm * 10) / 10,
      bearingDeg: Math.round(best.bearingDeg),
    });
  }
  return surviving.sort((a, b) =>
    String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")),
  );
}

module.exports = {
  GDACS_RSS_URL,
  KEEP_HAZARDS,
  ALERT_LEVEL_RANK,
  unescapeXml,
  tagValue,
  parseHazardsXml,
  mergeHazards,
  hazardsCachePath,
  loadHazards,
  saveHazards,
  refreshHazards,
  distanceNm,
  bearingDeg,
  filterHazards,
};
