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
 * @param {object} geometry - block geometry (bbox or polygon/line)
 * @returns {{latitude: number, longitude: number}|null}
 */
function geometryPosition(geometry, ref) {
  if (!geometry) {
    return null;
  }
  /** Normalizes a longitude to (-180, 180]. */
  const normalizeLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

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

function noteCategory(block) {
  if (block.subject === "A" || block.source === "ukho") {
    return "navigation-warning";
  }
  return "meteorological-warning";
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
 * then prunes notes whose blocks dropped out of the filtered set.
 *
 * @param {object} params
 * @param {NotesStore} params.store - the metarea notes store
 * @param {object|null} params.bulletin - metareaBulletin with blocks
 * @param {string|null} [params.bulletin.issuer] - issuing authority
 *   parsed from the bulletin text (extractIssuer)
 * @param {number|null} params.zone - resolved zone for chart links
 * @param {(zone: number) => {url: string, mimeType: string}|null}
 *   [params.synopticChartFor] - cached chart lookup (work doc #11)
 * @param {number[]} [params.ref] - vessel position [lon, lat] for
 *   nearest-point note placement
 * @returns {Promise<{published: string[], pruned: string[]}>}
 */
async function publishNotes({
  store,
  bulletin,
  zone = null,
  synopticChartFor = () => null,
  ref = null,
}) {
  if (!store || !bulletin) {
    return { published: [], pruned: [] };
  }
  const published = [];
  const kept = [];
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
    await store.set(id, note);
    kept.push(id);
    published.push(id);
  }
  await store.prune(kept);
  return { published, pruned: [] };
}

/** Clears the metarea notes store (publication disabled). */
async function clearNotes(store) {
  await store.clear();
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
  const all = await store.list();
  const pruned = [];
  for (const id of Object.keys(all)) {
    if (id.startsWith("hazard-") && !kept.has(id)) {
      await store.delete(id);
      pruned.push(id);
    }
  }
  return { published, pruned };
}

module.exports = {
  noteTitle,
  geometryPosition,
  noteId,
  buildNote,
  publishNotes,
  clearNotes,
  buildHazardNote,
  publishHazardNotes,
};
