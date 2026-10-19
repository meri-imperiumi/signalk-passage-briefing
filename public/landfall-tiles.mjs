/**
 * Tile readers for the landfall estimator (work doc #6): the browser
 * implementations of the `elevation(lat, lon)` and `placeName(lat,
 * lon)` interfaces, reading the corridor tile cache the way the map
 * already does — over HTTP from the chart resources, no SQLite in the
 * worker.
 *
 * Sources (inspected in the work doc #6 update #2):
 *
 * - **Elevation**: the corridor downloader's "elevation" layer —
 *   Mapterhorn GLO-30, lossless WebP tiles, Terrarium encoding
 *   (elevation = R·256 + G + B/256 − 32768; sea is exactly 0). The
 *   browser decodes WebP natively via `createImageBitmap`.
 * - **Gazetteer**: the "versatiles-shortbread" base layer —
 *   Shortbread-schema vector tiles whose `place_labels` layer carries
 *   named places (`name`, `kind`, `name_en`, `population`). Vector
 *   tiles arrive gzip-compressed; `DecompressionStream` unwraps them.
 *
 * Both readers cache tiles per (z, x, y) — the estimator's raycast
 * walks each corridor once, so a passage costs a corridor's worth of
 * tile fetches, not one per lookup.
 *
 * @file landfall-tiles.mjs
 */

import { absoluteTileUrl, parseChartLayers } from "./components/map-model.mjs";
import { tileFor } from "./landfall-estimator.mjs";
import { PbfReader } from "./vendor/mvt/pbf.js";
import { VectorTile } from "./vendor/mvt/vector-tile.js";

/** The charts resource the webapp's map already reads. */
const CHARTS_URL = "/signalk/v1/api/resources/charts";

/**
 * Terrarium decoding: RGB → meters above sea level. Sea level is
 * exactly (128, 0, 0) → 0.
 *
 * @param {number} r - Red, 0..255
 * @param {number} g - Green, 0..255
 * @param {number} b - Blue, 0..255
 * @returns {number} Meters
 */
