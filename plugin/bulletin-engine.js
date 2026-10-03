/**
 * Automated NAVAREA & NAVTEX filtering engine (work doc #4): turns
 * monolithic high-seas text bulletins into geographically relevant,
 * segmented blocks.
 *
 * Pipeline: strip transmission boilerplate → NAVTEX subject filter →
 * segment into semantic blocks on GMDSS anchors → extract geography
 * (coordinate chains, cardinal bounds) → spatially filter against
 * the vessel track → keep only what matters.
 *
 * Geography is computed for filtering, not drawn: blocks carry their
 * geometry type, never the polygon. Antimeridian crossings (the
 * South Pacific's `178W` next to `170E`) are handled by testing
 * longitudes in an unwrapped frame.
 *
 * Spatial tests reuse the hazard engine's ray-casting
 * (`pointInPolygon` from the shared route-sim module, ring order
 * [lat, lon]).
 *
 * Pure logic, zero dependencies, injectable fetch — unit-testable.
 *
 * @file bulletin-engine.js
 */

/** Severe weather keywords highlighted in the UI. */
const SEVERE_KEYWORDS = [
  "GALE",
  "STORM",
  "HURRICANE FORCE",
  "SQUALL",
  "VIOLENT STORM",
  "ROUGH SEAS",
  "VERY ROUGH SEAS",
  "HIGH SEAS",
  "PHENOMENAL SEAS",
];

/**
 * Retained NAVTEX B_2 subject indicators (work doc #4): A navigational
 * warnings, B gale warnings, E meteorological forecasts. The rest
 * (C ice reports, D SAR, …) is dropped for the weather briefing.
 */
const RETAINED_SUBJECTS = "ABE";

/** GMDSS section anchors that start a new semantic block. The
 * leading-dot NWS style (`.WARNINGS.`, `.SYNOPSIS AND FORECAST.`)
 * is tolerated alongside the GMDSS `PART 1` headings. */
const SECTION_ANCHORS =
  /^\.?\s*(PARTS?\s+\d+\b.*(?:WARNING|SYNOPSIS|FORECAST)|WARNINGS?|SYNOPSIS(?:\s+AND\s+FORECAST)?|FORECAST)\b/i;

/**
 * Strips transmission routing boilerplate: NAVTEX `ZCZC`/`NNNN`
 * framing, routing headers like `FQPS01 NFFN` and repeated blank
 * lines. The NAVTEX message id line (`ZCZC GA05 011200Z AUG 26`) is
 * kept — the subject filter reads it first.
 *
 * @param {string} text - Raw bulletin text
 * @returns {string} Cleaned text
 */
