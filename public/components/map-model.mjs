/**
 * Pure geometry and layer specs for the warnings map (work doc #47):
 * turns the briefing payload's already-computed geometry into draw
 * specs the `<pb-map-view>` Leaflet adapter renders. No DOM, no
 * Leaflet — unit-testable.
 *
 * The bulletin engine computes block geometry for *filtering*; the
 * map draws the same shapes, so the visual language must mark their
 * approximations as such (dashed bboxes, corridor bands) and the
 * console text card stays authoritative. Click-through pairs a shape
 * with its text card via the block's index.
 *
 * Longitudes are normalized into a continuous frame per shape (the
 * same shortest-arc logic the engine's ray-cast uses) so South
 * Pacific shapes spanning `170E`/`178W` draw east of the seam
 * instead of snapping a line across the whole map.
 *
 * @file components/map-model.mjs
 */

import { greatCircleNm } from "../sereno-physics.mjs";
import { kindGlyph, splitSevere } from "./models.mjs";

const DEG = Math.PI / 180;

/** The severities a bulletin block can carry, highest first. */
export const SHAPE_SEVERITY = ["severe", "warn", "info"];

/** The default fallback basemap (online only): OSM tiles. */
export const OSM_LAYER = {
  name: "OpenStreetMap (online)",
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: "© OpenStreetMap contributors",
  maxZoom: 19,
};

/**
 * Whether a parsed chart layer is a vector (Mapbox/MapLibre `.pbf`)
 * tile set that Leaflet's raster engine can't draw — the cue for the
 * map to mount it via `L.maplibreGL` instead (same chart path as
 * signalk-dead-reckoning, work doc #47 session).
 *
 * @param {{format?: string}|null|undefined} chart - parsed chart layer
 * @returns {boolean}
 */
export function isVectorChart(chart) {
  return chart?.format === "pbf";
}

/**
 * Makes a chart tilemapUrl absolute for MapLibre's style. MapLibre
 * fetches tiles from a blob-URL worker where root-relative URLs
 * (`/signalk/…`) can't resolve — every request fails with "URL is not
 * valid or contains user credentials". Absolute http(s) URLs pass
 * through; outside a browser (unit tests) there's no origin to
 * prepend.
 *
 * @param {string} url - chart tilemapUrl, possibly root-relative
 * @returns {string} absolute tile URL (or unchanged when no page origin)
 */
