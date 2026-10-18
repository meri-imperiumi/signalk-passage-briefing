/**
 * METAREA warnings as Signal K Notes (work doc #12): after each
 * bulletin filter pass, every surviving placeable block is published
 * as a georeferenced `resources/notes` entry, turning the bulletin
 * pipeline into a server-wide warning feed for chart plotters.
 *
 * Publishing is local to the Signal K server and deliberately NOT
 * internet-gated — radio-spool ingest publishes exactly like the
 * online fetch path. Blocks without extractable geometry are
 * skipped: a note that cannot be placed is a note on the wrong spot
 * of the chart.
 *
 * Lifecycle: note ids are content-addressed (block text + issuedAt),
 * so re-publishing updates in place; blocks that drop out of the
 * filtered set have their notes deleted — stale warnings on a chart
 * are dangerous, expiry is part of the feature.
 *
 * @file notes-publisher.js
 */

const { createHash } = require("node:crypto");

/**
 * Converts a block's extracted geometry to a region-feature geometry
 * (work doc #48): bbox becomes a four-corner ring; a parsed polygon
 * rides as-is (raw coordinates, the same ones the briefing map
 * normalizes client-side); a seam-crossing bbox splits into a
 * MultiPolygon of two spec-clean halves. Point and line geometry
 * cannot become regions (the region schema accepts polygons only):
 * the note alone carries those.
 *
 * @param {object} geometry - block geometry (bbox or polygon)
 * @returns {{type: string, coordinates: any}|null}
 */
function geometryToRegionGeometry(geometry) {
  if (!geometry) {
    return null;
  }
  if (geometry.type === "bbox") {
    const [minLon, minLat, maxLon, maxLat] = geometry.coordinates;
    if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
      return null;
    }
    if (minLon <= maxLon) {
      return {
        type: "Polygon",
        coordinates: [
          [
            [minLon, minLat],
            [minLon, maxLat],
            [maxLon, maxLat],
            [maxLon, minLat],
            [minLon, minLat],
          ],
        ],
      };
    }
    // A west edge east of the east edge declares an antimeridian-
    // crossing area: two rectangles, one touching each side of the
    // seam, so every client draws the intended extent
    return {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [minLon, minLat],
            [minLon, maxLat],
            [180, maxLat],
            [180, minLat],
            [minLon, minLat],
          ],
        ],
        [
          [
            [-180, minLat],
            [-180, maxLat],
            [maxLon, maxLat],
            [maxLon, minLat],
            [-180, minLat],
          ],
        ],
      ],
    };
  }
  if (geometry.type === "polygon") {
    const ring = geometry.coordinates;
    if (!Array.isArray(ring) || ring.length < 3) {
      return null;
    }
    return { type: "Polygon", coordinates: ring };
  }
  return null;
}

const DEG = Math.PI / 180;

/**
 * Unfolds a polyline's longitudes sequentially into one continuous
 * frame, so a track across the antimeridian buffers as one band
 * instead of zig-zagging across the seam.
 *
 * @param {number[][]} points - [lon, lat] axis points
 * @returns {number[][]}
 */
function unfoldLine(points) {
  let prev = null;
  return (points ?? []).map(([lon, lat]) => {
    let value = lon;
    if (prev != null) {
      while (value - prev > 180) {
        value -= 360;
      }
      while (value - prev < -180) {
        value += 360;
      }
    }
    prev = value;
    return [value, lat];
  });
}

/**
 * Expands a corridor band (the `WITHIN 120 NAUTICAL MILES OF T1`
 * axis band) into a closed ring around a polyline — the same
 * algorithm as `corridorRing` in public/components/map-model.mjs,
 * which draws the identical shape on the briefing map (parity is
 * asserted in the tests). Offset legs are rectangular — a coarse but
 * honest approximation for a band the engine itself tests as a
 * padded bbox.
 *
 * @param {Array<[number, number]>} points - Unwrapped axis points
 * @param {number} bufferNm - Band half-width in nautical miles
 * @returns {Array<[number, number]>} Closed ring (lon/lat)
 */