function stripBoilerplate(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (/^NNNN$/.test(trimmed)) {
        return false; // End-of-message frame
      }
      if (/^[A-Z]{4}\d{2}\s+[A-Z]{4}\s+\d{6}Z/.test(trimmed)) {
        return false; // Routing header (FQPS01 NFFN 011200Z AUG 26)
      }
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extracts the NAVTEX B_2 subject indicator from a message.
 * `ZCZC <B1><B2><B3><B4>`: B_1 is the broadcast station (e.g. G for
 * Nadi radio), B_2 is the subject (A navigational warnings, B gale,
 * …), B_3B_4 the serial number — so `ZCZC GA14` is subject A.
 *
 * @param {string} text
 * @returns {string|null} Subject letter (A–Z), null when not NAVTEX
 */
function navtexSubject(text) {
  const match = text.match(/\bZCZC\s+[A-Z]([A-Z])\d{2}\b/);
  return match ? match[1] : null;
}

/**
 * Decides whether a NAVTEX subject is retained for the briefing.
 * Non-NAVTEX bulletins (no subject) are always retained.
 *
 * @param {string|null} subject - B_2 indicator
 * @param {string} [retained=RETAINED_SUBJECTS] - Retained letters
 * @returns {boolean}
 */
function shouldRetainSubject(subject, retained = RETAINED_SUBJECTS) {
  if (subject == null) {
    return true;
  }
  return retained.toUpperCase().includes(subject.toUpperCase());
}

/**
 * Segments cleaned bulletin text into semantic blocks: first on
 * GMDSS section anchors (PART 1 WARNING, SYNOPSIS AND FORECAST,
 * …), then on blank lines within each section.
 *
 * @param {string} text - Cleaned bulletin text
 * @returns {string[]} Non-empty blocks
 */
function segmentBlocks(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = [];
  for (const line of lines) {
    if (SECTION_ANCHORS.test(line.trim()) && current.length > 0) {
      sections.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    sections.push(current);
  }
  // Blank-line split within sections, keeping substantive paragraphs
  const blocks = [];
  for (const section of sections) {
    let paragraph = [];
    const flush = () => {
      const text = paragraph.join("\n").trim();
      if (text.length > 0) {
        blocks.push(text);
      }
      paragraph = [];
    };
    for (const line of section) {
      if (line.trim().length === 0) {
        flush();
      } else {
        paragraph.push(line);
      }
    }
    flush();
  }
  return blocks;
}

/**
 * Parses hemisphere-suffixed coordinates: `16S` → −16, `178W` →
 * −178, `170E` → 170.
 *
 * @param {string} value - Digits
 * @param {string} hemisphere - N|S|E|W
 * @returns {number} Signed degrees
 */
function hemisphereDegrees(value, hemisphere) {
  const degrees = Number.parseFloat(value);
  if (!Number.isFinite(degrees)) {
    return NaN;
  }
  const sign = hemisphere === "S" || hemisphere === "W" ? -1 : 1;
  return sign * degrees;
}

/**
 * Extracts every coordinate pair from a block as lon/lat points,
 * without the ring bookkeeping. Hemisphere letters are optional to
 * accept the bulletin shorthand the strict form misses: the dateline
 * written as a bare `180` (`14S 180`, east by convention) and the
 * equator written as `EQT` (`EQT 177E`). Pairs where both letters
 * are missing are prose numbers ("280600 UTC", "20 TO 30 KNOTS")
 * and rejected.
 *
 * @param {string} text
 * @returns {number[][]} [[lon, lat], …] (possibly empty)
 */
function parseCoordinatePoints(text) {
  const pair = /(\d+(?:\.\d+)?|EQT)\s*([NS])?[,\s]+(\d+(?:\.\d+)?)\s*([EW])?/gi;
  const points = [];
  let match;
  while ((match = pair.exec(text)) !== null) {
    const equator = match[1].toUpperCase() === "EQT";
    const latHemi = match[2]?.toUpperCase();
    const lonHemi = match[4]?.toUpperCase();
    if (!equator && !latHemi && !lonHemi) {
      // Prose numbers, not coordinates — resume inside the rejected
      // span so it cannot swallow a following real coordinate pair
      pair.lastIndex = match.index + 1;
      continue;
    }
    const lat = equator ? 0 : hemisphereDegrees(match[1], latHemi ?? "N");
    const lon = hemisphereDegrees(match[3], lonHemi ?? "E");
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      points.push([lon, lat]);
    }
  }
  return points;
}

/**
 * Parses coordinate chains like `16S 170E 20S 178W` into a GeoJSON
 * ring (lon/lat pairs, unclosed input closed automatically).
 *
 * @param {string} text
 * @returns {number[][]|null} [[lon, lat], …] closed, or null
 */
function parseCoordinateChain(text) {
  const ring = parseCoordinatePoints(text);
  if (ring.length < 2) {
    return null;
  }
  // Two pairs form an open trough/front axis line; three or more
  // close into a polygon ring
  if (ring.length >= 3) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([...first]);
    }
  }
  return ring;
}

/**
 * Parses cardinal bounding statements (`SOUTH OF 12S AND WEST OF
 * 173W`) into a [minLon, minLat, maxLon, maxLat] box. When both an
 * east-of and a west-of bound are present the box spans east of the
 * first and west of the second — across the antimeridian when the
 * east bound is numerically greater — and maxLon is unwrapped (+360)
 * so the intersection test can treat it as a plain range. Callers
 * must not compare these longitudes against raw geo longitudes
 * directly.
 *
 * @param {string} text
 * @returns {number[]|null} [minLon, minLat, maxLon, maxLat] (maxLon
 *   may exceed 180 for seam-crossing boxes), null when no bounds
 *   found
 */
