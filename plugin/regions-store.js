/**
 * The server's regions resource store + provider (work doc #48): the
 * plugin registers as a `regions` resource provider alongside the
 * server's built-in one — the resources API merges every registered
 * provider of a type, so user-created regions survive untouched.
 *
 * The store backs the warning shapes the bulletin pipeline publishes:
 * METAREA and CAP area geometry as native Polygon features, paired
 * with their point notes (same hash base, `*-area-` ids) so plotters
 * that render regions show the warning's true extent while the note
 * stays the anchored, queryable detail.
 *
 * Query contract (SK v2 resources API): a bbox as
 * [swLon, swLat, neLon, neLat] matches regions whose geometry bbox
 * intersects it; distance in meters from a position matches by the
 * distance to the geometry bbox (0 inside). A region has no position
 * of its own — the paired note is the queryable anchor.
 *
 * @file regions-store.js
 */

const { join } = require("node:path");
const { writeFileAtomic, readFileAtomic } = require("./fs-atomic.js");

const EARTH_RADIUS_M = 6371000;

/** Parses a query position: [lon, lat] array or {latitude, longitude}. */
function parsePosition(position) {
  if (Array.isArray(position) && position.length >= 2) {
    const longitude = Number(position[0]);
    const latitude = Number(position[1]);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return { longitude, latitude };
    }
    return null;
  }
  if (position && typeof position === "object") {
    const { latitude, longitude } = position;
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return { latitude, longitude };
    }
  }
  return null;
}

/** Normalizes a longitude to (-180, 180]. */
function normalizeLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * The [minLon, minLat, maxLon, maxLat] box of one ring of [lon, lat]
 * points, antimeridian-safe: longitudes are unfolded relative to the
 * first coordinate so a ring across the seam stays one continuous box.
 *
 * @param {number[][]} ring
 * @returns {number[]|null} bbox, null when the ring has no coordinates
 */
function ringBbox(ring) {
  if (!Array.isArray(ring) || ring.length === 0) {
    return null;
  }
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let prev = null;
  for (const point of ring) {
    // Malformed entries (a pre-fix publication could store a bare
    // point list where the ring nesting belongs) skip instead of
    // crashing the whole listing
    if (!Array.isArray(point) || point.length < 2) {
      continue;
    }
    const [lon, lat] = point;
    // Unfold each longitude against its predecessor so a ring across
    // the antimeridian spans one continuous frame
    let value = lon;
    if (prev != null) {
      while (value - prev > 180) {
        value -= 360;
      }
      while (value - prev < -180) {
        value += 360;
      }
    }
    if (value < minLon) {
      minLon = value;
    }
    if (value > maxLon) {
      maxLon = value;
    }
    if (lat < minLat) {
      minLat = lat;
    }
    if (lat > maxLat) {
      maxLat = lat;
    }
    prev = value;
  }
  return [normalizeLon(minLon), minLat, normalizeLon(maxLon), maxLat];
}

/** The geometry bbox of a published region: the union over every
 * polygon part (Polygon or MultiPolygon), null without geometry. */
function regionBbox(region) {
  const geometry = region?.feature?.geometry;
  const rings = [];
  if (geometry?.type === "Polygon") {
    rings.push(geometry.coordinates?.[0]);
  } else if (geometry?.type === "MultiPolygon") {
    for (const polygon of geometry.coordinates ?? []) {
      rings.push(polygon?.[0]);
    }
  }
  const boxes = rings
    .map(ringBbox)
    .filter((box) => box?.every(Number.isFinite));
  if (boxes.length === 0) {
    return null;
  }
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ];
}

/** Longitude distance from a west-east box edge pair, seam-aware. */
function lonDistance(lon, minLon, maxLon) {
  if (minLon <= maxLon) {
    if (lon >= minLon && lon <= maxLon) {
      return 0;
    }
    return Math.min(Math.abs(lon - minLon), Math.abs(lon - maxLon));
  }
  // A west edge east of the east edge declares an antimeridian-
  // crossing box: in-range on either side of the seam
  const inWest = lon >= minLon;
  const inEast = lon <= maxLon;
  if (inWest || inEast) {
    return 0;
  }
  return Math.min(
    Math.abs(lon - minLon),
    Math.abs(lon - maxLon),
    Math.abs(lon - (minLon - 360)),
    Math.abs(lon - (maxLon + 360)),
  );
}