function corridorRing(points, bufferNm) {
  const latPad = bufferNm / 60;
  const meanLat =
    (points.reduce((sum, [, lat]) => sum + lat, 0) / points.length) * DEG;
  const lonPad = latPad / Math.max(0.2, Math.cos(meanLat));
  const ring = [
    ...points.map(([lon, lat]) => [lon + lonPad, lat + latPad]),
    ...[...points].reverse().map(([lon, lat]) => [lon - lonPad, lat - latPad]),
  ];
  ring.push([...ring[0]]);
  return ring;
}

/**
 * The region geometry for one bulletin block — the same shape set
 * the briefing map draws (work doc #47): bbox rectangles, parsed
 * polygons, axis bands expanded into corridor rings, and advisory
 * storms as the MultiPolygon of their present wind/seas quadrant
 * rings. Line axes without a stated band and text-only storm
 * declarations have no area on the map either: the note alone
 * carries those.
 *
 * @param {object} block - bulletin block
 * @returns {{type: string, coordinates: any, derived: string}|null}
 *   `derived` names what the region geometry was built from
 */
function blockToRegionGeometry(block) {
  const geometry = block?.geometry;
  if (!geometry) {
    return null;
  }
  // Advisory storm: the present quadrant rings are the warning
  // area — the forecast track is points, not area, and publishing
  // forecast rings would go stale between bulletins
  const rings = (block?.storm?.fields ?? [])
    .filter(
      (field) =>
        field?.geometry?.type === "polygon" &&
        Array.isArray(field.geometry.coordinates) &&
        field.geometry.coordinates.length >= 3,
    )
    .map((field) => field.geometry.coordinates);
  if (block?.storm) {
    if (rings.length === 0) {
      return null;
    }
    return {
      type: "MultiPolygon",
      coordinates: rings.map((ring) => [ring]),
      derived: "quadrant-rings",
    };
  }
  if (geometry.type === "line" && geometry.bufferNm > 0) {
    const points = unfoldLine(geometry.coordinates ?? []);
    if (points.length < 2) {
      return null;
    }
    return {
      type: "Polygon",
      coordinates: [corridorRing(points, geometry.bufferNm)],
      derived: "corridor",
    };
  }
  const mapped = geometryToRegionGeometry(geometry);
  return mapped ? { ...mapped, derived: "extracted" } : null;
}

/**
 * Derives a short note title: the first sentence of the block (the
 * GMDSS anchor usually is one), truncated on a word boundary.
 *
 * @param {string} text
 * @returns {string}
 */
function noteTitle(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentence = flat.split(/(?<=\.)\s/, 1)[0] ?? flat;
  const firstLine = text.split(/\r?\n/, 1)[0].replace(/\s+/g, " ").trim();
  const base = sentence.length >= 8 ? sentence : firstLine || flat;
  if (base.length <= 48) {
    return base.replace(/\.$/, "");
  }
  const cut = base.slice(0, 48);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

/**
 * A representative position for extracted geometry, antimeridian-
 * safe: longitudes are unfolded relative to the first coordinate
 * before averaging, then normalized back.
 *
 * @param {object} geometry - block geometry (bbox, point, or
 *   polygon/line)
 * @returns {{latitude: number, longitude: number}|null}
 */
function geometryPosition(geometry, ref) {
  if (!geometry) {
    return null;
  }
  /** Normalizes a longitude to (-180, 180]. */
  const normalizeLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

  // A named-system declaration plots at the analysed position itself:
  // the note belongs on the storm centre, not an averaged ring
  if (geometry.type === "point") {
    const [lon, lat] = geometry.coordinates;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return null;
    }
    return { latitude: lat, longitude: normalizeLon(lon) };
  }

  if (geometry.type === "bbox") {
    const [minLon, minLat, maxLon, maxLat] = geometry.coordinates;
    let lat = (minLat + maxLat) / 2;
    let lon = (minLon + maxLon) / 2;
    if (ref && Number.isFinite(ref[0]) && Number.isFinite(ref[1])) {
      // Quadrant nearest the vessel: wide warning areas span oceans,
      // and their center can be a thousand miles from the crew. Halve
      // each axis toward the vessel and place the note at that
      // quadrant's center — regional, never on top of the boat.
      const midLat = (minLat + maxLat) / 2;
      const midLon = (minLon + maxLon) / 2;
      lat = ref[1] <= midLat ? (minLat + midLat) / 2 : (midLat + maxLat) / 2;
      lon = ref[0] <= midLon ? (minLon + midLon) / 2 : (midLon + maxLon) / 2;
    }
    return {
      latitude: Math.round(lat * 1e4) / 1e4,
      longitude: Math.round(normalizeLon(lon) * 1e4) / 1e4,
    };
  }

  const points = geometry.coordinates ?? [];
  if (points.length === 0) {
    return null;
  }
  if (ref && Number.isFinite(ref[0])) {
    // Nearest vertex to the vessel, comparing across the seam
    let best = null;
    let bestDistance = Infinity;
    for (const [lon, lat] of points) {
      for (const shift of [0, 360, -360]) {
        const d = (lon + shift - ref[0]) ** 2 + (lat - ref[1]) ** 2;
        if (d < bestDistance) {
          bestDistance = d;
          best = { longitude: normalizeLon(lon + shift), latitude: lat };
        }
      }
    }
    if (best) {
      return {
        latitude: Math.round(best.latitude * 1e4) / 1e4,
        longitude: Math.round(best.longitude * 1e4) / 1e4,
      };
    }
  }

  let prev = null;
  let lonSum = 0;
  let latSum = 0;
  let count = 0;
  for (const [lon, lat] of points) {
    let value = lon;
    if (prev != null) {
      while (value - prev > 180) {
        value -= 360;
      }
      while (value - prev < -180) {
        value += 360;
      }
    }
    lonSum += value;
    latSum += lat;
    count++;
    prev = value;
  }
  return {
    latitude: Math.round((latSum / count) * 1e4) / 1e4,
    longitude: Math.round(normalizeLon(lonSum / count) * 1e4) / 1e4,
  };
}