function parseCardinalBounds(text) {
  let minLat = -90;
  let maxLat = 90;
  let found = false;

  // SOUTH OF x means lat ≤ x (x becomes the box's max), NORTH OF x
  // means lat ≥ x (the box's min). The bound's own hemisphere only
  // sets its sign.
  const southOf = text.match(/SOUTH OF\s+(\d+(?:\.\d+)?)\s*([NS])/i);
  if (southOf) {
    maxLat = hemisphereDegrees(southOf[1], southOf[2].toUpperCase());
    found = true;
  }
  const northOf = text.match(/NORTH OF\s+(\d+(?:\.\d+)?)\s*([NS])/i);
  if (northOf) {
    minLat = hemisphereDegrees(northOf[1], northOf[2].toUpperCase());
    found = true;
  }

  // EAST OF x means lon ≥ x; WEST OF y means lon ≤ y. Both present:
  // the box runs from x eastwards to y (unwrapping y across the seam
  // when y < x). Only one: half a world against the fixed bound.
  const eastOf = text.match(/EAST OF\s+(\d+(?:\.\d+)?)\s*([EW])/i);
  const westOf = text.match(/WEST OF\s+(\d+(?:\.\d+)?)\s*([EW])/i);
  // NFFN phrasing: "BETWEEN 165W AND 135W" — a longitude pair
  const between = text.match(
    /BETWEEN\s+(\d+(?:\.\d+)?)\s*([EW])\s+AND\s+(\d+(?:\.\d+)?)\s*([EW])/i,
  );
  const eastBound = eastOf
    ? hemisphereDegrees(eastOf[1], eastOf[2].toUpperCase())
    : between
      ? Math.min(
          hemisphereDegrees(between[1], between[2].toUpperCase()),
          hemisphereDegrees(between[3], between[4].toUpperCase()),
        )
      : null;
  const westBound = westOf
    ? hemisphereDegrees(westOf[1], westOf[2].toUpperCase())
    : between
      ? Math.max(
          hemisphereDegrees(between[1], between[2].toUpperCase()),
          hemisphereDegrees(between[3], between[4].toUpperCase()),
        )
      : null;

  let minLon;
  let maxLon;
  if (eastBound != null && westBound != null) {
    minLon = eastBound;
    maxLon = westBound;
    if (maxLon < minLon) {
      maxLon += 360;
    }
    found = true;
  } else if (eastBound != null) {
    minLon = eastBound;
    maxLon = 180;
    found = true;
  } else if (westBound != null) {
    minLon = -180;
    maxLon = westBound;
    found = true;
  } else {
    minLon = -180;
    maxLon = 180;
  }
  return found ? [minLon, minLat, maxLon, maxLat] : null;
}

/**
 * Synoptic feature declarations the named-bound resolution
 * recognizes: `TROUGH T1`, `COLD FRONT CF`, `LOW PRESSURE L`, … The
 * name must carry a digit or be one of the conventional CF, L, H so
 * prose ("TROUGH AXIS") is not mistaken for a name.
 */
const FEATURE_DECLARATION =
  /^(?:TROUGH|COLD FRONT|WARM FRONT|SHEAR LINE|RIDGE|LOW(?:\s+PRESSURE)?|HIGH)\s+([A-Z]\d+|CF|L|H)\b/i;

/** Name-shaped token referenced by cardinal bounds. */
const FEATURE_NAME = "(CF|L|H|[A-Z]\\d+)";

/**
 * Collects named synoptic features from a full bulletin: blocks that
 * declare a feature and carry its defining coordinate chain —
 * `COLD FRONT CF 16S 150W 20S 140W 25S 132W` — mapped name →
 * chain. Later blocks reference these by name in their bounds
 * ("WEST OF CF", "BETWEEN 150W AND CF").
 *
 * @param {string} text - Cleaned bulletin text
 * @returns {Map<string, number[][]>} name → [[lon, lat], …]
 */
function collectFeatures(text) {
  const features = new Map();
  for (const block of segmentBlocks(text)) {
    const match = block.trim().match(FEATURE_DECLARATION);
    if (!match || features.has(match[1].toUpperCase())) {
      continue;
    }
    const points = parseCoordinatePoints(block);
    if (points.length > 0) {
      features.set(match[1].toUpperCase(), points);
    }
  }
  return features;
}

/**
 * Clips a polyline to a latitude band, interpolating where segments
 * cross the band edges, so composed feature polygons never extend
 * past the block's stated latitude bounds. A chain entirely outside
 * the band is kept unchanged (its ends still anchor the caps).
 *
 * @param {number[][]} pts - [[lon, lat], …]
 * @param {number} minLat
 * @param {number} maxLat
 * @returns {number[][]} Clipped chain
 */