export function absoluteTileUrl(url) {
  if (/^https?:\/\//i.test(url)) return url;
  const origin = globalThis.location?.origin;
  return origin ? `${origin}${url}` : url;
}

/**
 * The mirror discovery contract the corridor tile downloader serves
 * at `/plugins/signalk-corridor-tile-downloader/assets/manifest.json`:
 * absolute style/sprite/glyph URLs, the style link appearing only
 * once the mirror is complete enough to render. Null when the
 * manifest is absent or the style link is missing/non-absolute —
 * the map falls back to per-chart vector rendering.
 *
 * @param {object|null|undefined} value - fetched manifest JSON
 * @returns {{style: string}|null}
 */
export function chartAssetsFromManifest(value) {
  if (!value || typeof value !== "object") return null;
  const style = value.style;
  if (typeof style !== "string" || !/^https?:\/\//i.test(style)) {
    return null;
  }
  return { style };
}

// ---------------------------------------------------------------------------
// Generic vector chart styling (work doc #47 session): a hand-rolled
// MapLibre style for charts served as raw `.pbf` XYZ without a GL
// style of their own — the same families and paint dead-reckoning's
// chart path uses (ported from its viewmodel; the two webapps should
// read the same chart the same way).
// ---------------------------------------------------------------------------

/** Vector source-layer families and their paint, by id pattern. */
const VECTOR_LAYER_FAMILIES = [
  // Land masses and built-up areas → solid dark-olive fills.
  {
    kind: "land",
    match: [/^land$/i, /^landcover$/i, /^landuse$/i, /^lndare$/i],
    styles: {
      fill: { "fill-color": "#2a3a2e", "fill-opacity": 0.9 },
      line: { "line-color": "#3d4f40", "line-width": 0.6 },
    },
  },
  // Depth / water areas → translucent deep-blue fills.
  {
    kind: "water",
    match: [/^water$/i, /^depare$/i, /^sea$/i, /^ocean$/i, /^sea_area$/i],
    styles: {
      fill: { "fill-color": "#102a3d", "fill-opacity": 0.55 },
      line: { "line-color": "#1c3c52", "line-width": 0.5 },
    },
  },
  // Rivers / channels / canals → water-toned fills and lines.
  {
    kind: "waterway",
    match: [/^waterway$/i, /^river$/i, /^canal$/i, /^stream$/i],
    styles: {
      fill: { "fill-color": "#14324a", "fill-opacity": 0.5 },
      line: { "line-color": "#2f6a80", "line-width": 1 },
    },
  },
  // Marsh / mangrove → muted green fills between land and water.
  {
    kind: "wetland",
    match: [/^wetland$/i, /^marsh/i, /^mangrove$/i],
    styles: {
      fill: { "fill-color": "#233830", "fill-opacity": 0.6 },
      line: { "line-color": "#35503f", "line-width": 0.6 },
    },
  },
  // Buoys, beacons, restricted areas, moorings → visible teal marks.
  {
    kind: "seamark",
    match: [/^seamark$/i, /^navigation/i],
    styles: {
      fill: { "fill-color": "#16394a", "fill-opacity": 0.45 },
      line: { "line-color": "#4b8b99", "line-width": 0.9 },
      circle: { "circle-color": "#9fd6d9", "circle-radius": 2 },
    },
  },
  // Coastlines → the crisp reference edge over the fills.
  {
    kind: "coastline",
    match: [/^coalne$/i, /^coastline$/i, /^shoreline$/i],
    styles: {
      line: { "line-color": "#7fa3b0", "line-width": 1.2 },
    },
  },
  // Depth contours / bathymetry → thin mid-blue lines.
  {
    kind: "contour",
    match: [/^depcnt$/i, /^contour/i, /^depth_contour$/i],
    styles: {
      line: { "line-color": "#2f5a70", "line-width": 0.8 },
    },
  },
  // Soundings / spot points → tiny dots.
  {
    kind: "point",
    match: [/^soundg$/i, /^sounding/i, /^soundings$/i],
    styles: {
      circle: { "circle-color": "#4b8b99", "circle-radius": 1.5 },
    },
  },
  // Lights (lighthouses, beacons) → amber dots that read instantly.
  {
    kind: "light",
    match: [/^lights?$/i],
    styles: {
      circle: { "circle-color": "#e0b458", "circle-radius": 2.5 },
      line: { "line-color": "#e0b458", "line-width": 0.6 },
    },
  },
];

/** Fallback family for source layers no pattern matches. */
const VECTOR_DEFAULT_FAMILY = {
  kind: "default",
  match: [],
  styles: {
    fill: { "fill-color": "#1c2830", "fill-opacity": 0.35 },
    line: { "line-color": "#6a7a86", "line-width": 0.8 },
    circle: { "circle-color": "#6a7a86", "circle-radius": 1.5 },
  },
};

/**
 * Classifies a vector source-layer id into its styling family.
 *
 * @param {string} layerId
 * @returns {object} Family with `kind` and `styles`
 */
function vectorLayerFamily(layerId) {
  for (const family of VECTOR_LAYER_FAMILIES) {
    if (family.match.some((re) => re.test(layerId))) return family;
  }
  return VECTOR_DEFAULT_FAMILY;
}

/**
 * Builds a complete MapLibre style for a vector chart layer, entirely
 * client-side: one vector source on the chart's `tilemapUrl` (made
 * absolute — MapLibre's tile workers can't resolve relative URLs), a
 * dark sea background, and a fill/line/circle trio per source layer —
 * a line layer only draws line features, fills only polygons, circles
 * only points, so the trio covers any geometry without knowing the
 * schema. The source's `maxzoom` is the *native* tile max, so MapLibre
 * keeps overzooming vector data past it (the raster path's
 * maxNativeZoom behaviour, but sharper). No symbol layers: without a
 * glyphs endpoint they can't render.
 *
 * @param {{identifier: string, name: string, url: string, minZoom:
 *   number, maxZoom: number, format?: string, chartLayers?:
 *   string[]}} chart - parsed chart layer
 * @returns {{version: number, name: string, sources: object,
 *   layers: Array<object>}} MapLibre style spec object
 */
export function maplibreStyleFor(chart) {
  const sourceId = chart.identifier.replace(/[^\w.-]/g, "_");
  // Without the resource's vector_layers metadata, guess the
  // conventional single-layer name (the chart identifier) —
  // best-effort, documented. Duplicated ids in the metadata table
  // would yield duplicate MapLibre layer ids (undefined rendering),
  // so they're deduped first.
  const sourceLayers = [
    ...new Set(
      chart.chartLayers && chart.chartLayers.length > 0
        ? chart.chartLayers
        : [chart.identifier],
    ),
  ];

  const families = sourceLayers.map((id) => ({
    id,
    family: vectorLayerFamily(id),
  }));

  const layers = [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#0b1b26" },
    },
  ];
  // Paint order matters: area fills under lines under points; land
  // before water so islands don't drown (both translucent otherwise);
  // seamark areas above the natural families so marks stay legible.
  const byKind = (kind) => families.filter((f) => f.family.kind === kind);
  for (const kind of [
    "land",
    "water",
    "waterway",
    "wetland",
    "seamark",
    "default",
    "coastline",
    "contour",
  ]) {
    for (const { id, family } of byKind(kind)) {
      if (!family.styles.fill) continue;
      layers.push({
        id: `${sourceId}-${id}-fill`,
        type: "fill",
        source: sourceId,
        "source-layer": id,
        paint: family.styles.fill,
      });
    }
  }
  for (const { id, family } of families) {
    if (!family.styles.line) continue;
    layers.push({
      id: `${sourceId}-${id}-line`,
      type: "line",
      source: sourceId,
      "source-layer": id,
      paint: family.styles.line,
    });
  }
  for (const { id, family } of families) {
    if (!family.styles.circle) continue;
    layers.push({
      id: `${sourceId}-${id}-circle`,
      type: "circle",
      source: sourceId,
      "source-layer": id,
      paint: family.styles.circle,
    });
  }

  return {
    version: 8,
    name: chart.name,
    sources: {
      [sourceId]: {
        type: "vector",
        tiles: [absoluteTileUrl(chart.url)],
        minzoom: chart.minZoom,
        maxzoom: chart.maxZoom,
      },
    },
    layers,
  };
}