function noteId(text, issuedAt) {
  const hash = createHash("sha1").update(`${text}|${issuedAt}`).digest("hex");
  return `metarea-${hash.slice(0, 12)}`;
}

/**
 * The paired region's id: the note's hash base under an `area` arm,
 * so a note and its shape are recognizably the same warning.
 *
 * @param {string} text
 * @param {string} issuedAt
 * @returns {string}
 */
function regionId(text, issuedAt) {
  const hash = createHash("sha1").update(`${text}|${issuedAt}`).digest("hex");
  return `metarea-area-${hash.slice(0, 12)}`;
}

function noteCategory(block) {
  if (block.subject === "A" || block.source === "ukho") {
    return "navigation-warning";
  }
  return "meteorological-warning";
}

function regionProperties(block, { issuedAt, issuer, zone }) {
  return {
    category: noteCategory(block),
    subject: block.subject ?? null,
    geometryType: block.geometryType ?? null,
    source: block.source ?? null,
    zone,
    sourcePlugin: "signalk-passage-briefing",
    // Provenance (who published, when): the issuing authority parsed
    // from the bulletin header when it names its service, else the
    // plugin publishing on its own account — plus the bulletin's
    // issue time, which is when the warning came into being.
    publishedBy: issuer ?? "signalk-passage-briefing",
    publishedAt: issuedAt,
  };
}

/**
 * Builds one Signal K region for a shaped warning block (work doc
 * #48): the same shape set the briefing map draws — the full parsed
 * area as a native Polygon feature (the note's quadrant-center
 * position is a placement aid, the region is the actual extent),
 * axis bands as corridor rings, advisory storms as their present
 * quadrant rings. Schema-conservative: name, description and the
 * feature only; there is no timestamp or url field in the region
 * schema, so provenance rides feature.properties.
 *
 * @param {object} block - bulletin block with geometry
 * @param {object} params
 * @returns {object|null} Region, null when the geometry has no extent
 */
function buildRegion(block, { issuedAt, issuer = null, zone }) {
  const geometry = blockToRegionGeometry(block);
  if (!geometry) {
    return null;
  }
  const { derived, ...featureGeometry } = geometry;
  return {
    name: noteTitle(block.text),
    description: block.text,
    feature: {
      geometry: featureGeometry,
      properties: {
        ...regionProperties(block, { issuedAt, issuer, zone }),
        // Honesty marker: what the region geometry was derived from
        // (the extracted area itself, a corridor around an axis band,
        // or the advisory's present quadrant rings)
        derived,
      },
    },
  };
}