function clipChainToLatBand(pts, minLat, maxLat) {
  if (pts.length === 0) {
    return pts;
  }
  const inside = (lat) => lat <= maxLat && lat >= minLat;
  const out = [];
  if (inside(pts[0][1])) {
    out.push(pts[0]);
  }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (inside(a[1]) !== inside(b[1])) {
      const bound = inside(b[1])
        ? a[1] > maxLat
          ? maxLat
          : minLat
        : b[1] > maxLat
          ? maxLat
          : minLat;
      const t = (bound - a[1]) / (b[1] - a[1]);
      out.push([a[0] + (b[0] - a[0]) * t, bound]);
    }
    if (inside(b[1])) {
      out.push(b);
    }
  }
  return out.length > 0 ? out : pts;
}

/**
 * Builds the polygon for bounds that reference a named feature
 * instead of a longitude — `SOUTH OF 09S AND WEST OF CF`, `SOUTH OF
 * 10S, BETWEEN 150W AND CF`. The feature's chain forms the slanted
 * edge, clipped to the block's latitude bounds; the open side closes
 * on the BETWEEN meridian when one is given, otherwise on the
 * antimeridian extended a margin past the seam so areas west of a
 * front still match vessels in the western Pacific. The front's
 * trend south of its last point is approximated by its end meridian.
 *
 * @param {string} text - Block text
 * @param {Map<string, number[][]>} features - `collectFeatures` map
 * @returns {{type: "polygon", coordinates: number[][]}|null} Closed
 *   ring, or null when no known feature is referenced (caller falls
 *   back to the numeric bbox path)
 */
function composeFeatureBounds(text, features) {
  const southOf = text.match(/SOUTH OF\s+(\d+(?:\.\d+)?)\s*([NS])/i);
  const northOf = text.match(/NORTH OF\s+(\d+(?:\.\d+)?)\s*([NS])/i);
  if (!southOf && !northOf) {
    return null; // Feature refs come as area phrases with a lat bound
  }
  const maxLat = southOf
    ? hemisphereDegrees(southOf[1], southOf[2].toUpperCase())
    : 90;
  const minLat = northOf
    ? hemisphereDegrees(northOf[1], northOf[2].toUpperCase())
    : -90;

  // Which side of which feature: WEST OF/EAST OF name, or BETWEEN a
  // meridian and a name (the name is then the opposite bound).
  const westOf = text.match(new RegExp(`WEST OF\\s+${FEATURE_NAME}\\b`, "i"));
  const eastOf = text.match(new RegExp(`EAST OF\\s+${FEATURE_NAME}\\b`, "i"));
  const betweenMeridianName = text.match(
    new RegExp(
      `BETWEEN\\s+\\d+(?:\\.\\d+)?\\s*[EW]\\s+AND\\s+${FEATURE_NAME}\\b`,
      "i",
    ),
  );
  const betweenNameMeridian = text.match(
    new RegExp(
      `BETWEEN\\s+${FEATURE_NAME}\\s+AND\\s+\\d+(?:\\.\\d+)?\\s*[EW]`,
      "i",
    ),
  );
  const meridianMatch = text.match(/BETWEEN\s+(\d+(?:\.\d+)?)\s*([EW])/i);

  let feature = null;
  let side = null; // Region lies on this side of the feature
  let meridian = null; // Explicit meridian closing the open side
  if (westOf && features.has(westOf[1].toUpperCase())) {
    feature = features.get(westOf[1].toUpperCase());
    side = "west";
  } else if (eastOf && features.has(eastOf[1].toUpperCase())) {
    feature = features.get(eastOf[1].toUpperCase());
    side = "east";
  } else if (
    betweenMeridianName &&
    features.has(betweenMeridianName[1].toUpperCase())
  ) {
    feature = features.get(betweenMeridianName[1].toUpperCase());
    side = "west";
    meridian = hemisphereDegrees(
      meridianMatch[1],
      meridianMatch[2].toUpperCase(),
    );
  } else if (
    betweenNameMeridian &&
    features.has(betweenNameMeridian[1].toUpperCase())
  ) {
    feature = features.get(betweenNameMeridian[1].toUpperCase());
    side = "east";
    meridian = hemisphereDegrees(
      meridianMatch[1],
      meridianMatch[2].toUpperCase(),
    );
  }
  if (!feature) {
    return null; // Unknown name: fall back to the numeric bbox path
  }

  // Unwrap the chain into a contiguous frame and orient it
  // north-end-first so the caps attach to the right ends
  const lons = [feature[0][0]];
  for (let i = 1; i < feature.length; i++) {
    lons.push(unwrapLon(feature[i][0], lons[i - 1]));
  }
  let pts = feature.map(([, lat], i) => [lons[i], lat]);
  if (pts.length > 1 && pts[0][1] < pts[pts.length - 1][1]) {
    pts = [...pts].reverse();
  }
  pts = clipChainToLatBand(pts, minLat, maxLat);
  const first = pts[0];
  const last = pts[pts.length - 1];
  const center = (Math.min(...lons) + Math.max(...lons)) / 2;
  let openLon;
  if (meridian != null) {
    openLon = unwrapLon(meridian, center);
  } else if (side === "west") {
    // West of the front reaches across the seam: the antimeridian
    // plus a margin so 170E–180E vessels stay inside the area
    openLon = unwrapLon(-180, center) - 60;
  } else {
    openLon = unwrapLon(180, center) + 60;
  }

  const ring = [
    [first[0], maxLat],
    ...pts,
    [last[0], minLat],
    [openLon, minLat],
    [openLon, maxLat],
  ];
  if (
    ring[0][0] !== ring[ring.length - 1][0] ||
    ring[0][1] !== ring[ring.length - 1][1]
  ) {
    ring.push([...ring[0]]);
  }
  return { type: "polygon", coordinates: ring };
}

