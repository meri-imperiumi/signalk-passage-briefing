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
  "HURRICANE",
  "HURRICANE FORCE",
  "CYCLONE",
  "SQUALL",
  "VIOLENT STORM",
  "ROUGH SEAS",
  "VERY ROUGH SEAS",
  "HIGH SEAS",
  "PHENOMENAL SEAS",
  "FREEZING SPRAY",
  "DENSE FOG",
  "VOLCANIC ASH",
];

/**
 * Whether a block carries a severity keyword (kept in sync with the
 * webapp's highlighter copy in `public/components/models.mjs`).
 *
 * Product and office names must not trip the keywords, or every NWS
 * masthead survives the boilerplate filter: "HIGH SEAS FORECAST"
 * would read as a HIGH SEAS warning, "NATIONAL HURRICANE CENTER"
 * as a hurricane warning.
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasSevereKeyword(text) {
  const upper = String(text ?? "")
    .toUpperCase()
    .replace(/HIGH SEAS FORECAST/g, "")
    .replace(/HURRICANE CENTER/g, "");
  return SEVERE_KEYWORDS.some((keyword) => upper.includes(keyword));
}

/**
 * Bulletin masthead titles: the product-identification text an issuer
 * prints ahead of the first section — NFFN/NZKL `MARINE WEATHER
 * BULLETIN FOR <AREA>` (with the declared-area statement riding the
 * same block or its own), NWS `HIGH SEAS FORECAST`, and MetService's
 * standalone `Area from 25S to 40S, …` statement. Metadata for the
 * headline and the declared-area parse, never a warning: the block
 * must not reach the console even when its area bounds intersect the
 * track, or the bulletin title renders as a "warning" covering the
 * issuer's whole declared area.
 */
const MASTHEAD_TITLE =
  /^(?:MARINE WEATHER BULLETIN FOR\s+\S+|HIGH SEAS FORECAST\b|AREA FROM\s+\d+(?:\.\d+)?\s*[NS]\s+TO\s+\d+(?:\.\d+)?\s*[NS])/i;

/**
 * Whether a block is the bulletin's masthead (title/area statement):
 * detected on the block's first line, since issuers fuse the area
 * statement into the title block on the wire (TGFTP single-newline
 * rendering) and the title always leads it.
 *
 * @param {string} blockText
 * @returns {boolean}
 */
function isMastheadBlock(blockText) {
  const firstLine = String(blockText ?? "")
    .split(/\r?\n/, 1)[0]
    ?.trim();
  return MASTHEAD_TITLE.test(firstLine);
}

/**
 * Console relevance radius for synoptic feature declarations (work
 * doc #57 session, Tonga→NZ): a passage hugs subarea and METAREA
 * boundaries, and the crew expects the area's weather picture — the
 * trough 300 nm ahead, the front at the far edge — on the console
 * while it is within this radius of the track. Applicability areas
 * (the WITHIN bands, the swells notes) have no such slack: their
 * geometry is exactly where the warning applies. Matches the hazard
 * radii' order of magnitude.
 */
const BULLETIN_PROXIMITY_NM = 500;

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
  /^(?:\.?\s*PARTS?\s+\d+\b.*(?:WARNING|SYNOPSIS|FORECAST)\b|\.?\s*(?:WARNINGS?|SYNOPSIS(?:\s+AND\s+FORECAST)?|FORECAST)\s*\.?\s*$)/i;

/**
 * Strips transmission routing boilerplate: NAVTEX `ZCZC`/`NNNN`
 * framing, routing headers like `FQPS01 NFFN` and repeated blank
 * lines. The NAVTEX message id line (`ZCZC GA05 011200Z AUG 26`) is
 * kept — the subject filter reads it first.
 *
 * NWS's renamed geography is normalized back to the name the crew
 * uses: "GULF OF AMERICA" reads "GULF OF MEXICO" everywhere the
 * cleaned text is shown or matched.
 *
 * @param {string} text - Raw bulletin text
 * @returns {string} Cleaned text
 */
/**
 * NWS fixed disclaimer paragraphs, stripped whole by their stable
 * opening line. These frame every High Seas Forecast (seasonal
 * coverage note, sea-state definitions, tropical-cyclone pointers);
 * they are transmission framing, not bulletin content — and with
 * HURRICANE/CYCLONE in the severity keywords they would otherwise
 * survive the boilerplate filter by enumeration.
 */
const DISCLAIMER_START =
  /^(SEAS GIVEN AS SIGNIFICANT|SUPERSEDED BY NEXT ISSUANCE|THIS HIGH SEAS FORECAST USES|FORECAST WINDS IN AND NEAR ACTIVE TROPICAL CYCLONES|ONLY YOU KNOW THE WEATHER|FOR ANY TROPICAL CYCLONE INFORMATION|ALL FORECASTS VALID OVER ICE FREE|FROM\s+[A-Z]+\s+\d+\s+TO\s+[A-Z]+\s+\d+\s*,?\s+DUE TO THE CLIMATOLOGY)/i;

function stripBoilerplate(text) {
  const kept = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      skipping = false;
      kept.push(line);
      continue;
    }
    if (/^NNNN$/.test(trimmed)) {
      continue; // End-of-message frame
    }
    if (/^\d{3,4}$/.test(trimmed)) {
      continue; // NWS product frame line ("000")
    }
    if (/^\*+$/.test(trimmed)) {
      continue; // NFFN asterisk separator rule (framing, not content)
    }
    if (/^[A-Z]{4}\d{2}\s+[A-Z]{4}\s+\d{6}Z?/.test(trimmed)) {
      continue; // Routing header (FQPS01 NFFN 011200Z AUG 26,
      // or the NWS API's bare "FZPN03 KNHC 030838")
    }
    if (!skipping && DISCLAIMER_START.test(trimmed)) {
      skipping = true; // Fixed disclaimer paragraph: drop to the blank line
      continue;
    }
    if (!skipping) {
      kept.push(line);
    }
  }
  return (
    kept
      .join("\n")
      .replace(/\bGULF OF AMERICA\b/gi, "GULF OF MEXICO")
      // The reports-request email address ("EMAIL NADITCC AT MET DOT
      // GOV DOT FJ") is administrative framing; when a multi-part
      // bulletin splits the paragraph at the part boundary the
      // fragment lands fused onto the next line ("…DOT FJTHIS WARNING
      // CANCELS…"), breaking the section anchor it precedes. Dropped
      // only in the fused form — the standalone address line stays
      // put (it rides its own block and is dropped by the filter)
      .replace(/[ \t]*AT MET DOT GOV DOT FJ(?=[A-Z])/gi, "")
      // OCR misread of the digit zero as a letter O ("NORTH OF O5S"):
      // an O directly opening a number run is always a zero in these
      // all-caps bulletins, and an unparsed latitude bound widens the
      // area to pole-to-pole
      .replace(/\bO(?=\d)/g, "0")
      // NFFN spells the hemispheres out in cyclone positions ("NEAR
      // 12.1 SOUTH 163.0 WEST", line-wrapped anywhere): contracted to
      // the letter form the coordinate and NEAR parsers expect. Only
      // the paired lat+lon form is rewritten, so prose like "5 SOUTH
      // OF T1" is left alone.
      .replace(
        /\b(\d+(?:\.\d+)?)\s+(NORTH|SOUTH)\s+(\d+(?:\.\d+)?)\s+(EAST|WEST)\b/gi,
        (_text, lat, latWord, lon, lonWord) =>
          `${lat}${latWord[0].toUpperCase()} ${lon}${lonWord[0].toUpperCase()}`,
      )
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
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
 * Segments cleaned bulletin text into sections on GMDSS section
 * anchors (PART 1 WARNING, SYNOPSIS AND FORECAST, …), then each
 * section into semantic blocks on blank lines. The preamble before
 * the first anchor is its own section.
 *
 * Bulletins wrapped in single newlines on the wire (MetService's
 * TGFTP products print each Part 2/3 sentence on its own line) split
 * additionally on `BLOCK_START_ANCHOR`: a declaration or named
 * reference starts a new block where the blank-line rendering would
 * have had a paragraph break — the engine sees the same block
 * structure whichever way the issuer typeset it.
 *
 * @param {string} text - Cleaned bulletin text
 * @returns {string[][]} Sections of non-empty blocks
 */
function segmentSections(text) {
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
  return sections.map((sectionLines) => {
    const blocks = [];
    let paragraph = [];
    const flush = () => {
      const text = paragraph.join("\n").trim();
      if (text.length > 0) {
        blocks.push(text);
      }
      paragraph = [];
    };
    for (const line of sectionLines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        flush();
        continue;
      }
      // A line starting a new declaration or named reference splits
      // here when the previous line ended a sentence — mid-sentence
      // wraps in NWS prose never split
      if (
        paragraph.length > 0 &&
        /[.:]\s*$/.test(paragraph[paragraph.length - 1]) &&
        BLOCK_START_ANCHOR.test(trimmed)
      ) {
        flush();
      }
      paragraph.push(line);
    }
    flush();
    return blocks;
  });
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
  return segmentSections(text).flat();
}