function buildNote(block, { issuedAt, issuer = null, zone, chart, ref }) {
  const position = geometryPosition(block.geometry, ref);
  if (!position) {
    return null;
  }
  // Schema-conservative note: only fields the resources/notes schema
  // knows (title, description, position, url, mimeType, properties,
  // timestamp). Provenance rides inside properties — a rejected note
  // publishes nothing, and unknown top-level fields are the classic
  // rejection cause.
  const note = {
    title: noteTitle(block.text),
    description: block.text,
    position,
    properties: {
      category: noteCategory(block),
      subject: block.subject ?? null,
      geometryType: block.geometryType ?? null,
      source: block.source ?? null,
      zone,
      sourcePlugin: "signalk-passage-briefing",
      // Provenance (who published, when): the issuing authority parsed
      // from the bulletin header when it names its service, else the
      // plugin publishing on its own account — plus the bulletin's
      // issue time, which is when the warning came into being (the
      // top-level timestamp carries the same instant).
      publishedBy: issuer ?? "signalk-passage-briefing",
      publishedAt: issuedAt,
    },
    timestamp: issuedAt,
  };
  if (chart) {
    note.url = chart.url;
    note.mimeType = chart.mimeType;
  }
  return note;
}

/**
 * Publishes one bulletin's placeable blocks as notes into the store,
 * each shaped block also as a paired region (work doc #48), then
 * prunes this feed's stale entries. Note ids are content-addressed
 * (block text + issuedAt), so re-publishing updates in place; blocks
 * that drop out of the filtered set have their notes and regions
 * deleted — stale warnings on a chart are dangerous, expiry is part
 * of the feature.
 *
 * @param {object} params
 * @param {NotesStore} params.store - the metarea notes store
 * @param {RegionsStore|null} [params.regionsStore] - the regions
 *   store; omitted (or a server without the regions registry) keeps
 *   the notes point-only
 * @param {object|null} params.bulletin - metareaBulletin with blocks
 * @param {string|null} [params.bulletin.issuer] - issuing authority
 *   parsed from the bulletin text (extractIssuer)
 * @param {number|null} params.zone - resolved zone for chart links
 * @param {(zone: number) => {url: string, mimeType: string}|null}
 *   [params.synopticChartFor] - cached chart lookup (work doc #11)
 * @param {number[]} [params.ref] - vessel position [lon, lat] for
 *   nearest-point note placement
 * @returns {Promise<{published: string[], pruned: string[],
 *   regionsPublished: string[], regionsPruned: string[]}>}
 */
async function publishNotes({
  store,
  regionsStore = null,
  bulletin,
  zone = null,
  synopticChartFor = () => null,
  ref = null,
}) {
  if (!store || !bulletin) {
    return {
      published: [],
      pruned: [],
      regionsPublished: [],
      regionsPruned: [],
    };
  }
  const published = [];
  const kept = [];
  const regionsPublished = [];
  const regionsKept = [];
  for (const block of bulletin.blocks ?? []) {
    const chart = zone != null ? synopticChartFor(zone) : null;
    const note = buildNote(block, {
      issuedAt: bulletin.issuedAt,
      issuer: bulletin.issuer ?? null,
      zone,
      chart,
      ref,
    });
    if (!note) {
      continue;
    }
    const id = noteId(block.text, bulletin.issuedAt);
    const region =
      regionsStore &&
      buildRegion(block, {
        issuedAt: bulletin.issuedAt,
        issuer: bulletin.issuer ?? null,
        zone,
      });
    if (region) {
      const rid = regionId(block.text, bulletin.issuedAt);
      await regionsStore.set(rid, region);
      regionsKept.push(rid);
      regionsPublished.push(rid);
      // The pairing the region panel lists: the note points at its
      // shape, the shape's detail carries the note
      note.href = `/resources/regions/${rid}`;
    }
    await store.set(id, note);
    kept.push(id);
    published.push(id);
  }
  // Scoped expiry: drop this feed's notes and regions that fell out
  // of the set — hazard, CAP and other-client entries are untouched
  const pruned = await prunedIds(store, kept, "metarea-");
  const regionsPruned = [];
  if (regionsStore) {
    regionsPruned.push(
      ...(await prunedIds(regionsStore, regionsKept, "metarea-area-")),
    );
  }
  return { published, pruned, regionsPublished, regionsPruned };
}