/**
 * Extracts the geographic geometry of a block: coordinate chain
 * first (polygon), cardinal bounds second (bbox). Front/trough
 * "axis" chains are lines, with the warning living in a band around
 * them ("WITHIN 120NM EAST OF AXIS") — when the text declares a
 * distance the geometry carries `bufferNm` so the intersection test
 * expands to the band instead of the bare line.
 *
 * Bounds referencing a named feature collected by `collectFeatures`
 * ("WEST OF CF") resolve to a composed polygon; with no such feature
 * known they fall back to the numeric bbox path.
 *
 * @param {string} blockText
 * @param {Map<string, number[][]>} [features] - `collectFeatures` map
 * @returns {{type: "polygon", coordinates: number[][], bufferNm?: number}|
 *   {type: "bbox", coordinates: number[]}|null}
 */
function extractGeometry(blockText, features = new Map()) {
  const bandMatch = blockText.match(
    /WITHIN\s+(\d+(?:\.\d+)?)\s*(?:NM|NAUTICAL\s+MILES?)\b/i,
  );
  const bufferNm = bandMatch ? Number.parseFloat(bandMatch[1]) : null;
  const polygon = parseCoordinateChain(blockText);
  if (polygon) {
    return {
      // Two coordinate pairs are a trough/front axis line, three or
      // more close into an area polygon
      type: polygon.length === 2 ? "line" : "polygon",
      coordinates: polygon,
      ...(bufferNm != null ? { bufferNm } : {}),
    };
  }
  const featurePolygon = composeFeatureBounds(blockText, features);
  if (featurePolygon) {
    return featurePolygon;
  }
  const bbox = parseCardinalBounds(blockText);
  if (bbox) {
    return { type: "bbox", coordinates: bbox };
  }
  return null;
}

/**
 * Unwraps a longitude for antimeridian-safe comparison: returns a
 * candidate ≥ reference choosing the representative closest to it
 * (lon or lon ± 360).
 *
 * @param {number} lon
 * @param {number} reference
 * @returns {number}
 */
function unwrapLon(lon, reference) {
  let value = lon;
  while (value - reference > 180) {
    value -= 360;
  }
  while (reference - value > 180) {
    value += 360;
  }
  return value;
}

/**
 * Ray-casting containment for a GeoJSON ring (lon/lat, closed or
 * unclosed). The ring is unwrapped against itself once (sequential
 * shortest-arc), so a polygon spanning the antimeridian stays
 * contiguous; the query longitude is brought into that frame via
 * its nearest representative.
 *
 * @param {number[][]} ring - [[lon, lat], …]
 * @param {number} lon
 * @param {number} lat
 * @returns {boolean}
 */
