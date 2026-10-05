/**
 * CAP (Common Alerting Protocol) source (work doc #24): official,
 * structured warnings — the second ingestion channel alongside the
 * free-text bulletin pipeline (#4/#12). Where the text pipeline
 * *reconstructs* geometry from prose, CAP hands over native polygons
 * and circles, machine-readable severity, and a deterministic expiry.
 *
 * The canonical feed for this boat: the NWS Pacific tsunami warning
 * center's PHEBCAP.xml. FAH (the Filtered Alert Hub) aggregation is
 * supported at the fetch layer: an RSS item list whose `<link>`s point
 * at per-alert CAP documents is followed (newest first, bounded) and
 * each linked document parsed by the same single-format parser.
 *
 * Parsed alerts map onto the bulletin-engine's geometry types and
 * reuse its track-intersection tests — no new spatial math. Dedup is
 * on `<identifier>` + `<sent>`; `<expires>` drives deterministic
 * expiry, no heuristic aging.
 *
 * @file cap-source.js
 */

const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { intersectsTrack } = require("./bulletin-engine.js");
const { tagValue, unescapeXml } = require("./hazard-source.js");

/** Severity ranking for CAP's own vocabulary. */
const SEVERITY_RANK = { extreme: 3, severe: 2, moderate: 1, minor: 0 };

/**
 * Instruction placeholders some senders ship (PTWC's CAP documents
 * carry a literal "N/A"): rendered as the crew's action, so a bare
 * placeholder is no instruction at all.
 */
const INSTRUCTION_PLACEHOLDER = /^n\/?a\.?$/i;

/** Default feed: the NWS Pacific tsunami warning center. */
const CAP_DEFAULT_URL = "https://www.tsunami.gov/events/xml/PHEBCAP.xml";

/** Maximum cached alerts across repolls. */
const KEEP_CAP_ALERTS = 50;

/** RSS items followed per feed per refresh (newest first). */
const FOLLOW_RSS_ITEMS = 10;

/** Segments used to approximate a CAP circle as a polygon. */
const CIRCLE_SEGMENTS = 24;

/**
 * Unescapes CAP text fields.
 *
 * @param {string} text
 * @returns {string}
 */
function capText(block, tag) {
  return unescapeXml(tagValue(block, tag) ?? "").trim();
}

/**
 * Picks the info block to surface: highest severity wins, English
 * preferred at equal rank (per-language, per-area info blocks carry
 * the same warning; the rest stay in the raw document for
 * diagnostics).
 *
 * @param {string} alertXml - Raw `<alert>` document
 * @returns {string|null} The chosen `<info>` block, null when none
 */
function pickInfoBlock(alertXml) {
  const blocks = alertXml
    .split(/<info(?:\s[^>]*)?>/)
    .slice(1)
    .map((chunk) => chunk.split(/<\/info(?:\s[^>]*)?>/)[0]);
  let best = null;
  let bestRank = -1;
  for (const block of blocks) {
    const severity = (tagValue(block, "severity") ?? "").toLowerCase();
    const rank = SEVERITY_RANK[severity] ?? 0;
    const language = (tagValue(block, "language") ?? "en").toLowerCase();
    const english = language.startsWith("en") ? 0.5 : 0;
    const score = rank + english;
    if (score > bestRank) {
      bestRank = score;
      best = block;
    }
  }
  return best;
}

/**
 * Converts a CAP `<circle>` ("lat,lon radiusKm") into a polygon ring
 * ([lon, lat] pairs), antimeridian-naive (a circle crossing the seam
 * wraps; the bulletin-engine's intersection tests unfold longitudes
 * per comparison).
 *
 * @param {string} circleText - "lat,lon radiusKm"
 * @returns {number[][]|null} [[lon, lat], …] closed
 */