/** Applies a scoped prune and reports which ids it dropped. */
async function prunedIds(store, keepIds, prefix) {
  const before = new Set(Object.keys(await store.list()));
  await store.prune(keepIds, prefix);
  const after = new Set(Object.keys(await store.list()));
  const pruned = [];
  for (const id of before) {
    if (!after.has(id)) {
      pruned.push(id);
    }
  }
  return pruned;
}

/** Clears the metarea notes store (publication disabled). */
async function clearNotes(store) {
  if (store) {
    await store.clear();
  }
}

/** Clears the regions store (publication disabled). */
async function clearRegions(store) {
  if (store) {
    await store.clear();
  }
}

/**
 * Builds one Signal K note for a GDACS hazard event (work doc #22):
 * schema-conservative like the METAREA notes — position, description,
 * provenance in properties, event page as the url.
 *
 * @param {object} event - Filtered hazard event
 * @returns {object} Note (id derived separately)
 */
function buildHazardNote(event) {
  const title = String(event.title ?? "Hazard event").trim() || "Hazard event";
  return {
    title:
      title.length > 48
        ? `${title.slice(0, title.lastIndexOf(" ", 48))}…`
        : title,
    description: event.description ?? title,
    position: {
      latitude: Math.round(event.lat * 1e4) / 1e4,
      longitude: Math.round(event.lon * 1e4) / 1e4,
    },
    url: event.link ?? undefined,
    properties: {
      category: "hazard-event",
      eventType: event.type ?? null,
      alertLevel: event.alertLevel ?? null,
      source: "gdacs",
      sourcePlugin: "signalk-passage-briefing",
      publishedBy: "GDACS",
      publishedAt: event.timestamp ?? null,
    },
    timestamp: event.timestamp ?? null,
  };
}

/**
 * Publishes filtered hazard events as notes, then prunes stale ones.
 * Note ids are content-addressed on the GDACS event id, so a repoll
 * updates in place; the prune touches only `hazard-` prefixed ids —
 * the METAREA pass and notes written by other clients are untouched.
 *
 * @param {object} params
 * @param {NotesStore} params.store - the shared notes store
 * @param {Array<object>} params.events - Filtered hazard events
 * @returns {Promise<{published: string[], pruned: string[]}>}
 */
async function publishHazardNotes({ store, events }) {
  if (!store) {
    return { published: [], pruned: [] };
  }
  const published = [];
  const kept = new Set();
  for (const event of events ?? []) {
    if (!Number.isFinite(event?.lat) || !Number.isFinite(event?.lon)) {
      continue; // A note that cannot be placed is on the wrong spot
    }
    const id = `hazard-${createHash("sha1")
      .update(String(event.id))
      .digest("hex")
      .slice(0, 12)}`;
    await store.set(id, buildHazardNote(event));
    kept.add(id);
    published.push(id);
  }
  // Scoped expiry: drop this feed's notes that fell out of the set
  const pruned = await prunedIds(store, [...kept], "hazard-");
  return { published, pruned };
}

/**
 * Builds one Signal K note for a CAP alert (work doc #24). The note
 * schema is title/description/url/properties + a position — the
 * centroid places the note on the chart while the native polygon
 * rides the paired region (work doc #48), linked via href.
 *
 * @param {object} alert - Filtered CAP alert
 * @returns {object|null} Note, null when the geometry cannot place it
 */