function ringContains(ring, lon, lat) {
  if (ring.length === 0) {
    return false;
  }
  // Unwrap the ring in its own frame (running shortest-arc)
  const lons = [ring[0][0]];
  for (let i = 1; i < ring.length; i++) {
    lons.push(unwrapLon(ring[i][0], lons[i - 1]));
  }
  // Bring the query into the ring's frame
  const center = (Math.min(...lons) + Math.max(...lons)) / 2;
  const query = unwrapLon(lon, center);

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = lons[i];
    const yi = ring[i][1];
    const xj = lons[j];
    const yj = ring[j][1];
    const intersects =
      yi > lat !== yj > lat &&
      query < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Tests whether a polygon intersects any of the track points
 * (midpoints included, so a track leg through a small polygon is
 * caught even with sparse waypoints).
 *
 * @param {number[][]} ring - GeoJSON ring [[lon, lat], …]
 * @param {number[][]} track - Track points [[lon, lat], …]
 * @returns {boolean}
 */
function polygonIntersectsTrack(ring, track) {
  if (track.length === 0) {
    return false;
  }
  const points = [];
  for (let i = 0; i < track.length; i++) {
    points.push(track[i]);
    if (i > 0) {
      points.push([
        (track[i - 1][0] + track[i][0]) / 2,
        (track[i - 1][1] + track[i][1]) / 2,
      ]);
    }
  }
  return points.some(([lon, lat]) => ringContains(ring, lon, lat));
}

/**
 * Tests whether a bbox intersects the track, with antimeridian
 * wrap: a point matches when its longitude (or longitude ± 360)
 * falls inside the box's lon range.
 *
 * @param {number[]} bbox - [minLon, minLat, maxLon, maxLat]
 * @param {number[][]} track - Track points [[lon, lat], …]
 * @returns {boolean}
 */
function bboxIntersectsTrack(bbox, track) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return track.some(([lon, lat]) => {
    if (lat < Math.min(minLat, maxLat) || lat > Math.max(minLat, maxLat)) {
      return false;
    }
    for (const candidate of [lon, lon + 360, lon - 360]) {
      if (
        candidate >= Math.min(minLon, maxLon) &&
        candidate <= Math.max(minLon, maxLon)
      ) {
        return true;
      }
    }
    return false;
  });
}

/**
 * Whether a block's geometry intersects the track. Blocks without
 * extractable geometry are kept (cannot be placed — a conservative
 * miss beats silently losing a warning). Axis-line polygons with a
 * declared band ("WITHIN 120NM") expand their bounding box by the
 * band before the test: the warning area is the band, not the line.
 *
 * @param {{type: "polygon"|"bbox", coordinates: number[][]|number[],
 *   bufferNm?: number}}|null geometry
 * @param {number[][]} track - Track points [[lon, lat], …]
 * @returns {boolean} True when the block should be kept
 */
function intersectsTrack(geometry, track) {
  if (!geometry) {
    return true;
  }
  if (track.length === 0) {
    return true;
  }
  if (geometry.type === "polygon" || geometry.type === "line") {
    if (polygonIntersectsTrack(geometry.coordinates, track)) {
      return true;
    }
    // Band expansion for axis lines and WITHIN-nm areas. Chains that
    // cross the antimeridian are unfolded into a continuous frame and
    // track longitudes are tested in all three representations.
    if (geometry.bufferNm > 0) {
      const lats = geometry.coordinates.map(([, lat]) => lat);
      const meanLat =
        ((Math.min(...lats) + Math.max(...lats)) / 2) * (Math.PI / 180);
      const latPad = geometry.bufferNm / 60;
      const lonPad = latPad / Math.max(0.2, Math.cos(meanLat));
      const unfolded = [];
      let prev = null;
      for (const [lon] of geometry.coordinates) {
        let value = prev == null ? lon : lon;
        if (prev != null) {
          while (value - prev > 180) {
            value -= 360;
          }
          while (value - prev < -180) {
            value += 360;
          }
        }
        unfolded.push(value);
        prev = value;
      }
      const minLon = Math.min(...unfolded) - lonPad;
      const maxLon = Math.max(...unfolded) + lonPad;
      const minLat = Math.min(...lats) - latPad;
      const maxLat = Math.max(...lats) + latPad;
      return track.some(([lon, lat]) =>
        [0, 360, -360].some((shift) => {
          const shifted = lon + shift;
          return (
            shifted >= minLon &&
            shifted <= maxLon &&
            lat >= minLat &&
            lat <= maxLat
          );
        }),
      );
    }
    return false;
  }
  if (geometry.type === "bbox") {
    return bboxIntersectsTrack(geometry.coordinates, track);
  }
  return true;
}