/**
 * Parses the server's configured chart resources into chart layer
 * specs (offline MBTiles and tile proxies serve the standard
 * `{z}/{x}/{y}` scheme). Field names follow the Signal K chart
 * resource convention — `minzoom`/`maxzoom`, lowercase — with
 * numeric guards so a malformed value degrades to Leaflet's
 * defaults, never into the tile layer's zoom arithmetic.
 *
 * Vector charts (`pbf`, carrying `chartLayers`) parse too: the map
 * mounts them through MapLibre GL (see {@link maplibreStyleFor}), not
 * Leaflet's raster engine. `mapstyleJSON` GL styles and other
 * non-XYZ entries skip with a logged reason — the corridor
 * downloader's own provider entry is redundant with the mirror the
 * manifest advertises.
 *
 * @param {object|null} resource - `/signalk/v1/api/resources/charts`
 * @returns {Array<{identifier: string, name: string, url: string,
 *   attribution?: string, minZoom: number, maxZoom: number,
 *   format?: string, chartLayers?: string[]}>}
 */
export function parseChartLayers(resource) {
  const layers = [];
  for (const [id, chart] of Object.entries(resource ?? {})) {
    const url =
      typeof chart?.tilemapUrl === "string" && chart.tilemapUrl.includes("{z}")
        ? chart.tilemapUrl
        : null;
    if (!url) {
      // GL styles and other non-XYZ entries — identifiable ones say
      // why they are not here
      if (chart?.type != null || chart?.url != null) {
        console.info(
          `pb-map-view: chart "${chart?.name ?? id}" is a ${chart?.type ?? "non-XYZ"} chart — renders via the chart mirror, skipped`,
        );
      }
      continue;
    }
    const layer = {
      identifier: chart.identifier || id,
      name: chart.name ?? chart.identifier ?? id,
      url,
      attribution: chart.attribution ?? "",
      minZoom: typeof chart.minzoom === "number" ? chart.minzoom : 0,
      maxZoom: typeof chart.maxzoom === "number" ? chart.maxzoom : 19,
    };
    if (typeof chart.format === "string" && chart.format.length > 0) {
      layer.format = chart.format.toLowerCase();
    }
    if (Array.isArray(chart.chartLayers)) {
      layer.chartLayers = chart.chartLayers.filter(
        (x) => typeof x === "string" && x.length > 0,
      );
    }
    layers.push(layer);
  }
  return layers.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Normalizes a coordinate list into a continuous longitude frame:
 * each point takes the representative within 180° of its predecessor
 * (so `[178, -20], [-178, -21]` becomes `178, 182` and draws as the
 * short hop across the dateline).
 *
 * @param {Array<[number, number]>} points - [[lon, lat], …]
 * @returns {Array<[number, number]>} Unwrapped copy (input untouched)
 */
export function unwrapFrame(points, referenceLon = null) {
  const out = [];
  let prev = referenceLon;
  for (const [lon, lat] of points ?? []) {
    let value = lon;
    if (prev != null) {
      while (value - prev > 180) value -= 360;
      while (value - prev < -180) value += 360;
    }
    out.push([value, lat]);
    prev = value;
  }
  return out;
}

/**
 * Bounding box of a coordinate list in its continuous frame: the
 * honest envelope for fitting the map view.
 *
 * @param {Array<[number, number]>} points
 * @returns {[number, number, number, number]|null} [minLon, minLat,
 *   maxLon, maxLat], null when empty
 */
export function frameBounds(points) {
  if (!points || points.length === 0) {
    return null;
  }
  let [minLon, minLat, maxLon, maxLat] = [
    points[0][0],
    points[0][1],
    points[0][0],
    points[0][1],
  ];
  for (const [lon, lat] of points) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * Whether a bulletin block text carries a severe keyword — the same
 * highlighter the console renders (one source of truth: a shape
 * lights up exactly when its text card does).
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isSevereText(text) {
  return splitSevere(String(text ?? "")).some((token) => token.severe);
}

/**
 * Expands a corridor band (the `WITHIN 120 NAUTICAL MILES OF T1`
 * axis band) into a closed ring around a polyline: the band is the
 * warning area, not the line. Offset legs are rectangular — a coarse
 * but honest approximation for a band the engine itself tests as a
 * padded bbox.
 *
 * @param {Array<[number, number]>} points - Unwrapped axis points
 * @param {number} bufferNm - Band half-width in nautical miles
 * @returns {Array<[number, number]>} Closed ring (lon/lat)
 */
export function corridorRing(points, bufferNm) {
  const latPad = bufferNm / 60;
  const meanLat =
    (points.reduce((sum, [, lat]) => sum + lat, 0) / points.length) * DEG;
  const lonPad = latPad / Math.max(0.2, Math.cos(meanLat));
  const forward = points;
  const back = [...points].reverse();
  const ring = [
    ...forward.map(([lon, lat]) => [lon + lonPad, lat + latPad]),
    ...back.map(([lon, lat]) => [lon - lonPad, lat - latPad]),
  ];
  ring.push([...ring[0]]);
  return ring;
}

/**
 * The draw spec for one bulletin block: the geometry the engine
 * extracted, normalized for drawing. Null when the block carries no
 * geometry (the console shows its text; the map has nothing to say).
 *
 * - `polygon`: coordinate-chain areas (gale areas, convergence zones)
 * - `line` with `bufferNm`: axis bands, expanded into a corridor ring
 * - `bbox`: cardinal-bound areas — dashed on the map, approximate
 * - `point`: tropical cyclone/depression declarations
 *
 * @param {{text: string, geometry?: {type: string, coordinates:
 *   number[]|number[][]}, geometryType?: string|null}} block
 * @param {number} index - Block index in the console (the
 *   click-through key)
 * @returns {{kind: string, index: number, points: number[][],
 *   bufferNm: number|null, severe: boolean, dashed: boolean,
 *   label: string}|null} `label` names the block for the map tooltip
 *   (the console card's first line, clipped) — points carry no label,
 *   the storm marker supplies its own
 */
export function blockShape(block, index, referenceLon = null) {
  const geometry = block?.geometry;
  if (!geometry) {
    return null;
  }
  const severe = isSevereText(block?.text);
  // The map tooltip names the block the way the console's own text
  // card headline does — the card stays authoritative, the pin says
  // what you are hovering
  const label = (block?.text ?? "").split("\n")[0].slice(0, 90);
  if (geometry.type === "point") {
    const [lon, lat] = geometry.coordinates;
    return {
      kind: "point",
      index,
      points: [[lon, lat]],
      bufferNm: null,
      severe,
      dashed: false,
    };
  }
  if (geometry.type === "bbox") {
    const [minLon, minLat, maxLon, maxLat] = geometry.coordinates;
    // Unwrap the box into a continuous frame: a bbox spanning the
    // seam draws as one rectangle, not a wrapped sliver
    const points = [
      [minLon, minLat],
      [maxLon, minLat],
      [maxLon, maxLat],
      [minLon, maxLat],
      [minLon, minLat],
    ];
    return {
      kind: "bbox",
      index,
      points: unwrapFrame(points),
      bufferNm: null,
      severe,
      dashed: true,
      label,
    };
  }
  // polygon or line: a ring, or an axis — axes with a stated band
  // expand into the corridor ring the band implies
  const points = unwrapFrame(geometry.coordinates ?? [], referenceLon);
  if (points.length === 0) {
    return null;
  }
  if (geometry.type === "line" && block.geometry.bufferNm > 0) {
    return {
      kind: "polygon",
      index,
      points: corridorRing(points, block.geometry.bufferNm),
      bufferNm: block.geometry.bufferNm,
      severe,
      dashed: false,
      label,
    };
  }
  if (geometry.type === "line") {
    return {
      kind: "line",
      index,
      points,
      bufferNm: null,
      severe,
      dashed: false,
      label,
    };
  }
  return {
    kind: "polygon",
    index,
    points:
      points[0][0] === points[points.length - 1][0] &&
      points[0][1] === points[points.length - 1][1]
        ? points
        : [...points, [...points[0]]],
    bufferNm: block.geometry.bufferNm ?? null,
    severe,
    dashed: false,
    label,
  };
}

/**
 * Draw specs for every placeable bulletin block, indexed by console
 * order (the click-through key pairs shape and text card).
 *
 * @param {Array<object>} blocks - metareaBulletin blocks
 * @returns {Array<object>} Non-null blockShape results
 */
export function blockShapes(blocks, referenceLon = null) {
  return (blocks ?? [])
    .map((block, index) => blockShape(block, index, referenceLon))
    .filter(Boolean);
}

/**
 * The track line from the compiled payload waypoints (sailed legs
 * already trimmed away server-side).
 *
 * @param {Array<{lat: number, lon: number}>} waypoints
 * @returns {Array<[number, number]>} [[lon, lat], …] in a continuous
 *   frame, empty when there is no route
 */
export function trackLine(waypoints, referenceLon = null) {
  return unwrapFrame(
    (waypoints ?? [])
      .filter((w) => Number.isFinite(w?.lat) && Number.isFinite(w?.lon))
      .map((w) => [w.lon, w.lat]),
    referenceLon,
  );
}

/**
 * The draw spec for one CAP alert: the authoritative native geometry
 * (polygon ring or zero-radius bbox) — unlike bulletin shapes these
 * draw solid: the sender published the area.
 *
 * @param {{event?: string, headline?: string, severity?: string,
 *   geometry?: {type: string, coordinates: number[]|number[][]}}} alert
 * @returns {{kind: string, points: number[][], label: string,
 *   severity: string}|null}
 */
export function capShape(alert, referenceLon = null) {
  const geometry = alert?.geometry;
  if (!geometry) {
    return null;
  }
  let points;
  if (geometry.type === "bbox") {
    const [minLon, minLat, maxLon, maxLat] = geometry.coordinates;
    points = unwrapFrame(
      [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat],
      ],
      referenceLon,
    );
  } else {
    points = unwrapFrame(geometry.coordinates ?? [], referenceLon);
  }
  if (points.length === 0) {
    return null;
  }
  return {
    kind: geometry.type === "bbox" ? "bbox" : "polygon",
    points,
    label: alert.headline ?? alert.event ?? "Official alert",
    severity: String(alert.severity ?? "").toLowerCase(),
  };
}

/**
 * The pin for one GDACS event: a point with the alert-level color
 * the timeline uses for its severity.
 *
 * @param {{lat: number, lon: number, alertLevel?: string, title?:
 *   string, link?: string|null}} event
 * @returns {{lon: number, lat: number, level: string, label: string,
 *   url: string|null}|null}
 */
export function hazardPin(event, referenceLon = null) {
  if (!Number.isFinite(event?.lat) || !Number.isFinite(event?.lon)) {
    return null;
  }
  return {
    lon: unwrapFrame([[event.lon, event.lat]], referenceLon)[0][0],
    lat: event.lat,
    level: String(event.alertLevel ?? "").toLowerCase(),
    label: event.title ?? "GDACS event",
    url: event.link ?? null,
  };
}

/**
 * The cyclone marker spec for a storm-declaration block: the
 * analysed position plus the movement text, so the map can pin the
 * system the way the console names it.
 *
 * @param {{text: string, geometry?: {type: string, coordinates:
 *   number[]}}|null} block
 * @returns {{lon: number, lat: number, label: string}|null}
 */
export function stormMarker(block) {
  if (block?.geometry?.type !== "point") {
    return null;
  }
  const [lon, lat] = block.geometry.coordinates;
  const name = block.text.match(
    /TROPICAL\s+(?:DEPRESSION|CYCLONE|STORM)\s+([A-Z0-9]+)/i,
  );
  return {
    lon,
    lat,
    label: name ? `Tropical cyclone ${name[1]}` : block.text.slice(0, 60),
  };
}

/**
 * Run-length ribbon segments from the simulated track: consecutive
 * hourly rows collapse into one polyline per regime change (comfort
 * tier, slatting, motoring, night), so the route draws as the plan
 * reads — colored stretches, motoring dashes, shaded nights. Rows
 * without coordinates bridge silently into the next segment.
 *
 * @param {Array<{hoursFromNow: number, lat: number, lon: number,
 *   comfortLevel: string|null, slatting: boolean, motoring: boolean,
 *   night: boolean}>} track - summary.track rows
 * @returns {Array<{points: number[][], comfortLevel: string|null,
 *   slatting: boolean, motoring: boolean, night: boolean}>}
 */
export function ribbonSegments(track, referenceLon = null) {
  const segments = [];
  const keyOf = (row) =>
    [
      row.comfortLevel ?? "?",
      row.slatting === true ? "slat" : "calm",
      row.motoring === true ? "motor" : "sail",
      row.night === true ? "night" : "day",
    ].join("|");
  let current = null;
  let prev = referenceLon;
  for (const row of track ?? []) {
    if (!Number.isFinite(row?.lat) || !Number.isFinite(row?.lon)) {
      continue; // Gap: the next row starts its own stretch
    }
    let lon = row.lon;
    if (prev != null) {
      while (lon - prev > 180) lon -= 360;
      while (lon - prev < -180) lon += 360;
    }
    prev = lon;
    const key = keyOf(row);
    if (current && current.key === key) {
      current.points.push([lon, row.lat]);
    } else {
      current = {
        key,
        points: [[lon, row.lat]],
        comfortLevel: row.comfortLevel ?? null,
        slatting: row.slatting === true,
        motoring: row.motoring === true,
        night: row.night === true,
      };
      segments.push(current);
    }
  }
  // Continuity: a segment's end is the next segment's start, so the
  // ribbon never shows a gap at a regime change
  for (let i = segments.length - 1; i > 0; i--) {
    if (
      segments[i].points.length > 1 &&
      (segments[i - 1].points.at(-1)[0] !== segments[i].points[0][0] ||
        segments[i - 1].points.at(-1)[1] !== segments[i].points[0][1])
    ) {
      segments[i - 1].points.push([...segments[i].points[0]]);
    }
  }
  return segments.map(({ key, ...segment }) => segment);
}

/**
 * The colorized route (work doc #47 session): the real route polyline
 * — the payload's waypoints, sampled along the route's own geometry —
 * carrying the plan's per-stretch encoding. Each route point takes
 * the attributes of the simulated row whose made-good distance covers
 * it (waypoints and rows both measure from the route start), and
 * consecutive points sharing an encoding collapse into one polyline —
 * the same segment shape {@link ribbonSegments} emits. One line on
 * the map, the route itself, colored as the plan reads: no second
 * simplified sim-track line drifting a mile or two off the route.
 *
 * Returns null when the payload carries no route geometry (here
 * mode), so the caller can fall back to the row ribbon.
 *
 * @param {Array<{lat: number, lon: number,
 *   distanceFromStartNm?: number}>} waypoints - The viewed route's
 *   sampled geometry
 * @param {Array<{distanceFromStartNm: number, lat: number, lon: number,
 *   comfortLevel: string|null, slatting: boolean, motoring: boolean,
 *   night: boolean}>} track - summary.track rows
 * @param {number|null} referenceLon - The map's longitude frame
 * @returns {Array<{points: number[][], comfortLevel: string|null,
 *   slatting: boolean, motoring: boolean, night: boolean}>|null}
 */
export function routeRibbon(waypoints, track, referenceLon = null) {
  const points = (waypoints ?? []).filter(
    (w) => Number.isFinite(w?.lat) && Number.isFinite(w?.lon),
  );
  if (points.length < 2) {
    return null;
  }
  // Route distance per point: the payload carries it from the
  // sampling; payloads without it get it recomputed along the line
  let acc = 0;
  const distances = points.map((point, i) => {
    if (Number.isFinite(point?.distanceFromStartNm)) {
      return point.distanceFromStartNm;
    }
    if (i > 0) {
      acc += greatCircleNm(
        points[i - 1].lat,
        points[i - 1].lon,
        point.lat,
        point.lon,
      );
    }
    return acc;
  });
  const rows = (track ?? [])
    .filter((row) => Number.isFinite(row?.distanceFromStartNm))
    .sort((a, b) => a.distanceFromStartNm - b.distanceFromStartNm);
  // Without row data the route still draws — one neutral stretch the
  // renderer paints in the plain route color
  const attributes = [];
  let cursor = 0;
  for (const d of distances) {
    while (
      cursor + 1 < rows.length &&
      rows[cursor + 1].distanceFromStartNm <= d
    ) {
      cursor++;
    }
    attributes.push(rows[cursor] ?? null);
  }
  const keyOf = (row) =>
    row == null
      ? "none"
      : [
          row.comfortLevel ?? "?",
          row.slatting === true ? "slat" : "calm",
          row.motoring === true ? "motor" : "sail",
          row.night === true ? "night" : "day",
        ].join("|");
  const segments = [];
  let current = null;
  let prev = referenceLon;
  for (let i = 0; i < points.length; i++) {
    let lon = points[i].lon;
    if (prev != null) {
      while (lon - prev > 180) lon -= 360;
      while (lon - prev < -180) lon += 360;
    }
    prev = lon;
    const row = attributes[i];
    const key = keyOf(row);
    if (current && current.key === key) {
      current.points.push([lon, points[i].lat]);
    } else {
      current = {
        key,
        points: [[lon, points[i].lat]],
        comfortLevel: row?.comfortLevel ?? null,
        slatting: row?.slatting === true,
        motoring: row?.motoring === true,
        night: row?.night === true,
      };
      segments.push(current);
    }
  }
  // Continuity: a segment's end is the next segment's start, so the
  // route never shows a gap at a regime change
  for (let i = segments.length - 1; i > 0; i--) {
    if (
      segments[i].points.length > 1 &&
      (segments[i - 1].points.at(-1)[0] !== segments[i].points[0][0] ||
        segments[i - 1].points.at(-1)[1] !== segments[i].points[0][1])
    ) {
      segments[i - 1].points.push([...segments[i].points[0]]);
    }
  }
  return segments.map(({ key, ...segment }) => segment);
}

/**
 * The coordinates the map's initial fit frames (work doc #47 session:
 * the fit is the route's, not the warnings'). When route geometry
 * exists the fit frames the colorized route and the events pinned to
 * it — a warning area as large as a hemisphere (a cardinal-bound box
 * down to 90°S) must not zoom the view to the pole. Without a route
 * the vessel anchors the view (see {@link vesselFitBounds}); only
 * without either do the warning shapes and storm graphics drive the
 * fit.
 *
 * @param {object} specs - The map's draw specs
 * @param {Array<{points: number[][]}>} [specs.ribbon] - Colorized
 *   route segments
 * @param {Array<{lon: number, lat: number}>} [specs.eventPins]
 * @param {{lat: number, lon: number}|null} [specs.vessel] - The
 *   vessel's position (here mode's single waypoint)
 * @param {Array<object>} [specs.storms] - Cyclone graphics
 * @param {Array<{kind: string, points: number[][]}>} [specs.shapes]
 * @param {Array<{points: number[][]}>} [specs.caps]
 * @param {Array<{lon: number, lat: number}>} [specs.pins] - Hazard
 *   pins
 * @returns {Array<[number, number]>} [lon, lat] points for the fit —
 *   exactly one when the vessel anchors the view
 */
export function fitPoints(specs = {}) {
  const ribbon = (specs.ribbon ?? []).flatMap((segment) => segment.points);
  if (ribbon.length > 0) {
    return [
      ...ribbon,
      ...(specs.eventPins ?? []).map((pin) => [pin.lon, pin.lat]),
    ];
  }
  const vessel = specs.vessel;
  if (vessel && Number.isFinite(vessel.lat) && Number.isFinite(vessel.lon)) {
    return [[vessel.lon, vessel.lat]];
  }
  return [
    ...(specs.storms ?? []).flatMap((storm) => [
      storm.center,
      ...storm.rings.flatMap((ring) => ring.points),
      ...storm.track,
      ...storm.forecastPoints.map((point) => [point.lon, point.lat]),
    ]),
    ...(specs.eventPins ?? []).map((pin) => [pin.lon, pin.lat]),
    ...(specs.shapes ?? []).flatMap((shape) =>
      shape.kind === "point" ? [shape.points[0]] : shape.points,
    ),
    ...(specs.caps ?? []).flatMap((cap) => cap.points),
    ...(specs.pins ?? []).map((pin) => [pin.lon, pin.lat]),
  ];
}

/**
 * The view box around the vessel when no route anchors the map: a
 * couple hundred miles of water in every direction, regardless of
 * screen size — fitBounds on a fabricated square beats a fixed zoom
 * level, which shows a different span on a phone than on a tablet.
 *
 * @param {{lat: number, lon: number}|null} position - The vessel
 * @param {number} [radiusNm=120] - Water shown in every direction
 * @returns {Array<[number, number]>|null} [lon, lat] box corners,
 *   null without a usable position
 */
export function vesselFitBounds(position, radiusNm = 120) {
  if (
    !position ||
    !Number.isFinite(position.lat) ||
    !Number.isFinite(position.lon)
  ) {
    return null;
  }
  const dLat = radiusNm / 60;
  const dLon = dLat / Math.max(0.2, Math.cos((position.lat * Math.PI) / 180));
  return [
    [position.lon - dLon, position.lat - dLat],
    [position.lon + dLon, position.lat + dLat],
  ];
}

/**
 * Timeline event pins for the map (work doc #47): the unified
 * timeline's own events, anchored at the position the night test
 * interpolates, carrying the same glyph the timeline row paints —
 * one map of kinds to marks, two projections of one list.
 *
 * @param {Array<{hoursFromNow: number|null, kind: string, severity:
 *   string, label: string, detail: string, position: {lat, lon}|null,
 *   timestamp: string|null}>} events - mergeTimeline output
 * @returns {Array<{index: number, lon: number, lat: number, glyph:
 *   string, label: string, detail: string, severity: string}>}
 */
export function eventPins(events, referenceLon = null) {
  const pins = [];
  for (const [index, event] of (events ?? []).entries()) {
    const position = event?.position;
    if (
      !position ||
      !Number.isFinite(position.lat) ||
      !Number.isFinite(position.lon)
    ) {
      continue; // Not placeable: rides the timeline only
    }
    const lon = unwrapFrame([[position.lon, position.lat]], referenceLon)[0][0];
    pins.push({
      index,
      lon,
      lat: position.lat,
      glyph: kindGlyph(event.kind),
      label: event.label ?? "",
      detail: event.detail ?? "",
      severity: event.severity ?? "info",
    });
  }
  return pins;
}

/**
 * The NHC-style cyclone graphic for an advisory block (work doc #47
 * phase 3): the present wind/seas quadrant rings, the forecast track
 * and each forecast position — all from the `block.storm` object the
 * engine's advisory parser already computed (the quadrant-arc rings
 * arrive as ready polygons; nothing is re-derived here). Null for
 * text-only storm declarations (the NFFN style keeps its plain
 * point marker).
 *
 * @param {{storm?: {center: {lat: number, lon: number}, stormName?:
 *   string|null, severityLabel?: string|null, fields?: Array<{label:
 *   string, threshold: number, kind: string, geometry?: {type:
 *   string, coordinates: number[][]}}>, forecastPoints?: Array<{lat:
 *   number, lon: number, validText: string|null, maxWindKt: number|
 *   null}>}}} block
 * @param {number} index - Block index in the console (click-through)
 * @param {number|null} referenceLon - The map's longitude frame
 * @returns {{index: number, name: string|null, severityLabel: string|
 *   null, center: number[], rings: Array<{label: string, threshold:
 *   number, kind: string, points: number[][]}>, track: number[][],
 *   forecastPoints: Array<{lon: number, lat: number, label: string|
 *   null, maxWindKt: number|null}>}|null}
 */
export function stormGraphic(block, index, referenceLon = null) {
  const storm = block?.storm;
  if (
    !storm ||
    !Number.isFinite(storm.center?.lat) ||
    !Number.isFinite(storm.center?.lon)
  ) {
    return null;
  }
  const center = [
    unwrapFrame([[storm.center.lon, storm.center.lat]], referenceLon)[0][0],
    storm.center.lat,
  ];
  const rings = (storm.fields ?? [])
    .filter((field) => field?.geometry?.type === "polygon")
    .map((field) => ({
      label: field.label ?? "",
      threshold: field.threshold,
      kind: field.kind,
      points: unwrapFrame(field.geometry.coordinates ?? [], referenceLon),
    }))
    .filter((ring) => ring.points.length > 0);
  // The forecast track unwraps sequentially — each position takes
  // the representative nearest its predecessor, so the line follows
  // the storm across the seam without a 360° snap
  const track = [center];
  const forecastPoints = [];
  for (const point of storm.forecastPoints ?? []) {
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lon)) {
      continue;
    }
    const lon = unwrapFrame([[point.lon, point.lat]], track.at(-1))[0][0];
    track.push([lon, point.lat]);
    forecastPoints.push({
      lon,
      lat: point.lat,
      label: point.validText ?? null,
      maxWindKt: point.maxWindKt ?? null,
    });
  }
  return {
    index,
    name: storm.stormName ?? null,
    severityLabel: storm.severityLabel ?? null,
    center,
    rings,
    track,
    forecastPoints,
  };
}

/**
 * The ring color for one storm field: sea-state fields teal, wind
 * fields by the threshold the advisory names — 64 KT and above deep
 * red (hurricane force), 48–63 storm-force orange, 34–47
 * tropical-storm-force amber. Same severity ladder the console
 * highlights with.
 *
 * @param {{threshold: number, kind: string}} ring
 * @returns {string} CSS color
 */
export function stormRingColor(ring) {
  if (ring?.kind === "seas") {
    return "#4ec9b0";
  }
  if (ring?.threshold >= 64) {
    return "#ff3b3b";
  }
  if (ring?.threshold >= 48) {
    return "#ff8c42";
  }
  return "#ffd166";
}