function circleToPolygon(circleText) {
  const parts = circleText.trim().split(/\s+/);
  if (parts.length !== 2) {
    return null;
  }
  const [coordText, radiusText] = parts;
  const [lat, lon] = coordText.split(",").map(Number.parseFloat);
  const radiusKm = Number.parseFloat(radiusText);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  // A zero-radius circle is a point, not an area: the caller falls
  // back to a tiny placeable box (a degenerate all-equal ring would
  // fail every intersection test)
  if (radiusKm <= 0) {
    return null;
  }
  const radiusDeg = radiusKm / 111.32;
  const ring = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const angle = (i / CIRCLE_SEGMENTS) * 2 * Math.PI;
    ring.push([
      Math.round(
        (lon +
          (radiusDeg * Math.cos(angle)) / Math.cos((lat * Math.PI) / 180)) *
          1e4,
      ) / 1e4,
      Math.round((lat + radiusDeg * Math.sin(angle)) * 1e4) / 1e4,
    ]);
  }
  ring.push([...ring[0]]);
  return ring;
}

/**
 * Converts a CAP `<polygon>` ("lat,lon lat,lon …" — latitude FIRST,
 * the classic CAP integration trap) into the bulletin-engine's ring
 * shape ([lon, lat], closed).
 *
 * @param {string} polygonText
 * @returns {number[][]|null}
 */
function capPolygonToRing(polygonText) {
  const pairs = polygonText.trim().split(/\s+/);
  const ring = [];
  for (const pair of pairs) {
    const [lat, lon] = pair.split(",").map(Number.parseFloat);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null; // Malformed pair: the whole polygon is suspect
    }
    ring.push([lon, lat]);
  }
  if (ring.length < 3) {
    return null;
  }
  const [firstLon, firstLat] = ring[0];
  const [lastLon, lastLat] = ring[ring.length - 1];
  if (firstLon !== lastLon || firstLat !== lastLat) {
    ring.push([firstLon, firstLat]);
  }
  return ring;
}

/**
 * Extracts the area geometry of one info block: the first polygon,
 * else the first circle (approximated). Point-only circles become a
 * tiny placeable box.
 *
 * @param {string} infoBlock - Raw `<info>` XML
 * @returns {{type: string, coordinates: number[][]|number[]}|null}
 */
function infoGeometry(infoBlock) {
  const areaBlocks = infoBlock
    .split(/<area(?:\s[^>]*)?>/)
    .slice(1)
    .map((chunk) => chunk.split(/<\/area(?:\s[^>]*)?>/)[0]);
  for (const area of areaBlocks) {
    const polygon = tagValue(area, "polygon");
    if (polygon) {
      const ring = capPolygonToRing(polygon);
      if (ring) {
        return { type: "polygon", coordinates: ring };
      }
    }
  }
  for (const area of areaBlocks) {
    const circle = tagValue(area, "circle");
    if (circle) {
      const ring = circleToPolygon(circle);
      if (ring) {
        return { type: "polygon", coordinates: ring };
      }
      // Zero-radius: a point, as a tiny box (bulletin-engine has no
      // point geometry; a ~0.6 nm box keeps it placeable)
      const [center] = circle.trim().split(/\s+/);
      const [lat, lon] = center.split(",").map(Number.parseFloat);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return {
          type: "bbox",
          coordinates: [lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01],
        };
      }
    }
  }
  return null;
}

/**
 * Parses one CAP 1.2 document into an alert event. Dedup key:
 * `<identifier>` + `<sent>`.
 *
 * @param {string} xml - Raw CAP XML (one `<alert>`)
 * @param {object} [options]
 * @param {string} [options.sourceUrl] - Feed the document came from
 * @param {string} [options.raw] - Raw document kept for diagnostics
 * @returns {object|null} Alert event, null when the document carries
 *   no identifier (the dedup key)
 */