/**
 * Whether a section is a warning section: its anchor line (the
 * section's first block's first line) is a GMDSS anchor naming
 * WARNING — `PART 1 : WARNING`, `.WARNINGS.` — as opposed to the
 * synopsis/forecast sections where per-paragraph filtering is the
 * point.
 *
 * @param {string[]} sectionBlocks - One section's blocks
 * @returns {boolean}
 */
/**
 * Whether a section is a warning section: its anchor line (the
 * section's first block's first line) is a GMDSS anchor naming
 * WARNING — `PART 1 : WARNING`, `.WARNINGS.` — or the section opens
 * with a bare RSMC warning header. The part-continuation bulletins
 * (NFFN splits a gale warning across PART 2) carry no `PART n :`
 * GMDSS prefix: the header is the plain `GALE WARNING 020 ISSUED
 * FROM RSMC NADI…` line, possibly preceded by a fused admin
 * fragment, and the section must still coalesce.
 *
 * @param {string[]} sectionBlocks - One section's blocks
 * @returns {boolean}
 */
const WARNING_HEADER_ANCHOR = /\bWARNING\s+\d+\s+ISSUED\s+FROM\b/i;

function isWarningSection(sectionBlocks) {
  const anchor = sectionBlocks[0]?.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (SECTION_ANCHORS.test(anchor) && /WARNING/i.test(anchor)) {
    return true;
  }
  // No GMDSS prefix: a bare RSMC warning header inside the section's
  // first blocks types it anyway (the synopsis never carries one —
  // it references warning *numbers*, never their ISSUED FROM line)
  return sectionBlocks
    .slice(0, 3)
    .some((block) => WARNING_HEADER_ANCHOR.test(block.split(/\r?\n/, 1)[0]));
}

/**
 * Coalesces a warning section's prose fragments into their anchored
 * area block: a bare "PART 1 : WARNING GALE WARNING 004 ISSUED FROM
 * RSMC NADI…" header or an "AREA OF GALES SLOW MOVING." trailer
 * carries no geography of its own, so it must live or die with the
 * area paragraph it describes — a discarded area must not leave its
 * warning header floating on the console unanchored, and a kept one
 * should read as the complete warning.
 *
 * Anchored means the block extracts geometry of its own — including
 * cardinal-bounds areas, which carry no coordinate pairs at all
 * ("BETWEEN 107W AND 116W"); those must anchor themselves, not merge
 * into a coordinate-bearing neighbour and lose their bounds. Only
 * pure-prose fragments (no coordinate pairs at all) attach, so a
 * spliced stray point can never corrupt a neighbour's chain; a block
 * with coordinates that still places to null keeps its own
 * conservative severe-keyword keep. Sections with no anchored block
 * (a text-only warning) pass through unchanged.
 *
 * @param {string[]} sectionBlocks - One section's blocks
 * @param {Map<string, number[][]>} [features] - `collectFeatures` map
 * @returns {string[]} Blocks with fragments merged into their
 *   nearest anchored block, original order preserved
 */