/**
 * Extracts the issuing authority from a bulletin's text (work doc #12
 * provenance): GMDSS bulletins name their service in the header block,
 * e.g. "ISSUED BY FIJI METEOROLOGICAL SERVICE SEP 270800 UTC." The
 * name is captured verbatim, minus the trailing issue-time fragment
 * and punctuation. Null when the bulletin does not name an issuer
 * (structured UKHO warnings, some NWS products) — consumers then fall
 * back to the publishing plugin.
 *
 * @param {string} text - Raw or cleaned bulletin text
 * @returns {string|null} Issuer name, e.g. "FIJI METEOROLOGICAL SERVICE"
 */
function extractIssuer(text) {
  const match = text.match(/ISSUED\s+BY\s+(.+)/i);
  if (!match) {
    return null;
  }
  // Strip the trailing issue-time fragment in its observed shapes
  // ("SEP 270800 UTC", "270800 UTC", "270800Z"), then any trailing
  // punctuation or padding the station style leaves behind. The
  // leading \s+ anchors the fragment to a word start, so a name that
  // merely ends in 3–4 letters can't be mistaken for the month token.
  const name = match[1]
    .replace(/\s+(?:[A-Z]{3,4}\.?\s+)?\d{4,10}Z?(?:\s+UTC)?\.?\s*$/i, "")
    .replace(/[.\s]+$/, "");
  return name || null;
}

/**
 * Runs the full pipeline over one raw bulletin (work doc #4 §2–4):
 * boilerplate stripping, NAVTEX subject filter, GMDSS segmentation,
 * geographic extraction and track filtering.
 *
 * @param {object} params
 * @param {string} params.rawText - Raw bulletin text
 * @param {"api"|"spool"} params.source - Ingestion source
 * @param {number[][]} [params.track] - Track points [[lon, lat], …]
 *   (route waypoints, current position first)
 * @param {string} [params.retainedSubjects] - NAVTEX B_2 letters to
 *   keep (default {@link RETAINED_SUBJECTS})
 * @param {string} [params.issuedAt] - Issue time override (spool
 *   file parsing result); extracted from the text otherwise
 * @returns {object|null} `{header, issuedAt, issuer, bulletinText,
 *   source, blocks: [{text, subject, geometryType, source}]}` — null
 *   when the whole message is discarded by the subject filter
 */
function filterBulletin({
  rawText,
  source,
  track = [],
  retainedSubjects = RETAINED_SUBJECTS,
  issuedAt,
}) {
  const subject = navtexSubject(rawText);
  if (!shouldRetainSubject(subject, retainedSubjects)) {
    return null;
  }
  const cleaned = stripBoilerplate(rawText);
  const features = collectFeatures(cleaned);
  const header = cleaned.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const blocks = segmentBlocks(cleaned)
    .map((blockText) => {
      const geometry = extractGeometry(blockText, features);
      if (!intersectsTrack(geometry, track)) {
        return null; // Discard rule: not on our waters
      }
      return {
        text: blockText,
        subject: subject ?? null,
        geometryType: geometry ? geometry.type : null,
        geometry: geometry ?? null,
        source,
      };
    })
    .filter(Boolean);

  const spoolWatcher = require("./spool-watcher.js");
  return {
    header,
    issuedAt:
      issuedAt ??
      spoolWatcher.extractIssuedAt(cleaned) ??
      new Date(0).toISOString(),
    issuer: extractIssuer(cleaned),
    bulletinText: rawText,
    source,
    blocks,
  };
}

/**
 * Pulls a remote bulletin over HTTP(S) (work doc #4 §1: the
 * online-transition triggered REST/RSS pull). The response is plain
 * text run through the same pipeline as spool files.
 *
 * @param {string} url
 * @param {object} [params]
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<string>} Raw bulletin text
 */
async function fetchRemoteBulletin(
  url,
  { fetchImpl = fetch, timeoutMs = 15000 } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: "text/plain" },
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