function buildCapAlertNote(alert) {
  if (!alert?.geometry) {
    return null;
  }
  const position = geometryPosition(alert.geometry);
  if (!position) {
    return null;
  }
  const headline = alert.headline || alert.event || "Official alert";
  const title =
    headline.length > 48 ? `${headline.slice(0, 48).trimEnd()}…` : headline;
  const description = [
    alert.description,
    alert.instruction ? `INSTRUCTION: ${alert.instruction}` : null,
    `Effective: ${alert.effective ?? alert.sent ?? "?"}`,
    alert.expires ? `Expires: ${alert.expires}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  const note = {
    title,
    description,
    position,
    ...(alert.web ? { url: alert.web } : {}),
    properties: {
      category: "cap-alert",
      eventType: alert.event ?? null,
      severity: alert.severity ?? null,
      urgency: alert.urgency ?? null,
      certainty: alert.certainty ?? null,
      source: "cap",
      sourcePlugin: "signalk-passage-briefing",
      publishedBy: alert.senderName ?? "CAP",
      publishedAt: alert.sent ?? null,
    },
    timestamp: alert.sent ?? null,
  };
  return note;
}

/**
 * Builds one Signal K region for a CAP alert (work doc #48): the
 * native CAP polygon as the region feature — the note keeps its
 * centroid anchor and url, the region shows the full extent.
 *
 * @param {object} alert - Filtered CAP alert
 * @returns {object|null} Region, null when the geometry has no extent
 */
function buildCapAlertRegion(alert) {
  if (!alert?.geometry) {
    return null;
  }
  const geometry = geometryToRegionGeometry(alert.geometry);
  if (!geometry) {
    return null;
  }
  const headline = alert.headline || alert.event || "Official alert";
  return {
    name:
      headline.length > 48 ? `${headline.slice(0, 48).trimEnd()}…` : headline,
    description: [
      alert.description,
      alert.instruction ? `INSTRUCTION: ${alert.instruction}` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
    feature: {
      geometry,
      properties: {
        category: "cap-alert",
        eventType: alert.event ?? null,
        severity: alert.severity ?? null,
        urgency: alert.urgency ?? null,
        certainty: alert.certainty ?? null,
        source: "cap",
        sourcePlugin: "signalk-passage-briefing",
        publishedBy: alert.senderName ?? "CAP",
        publishedAt: alert.sent ?? null,
        areaDesc: alert.areaDesc ?? null,
      },
    },
  };
}

/**
 * Publishes filtered CAP alerts as notes (work doc #24) and, for the
 * shaped ones, paired regions (work doc #48): ids are content-
 * addressed on the CAP identifier+sent (repolls update in place), and
 * the prune touches only `cap-` prefixed ids — the METAREA, hazard
 * and other-client entries are untouched.
 *
 * @param {object} params
 * @param {NotesStore} params.store
 * @param {RegionsStore|null} [params.regionsStore]
 * @param {Array<object>} params.alerts - Filtered CAP alerts
 * @returns {Promise<{published: string[], pruned: string[],
 *   regionsPublished: string[], regionsPruned: string[]}>}
 */
async function publishCapAlertNotes({ store, regionsStore = null, alerts }) {
  if (!store) {
    return {
      published: [],
      pruned: [],
      regionsPublished: [],
      regionsPruned: [],
    };
  }
  const published = [];
  const kept = [];
  const regionsPublished = [];
  const regionsKept = [];
  for (const alert of alerts ?? []) {
    if (!alert?.geometry) {
      continue; // A note that cannot be placed is on the wrong spot
    }
    const hash = createHash("sha1")
      .update(String(alert.identifier))
      .digest("hex")
      .slice(0, 12);
    const id = `cap-${hash}`;
    const note = buildCapAlertNote(alert);
    if (!note) {
      continue;
    }
    const region = regionsStore && buildCapAlertRegion(alert);
    if (region) {
      const rid = `cap-area-${hash}`;
      await regionsStore.set(rid, region);
      regionsKept.push(rid);
      regionsPublished.push(rid);
      // The pairing the region panel lists: the note points at its
      // shape, the shape's detail carries the note
      note.href = `/resources/regions/${rid}`;
    }
    await store.set(id, note);
    kept.push(id);
    published.push(id);
  }
  const pruned = await prunedIds(store, kept, "cap-");
  const regionsPruned = [];
  if (regionsStore) {
    regionsPruned.push(
      ...(await prunedIds(regionsStore, regionsKept, "cap-area-")),
    );
  }
  return { published, pruned, regionsPublished, regionsPruned };
}

module.exports = {
  noteTitle,
  geometryPosition,
  geometryToRegionGeometry,
  blockToRegionGeometry,
  corridorRing,
  noteId,
  regionId,
  buildNote,
  buildRegion,
  publishNotes,
  clearNotes,
  clearRegions,
  buildHazardNote,
  publishHazardNotes,
  buildCapAlertNote,
  buildCapAlertRegion,
  publishCapAlertNotes,
};