function coalesceWarningBlocks(sectionBlocks, features = new Map()) {
  const anchored = [];
  const pointAnchors = [];
  sectionBlocks.forEach((block, i) => {
    const geometry = extractGeometry(block, features);
    if (geometry != null) {
      anchored.push(i);
      if (geometry.type === "point") {
        pointAnchors.push(i);
      }
    }
  });
  if (anchored.length === 0) {
    return sectionBlocks;
  }
  // Block → the anchored block it will be emitted with. Anchors own
  // themselves; attachable fragments (no coordinate pairs) join their
  // nearest anchor, ties to the earlier one — a trailer describes the
  // area above it. Coordinate-bearing blocks that place to null stay
  // unowned: they emit as their own blocks, never merged.
  // Quadrant wind-radii lines ("WITHIN 95 NAUTICAL MILES IN SE
  // QUADRANT") describe the storm, not the nearest area: they prefer
  // a declared storm's point anchor so they keep or drop with the
  // warning they belong to.
  const owner = new Map();
  for (const i of anchored) {
    owner.set(i, i);
  }
  for (let i = 0; i < sectionBlocks.length; i++) {
    if (owner.has(i) || parseCoordinatePoints(sectionBlocks[i]).length > 0) {
      continue;
    }
    const candidates =
      /QUADRANT/i.test(sectionBlocks[i]) && pointAnchors.length > 0
        ? pointAnchors
        : anchored;
    const target = candidates.reduce((best, candidate) =>
      Math.abs(candidate - i) < Math.abs(best - i) ? candidate : best,
    );
    owner.set(i, target);
  }
  const outputs = [];
  for (let i = 0; i < sectionBlocks.length; i++) {
    const anchor = owner.get(i);
    if (anchor === undefined) {
      outputs.push(sectionBlocks[i]); // Unowned: keep as its own block
      continue;
    }
    if (anchor !== i) {
      continue; // Emitted with its group's first member below
    }
    const members = [...owner.entries()]
      .filter(([, target]) => target === i)
      .map(([index]) => index)
      .sort((a, b) => a - b);
    outputs.push(members.map((index) => sectionBlocks[index]).join("\n\n"));
  }
  return outputs;
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
 * Also accepts the compact NHC Atlantic form (`13N67W`, no separator
 * between the latitude and longitude parts) by normalizing it to the
 * spaced form first — the loose pattern cannot match it because
 * there is no separator to consume.
 *
 * @param {string} text
 * @returns {number[][]} [[lon, lat], …] (possibly empty)
 */
function parseCoordinatePoints(text) {
  // Compact NHC pairs: digits + NS + digits + EW glued together
  const compact = text.replace(
    /\b(\d{1,3})([NS])(\d{1,3})([EW])\b/g,
    "$1$2 $3$4",
  );
  const pair = /(\d+(?:\.\d+)?|EQT)\s*([NS])?[,\s]+(\d+(?:\.\d+)?)\s*([EW])?/gi;
  const points = [];
  let match;
  while ((match = pair.exec(compact)) !== null) {
    const equator = match[1].toUpperCase() === "EQT";
    const latHemi = match[2]?.toUpperCase();
    const lonHemi = match[4]?.toUpperCase();
    if (!equator && !latHemi && !lonHemi) {
      // Prose numbers, not coordinates — resume inside the rejected
      // span so it cannot swallow a following real coordinate pair
      pair.lastIndex = match.index + 1;
      continue;
    }
    const lonValue = hemisphereDegrees(match[3], lonHemi ?? "E");
    if (!equator && !lonHemi && lonValue !== 180) {
      // A hemisphere-less longitude that is not the dateline
      // shorthand is prose's second number ("07N TO 31N" is two
      // latitudes, not 7N 31E) — reject it the same way
      pair.lastIndex = match.index + 1;
      continue;
    }
    const lat = equator ? 0 : hemisphereDegrees(match[1], latHemi ?? "N");
    if (Number.isFinite(lat) && Number.isFinite(lonValue)) {
      points.push([lonValue, lat]);
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
 * Eastward distance from one meridian to another, in degrees
 * [0, 360).
 *
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
function eastwardSpan(from, to) {
  return (((to - from) % 360) + 360) % 360;
}

/**
 * Clamps a parsed bounds box into the bulletin's declared area (the
 * `EQUATOR TO 25S BETWEEN 160E AND 120W` statement NFFN prints in
 * its header). Latitude clamps into the area band; longitude clamps
 * in the area's unwrapped eastward frame — both boxes treated as the
 * eastward arcs they are, so a seam-crossing pair stays contiguous —
 * and a box entirely outside the declared area returns null: the
 * prose describes other ocean's conditions. The result shifts into
 * the raw ±180 frame so callers see chart-ready coordinates.
 *
 * @param {number[]} bbox - [minLon, minLat, maxLon, maxLat]
 * @param {number[]} area - Declared area, maxLon possibly +360
 * @returns {number[]|null} Clamped box, null when disjoint
 */
function clampBoundsToArea(bbox, area) {
  const [areaMinLon, areaMinLat, areaMaxLon, areaMaxLat] = area;
  const minLat = Math.max(bbox[1], areaMinLat);
  const maxLat = Math.min(bbox[3], areaMaxLat);
  if (minLat >= maxLat) {
    return null;
  }
  // A full-circle "bound" (EAST OF x AND WEST OF x) bounds nothing
  if (eastwardSpan(bbox[0], bbox[2]) % 360 === 0) {
    return null;
  }
  // The box brought into the area's frame; a box sticking out west
  // of the area's west edge takes its other-turn representative
  let minLon = areaMinLon + eastwardSpan(areaMinLon, bbox[0]);
  let maxLon = minLon + eastwardSpan(bbox[0], bbox[2]);
  let lo = Math.max(minLon, areaMinLon);
  let hi = Math.min(maxLon, areaMaxLon);
  if (lo > hi) {
    minLon -= 360;
    maxLon -= 360;
    lo = Math.max(minLon, areaMinLon);
    hi = Math.min(maxLon, areaMaxLon);
    if (lo > hi) {
      return null;
    }
  }
  while (lo >= 180) {
    lo -= 360;
    hi -= 360;
  }
  while (lo < -180) {
    lo += 360;
    hi += 360;
  }
  return [lo, minLat, hi, maxLat];
}

/**
 * Parses the bulletin-level declared area from its header lines: the
 * `EQUATOR TO 25S BETWEEN 160E AND 120W` statement NFFN prints under
 * the bulletin title, or MetService's boundary walk (`Area from 25S
 * to 40S, western boundary from 40S 163E to 29S 170E then to 25S
 * 170E, eastern boundary 170W.`) and its flat form (`Area from 25S
 * to 55S and 170W to 120W.`). Loose cardinal bounds inside the
 * bulletin ("IN THE AREA EAST OF 170W, EXPECT MODERATE SOUTHERLY
 * SWELLS") close against this area instead of the dateline defaults,
 * so a one-sided phrase yields the issuer's waters, not half a world.
 * Scanned per line before the first section anchor; the statement
 * must carry both a latitude and a longitude bound — anything less
 * (a lone band, an issuer sentence, an ice-edge reference) is not an
 * area. Bulletins without such a statement — most NWS products state
 * their areas per section — return null and parse exactly as before.
 *
 * @param {string} text - Cleaned bulletin text
 * @returns {number[]|null} [minLon, minLat, maxLon, maxLat] with
 *   maxLon unwrapped (+360) when the area crosses the seam
 */
/**
 * MetService states its area as a boundary walk — `Area from 25S to
 * 40S, western boundary from 40S 163E to 29S 170E then to 25S 170E,
 * eastern boundary 170W.` — or flat, `Area from 25S to 55S and 170W
 * to 120W.` Either form is a latitude band plus a longitude span; the
 * walk's east meridian unwraps against the western chain so a
 * seam-crossing area reads as the eastward arc it is.
 *
 * @param {string} line - One header line
 * @param {RegExpMatchArray} latPair - The `Area from X to Y` match
 * @returns {number[]|null} [minLon, minLat, maxLon, maxLat], or null
 *   when the line states no usable longitude span
 */
function coverageFromAreaStatement(line, latPair) {
  const latA = hemisphereDegrees(latPair[1], latPair[2].toUpperCase());
  const latB = hemisphereDegrees(latPair[3], latPair[4].toUpperCase());
  const minLat = Math.min(latA, latB);
  const maxLat = Math.max(latA, latB);
  // Flat form: the longitude span is an AND/TO pair
  const flat = line.match(
    /AND\s+(\d+(?:\.\d+)?)\s*([EW])\s+TO\s+(\d+(?:\.\d+)?)\s*([EW])/i,
  );
  if (flat) {
    const a = hemisphereDegrees(flat[1], flat[2].toUpperCase());
    const b = hemisphereDegrees(flat[3], flat[4].toUpperCase());
    let east = a;
    let span = eastwardSpan(a, b);
    if (span > 180) {
      east = b;
      span = 360 - span;
    }
    return [east, minLat, east + span, maxLat];
  }
  // Boundary-walk form: the coordinate pairs on the line are the
  // western chain (the lone eastern meridian carries no latitude, so
  // it parses as no point); the eastern boundary closes east of it
  const eastern = line.match(/EASTERN BOUNDARY\s+(\d+(?:\.\d+)?)\s*([EW])/i);
  const points = parseCoordinatePoints(line);
  if (!eastern || points.length === 0) {
    return null;
  }
  const westLons = points.map(([lon]) => lon);
  const minLon = Math.min(...westLons);
  const meanLon = (minLon + Math.max(...westLons)) / 2;
  const eastLon = hemisphereDegrees(eastern[1], eastern[2].toUpperCase());
  return [minLon, minLat, unwrapLon(eastLon, meanLon), maxLat];
}

function parseCoverageArea(text) {
  for (const line of text.split(/\r?\n/)) {
    if (SECTION_ANCHORS.test(line.trim())) {
      break;
    }
    const areaFrom = line.match(
      /^AREA FROM\s+(\d+(?:\.\d+)?)\s*([NS])\s+TO\s+(\d+(?:\.\d+)?)\s*([NS])/i,
    );
    if (areaFrom) {
      const walked = coverageFromAreaStatement(line, areaFrom);
      if (walked) {
        return walked;
      }
    }
    const bbox = parseCardinalBounds(line);
    if (
      bbox &&
      bbox[1] !== -90 &&
      bbox[3] !== 90 &&
      !(bbox[0] === -180 && bbox[2] === 180)
    ) {
      return bbox;
    }
  }
  return null;
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
 * @param {number[]|null} [coverage] - The bulletin's declared area
 *   (parseCoverageArea). When present the box clamps into it:
 *   defaulted sides close at the area's edges, disjoint boxes return
 *   null. Omitted, the box keeps the dateline defaults.
 * @returns {number[]|null} [minLon, minLat, maxLon, maxLat] (maxLon
 *   may exceed 180 for seam-crossing boxes), null when no bounds
 *   found or the box sits outside the declared area
 */
function parseCardinalBounds(text, coverage = null) {
  let minLat = -90;
  let maxLat = 90;
  let found = false;

  // SOUTH OF x means lat ≤ x (x becomes the box's max), NORTH OF x
  // means lat ≥ x (the box's min). The bound's own hemisphere only
  // sets its sign. NWS bulletins abbreviate to "N OF"/"S OF" — the
  // full word is matched first so the abbreviation cannot swallow it
  // (an unmatched N OF left the band pole-to-pole and a North Pacific
  // synopsis intersected every water on its longitude band).
  const southOf = text.match(/\b(?:SOUTH|S)\s+OF\s+(\d+(?:\.\d+)?)\s*([NS])/i);
  if (southOf) {
    maxLat = hemisphereDegrees(southOf[1], southOf[2].toUpperCase());
    found = true;
  }
  const northOf = text.match(/\b(?:NORTH|N)\s+OF\s+(\d+(?:\.\d+)?)\s*([NS])/i);
  if (northOf) {
    minLat = hemisphereDegrees(northOf[1], northOf[2].toUpperCase());
    found = true;
  }
  // NFFN states the latitude band as a pair — with the occasional
  // stray "OF" ("IN THE AREA BETWEEN OF 16S AND 22S"). Longitude
  // BETWEEN pairs (EW) are matched separately below.
  const latBand = text.match(
    /BETWEEN\s+(?:OF\s+)?(\d+(?:\.\d+)?)\s*([NS])\s+AND\s+(\d+(?:\.\d+)?)\s*([NS])/i,
  );
  if (latBand) {
    const a = hemisphereDegrees(latBand[1], latBand[2].toUpperCase());
    const b = hemisphereDegrees(latBand[3], latBand[4].toUpperCase());
    minLat = Math.max(minLat, Math.min(a, b));
    maxLat = Math.min(maxLat, Math.max(a, b));
    found = true;
  }
  // The equator is a real bound in NWS area headers ("NORTH PACIFIC
  // EQUATOR TO 30N BETWEEN 140W AND 180W"), not a poleward default —
  // without this the area line parses to a pole-to-pole box that
  // intersects every water on the longitude band
  const equatorTo = text.match(/EQUATOR\s+TO\s+(\d+(?:\.\d+)?)\s*([NS])/i);
  if (equatorTo) {
    const deg = hemisphereDegrees(equatorTo[1], equatorTo[2].toUpperCase());
    if (deg >= 0) {
      minLat = Math.max(minLat, 0);
      maxLat = Math.min(maxLat, deg);
    } else {
      minLat = Math.max(minLat, deg);
      maxLat = Math.min(maxLat, 0);
    }
    found = true;
  }

  // EAST OF x means lon ≥ x; WEST OF y means lon ≤ y. Both present:
  // the box runs from x eastwards to y (unwrapping y across the seam
  // when y < x). Only one: half a world against the fixed bound.
  const eastOf = text.match(/EAST OF\s+(\d+(?:\.\d+)?)\s*([EW])/i);
  const westOf = text.match(/WEST OF\s+(\d+(?:\.\d+)?)\s*([EW])/i);
  // NFFN phrasing: "BETWEEN 165W AND 135W" — a longitude pair. The
  // pair spans the shorter (≤180°) eastward arc: "BETWEEN 160E AND
  // 120W" is the 80° Fiji arc across the seam, not the numeric
  // min/max sweep the long way through the Americas
  const between = text.match(
    /BETWEEN\s+(\d+(?:\.\d+)?)\s*([EW])\s+AND\s+(\d+(?:\.\d+)?)\s*([EW])/i,
  );
  let betweenPair = null;
  if (between) {
    const a = hemisphereDegrees(between[1], between[2].toUpperCase());
    const b = hemisphereDegrees(between[3], between[4].toUpperCase());
    let east = a;
    let span = eastwardSpan(a, b);
    if (span > 180) {
      east = b;
      span = 360 - span;
    }
    betweenPair = [east, east + span];
  }
  const eastBound = eastOf
    ? hemisphereDegrees(eastOf[1], eastOf[2].toUpperCase())
    : betweenPair
      ? betweenPair[0]
      : null;
  const westBound = westOf
    ? hemisphereDegrees(westOf[1], westOf[2].toUpperCase())
    : betweenPair
      ? betweenPair[1]
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
    // A lone east bound is a half-world ray eastward; with a known
    // declared area it closes at the area's east edge when that sits
    // within the ray, and lands outside everything otherwise
    maxLon = coverage
      ? minLon + Math.min(eastwardSpan(minLon, coverage[2]), 180)
      : 180;
    found = true;
  } else if (westBound != null) {
    maxLon = westBound;
    // Mirror image: the ray closes at the declared area's west edge
    minLon = coverage
      ? maxLon - Math.min(eastwardSpan(coverage[0], maxLon), 180)
      : -180;
    found = true;
  } else if (coverage) {
    // Latitude-only bounds: the declared area is the longitude span
    minLon = coverage[0];
    maxLon = coverage[2];
  } else {
    minLon = -180;
    maxLon = 180;
  }
  if (!found) {
    return null;
  }
  return coverage
    ? clampBoundsToArea([minLon, minLat, maxLon, maxLat], coverage)
    : [minLon, minLat, maxLon, maxLat];
}

/**
 * Synoptic feature declarations the named-bound resolution
 * recognizes: `TROUGH T1`, `COLD FRONT CF`, `LOW PRESSURE L`,
 * `CONVERGENCE ZONE CZ1`, … The name must carry a digit or be one of
 * the conventional CF, L, H so prose ("TROUGH AXIS") is not mistaken
 * for a name. Intensity modifiers ("SHALLOW LOW PRESSURE L") ride
 * ahead of the feature word — NFFN spells them out. MetService's
 * Part 2 analysis declares bare `Front F1` / `Area A1` — no cold/warm
 * qualifier, no trough word — so FRONT and AREA are declarations too;
 * the name's digit requirement keeps prose (`Area from 25S to 40S`,
 * `IN THE AREA EAST OF 170W`) from matching.
 */
const FEATURE_DECLARATION =
  /^(?:(?:SHALLOW|DEEP|INTENSE|WEAK)\s+)?(?:TROUGH|COLD FRONT|WARM FRONT|SHEAR LINE|RIDGE|CONVERGENCE ZONE|LOW(?:\s+PRESSURE)?|HIGH|FRONT|AREA)\s+([A-Z]\d+|CF|L|H)\b/i;

/**
 * Line-start anchors that begin a new semantic block even without a
 * blank line: issuers wrap bulletins in single newlines on the wire
 * (MetService TGFTP products print each Part 2/3 sentence on its own
 * line), and the sentence boundary is where the blank-line rendering
 * would have split. A feature declaration, a `WITHIN … OF <name>`
 * reference or band, a side-of-feature bound, or an Outlook header
 * starts the next sentence. Callers guard on the previous line
 * ending one (period or colon), so mid-sentence line wraps in NWS
 * prose never split; anchored so an unanchored WITHIN phrase inside
 * a longer line is prose, not a boundary.
 */
const BLOCK_START_ANCHOR = new RegExp(
  `^(?:${FEATURE_DECLARATION.source}|WITHIN\\s+(?:\\d+(?:\\.\\d+)?\\s*(?:NM|NAUTICAL\\s+MILES?)?\\s+(?:(?:NORTH|SOUTH|EAST|WEST)\\s+OF\\s+)?(?:CF|L|H|[A-Z]\\d+)|(?:CF|L|H|[A-Z]\\d+))\\b|(?:NORTH|SOUTH|EAST|WEST)\\s+OF\\s+(?:CF|L|H|[A-Z]\\d+)\\b|OUTLOOK\\b)`,
  "i",
);

/** Name-shaped token referenced by cardinal bounds. */
const FEATURE_NAME = "(CF|L|H|[A-Z]\\d+)";

/**
 * Tropical-system declarations the feature map also recognizes:
 * `TROPICAL DEPRESSION 01F`, `SEVERE TROPICAL CYCLONE KEILA`. The
 * name may lead with digits (Nadi's `01F` numbering) or be a word.
 */
const STORM_DECLARATION =
  /^(?:SEVERE\s+)?TROPICAL\s+(?:DEPRESSION|CYCLONE|STORM)\s+([A-Z0-9]{2,})\b/i;

/** Name-shaped token referenced from other blocks: prefixed storm
 * shorthand (`TD01F`), named features (`T1`, `L1`, `CF`), and word
 * storm names (`KEILA`). Only used where the matched name is then
 * resolved against the feature map, so prose that happens to match
 * the shape is left untouched. */
const FEATURE_REFERENCE =
  "T[DCS]\\s*[A-Z0-9]{2,}|[A-Z]\\d+|\\d{1,2}[A-Z]|CF|L\\d*|H\\d*|[A-Z]{3,}";

/**
 * Resolves a referenced feature name to its defining points: direct
 * map hit first, then the storm shorthand prefixes stripped (`TD01F`
 * names the system collected as `01F`).
 *
 * @param {string} name - Referenced name
 * @param {Map<string, number[][]>} features - `collectFeatures` map
 * @returns {number[][]|null}
 */
function lookupFeature(name, features) {
  const key = String(name ?? "")
    .toUpperCase()
    .replace(/\s+/g, "");
  if (features.has(key)) {
    return features.get(key);
  }
  const stripped = key.replace(/^(?:TD|TC|TS)/, "");
  return stripped !== key && features.has(stripped)
    ? features.get(stripped)
    : null;
}

/**
 * Formats a point back into bulletin coordinate shorthand, for
 * splicing named references into chains: `[-163.4, -10.1]` reads
 * `10.1S 163.4W`.
 *
 * @param {number[]} point - [lon, lat]
 * @returns {string}
 */
function formatCoordPair([lon, lat]) {
  return `${Math.abs(lat)}${lat < 0 ? "S" : "N"} ${Math.abs(lon)}${lon < 0 ? "W" : "E"}`;
}

/**
 * Rewrites chain endpoints that reference a collected feature into
 * that feature's coordinates: `TROUGH T2 FM TD01F TO 15S 166W` reads
 * as if the TD's analysed position were written out. Unresolvable
 * names are left verbatim (they parse as prose and are ignored).
 *
 * @param {string} text - Block text
 * @param {Map<string, number[][]>} features - `collectFeatures` map
 * @returns {string} Text with resolved references spliced in
 */
function resolveNamedEndpoints(text, features) {
  if (
    !features ||
    features.size === 0 ||
    !/\b(?:FM|TO|AND)\s+[A-Z0-9]/i.test(text)
  ) {
    return text;
  }
  return text.replace(
    new RegExp(`\\b(FM|TO|AND)\\s+(${FEATURE_REFERENCE})`, "gi"),
    (match, keyword, name) => {
      const points = lookupFeature(name, features);
      // Multi-point features anchor at their first point: the chain
      // endpoint convention of NFFN-style troughs
      return points ? `${keyword} ${formatCoordPair(points[0])}` : match;
    },
  );
}

/**
 * The analysed position of a declared tropical system, from its
 * declaring block: `TROPICAL DEPRESSION 01F CENTER [1000HPA] WAS
 * ANALYSED NEAR 10.1S 163.4W` → `[-163.4, -10.1]`. Falls back to the
 * block's first coordinate pair. Null when the block declares a
 * system but carries no position.
 *
 * The anchored-per-paragraph test (not the whole-block test) keeps
 * coalesced warning blocks working: they lead with the "PART 1 :
 * WARNING STORM WARNING 012" header, and a whole-block anchored test
 * would type the merged block geometry-less — dropping the whole
 * storm warning for any vessel outside the forecast line.
 *
 * @param {string} text - Block text
 * @returns {number[]|null} [lon, lat]
 */
function stormDeclarationPoint(text) {
  const declaring = String(text ?? "")
    .split(/\n\n/)
    .find((paragraph) => STORM_DECLARATION.test(paragraph.trim()));
  if (!declaring) {
    return null;
  }
  const near = declaring.match(
    /NEAR\s+(\d+(?:\.\d+)?)\s*([NS])\s+(\d+(?:\.\d+)?)\s*([EW])/i,
  );
  if (near) {
    return [
      hemisphereDegrees(near[3], near[4].toUpperCase()),
      hemisphereDegrees(near[1], near[2].toUpperCase()),
    ];
  }
  const points = parseCoordinatePoints(declaring);
  return points.length > 0 ? points[0] : null;
}

/**
 * Geometry for a block that distances itself from a collected
 * feature: `WITHIN 180 NAUTICAL MILES OF TD01F`. A single-point
 * feature (a storm centre) becomes a padded bbox; a chain feature
 * (a trough referenced from its own block) keeps its line with the
 * stated band. Null when no buffer is stated or no feature resolves.
 *
 * @param {string} text - Block text
 * @param {Map<string, number[][]>} features - `collectFeatures` map
 * @param {number|null} bufferNm - Stated band width
 * @returns {object|null} `extractGeometry`-compatible shape
 */
function stormReferenceGeometry(text, features, bufferNm) {
  if (bufferNm == null) {
    return null;
  }
  const match = text.match(
    new RegExp(
      `\\b(?:OF|AROUND)\\s+(?:(?:SEVERE\\s+)?TROPICAL\\s+(?:CYCLONE|STORM|DEPRESSION|HURRICANE|TYPHOON)\\s+)?(${FEATURE_REFERENCE})\\b`,
      "i",
    ),
  );
  if (!match) {
    return null;
  }
  const points = lookupFeature(match[1], features);
  if (!points) {
    return null;
  }
  if (points.length === 1) {
    const [lon, lat] = points[0];
    // "WITHIN 300 NAUTICAL MILES OF TC WATI CENTRE" reads as a circle
    // on the chart, not a square (work doc #47 session): the quadrant
    // ring builder with four equal radii is exactly that circle
    return quadrantRing({
      lat,
      lon,
      radiiNm: {
        ne: bufferNm,
        se: bufferNm,
        sw: bufferNm,
        nw: bufferNm,
      },
    });
  }
  return { type: "line", coordinates: points, bufferNm };
}

/**
 * Closes a feature chain into a strip of the stated width on the
 * stated side of it: `Within 180 nautical miles south of F1` is the
 * band between the front axis and the parallel 180 nm south of it —
 * the chain offset by the band on one side, not a ring around it.
 * The ring keeps the chain's unwrapped frame, so seam-crossing fronts
 * compose contiguous strips.
 *
 * @param {number[][]} points - Feature chain [[lon, lat], …]
 * @param {string} side - NORTH|SOUTH|EAST|WEST (as matched, uppercased)
 * @param {number} bandNm - Stated band width
 * @returns {{type: "polygon", coordinates: number[][]}} Closed ring
 */
function sideBandPolygon(points, side, bandNm) {
  const lats = points.map(([, lat]) => lat);
  const meanLat =
    ((Math.min(...lats) + Math.max(...lats)) / 2) * (Math.PI / 180);
  const bandDeg = bandNm / 60;
  const offset = ([lon, lat]) => {
    if (side === "NORTH") {
      return [lon, lat + bandDeg];
    }
    if (side === "SOUTH") {
      return [lon, lat - bandDeg];
    }
    const dlon = bandDeg / Math.max(0.2, Math.cos(meanLat));
    return side === "EAST" ? [lon + dlon, lat] : [lon - dlon, lat];
  };
  const ring = [...points, ...[...points].reverse().map(offset)];
  ring.push([...ring[0]]);
  return { type: "polygon", coordinates: ring };
}

/**
 * Geometry for a block that bounds itself against a collected feature
 * by distance AND side — `Within 180 nautical miles south of F1:` —
 * or that references a collected area outright: `Within A1:`. The
 * side-band form is a one-sided strip (sideBandPolygon); the named
 * form is the feature's own ring. A distance with no side keeps the
 * symmetric handling of the storm-reference path; null otherwise so
 * the caller falls through the other geometry paths.
 *
 * @param {string} text - Block text
 * @param {Map<string, number[][]>} features - `collectFeatures` map
 * @returns {object|null} `extractGeometry`-compatible shape
 */
function featureReferenceGeometry(text, features) {
  if (!features || features.size === 0) {
    return null;
  }
  // "Within 180 nautical miles south of F1": the name rides the band
  // match, so the side token must sit between the distance and it —
  // "WITHIN 090 NAUTICAL MILES OF T1" (no side) matches the distance
  // group but resolves side-null and defers to the symmetric path
  const band = text.match(
    /\bWITHIN\s+(\d+(?:\.\d+)?)\s*(?:NM|NAUTICAL\s+MILES?)?\s+(?:(NORTH|SOUTH|EAST|WEST)\s+OF\s+)?((?:CF|L|H|[A-Z]\d+))\b/i,
  );
  if (band) {
    const [, distance, side, name] = band;
    const points = lookupFeature(name, features);
    if (!points) {
      return null;
    }
    const bufferNm = Number.parseFloat(distance);
    if (!side) {
      return null; // Symmetric band: storm-reference path's shape
    }
    if (points.length === 1) {
      const [lon, lat] = points[0];
      return quadrantRing({
        lat,
        lon,
        radiiNm: { ne: bufferNm, se: bufferNm, sw: bufferNm, nw: bufferNm },
      });
    }
    return sideBandPolygon(points, side.toUpperCase(), bufferNm);
  }
  // "Within A1": the collected area's own ring
  const named = text.match(
    new RegExp(`\\bWITHIN\\s+(${FEATURE_NAME})\\b`, "i"),
  );
  if (named) {
    const points = lookupFeature(named[1], features);
    if (!points || points.length < 2) {
      return null;
    }
    const ring = [...points];
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([...first]);
    }
    return { type: "polygon", coordinates: ring };
  }
  return null;
}

/**
 * Collects named synoptic features from a full bulletin: blocks that
 * declare a feature and carry its defining coordinate chain —
 * `COLD FRONT CF 16S 150W 20S 140W 25S 132W` — mapped name →
 * chain. Tropical systems (`TROPICAL DEPRESSION 01F … NEAR 10.1S
 * 163.4W`) are collected as single points under both the bare name
 * and the `TD`/`TC`/`TS` prefixed shorthands other blocks reference.
 * Later blocks reference these by name in their bounds ("WEST OF
 * CF", "BETWEEN 150W AND CF", "WITHIN 180 NM OF TD01F").
 *
 * @param {string} text - Cleaned bulletin text
 * @returns {Map<string, number[][]>} name → [[lon, lat], …]
 */
function collectFeatures(text) {
  const features = new Map();
  for (const block of segmentBlocks(text)) {
    const trimmed = block.trim();
    const storm = trimmed.match(STORM_DECLARATION);
    if (storm) {
      const point = stormDeclarationPoint(block);
      if (point) {
        const key = storm[1].toUpperCase();
        features.set(key, [point]);
        for (const prefix of ["TD", "TC", "TS"]) {
          features.set(`${prefix}${key}`, [point]);
        }
      }
      continue;
    }
    const match = trimmed.match(FEATURE_DECLARATION);
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
 * 10S, BETWEEN 150W AND CF`, or MetService's bare `East of F2:`. The
 * feature's chain forms the slanted edge, clipped to the block's
 * latitude bounds — explicit digits when the phrase states them,
 * the feature's own latitudinal extent when it does not; the open
 * side closes on the BETWEEN meridian when one is given, otherwise
 * on the antimeridian extended a margin past the seam so areas west
 * of a front still match vessels in the western Pacific. The front's
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
  // Latitude bounds: explicit digits win; the opposite unstated side
  // keeps its poleward default. A bare side-of-feature phrase
  // (MetService Part 3: `East of F2:`) states neither — the band is
  // where the feature itself lives, not the whole bulletin area
  const maxLat = southOf
    ? hemisphereDegrees(southOf[1], southOf[2].toUpperCase())
    : northOf
      ? 90
      : Math.max(...feature.map(([, lat]) => lat));
  const minLat = northOf
    ? hemisphereDegrees(northOf[1], northOf[2].toUpperCase())
    : southOf
      ? -90
      : Math.min(...feature.map(([, lat]) => lat));

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
 * The declared-area coverage (parseCoverageArea) clamps only the
 * numeric bbox path: chains, axis bands and storm points carry the
 * issuer's own precise coordinates, which may legitimately sit
 * outside the stated bulletin area.
 *
 * @param {string} blockText
 * @param {Map<string, number[][]>} [features] - `collectFeatures` map
 * @param {number[]|null} [coverage] - Bulletin's declared area
 * @returns {{type: "polygon", coordinates: number[][], bufferNm?: number}|
 *   {type: "bbox", coordinates: number[]}|null}
 */
function extractGeometry(blockText, features = new Map(), coverage = null) {
  // A storm declaration block is its own geometry: the analysed
  // position of the named system, typed "point". Declarations are
  // found per paragraph, so a coalesced block leading with the
  // "PART 1 : WARNING STORM WARNING 012" header still types as its
  // storm's point.
  const stormPoint = stormDeclarationPoint(blockText);
  if (stormPoint) {
    return { type: "point", coordinates: stormPoint };
  }
  const bandMatch = blockText.match(
    /WITHIN\s+(\d+(?:\.\d+)?)\s*(?:NM|NAUTICAL\s+MILES?)\b/i,
  );
  const bufferNm = bandMatch ? Number.parseFloat(bandMatch[1]) : null;
  // Chain endpoints may name a collected feature ("… TO TD01F",
  // "FM TD01F TO 15S 166W"): splice its position into the chain
  const polygon = parseCoordinateChain(
    resolveNamedEndpoints(blockText, features),
  );
  if (polygon) {
    return {
      // Two coordinate pairs are a trough/front axis line, three or
      // more close into an area polygon
      type: polygon.length === 2 ? "line" : "polygon",
      coordinates: polygon,
      ...(bufferNm != null ? { bufferNm } : {}),
    };
  }
  // "WITHIN 180 NAUTICAL MILES OF TD01F": the block distances itself
  // from a collected feature instead of carrying coordinates. A stated
  // SIDE (MetService: "Within 180 nautical miles south of F1") or a
  // bare named area ("Within A1") is one-sided and resolves first —
  // the symmetric band must not swallow the side
  const sideReference = featureReferenceGeometry(blockText, features);
  if (sideReference) {
    return sideReference;
  }
  const reference = stormReferenceGeometry(blockText, features, bufferNm);
  if (reference) {
    return reference;
  }
  const featurePolygon = composeFeatureBounds(blockText, features);
  if (featurePolygon) {
    return featurePolygon;
  }
  const bbox = parseCardinalBounds(blockText, coverage);
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
/**
 * Whether a block's geometry intersects the track. Blocks without
 * extractable geometry are kept (cannot be placed — a conservative
 * miss beats silently losing a warning). Axis-line polygons with a
 * declared band ("WITHIN 120NM") expand their bounding box by the
 * band before the test: the warning area is the band, not the line.
 * A proximity radius (feature declarations near an area boundary)
 * widens the test the same way, never below the block's own band.
 *
 * @param {{type: "polygon"|"bbox", coordinates: number[][]|number[],
 *   bufferNm?: number}}|null geometry
 * @param {number[][]} track - Track points [[lon, lat], …]
 * @param {number} [proximityNm] - Console relevance radius around the
 *   geometry's own extent
 * @returns {boolean} True when the block should be kept
 */
function intersectsTrack(geometry, track, proximityNm = 0) {
  if (!geometry) {
    return true;
  }
  if (track.length === 0) {
    return true;
  }
  // Named-system declarations plot as a point and are kept wherever
  // the track is: a depression may develop or head toward the route
  if (geometry.type === "point") {
    return true;
  }
  if (geometry.type === "polygon" || geometry.type === "line") {
    if (polygonIntersectsTrack(geometry.coordinates, track)) {
      return true;
    }
    // Band expansion for axis lines and WITHIN-nm areas. Chains that
    // cross the antimeridian are unfolded into a continuous frame and
    // track longitudes are tested in all three representations. The
    // radius is the wider of the block's own declared band and the
    // caller's proximity: a 540 nm swell band keeps its full width,
    // a bare trough axis gains the console's relevance radius.
    const bandNm = Math.max(geometry.bufferNm ?? 0, proximityNm);
    if (bandNm > 0) {
      const lats = geometry.coordinates.map(([, lat]) => lat);
      const meanLat =
        ((Math.min(...lats) + Math.max(...lats)) / 2) * (Math.PI / 180);
      const latPad = bandNm / 60;
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
    // NHC High Seas style: ".FORECASTER DELGADO. NATIONAL HURRICANE
    // CENTER." — the forecaster's surname stands in for the issuer
    const forecaster = text.match(/\bFORECASTER\s+([A-Z][A-Z .'-]+)/i);
    return forecaster ? forecaster[1].replace(/[.\s]+$/, "") : null;
  }
  // Strip the trailing issue-time fragment in its observed shapes
  // ("SEP 270800 UTC", "270800 UTC", "270800Z"), then any trailing
  // punctuation or padding the station style leaves behind. The
  // leading \s+ anchors the fragment to a word start, so a name that
  // merely ends in 3–4 letters can't be mistaken for the month token.
  const name = match[1]
    .replace(/\s+(?:[A-Z]{3,4}\.?\s+)?\d{4,10}Z?(?:\s+UTC)?\.?\s*$/i, "")
    .replace(/^[Tt][Hh][Ee]\s+/, "")
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
/**
 * Builds a quadrant-arc ring around a storm center (work doc #21):
 * walking bearings 0..360°, each 90° quadrant carries its own radius
 * (NE/SE/SW/NW), the four arcs join into one closed ring. A zero or
 * missing radius collapses that quadrant's arc onto the center — the
 * NHC "0SW" case — without breaking the ring. Points are [lon, lat].
 *
 * @param {object} params
 * @param {number} params.lat - Center latitude
 * @param {number} params.lon - Center longitude
 * @param {{ne: number, se: number, sw: number, nw: number}} params.radiiNm
 * @returns {number[][]|null} Closed ring, null when every radius is
 *   zero (no area to draw)
 */
function quadrantRing({ lat, lon, radiiNm }) {
  const radii = [
    radiiNm?.ne ?? 0,
    radiiNm?.se ?? 0,
    radiiNm?.sw ?? 0,
    radiiNm?.nw ?? 0,
  ];
  if (radii.every((r) => !(r > 0))) {
    return null;
  }
  const toRad = Math.PI / 180;
  const ring = [];
  for (let bearing = 0; bearing < 360; bearing += 5) {
    const quadrant = Math.floor(bearing / 90) % 4;
    const radiusNm = radii[quadrant];
    if (!(radiusNm > 0)) {
      ring.push([lon, lat]); // Collapsed quadrant: touch the center
      continue;
    }
    const distanceRad = radiusNm / 3440.065;
    const bearingRad = bearing * toRad;
    const latRad = lat * toRad;
    const lat2 = Math.asin(
      Math.sin(latRad) * Math.cos(distanceRad) +
        Math.cos(latRad) * Math.sin(distanceRad) * Math.cos(bearingRad),
    );
    const lon2 =
      lon * toRad +
      Math.atan2(
        Math.sin(bearingRad) * Math.sin(distanceRad) * Math.cos(latRad),
        Math.cos(distanceRad) - Math.sin(latRad) * Math.sin(lat2),
      );
    ring.push([
      Math.round((((lon2 / toRad + 540) % 360) - 180) * 100) / 100,
      Math.round((lat2 / toRad) * 100) / 100,
    ]);
  }
  ring.push([...ring[0]]);
  return { type: "polygon", coordinates: ring };
}

/**
 * Severity label for the advisory family, from the max wind threshold
 * present (work doc #21): 64 KT and above is hurricane force, 48–63
 * storm force, 34–47 gale.
 *
 * @param {number} maxWindKt
 * @returns {string|null}
 */
function advisorySeverityLabel(maxWindKt) {
  if (!(maxWindKt > 0)) {
    return null;
  }
  if (maxWindKt >= 64) {
    return "HURRICANE FORCE";
  }
  if (maxWindKt >= 48) {
    return "STORM FORCE";
  }
  if (maxWindKt >= 34) {
    return "GALE";
  }
  return null;
}

/**
 * Parses an NHC tropical-cyclone FORECAST/ADVISORY (the WTPZ/TCM
 * family, work doc #21) into structured storm data with native
 * geometry: present wind radii per threshold as quadrant-arc
 * polygons, sea-height radii as a single ring, and the forecast and
 * outlook positions with their own radii — the plan's forward storm
 * coverage.
 *
 * Radii lines carry the largest expected radius per quadrant:
 * `64 KT....... 40NE  35SE  25SW  40NW.` — zero radii (the "0SW"
 * case) collapse onto the center in the ring. Forecast positions:
 * `FORECAST VALID 03/1200Z 19.5N 112.1W` followed by their own wind
 * and radii lines.
 *
 * @param {string} text - Cleaned bulletin text
 * @returns {object|null} Structured storm, null when the text is not
 *   the advisory family
 */
/**
 * A tropical-cyclone declaration's quadrant wind radii (work doc #48
 * session): the RSMC NFFN storm warnings spell the wind fields out in
 * prose — "EXPECT WINDS OVER 47 KNOTS WITHIN 50 NAUTICAL MILES IN NE
 * QUADRANT AND WITHIN 60 NAUTICAL MILES IN SE QUADRANT …" — a format
 * the NHC advisory parser never sees. Each threshold's quadrant
 * radii build the same great-circle rings the advisory fields carry,
 * so the map's cyclone graphic and the published regions read the
 * same parsed structure for both formats. Null when the text names no
 * radii set.
 *
 * @param {string} text - Block text
 * @param {number[][]|null} coordinates - The declaration point
 *   ([lon, lat]) the radii centre on
 * @returns {object|null} A partial advisory shape ({center, fields,
 *   forecastPoints}) — the fields the map graphic and the region
 *   publisher already consume
 */
function declarationStorm(text, coordinates) {
  if (
    !Array.isArray(coordinates) ||
    coordinates.length !== 2 ||
    !coordinates.every(Number.isFinite)
  ) {
    return null;
  }
  const [lon, lat] = coordinates;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  const fields = [];
  // One set per threshold: "OVER 47 KNOTS" followed by its quadrant
  // radii chain — the chain breaks at the next "EXPECT ... KNOTS"
  const setRe =
    /OVER\s+(\d{1,3})\s*KNOTS((?:\s+AND)?\s+WITHIN\s+\d+\s*NAUTICAL\s*MILES\s+IN\s+(?:NE|SE|SW|NW)\s+QUADRANT)+/gi;
  const quadRe =
    /WITHIN\s+(\d+)\s*NAUTICAL\s*MILES\s+IN\s+(NE|SE|SW|NW)\s+QUADRANT/gi;
  for (const setMatch of text.matchAll(setRe)) {
    const threshold = Number.parseInt(setMatch[1], 10);
    const radiiNm = { ne: 0, se: 0, sw: 0, nw: 0 };
    for (const quadMatch of setMatch[0].matchAll(quadRe)) {
      radiiNm[quadMatch[2].toLowerCase()] = Number.parseInt(quadMatch[1], 10);
    }
    const geometry = quadrantRing({ lat, lon, radiiNm });
    if (geometry) {
      fields.push({
        label: `${threshold} KT`,
        threshold,
        kind: "wind",
        radiiNm,
        geometry,
      });
    }
  }
  if (fields.length === 0) {
    return null;
  }
  return { center: { lat, lon }, fields, forecastPoints: [] };
}

function parseAdvisory(text) {
  if (
    typeof text !== "string" ||
    !/FORECAST\/ADVISORY/i.test(text) ||
    !/MAX SUSTAINED WINDS/i.test(text)
  ) {
    return null;
  }
  const nameMatch = text.match(
    /\b([A-Z][A-Z .'-]+?)\s+FORECAST\/ADVISORY\s+NUMBER\s+(\d+)/i,
  );
  const centerMatch = text.match(
    /CENTER LOCATED NEAR\s+(\d+(?:\.\d+)?)([NS])\s+(\d+(?:\.\d+)?)([EW])/i,
  );
  if (!centerMatch) {
    return null;
  }
  const center = {
    lat:
      Number.parseFloat(centerMatch[1]) *
      (centerMatch[2].toUpperCase() === "S" ? -1 : 1),
    lon:
      Number.parseFloat(centerMatch[3]) *
      (centerMatch[4].toUpperCase() === "W" ? -1 : 1),
  };
  const movement = text.match(
    /PRESENT MOVEMENT TOWARD THE ([^.]+?) OR (\d{1,3}) DEGREES AT\s+(\d+) KT/i,
  );
  const pressure = text.match(/MINIMUM CENTRAL PRESSURE\s+(\d+) MB/i);
  const winds = text.match(
    /MAX SUSTAINED WINDS\s+(\d+) KT(?:\s+WITH GUSTS TO (\d+) KT)?/i,
  );
  const maxWindKt = winds ? Number.parseInt(winds[1], 10) : null;
  const gustKt = winds?.[2] ? Number.parseInt(winds[2], 10) : null;

  // Radius sets: the present fields live before the first VALID line;
  // each FORECAST/OUTLOOK VALID line starts a position block with its
  // own fields, centered on that block's position
  const parseRadii = (segment, centerLat, centerLon) => {
    const fields = [];
    const radiiRe =
      /\b(\d{1,3})\s*(M|FT)?\s*(SEAS|KT)\s*\.{2,}\s*(\d+)\s*NE\s+(\d+)\s*SE\s+(\d+)\s*SW\s+(\d+)\s*NW/gi;
    for (const radiiMatch of segment.matchAll(radiiRe)) {
      const threshold = Number.parseInt(radiiMatch[1], 10);
      const kind = radiiMatch[3].toLowerCase() === "seas" ? "seas" : "wind";
      const source = radiiMatch[2] ? `${radiiMatch[2].toUpperCase()} ` : "";
      const label = `${threshold} ${source}${radiiMatch[3].toUpperCase()}`;
      const radiiNm = {
        ne: Number.parseInt(radiiMatch[4], 10),
        se: Number.parseInt(radiiMatch[5], 10),
        sw: Number.parseInt(radiiMatch[6], 10),
        nw: Number.parseInt(radiiMatch[7], 10),
      };
      fields.push({
        label,
        threshold,
        kind,
        radiiNm,
        geometry: quadrantRing({
          lat: centerLat,
          lon: centerLon,
          radiiNm,
        }),
      });
    }
    return fields;
  };
  const parsePositionBlock = (segment) => {
    const position = segment.match(
      /\b(\d{1,2})\/(\d{4})Z\s+(\d+(?:\.\d+)?)([NS])\s+(\d+(?:\.\d+)?)([EW])/,
    );
    const wind = segment.match(
      /MAX WIND\s+(\d+) KT(?:\.{2,}|\s+)GUSTS\s+(\d+) KT/i,
    );
    const lat =
      position && Number.isFinite(Number.parseFloat(position[3]))
        ? Number.parseFloat(position[3]) *
          (position[4].toUpperCase() === "S" ? -1 : 1)
        : null;
    const lon =
      position && Number.isFinite(Number.parseFloat(position[5]))
        ? Number.parseFloat(position[5]) *
          (position[6].toUpperCase() === "W" ? -1 : 1)
        : null;
    return {
      validText: headerMatch(segment),
      lat,
      lon,
      maxWindKt: wind ? Number.parseInt(wind[1], 10) : null,
      gustKt: wind ? Number.parseInt(wind[2], 10) : null,
      fields: parseRadii(segment, lat ?? center.lat, lon ?? center.lon),
    };
  };
  const headerMatch = (segment) =>
    segment.match(/\b((?:FORECAST|OUTLOOK) VALID [^\n]*)/)?.[1]?.trim() ?? null;

  const parts = text.split(/(?=\b(?:FORECAST|OUTLOOK) VALID )/);
  const fields = parseRadii(parts[0] ?? "", center.lat, center.lon);
  const forecastPoints = [];
  const outlookPoints = [];
  for (let i = 1; i < parts.length; i++) {
    const block = parsePositionBlock(parts[i]);
    if (block.lat == null) {
      continue; // A VALID line without a position is not a storm point
    }
    const target = /OUTLOOK VALID/i.test(parts[i])
      ? outlookPoints
      : forecastPoints;
    target.push(block);
  }
  const primary =
    fields.find((field) => field.threshold === 34 && field.kind === "wind") ??
    fields.find((field) => field.kind === "wind") ??
    fields[0] ??
    null;
  return {
    stormName: nameMatch ? nameMatch[1].trim() : null,
    advisoryNumber: nameMatch ? Number.parseInt(nameMatch[2], 10) : null,
    center,
    movementText: movement ? movement[1].trim() : null,
    movementDegrees: movement ? Number.parseInt(movement[2], 10) : null,
    movementSpeedKt: movement ? Number.parseInt(movement[3], 10) : null,
    pressureMb: pressure ? Number.parseInt(pressure[1], 10) : null,
    maxWindKt,
    gustKt,
    severityLabel: advisorySeverityLabel(maxWindKt),
    fields,
    forecastPoints,
    outlookPoints,
    primaryGeometry: primary?.geometry ?? null,
  };
}

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
  const advisory = parseAdvisory(cleaned);
  if (advisory) {
    // Advisory family (work doc #21): one semantic unit — the whole
    // text is the block. The track filter runs over every field
    // (present + forecast wind/seas areas): the storm's forward
    // coverage counts, not just its present position. Severity from
    // the max wind threshold rides the block for the console.
    const fieldGeometries = [
      ...advisory.fields,
      ...advisory.forecastPoints.flatMap((point) => point.fields),
    ]
      .map((field) => field.geometry)
      .filter(Boolean);
    const onTrack =
      fieldGeometries.length === 0 ||
      fieldGeometries.some((geometry) => intersectsTrack(geometry, track));
    if (!onTrack) {
      return null; // Storm coverage misses our waters entirely
    }
    const spoolWatcher = require("./spool-watcher.js");
    return {
      header: cleaned.split(/\r?\n/, 1)[0]?.trim() ?? "",
      issuedAt:
        issuedAt ??
        spoolWatcher.extractIssuedAt(cleaned) ??
        new Date(0).toISOString(),
      issuer: extractIssuer(cleaned),
      bulletinText: rawText,
      source,
      blocks: [
        {
          text: cleaned,
          subject: subject ?? null,
          geometryType: advisory.primaryGeometry
            ? advisory.primaryGeometry.type
            : null,
          geometry: advisory.primaryGeometry,
          storm: advisory,
          source,
        },
      ],
    };
  }
  const features = collectFeatures(cleaned);
  // The bulletin's own declared area ("EQUATOR TO 25S BETWEEN 160E
  // AND 120W."): loose cardinal bounds inside clamp into it
  const coverage = parseCoverageArea(cleaned);
  const header = cleaned.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const blocks = segmentSections(cleaned)
    .flatMap((sectionBlocks) =>
      isWarningSection(sectionBlocks)
        ? coalesceWarningBlocks(sectionBlocks, features)
        : sectionBlocks,
    )
    .map((blockText) => {
      // The masthead is the bulletin's title card, not a warning: it
      // never reaches the console, even when its declared-area bounds
      // intersect the track (a clamped masthead bbox would render the
      // title as a "warning" over the issuer's whole area)
      if (isMastheadBlock(blockText)) {
        return null;
      }
      const geometry = extractGeometry(blockText, features, coverage);
      // The synoptic feature declarations (TROUGH T1, Front F1, Area
      // A1 bounded by…) are the area's weather picture, and passages
      // hug subarea and METAREA boundaries: a feature with a clear
      // geolocation stays on the console while it sits within
      // BULLETIN_PROXIMITY_NM of the track, whatever subarea it was
      // printed under. The applicability areas (the WITHIN bands, the
      // swells notes) have no such slack — their geometry is exactly
      // where the warning applies, clamped to the declared area.
      const declaresFeature = FEATURE_DECLARATION.test(
        blockText.trim().split(/\r?\n/, 1)[0],
      );
      const proximityNm = declaresFeature ? BULLETIN_PROXIMITY_NM : 0;
      if (!intersectsTrack(geometry, track, proximityNm)) {
        return null; // Discard rule: not on our waters
      }
      // Coordinates that failed to build geometry still place the
      // block: a synopsis naming "LOW 59N167W" is other ocean's text
      // even though the single point builds no ring. Only a block
      // with no coordinates at all is genuinely unplaceable — the
      // severity retention must not rescue the placed-but-far ones.
      if (
        geometry == null &&
        track.length > 0 &&
        textNearTrack(blockText, track, 150) === false
      ) {
        return null;
      }
      // The warnings console is for relevant paragraphs only: a block
      // with neither geography nor severity is transmission
      // boilerplate (preamble, disclaimers, footers) — dropping it
      // keeps real warnings from drowning in NWS preamble text
      if (!geometry && !hasSevereKeyword(blockText)) {
        return null;
      }
      // A storm declaration whose text spells out quadrant wind
      // radii carries the same parsed fields the advisory family
      // does — the cyclone's wind rings become map graphic and
      // published region, not just a point (work doc #48 session)
      const storm =
        geometry?.type === "point"
          ? declarationStorm(blockText, geometry.coordinates)
          : null;
      return {
        text: blockText,
        subject: subject ?? null,
        geometryType: geometry ? geometry.type : null,
        geometry: geometry ?? null,
        ...(storm ? { storm } : {}),
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
        // The URL rides in the message: the source status checklist
        // shows it verbatim in the row detail (work doc #23)
        throw new Error(
          `${url} returned ${response.status} ${response.statusText}`,
        );
      }
      return { text: await response.text(), source: "api" };
    } finally {
      clearTimeout(timer);
    }
  }

  // api.weather.gov: latest iteration of the product type/location.
  // No query parameters — the API now rejects unknown ones (limit
  // included) with a 400, so "latest" is resolved client-side by
  // sorting the returned graph on issuanceTime
  const listUrl = apiMatch[0];
  const get = async (u) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? 15000);
    try {
      const response = await fetchImpl(u, {
        signal: controller.signal,
        headers: { Accept: "application/geo+json, application/json" },
      });
      if (!response.ok) {
        throw new Error(
          `${u} returned ${response.status} ${response.statusText}`,
        );
      }
      return response.json();
    } finally {
      clearTimeout(timer);
    }
  };
  const list = await get(listUrl);
  // "id" is a bare UUID; the fetchable product URL lives in "@id"
  const latest = [...(list?.["@graph"] ?? [])]
    .filter((product) => product?.id)
    .sort((a, b) =>
      String(b.issuanceTime ?? "").localeCompare(String(a.issuanceTime ?? "")),
    )[0];
  if (!latest) {
    throw new Error("No product iterations available");
  }
  const productUrl =
    latest["@id"] ?? `https://api.weather.gov/products/${latest.id}`;
  const product = await get(productUrl);
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

/**
 * Whether a bulletin's own coordinates can plausibly cover a track:
 * the coarse bounding box of every coordinate the text mentions,
 * padded by a margin. An entry whose entire coordinate footprint
 * sits in another ocean (a North Pacific synopsis for a Tonga track)
 * fails this and must not reach the console — neither as blocks nor
 * as the headline. A text with no coordinates at all returns null:
 * it cannot be placed, and the caller keeps it (the storm-named-
 * without-coordinates case is a conservative keep, never a loss).
 *
 * @param {string} rawText - Raw bulletin text
 * @param {number[][]} track - Track points [[lon, lat], …]
 * @param {number} [marginNm] - Padding around the coordinate bbox
 * @returns {boolean|null} False = proven elsewhere, true = plausibly
 *   covering, null = cannot place
 */
function textNearTrack(rawText, track, marginNm = 500) {
  if (!Array.isArray(track) || track.length === 0) {
    return true;
  }
  const points = parseCoordinatePoints(rawText);
  if (points.length === 0) {
    return null;
  }
  const lons = points.map((point) => point[0]);
  const lats = points.map((point) => point[1]);
  const meanLat =
    ((Math.min(...lats) + Math.max(...lats)) / 2) * (Math.PI / 180);
  const latPad = marginNm / 60;
  const lonPad = latPad / Math.max(0.2, Math.cos(meanLat));
  const minLon = Math.min(...lons) - lonPad;
  const maxLon = Math.max(...lons) + lonPad;
  const minLat = Math.min(...lats) - latPad;
  const maxLat = Math.max(...lats) + latPad;
  return track.some(([lon, lat]) =>
    [0, 360, -360].some((shift) => {
      const shifted = lon + shift;
      return (
        shifted >= minLon && shifted <= maxLon && lat >= minLat && lat <= maxLat
      );
    }),
  );
}

module.exports = {
  parseAdvisory,
  advisorySeverityLabel,
  quadrantRing,
  RETAINED_SUBJECTS,
  BULLETIN_PROXIMITY_NM,
  SEVERE_KEYWORDS,
  SECTION_ANCHORS,
  STORM_DECLARATION,
  stripBoilerplate,
  hasSevereKeyword,
  isMastheadBlock,
  navtexSubject,
  shouldRetainSubject,
  segmentBlocks,
  segmentSections,
  isWarningSection,
  coalesceWarningBlocks,
  lookupFeature,
  resolveNamedEndpoints,
  stormDeclarationPoint,
  stormReferenceGeometry,
  featureReferenceGeometry,
  sideBandPolygon,
  ukhoBlocksFromWarnings,
  hemisphereDegrees,
  parseCoordinatePoints,
  parseCoordinateChain,
  parseCardinalBounds,
  parseCoverageArea,
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
  textNearTrack,
  fetchRemoteBulletin,
  resolveBulletinSource,
};
