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
const { readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");

const MANIFEST_FILE = "notes-manifest.json";

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
    let lon = minLon + (maxLon - minLon) / 2;
    let lat = (minLat + maxLat) / 2;
    if (ref && Number.isFinite(ref[0]) && Number.isFinite(ref[1])) {
      // Clamp the vessel position into the box: inside the area the
      // note lands on the crew, outside it lands at the nearest edge
      let clamped = null;
      for (const shift of [0, 360, -360]) {
        const candidate = ref[0] + shift;
        if (candidate >= minLon && candidate <= maxLon) {
          clamped = candidate;
          break;
        }
      }
      if (clamped == null) {
        // Vessel outside the box entirely: nearest representation,
        // clamped to the nearest edge
        const mid = (minLon + maxLon) / 2;
        const nearest = [ref[0], ref[0] + 360, ref[0] - 360].sort(
          (a, b) => Math.abs(a - mid) - Math.abs(b - mid),
        )[0];
        clamped = Math.min(Math.max(nearest, minLon), maxLon);
      }
      lon = clamped;
      lat = Math.min(Math.max(ref[1], minLat), maxLat);
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

function buildNote(block, { issuedAt, zone, chart }) {
  const position = geometryPosition(block.geometry);
  if (!position) {
    return null;
  }
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
    },
    timestamp: issuedAt,
    $source: "signalk-passage-briefing",
  };
  if (chart) {
    note.url = chart.url;
    note.mimeType = chart.mimeType;
  }
  return note;
}

async function loadManifest(dataDir) {
  try {
    return JSON.parse(await readFile(join(dataDir, MANIFEST_FILE), "utf8"));
  } catch {
    return { owned: [] };
  }
}

async function saveManifest(dataDir, manifest) {
  await writeFile(
    join(dataDir, MANIFEST_FILE),
    JSON.stringify(manifest, null, 2),
  );
}

/**
 * Publishes one bulletin's placeable blocks as notes, then deletes
 * the plugin's own notes that dropped out of the filtered set.
 *
 * @param {object} params
 * @param {object} params.app - Signal K server API
 * @param {string} params.dataDir
 * @param {object|null} params.bulletin - metareaBulletin with blocks
 * @param {number|null} params.zone - resolved zone for chart links
 * @param {(zone: number) => {url: string, mimeType: string}|null}
 *   [params.synopticChartFor] - cached chart lookup (work doc #11)
 * @returns {Promise<{published: string[], deleted: string[]}>}
 */
async function publishNotes({
  app,
  dataDir,
  bulletin,
  zone = null,
  synopticChartFor = () => null,
}) {
  const resources = app.resourcesApi;
  if (
    !bulletin ||
    !resources ||
    typeof resources.setResource !== "function" ||
    typeof resources.deleteResource !== "function"
  ) {
    return { published: [], deleted: [] };
  }
  const manifest = await loadManifest(dataDir);
  const published = [];
  for (const block of bulletin.blocks ?? []) {
    const chart = zone != null ? synopticChartFor(zone) : null;
    const note = buildNote(block, {
      issuedAt: bulletin.issuedAt,
      zone,
      chart,
      ref: bulletin.ref ?? null,
    });
    if (!note) {
      continue;
    }
    const id = noteId(block.text, bulletin.issuedAt);
    try {
      await resources.setResource("notes", id, note);
    } catch {
      continue; // Server rejected the note: skip, never fail the refresh
    }
    if (!manifest.owned.includes(id)) {
      manifest.owned.push(id);
    }
    published.push(id);
  }
  // Expiry: notes the filtered set no longer carries are deleted —
  // stale warnings on a chart are dangerous
  const deleted = [];
  for (const id of manifest.owned) {
    if (!published.includes(id)) {
      try {
        await resources.deleteResource("notes", id);
        deleted.push(id);
      } catch {
        // Already gone server-side: drop it from the manifest
        deleted.push(id);
      }
    }
  }
  manifest.owned = manifest.owned.filter((id) => !deleted.includes(id));
  await saveManifest(dataDir, manifest);
  return { published, deleted };
}

/**
 * Start-time re-sync: crash recovery for deletions. Server-side notes
 * carrying this plugin's $source but absent from the manifest (a
 * crash between note write and manifest save) are removed.
 *
 * @param {object} params
 * @param {object} params.app
 * @param {string} params.dataDir
 * @returns {Promise<string[]>} ids removed during the sync
 */
async function resyncNotes({ app, dataDir }) {
  const resources = app.resourcesApi;
  if (
    !resources ||
    typeof resources.listResources !== "function" ||
    typeof resources.deleteResource !== "function"
  ) {
    return [];
  }
  const manifest = await loadManifest(dataDir);
  let all;
  try {
    all = await resources.listResources("notes");
  } catch {
    return [];
  }
  const removed = [];
  for (const [id, note] of Object.entries(all ?? {})) {
    if (
      note?.$source === "signalk-passage-briefing" &&
      !manifest.owned.includes(id)
    ) {
      try {
        await resources.deleteResource("notes", id);
        removed.push(id);
      } catch {
        // Server beat us to it
      }
    }
  }
  return removed;
}

/**
 * Disabling publication (config) clears the plugin's published notes
 * and empties the manifest.
 *
 * @param {object} params
 * @param {object} params.app
 * @param {string} params.dataDir
 * @returns {Promise<string[]>} ids removed
 */
async function clearNotes({ app, dataDir }) {
  const manifest = await loadManifest(dataDir);
  const removed = [];
  const resources = app.resourcesApi;
  if (resources && typeof resources.deleteResource === "function") {
    for (const id of manifest.owned) {
      try {
        await resources.deleteResource("notes", id);
        removed.push(id);
      } catch {
        // Already gone server-side
      }
    }
  }
  await saveManifest(dataDir, { owned: [] });
  return removed;
}

module.exports = {
  noteTitle,
  geometryPosition,
  noteId,
  buildNote,
  publishNotes,
  resyncNotes,
  clearNotes,
  MANIFEST_FILE,
};