/** Great-circle distance in meters (flat-nav precision is fine). */
function distanceMeters(dLatDeg, dLonDeg, refLat) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const a =
    Math.sin(toRad(dLatDeg) / 2) ** 2 +
    Math.cos(toRad(refLat)) *
      Math.cos(toRad(refLat)) *
      Math.sin(toRad(dLonDeg) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Distance from a position to a region: the distance to its geometry
 * bbox, 0 when the position is inside. Flat-nav degrees to meters is
 * fine at warning-area granularity.
 *
 * @param {object} region - published region resource
 * @param {{latitude: number, longitude: number}} ref
 * @returns {number|null} meters, null when the region has no geometry
 */
function regionDistanceMeters(region, ref) {
  const bbox = regionBbox(region);
  if (!bbox) {
    return null;
  }
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const dLon = lonDistance(ref.longitude, minLon, maxLon);
  let dLat = 0;
  if (ref.latitude < minLat) {
    dLat = minLat - ref.latitude;
  } else if (ref.latitude > maxLat) {
    dLat = ref.latitude - maxLat;
  }
  if (dLon === 0 && dLat === 0) {
    return 0;
  }
  // Latitude span drives the longitude meter conversion; an equator
  // approximation overstates by a factor the filter never notices
  return distanceMeters(
    dLat,
    dLon * Math.cos((Math.abs(ref.latitude) * Math.PI) / 180),
    ref.latitude,
  );
}

/**
 * A box's longitude span as raw intervals: a normal box is one span,
 * a seam-crossing box (west edge east of the east edge) is two — one
 * touching each side of the antimeridian.
 */
function lonSpans([minLon, , maxLon]) {
  if (minLon <= maxLon) {
    return [[minLon, maxLon]];
  }
  return [
    [minLon, 180],
    [-180, maxLon],
  ];
}

/**
 * Whether two [minLon, minLat, maxLon, maxLat] boxes intersect,
 * either side of the antimeridian (both may cross it).
 */
function bboxesIntersect(a, b) {
  if (!(a[1] <= b[3] && b[1] <= a[3])) {
    return false;
  }
  for (const aSpan of lonSpans(a)) {
    for (const bSpan of lonSpans(b)) {
      if (aSpan[0] <= bSpan[1] && bSpan[0] <= aSpan[1]) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Applies resources/regions query parameters to one region.
 *
 * @param {object} region
 * @param {object} params - position/distance/bbox/zoom/limit
 * @returns {boolean} whether the region matches
 */
function matchesQuery(region, params) {
  if (params.distance != null || params.position != null) {
    const ref = parsePosition(params.position);
    if (!ref) {
      return false;
    }
    const d = regionDistanceMeters(region, ref);
    // NaN distances (degenerate geometry) match nothing
    if (
      d == null ||
      !Number.isFinite(d) ||
      (params.distance != null && d > Number(params.distance))
    ) {
      return false;
    }
  }
  if (params.bbox != null) {
    const bbox = regionBbox(region);
    if (!bbox || !bboxesIntersect(bbox, params.bbox)) {
      return false;
    }
  }
  return true;
}

/**
 * The durable regions store backing the provider. One JSON file like
 * the notes store: region counts are small (tens), writes happen a
 * few times a day.
 */
class RegionsStore {
  constructor(dataDir) {
    this.path = join(dataDir, "resources-regions.json");
    this.regions = {};
    this.loaded = false;
  }

  async load() {
    if (this.loaded) {
      return;
    }
    try {
      this.regions = JSON.parse(await readFileAtomic(this.path));
    } catch {
      this.regions = {};
    }
    this.loaded = true;
  }

  async save() {
    // Atomic AND ordered: concurrent publish passes (serve-time and
    // refresh-time) run on independent chains, and each save rewrites
    // the whole file. fs-atomic serializes the rewrites and the loads
    // per path, so a stale snapshot cannot rename last and resurrect
    // ids another pass just pruned, and a listing cannot race an
    // in-flight rename of the state this store just mutated (CI flake,
    // publication track test, October 2026)
    await writeFileAtomic(this.path, JSON.stringify(this.regions, null, 2));
  }

  async list(params = {}) {
    await this.load();
    const matching = {};
    for (const [id, region] of Object.entries(this.regions)) {
      if (matchesQuery(region, params)) {
        matching[id] = region;
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
    return this.regions[id] ?? null;
  }

  async set(id, region) {
    await this.load();
    // Identical rewrites save nothing: the serve-time publish runs on
    // every page load, and an unchanged warning set must not touch
    // the disk each time
    const prev = this.regions[id];
    if (prev && JSON.stringify(prev) === JSON.stringify(region)) {
      return;
    }
    this.regions[id] = region;
    await this.save();
  }

  async delete(id) {
    await this.load();
    delete this.regions[id];
    await this.save();
  }

  /**
   * Scoped expiry: drops only ids carrying the given prefix (this
   * feed's regions), leaving the built-in provider's user regions and
   * other feeds' ids untouched.
   *
   * @param {string[]} keepIds - ids that survived the filter pass
   * @param {string} prefix - the feed's id prefix, e.g. "metarea-area-"
   */
  async prune(keepIds, prefix) {
    await this.load();
    const keep = new Set(keepIds);
    let removed = false;
    for (const id of Object.keys(this.regions)) {
      if (id.startsWith(prefix) && !keep.has(id)) {
        delete this.regions[id];
        removed = true;
      }
    }
    if (removed) {
      await this.save();
    }
  }

  async clear() {
    await this.load();
    this.regions = {};
    await this.save();
  }
}

/**
 * Creates a RegionsStore rooted in the plugin data dir.
 *
 * @param {string} dataDir
 * @returns {RegionsStore}
 */
function createRegionsStore(dataDir) {
  return new RegionsStore(dataDir);
}

/**
 * Registers the plugin as a `regions` resource provider backed by the
 * store. Skips silently on servers without the provider registry. The
 * server merges providers per type, so the built-in resources-provider
 * keeps serving user-created regions beside these.
 *
 * @param {object} app - Signal K server API
 * @param {object} params
 * @param {RegionsStore} params.store
 * @param {string} params.id - plugin id
 * @returns {() => void} teardown — empties the served listing
 */
function registerRegionsProvider(app, { store, id }) {
  if (typeof app.registerResourceProvider !== "function") {
    app.debug?.(
      "Server has no resource provider registry: regions serving disabled",
    );
    return () => {};
  }
  let running = true;
  app.registerResourceProvider({
    type: "regions",
    methods: {
      listResources: async (params = {}) => {
        if (!running) {
          return {};
        }
        return store.list(params ?? {});
      },
      getResource: async (resourceId) => {
        const region = await store.get(resourceId);
        if (!region) {
          throw new Error(`No such region: ${resourceId}`);
        }
        return region;
      },
      // Read-only by design: this provider serves the warning shapes
      // the bulletin pipeline publishes. User region writes belong to
      // the built-in resources-provider.
      setResource: async (resourceId) => {
        throw new Error(
          `${id} regions are pipeline-fed and read-only (${resourceId})`,
        );
      },
      deleteResource: async (resourceId) => {
        throw new Error(
          `${id} regions are pipeline-fed and read-only (${resourceId})`,
        );
      },
    },
  });
  return () => {
    running = false;
  };
}

module.exports = {
  RegionsStore,
  bboxesIntersect,
  createRegionsStore,
  matchesQuery,
  normalizeLon,
  parsePosition,
  regionBbox,
  regionDistanceMeters,
  registerRegionsProvider,
  ringBbox,
};