const API_WEATHER_GOV_TYPES =
  /^https:\/\/api\.weather\.gov\/products\/types\/([A-Z0-9]+)\/locations\/([A-Z0-9]+)/i;

/**
 * Resolves a bulletin source URL to raw text. Plain URLs are
 * fetched verbatim; `api.weather.gov` product-type URLs resolve
 * two-step (latest iteration id → product JSON) and return the
 * embedded `productText` — the NWS High Seas Forecasts.
 *
 * @param {string} url
 * @param {object} [params]
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{text: string, source: string}>} Text plus a
 *   provenance label ("api" for resolved feeds, "spool" never here)
 */
async function resolveBulletinSource(
  url,
  { fetchImpl = fetch, timeoutMs } = {},
) {
  const apiMatch = url.match(API_WEATHER_GOV_TYPES);
  if (!apiMatch) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? 15000);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: "text/plain" },
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return { text: await response.text(), source: "api" };
    } finally {
      clearTimeout(timer);
    }
  }

  // api.weather.gov: latest iteration of the product type/location
  const listUrl = `${apiMatch[0]}?limit=1`;
  const get = async (u) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? 15000);
    try {
      const response = await fetchImpl(u, {
        signal: controller.signal,
        headers: { Accept: "application/geo+json, application/json" },
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return response.json();
    } finally {
      clearTimeout(timer);
    }
  };
  const list = await get(listUrl);
  const latest = (list?.["@graph"] ?? [])[0];
  if (!latest?.id) {
    throw new Error("No product iterations available");
  }
  const product = await get(latest.id);
  const text = product?.productText;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("Product has no text");
  }
  return { text, source: "api" };
}

/**
 * Filters structured UKHO MSI warnings against the track (work doc
 * #9: coordinates feed the intersection directly, bypassing the regex
 * engine). Output blocks match the `filterBulletin` block shape so
 * both ingestion paths merge into one console.
 *
 * @param {Array<{text: string, issuedAt: string|null,
 *   coordinates: number[][]}>} warnings - `parseUkhoWarnings` output
 * @param {number[][]} track - Track points [[lon, lat], …]
 * @param {object} [options]
 * @param {string} [options.source] - Block source label
 * @returns {Array<{text: string, subject: null, geometryType: string|null,
 *   source: string}>}
 */
function ukhoBlocksFromWarnings(warnings, track, { source = "ukho" } = {}) {
  const blocks = [];
  for (const warning of warnings ?? []) {
    if (!warning?.text) {
      continue;
    }
    const geometry = ukhoGeometry(warning);
    if (!intersectsTrack(geometry, track)) {
      continue; // Same discard rule as the text pipeline
    }
    blocks.push({
      text: warning.text,
      subject: null,
      geometryType: geometry ? geometry.type : null,
      geometry: geometry ?? null,
      source,
    });
  }
  return blocks;
}

/**
 * Geometry for one normalized UKHO warning: a ring of three or more
 * coordinate pairs becomes a polygon, a single point a small bbox so
 * it still intersects by containment.
 *
 * @param {object} warning
 * @returns {object|null} `extractGeometry`-compatible shape
 */
function ukhoGeometry(warning) {
  const points = warning?.coordinates ?? [];
  if (points.length >= 3) {
    return { type: "polygon", coordinates: points };
  }
  if (points.length === 1) {
    const [lon, lat] = points[0];
    // ~3 nm point-hazard box so single coordinates intersect by
    // containment like a tiny area would
    return {
      type: "bbox",
      coordinates: [lon - 0.05, lat - 0.05, lon + 0.05, lat + 0.05],
    };
  }
  return null;
}

module.exports = {
  RETAINED_SUBJECTS,
  SEVERE_KEYWORDS,
  SECTION_ANCHORS,
  stripBoilerplate,
  navtexSubject,
  shouldRetainSubject,
  segmentBlocks,
  ukhoBlocksFromWarnings,
  hemisphereDegrees,
  parseCoordinatePoints,
  parseCoordinateChain,
  parseCardinalBounds,
  collectFeatures,
  composeFeatureBounds,
  extractGeometry,
  unwrapLon,
  ringContains,
  polygonIntersectsTrack,
  bboxIntersectsTrack,
  intersectsTrack,
  extractIssuer,
  filterBulletin,
  fetchRemoteBulletin,
  resolveBulletinSource,
};