function parseCapAlert(xml, { sourceUrl = null, raw = null } = {}) {
  if (typeof xml !== "string" || !xml.includes("<alert")) {
    return null;
  }
  const identifier = capText(xml, "identifier");
  if (!identifier) {
    return null;
  }
  const sent = capText(xml, "sent") || null;
  const info = pickInfoBlock(xml) ?? "";
  const expires = capText(info, "expires") || null;
  const geometry = infoGeometry(info);
  const instruction = capText(info, "instruction") || null;
  return {
    id: `${identifier}|${sent ?? ""}`,
    identifier,
    sent,
    msgType: capText(xml, "msgType") || null,
    senderName: capText(info, "senderName") || capText(xml, "source") || null,
    event: capText(info, "event") || null,
    severity: (tagValue(info, "severity") ?? "").toLowerCase() || null,
    urgency: (tagValue(info, "urgency") ?? "").toLowerCase() || null,
    certainty: (tagValue(info, "certainty") ?? "").toLowerCase() || null,
    effective: capText(info, "effective") || capText(info, "onset") || null,
    expires,
    headline: capText(info, "headline") || null,
    description: capText(info, "description") || null,
    instruction:
      instruction && !INSTRUCTION_PLACEHOLDER.test(instruction)
        ? instruction
        : null,
    web: capText(info, "web") || null,
    areaDesc: capText(info, "areaDesc") || null,
    geometry,
    sourceUrl,
    raw,
  };
}

/**
 * Parses a FAH-style RSS item list into the CAP document links to
 * follow (newest first, bounded by the caller).
 *
 * @param {string} xml - Raw RSS
 * @returns {Array<{link: string, title: string, published: string|null}>}
 */
function parseCapFeedItems(xml) {
  if (typeof xml !== "string" || !xml.includes("<item>")) {
    return [];
  }
  const items = [];
  for (const chunk of xml.split("<item>").slice(1)) {
    const item = chunk.split("</item>")[0];
    const link = tagValue(item, "link");
    if (link) {
      items.push({
        link: link.trim(),
        title: unescapeXml(tagValue(item, "title")),
        published: tagValue(item, "pubDate"),
      });
    }
  }
  return items;
}

/**
 * Merges parsed alerts into the cache: dedup on the identifier+sent
 * key (repolls update in place), bounded to {@link KEEP_CAP_ALERTS},
 * newest `sent` first.
 *
 * @param {Array<object>} cached
 * @param {Array<object>} incoming
 * @returns {Array<object>}
 */
function mergeCapAlerts(cached, incoming) {
  const byId = new Map();
  for (const alert of [...(cached ?? []), ...(incoming ?? [])]) {
    // The identifier is the alert's identity: a republished alert (a
    // newer `sent`) is an update in place, never a duplicate
    const existing = byId.get(alert.identifier);
    if (
      !existing ||
      String(alert.sent ?? "").localeCompare(String(existing.sent ?? "")) > 0
    ) {
      byId.set(alert.identifier, alert);
    }
  }
  return [...byId.values()]
    .sort((a, b) => String(b.sent ?? "").localeCompare(String(a.sent ?? "")))
    .slice(0, KEEP_CAP_ALERTS);
}

/**
 * Cache path under the plugin data directory.
 *
 * @param {string} dataDir
 * @returns {string}
 */
function capCachePath(dataDir) {
  return join(dataDir, "weather", "cap-alerts.json");
}

/**
 * Loads the CAP alert cache. Missing or corrupt file → empty cache.
 *
 * @param {string} dataDir
 * @returns {Promise<Array<object>>}
 */
async function loadCapAlerts(dataDir) {
  try {
    const raw = JSON.parse(await readFile(capCachePath(dataDir), "utf8"));
    return Array.isArray(raw.events) ? raw.events : [];
  } catch {
    return [];
  }
}

/**
 * Persists the CAP alert cache.
 *
 * @param {string} dataDir
 * @param {Array<object>} events
 * @returns {Promise<void>}
 */
async function saveCapAlerts(dataDir, events) {
  await mkdir(join(dataDir, "weather"), { recursive: true });
  await writeFile(
    capCachePath(dataDir),
    `${JSON.stringify({ events }, null, 2)}\n`,
  );
}

/**
 * Fetches every configured CAP feed and merges the results into the
 * cache. Two feed shapes are handled: a direct CAP document (root
 * `<alert>`) and an RSS item list whose links point at CAP documents
 * (FAH aggregation — the newest {@link FOLLOW_RSS_ITEMS} items are
 * followed). Per-feed failures skip that feed; per-document failures
 * skip that alert.
 *
 * @param {object} params
 * @param {string} params.dataDir
 * @param {string[]} params.urls - CAP feed URLs
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{fetched: string[], failed: string[], events:
 *   Array<object>}>}
 */
