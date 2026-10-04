/**
 * The server's notes resource store + provider (work doc #12): the
 * plugin registers as the `notes` resource provider, so warnings
 * published by the bulletin pipeline AND notes written by other
 * clients (DR note panel, Freeboard) all live in one durable store
 * served to resources/notes queries.
 *
 * Query contract (SK v2 resources API — the provider decides what a
 * query returns): distance in meters from a position, a bbox as
 * [swLon, swLat, neLon, neLat], an optional limit. Zoom is accepted
 * but not filtered — a handful of warnings is always worth showing.
 *
 * @file notes-store.js
 */

const { readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");

const EARTH_RADIUS_M = 6371000;

/** Great-circle distance in meters (flat-nav precision is fine). */
function distanceMeters(position, ref) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(position.latitude - ref.latitude);
  const dLon = toRad(position.longitude - ref.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(ref.latitude)) *
      Math.cos(toRad(position.latitude)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Parses a query position: [lon, lat] array or {latitude, longitude}. */
function parsePosition(position) {
  if (Array.isArray(position) && position.length >= 2) {
    return { longitude: Number(position[0]), latitude: Number(position[1]) };
  }
  if (position && typeof position === "object") {
    const { latitude, longitude } = position;
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return { latitude, longitude };
    }
  }
  return null;
}

/**
 * Applies resources/notes query parameters to one note.
 *
 * @param {object} note
 * @param {object} params - position/distance/bbox/zoom/limit
 * @returns {boolean} whether the note matches
 */
function matchesQuery(note, params) {
  if (params.distance != null || params.position != null) {
    const ref = parsePosition(params.position);
    if (!ref || !note.position) {
      return false; // A placement-less note matches no near-me query
    }
    const d = distanceMeters(note.position, ref);
    if (params.distance != null && d > Number(params.distance)) {
      return false;
    }
  }
  if (params.bbox != null) {
    const [swLon, swLat, neLon, neLat] = params.bbox;
    const { latitude, longitude } = note.position ?? {};
    // A west edge east of the east edge declares an
    // antimeridian-crossing box: match either side of the seam
    const lonInBox =
      swLon <= neLon
        ? longitude >= swLon && longitude <= neLon
        : longitude <= neLon || longitude >= swLon;
    if (
      latitude == null ||
      longitude == null ||
      !lonInBox ||
      latitude < swLat ||
      latitude > neLat
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The durable notes store backing the provider. Everything lives in
 * one JSON file — note counts are small (tens), writes happen a few
 * times a day, and a single file survives restarts and stays
 * user-inspectable.
 */
class NotesStore {
  constructor(dataDir) {
    this.path = join(dataDir, "resources-notes.json");
    this.notes = {};
    this.loaded = false;
  }

  async load() {
    if (this.loaded) {
      return;
    }
    try {
      this.notes = JSON.parse(await readFile(this.path, "utf8"));
    } catch {
      this.notes = {};
    }
    this.loaded = true;
  }

  async save() {
    await writeFile(this.path, JSON.stringify(this.notes, null, 2));
  }

  async list(params = {}) {
    await this.load();
    const matching = {};
    for (const [id, note] of Object.entries(this.notes)) {
      if (matchesQuery(note, params)) {
        matching[id] = note;
      }
    }
    if (params.limit != null) {
      const capped = {};
      for (const id of Object.keys(matching).slice(0, Number(params.limit))) {
        capped[id] = matching[id];
      }
      return capped;
    }
    return matching;
  }

  async get(id) {
    await this.load();
    return this.notes[id] ?? null;
  }

  async set(id, note) {
    await this.load();
    this.notes[id] = note;
    await this.save();
  }

  async delete(id) {
    await this.load();
    delete this.notes[id];
    await this.save();
  }

  /** Keeps only the given ids (publisher expiry: warnings that
   * dropped out of the filtered set leave the store). */
  async prune(keepIds) {
    await this.load();
    const keep = new Set(keepIds);
    for (const id of Object.keys(this.notes)) {
      if (!keep.has(id)) {
        delete this.notes[id];
      }
    }
    await this.save();
  }

  async clear() {
    await this.load();
    this.notes = {};
    await this.save();
  }
}

/**
 * Creates a NotesStore rooted in the plugin data dir.
 *
 * @param {string} dataDir
 * @returns {NotesStore}
 */
function createNotesStore(dataDir) {
  return new NotesStore(dataDir);
}

/**
 * Registers the plugin as the `notes` resource provider backed by
 * the store. Skips silently on servers without the provider
 * registry. Registration is idempotent per app (the server has no
 * unregister; stop/start flips the running flag instead of stacking
 * providers).
 *
 * @param {object} app - Signal K server API
 * @param {object} params
 * @param {NotesStore} params.store
 * @param {string} params.id - plugin id
 * @returns {() => void} teardown — empties the served listing
 */
function registerNotesProvider(app, { store, id }) {
  if (typeof app.registerResourceProvider !== "function") {
    app.debug?.(
      "Server has no resource provider registry: notes serving disabled",
    );
    return () => {};
  }
  let running = true;
  app.registerResourceProvider({
    type: "notes",
    methods: {
      listResources: async (params = {}) => {
        if (!running) {
          return {};
        }
        return store.list(params ?? {});
      },
      getResource: async (resourceId) => {
        const note = await store.get(resourceId);
        if (!note) {
          throw new Error(`No such note: ${resourceId}`);
        }
        return note;
      },
      // Read-only by design: this provider serves the metarea
      // warnings the bulletin pipeline publishes. Other clients'
      // note writes belong to their own future providers.
      setResource: async (resourceId) => {
        throw new Error(
          `${id} notes are pipeline-fed and read-only (${resourceId})`,
        );
      },
      deleteResource: async (resourceId) => {
        throw new Error(
          `${id} notes are pipeline-fed and read-only (${resourceId})`,
        );
      },
    },
  });
  return () => {
    running = false;
  };
}

module.exports = {
  NotesStore,
  createNotesStore,
  distanceMeters,
  matchesQuery,
  parsePosition,
  registerNotesProvider,
};