export function terrariumElevation(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/**
 * Picks the landfall sources out of the parsed chart layers: the
 * Mapterhorn elevation DEM and the Shortbread vector base. Absent
 * layers come back `null` — the estimator is best-effort and the
 * briefing reads fine without it.
 *
 * @param {Array<{identifier: string, name: string, url: string,
 *   format?: string, minZoom: number, maxZoom: number}>} layers -
 *   `parseChartLayers()` output
 * @returns {{elevation: object|null, base: object|null}}
 */
export function pickLandfallCharts(layers) {
  let elevation = null;
  let base = null;
  for (const layer of layers ?? []) {
    if (/elevation/i.test(layer.name) && layer.format === "webp") {
      elevation = layer;
    } else if (/shortbread/i.test(layer.name) && layer.format === "pbf") {
      base = layer;
    }
  }
  return { elevation, base };
}

/**
 * Fetches and parses the charts resource.
 *
 * @param {typeof fetch} [fetchImpl] - Injectable fetch (tests)
 * @returns {Promise<Array<object>>} Parsed chart layers
 */
export async function loadChartLayers(fetchImpl = fetch) {
  const response = await fetchImpl(CHARTS_URL);
  if (!response.ok) {
    throw new Error(`charts resource: ${response.status}`);
  }
  return parseChartLayers(await response.json());
}

/**
 * XYZ tile fetch helper: fills the template, returns decoded bytes or
 * `null` on a miss. Vector tiles arrive gzip-compressed; elevation
 * WebPs are raw.
 *
 * @param {string} template - Tile URL with `{z}/{x}/{y}`
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Uint8Array|null>}
 */
async function fetchTile(template, z, x, y, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(
      absoluteTileUrl(
        template
          .replace("{z}", String(z))
          .replace("{x}", String(x))
          .replace("{y}", String(y)),
      ),
    );
  } catch {
    return null; // Offline or the provider is down — no data is not land
  }
  if (!response.ok) {
    return null;
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    if (typeof DecompressionStream === "undefined") {
      return null;
    }
    const stream = new Blob([buffer])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return buffer;
}

/**
 * Decodes a lossless-WebP tile into a Terrarium elevation raster via
 * the browser's own image codec (`createImageBitmap` +
 * `OffscreenCanvas` — available in workers; Node has neither, so the
 * unit tests inject synthetic elevation and never reach here).
 *
 * @param {Uint8Array} bytes - WebP bytes
 * @returns {Promise<{width: number, height: number,
 *   elevationAt: (x: number, y: number) => number}>}
 */
async function decodeElevationTile(bytes) {
  const bitmap = await createImageBitmap(
    new Blob([bytes], { type: "image/webp" }),
  );
  const width = bitmap.width;
  const height = bitmap.height;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const raster = context.getImageData(0, 0, width, height).data;
  bitmap.close();
  return {
    width,
    height,
    elevationAt: (x, y) => {
      const offset = (y * width + x) * 4;
      return terrariumElevation(
        raster[offset],
        raster[offset + 1],
        raster[offset + 2],
      );
    },
  };
}

/**
 * Builds the `elevation(lat, lon)` lookup for the estimator: meters
 * above sea level, `null` when no tile covers the point. Tries the
 * layer's top zoom first and falls back downwards — corridor edges
 * may only carry the coarse zooms.
 *
 * @param {object} layer - Parsed elevation chart layer (`webp`)
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] - Injectable fetch (tests)
 * @param {(bytes: Uint8Array) => Promise<{width: number,
 *   height: number, elevationAt: (x: number, y: number) => number}>}
 *   [options.decodeTile] - Injectable tile decoder (tests); defaults
 *   to the browser's own WebP codec
 * @returns {(lat: number, lon: number) => Promise<number|null>}
 */
export function createElevationReader(
  layer,
  { fetchImpl = fetch, decodeTile = decodeElevationTile } = {},
) {
  const cache = new Map();
  return async (lat, lon) => {
    if (layer == null) {
      return null;
    }
    const topZoom = Math.min(layer.maxZoom ?? 12, 12);
    const floorZoom = Math.min(layer.minZoom ?? 0, topZoom);
    for (let z = topZoom; z >= floorZoom; z--) {
      const { x, y } = tileFor(lat, lon, z);
      const key = `${z}/${x}/${y}`;
      let tilePromise = cache.get(key);
      if (tilePromise === undefined) {
        tilePromise = fetchTile(layer.url, z, x, y, fetchImpl).then((bytes) =>
          bytes == null ? null : decodeTile(bytes),
        );
        cache.set(key, tilePromise);
      }
      const tile = await tilePromise;
      if (tile == null) {
        continue;
      }
      const n = 2 ** z;
      const lonFraction = (lon + 180) / 360;
      const latFraction = mercatorYFraction(lat);
      const px = Math.min(
        tile.width - 1,
        Math.max(0, Math.round(lonFraction * n * tile.width - x * tile.width)),
      );
      const py = Math.min(
        tile.height - 1,
        Math.max(
          0,
          Math.round(latFraction * n * tile.height - y * tile.height),
        ),
      );
      return tile.elevationAt(px, py);
    }
    return null;
  };
}

/**
 * Web-Mercator y fraction of a latitude (0 = north edge, 1 = south).
 *
 * @param {number} lat - Degrees
 * @returns {number} 0..1
 */
export function mercatorYFraction(lat) {
  const latRad =
    (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  return (1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2;
}

/**
 * Nearest named place in a decoded MVT layer to a geographic point.
 * Points compare in the layer's own extent units — no re-projection
 * of the features.
 *
 * @param {object} mvtLayer - A `VectorTile` layer
 * @param {number} z - Tile zoom
 * @param {number} x - Tile x
 * @param {number} y - Tile y (XYZ)
 * @param {number} lat - Degrees
 * @param {number} lon - Degrees
 * @returns {{name: string, kind: string|null}|null} Nearest named
 *   place, or `null` when the layer has none
 */
export function nearestPlaceInLayer(mvtLayer, z, x, y, lat, lon) {
  const extent = mvtLayer.extent ?? 4096;
  const n = 2 ** z;
  const px = ((lon + 180) / 360 - x / n) * n * extent;
  const py = (mercatorYFraction(lat) - y / n) * n * extent;
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < mvtLayer.length; i++) {
    const feature = mvtLayer.feature(i);
    if (typeof feature.properties?.name !== "string") {
      continue;
    }
    const geometry = feature.loadGeometry();
    if (geometry.length === 0 || geometry[0].length === 0) {
      continue;
    }
    const dx = geometry[0][0].x - px;
    const dy = geometry[0][0].y - py;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = {
        name: feature.properties.name,
        kind:
          typeof feature.properties.kind === "string"
            ? feature.properties.kind
            : null,
      };
    }
  }
  return best;
}

/**
 * Builds the `placeName(lat, lon)` lookup for the estimator: the
 * nearest named Shortbread place, or `null` when the tiles name
 * nothing there (the estimator falls back to "land"). Works down from
 * z12 — islands and coastal towns — to the coarse zooms' capitals.
 *
 * @param {object} layer - Parsed Shortbread chart layer (`pbf`)
 * @param {typeof fetch} [fetchImpl] - Injectable fetch (tests)
 * @returns {(lat: number, lon: number) => Promise<{name: string,
 *   kind: string|null}|null>}
 */
export function createPlaceNameReader(layer, fetchImpl = fetch) {
  const cache = new Map();
  return async (lat, lon) => {
    if (layer == null) {
      return null;
    }
    const topZoom = Math.min(layer.maxZoom ?? 14, 12);
    const floorZoom = Math.min(layer.minZoom ?? 0, topZoom);
    for (let z = topZoom; z >= floorZoom; z--) {
      const { x, y } = tileFor(lat, lon, z);
      const key = `${z}/${x}/${y}`;
      let tilePromise = cache.get(key);
      if (tilePromise === undefined) {
        tilePromise = fetchTile(layer.url, z, x, y, fetchImpl).then((bytes) => {
          if (bytes == null) {
            return null;
          }
          try {
            return new VectorTile(new PbfReader(bytes));
          } catch {
            return null; // A bad tile must not break the briefing
          }
        });
        cache.set(key, tilePromise);
      }
      const tile = await tilePromise;
      if (tile == null) {
        continue;
      }
      const layerName =
        "place_labels" in tile.layers
          ? "place_labels"
          : Object.keys(tile.layers).find((name) => /place/i.test(name));
      if (layerName == null) {
        continue;
      }
      const place = nearestPlaceInLayer(
        tile.layers[layerName],
        z,
        x,
        y,
        lat,
        lon,
      );
      if (place != null) {
        return place;
      }
    }
    return null;
  };
}

/**
 * Wires both readers from the live charts resource. Returns `null`
 * when either source is missing — the estimator is best-effort and
 * its absence just means no landfall rows.
 *
 * @param {typeof fetch} [fetchImpl] - Injectable fetch (tests)
 * @returns {Promise<{elevation: (lat: number, lon: number) =>
 *   Promise<number|null>, placeName: (lat: number, lon: number) =>
 *   Promise<{name: string, kind: string|null}|null>}|null>}
 */
export async function createLandfallReaders(fetchImpl = fetch) {
  let layers;
  try {
    layers = await loadChartLayers(fetchImpl);
  } catch {
    return null;
  }
  const { elevation, base } = pickLandfallCharts(layers);
  if (elevation == null) {
    return null;
  }
  return {
    elevation: createElevationReader(elevation, fetchImpl),
    placeName: base != null ? createPlaceNameReader(base, fetchImpl) : null,
  };
}
