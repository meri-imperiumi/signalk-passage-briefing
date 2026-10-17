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

import { kindGlyph, splitSevere } from "./models.mjs";

const DEG = Math.PI / 180;

/** The severities a bulletin block can carry, highest first. */
export const SHAPE_SEVERITY = ["severe", "warn", "info"];

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
 *   bufferNm: number|null, severe: boolean, dashed: boolean}|null}
 */
export function blockShape(block, index, referenceLon = null) {
  const geometry = block?.geometry;
  if (!geometry) {
    return null;
  }
  const severe = isSevereText(block?.text);
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