async function refreshCapAlerts({
  dataDir,
  urls,
  fetchImpl = fetch,
  timeoutMs = 15000,
}) {
  const cached = await loadCapAlerts(dataDir);
  const fetched = [];
  const failed = [];
  const incoming = [];
  const grab = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        return null;
      }
      return await response.text();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  for (const url of urls ?? []) {
    const text = await grab(url);
    if (text == null) {
      failed.push(url);
      continue;
    }
    const trimmed = text.trim();
    if (trimmed.startsWith("<")) {
      const root = trimmed.match(/^<\?xml[^>]*\?>\s*<(\w+)/);
      const rootTag = root ? root[1] : "";
      if (rootTag === "alert") {
        const parsed = parseCapAlert(trimmed, { sourceUrl: url, raw: trimmed });
        if (parsed) {
          incoming.push(parsed);
          fetched.push(url);
          continue;
        }
        failed.push(url);
        continue;
      }
      if (rootTag === "rss" || rootTag === "feed") {
        // FAH-style aggregation: follow the newest item links
        const items = parseCapFeedItems(trimmed).slice(0, FOLLOW_RSS_ITEMS);
        let followed = 0;
        for (const item of items) {
          const doc = await grab(item.link);
          if (doc == null) {
            continue;
          }
          const parsed = parseCapAlert(doc, { sourceUrl: url, raw: doc });
          if (parsed) {
            incoming.push(parsed);
            followed++;
          }
        }
        fetched.push(url);
        if (followed === 0) {
          // The feed answered but nothing parsed: still a fetched URL
        }
        continue;
      }
    }
    failed.push(url);
  }
  const events = mergeCapAlerts(cached, incoming);
  await saveCapAlerts(dataDir, events);
  return { fetched, failed, events };
}

/**
 * Filters cached alerts down to what the briefing surfaces (work doc
 * #24): severity at or above the configured minimum, not expired
 * (deterministic — `<expires>` is a hard gate), and geographically
 * relevant — the alert's native geometry must intersect the vessel's
 * track. Geometry-less alerts cannot be placed and are dropped.
 *
 * @param {object} params
 * @param {Array<object>} params.events - Cached CAP alerts
 * @param {number[][]} params.track - Track points [[lon, lat], …]
 * @param {string} [params.minSeverity] - "Minor"|"Moderate"|"Severe"|
 *   "Extreme" (case-insensitive)
 * @param {Date} [params.now]
 * @returns {Array<object>} Surviving alerts, newest first
 */
function filterCapAlerts({
  events,
  track,
  minSeverity = "Severe",
  now = new Date(),
}) {
  const minRank = SEVERITY_RANK[String(minSeverity).toLowerCase()] ?? 2;
  const nowMs = now.getTime();
  const surviving = [];
  for (const alert of events ?? []) {
    const rank = SEVERITY_RANK[String(alert.severity ?? "").toLowerCase()];
    if (rank == null || rank < minRank) {
      continue;
    }
    if (alert.expires) {
      const expires = new Date(alert.expires).getTime();
      if (Number.isFinite(expires) && expires < nowMs) {
        continue;
      }
    }
    if (!alert.geometry || !intersectsTrack(alert.geometry, track)) {
      continue;
    }
    surviving.push(alert);
  }
  return surviving.sort((a, b) =>
    String(b.sent ?? "").localeCompare(String(a.sent ?? "")),
  );
}

module.exports = {
  CAP_DEFAULT_URL,
  KEEP_CAP_ALERTS,
  SEVERITY_RANK,
  FOLLOW_RSS_ITEMS,
  pickInfoBlock,
  circleToPolygon,
  capPolygonToRing,
  infoGeometry,
  parseCapAlert,
  parseCapFeedItems,
  mergeCapAlerts,
  capCachePath,
  loadCapAlerts,
  saveCapAlerts,
  refreshCapAlerts,
  filterCapAlerts,
};
