/**
 * Unit tests for the NAVAREA/NAVTEX filtering engine (work doc #4)
 * and the internet bulletin source: boilerplate stripping, NAVTEX
 * subject filtering, GMDSS segmentation, geographic extraction with
 * antimeridian handling, the track discard rule, and cache/gating.
 *
 * @file bulletin-engine.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  collectFeatures,
  coalesceWarningBlocks,
  parseAdvisory,
  extractGeometry,
  filterBulletin,
  featureReferenceGeometry,
  isMastheadBlock,
  navtexSubject,
  parseCardinalBounds,
  parseCoverageArea,
  parseCoordinateChain,
  parseCoordinatePoints,
  resolveBulletinSource,
  segmentBlocks,
  shouldRetainSubject,
  stormDeclarationPoint,
  stripBoilerplate,
  bboxIntersectsTrack,
  polygonIntersectsTrack,
  ringContains,
  ukhoBlocksFromWarnings,
  extractIssuer,
} = require("../plugin/bulletin-engine.js");
const {
  loadBulletinCache,
  refreshBulletins,
  saveBulletinCache,
} = require("../plugin/bulletin-source.js");

const approx = (actual, expected, epsilon = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} ≈ ${expected} (±${epsilon})`,
  );

/** A realistic NAVAREA XIV gale warning, South Pacific (doc #4). */
const NAVAREA_FIXTURE = `FQPS01 NFFN 011200Z AUG 26
ZCZC GA14
011200Z AUG 26
NAVAREA XIV 114/26
SOUTH PACIFIC FIJI WATERS
GALE WARNING
PART 1 WARNING
DEVELOPING TROUGH T1 WITH SQUALLS AND GALES WITHIN 120NM
EAST OF AXIS 16S 170E TO 20S 178W TO 25S 175W AT 011200Z.
EXPECT WINDS 35 KNOTS. ROUGH SEAS WITH HEAVY SWELLS.
PARTS 2 AND 3 SYNOPSIS AND FORECAST
SITUATION IS MODERATE OVER REMAINDER WATERS.
NNNN`;

/** Ice report — NAVTEX subject C, must be discarded. */
const ICE_FIXTURE = `ZCZC CC12
030800Z AUG 26
NAVAREA XIV 201/26
ICE REPORTS SOUTHERN OCEAN. BERGS DRIFTING NORTH.
NNNN`;

/**
 * Tonga → Opua track samples, GeoJSON [lon, lat] order — crosses
 * the antimeridian.
 */
const TONGA_TRACK = [
  [-175.2, -21.1],
  [-179.0, -25.0],
  [179.0, -30.0],
  [174.3, -35.3],
];

// --- Tokenizer ------------------------------------------------------------

test("stripBoilerplate removes ZCZC/NNNN and routing headers", () => {
  const cleaned = stripBoilerplate(NAVAREA_FIXTURE);
  assert.equal(cleaned.includes("FQPS01 NFFN"), false);
  assert.equal(cleaned.includes("NNNN"), false);
  // The NAVTEX id line stays (the subject filter reads it)
  assert.match(cleaned, /ZCZC GA14/);
  assert.match(cleaned, /GALE WARNING/);
});

test("NAVTEX B_2 subject filtering: C dropped, A and E retained", () => {
  // ZCZC GA14: B_1 = G (Nadi station), B_2 = A (nav warnings)
  assert.equal(navtexSubject(NAVAREA_FIXTURE), "A");
  assert.equal(navtexSubject(ICE_FIXTURE), "C");
  assert.equal(shouldRetainSubject("C"), false);
  assert.equal(shouldRetainSubject("A"), true);
  assert.equal(shouldRetainSubject("E"), true);
  assert.equal(shouldRetainSubject(null), true); // Not NAVTEX: keep
  assert.equal(filterBulletin({ rawText: ICE_FIXTURE, source: "api" }), null);
});

test("segmentBlocks anchors on PART headings and blank lines", () => {
  const cleaned = stripBoilerplate(NAVAREA_FIXTURE);
  const blocks = segmentBlocks(cleaned);
  assert.ok(blocks.length >= 3, `blocks ${blocks.length}`);
  const warning = blocks.find((b) => b.includes("PART 1 WARNING"));
  assert.ok(warning, "warning section found");
  assert.match(warning, /DEVELOPING TROUGH/);
});

test("single-newline rendering splits per sentence on declarations and references", () => {
  // MetService TGFTP rendering: no blank lines inside the parts — the
  // wire form of the Part 2/3 bodies, where the blank-line rendering
  // would have one paragraph per sentence
  const blocks = segmentBlocks(
    [
      "Part 3 - Forecast:",
      "Refer to latest warnings.",
      "Within 180 nautical miles south of F1: Poor visibility in rain, easing by 290600UTC.",
      "Within A1: Northwest 25kt at times, poor visibility in rain developing by 290000UTC.",
      "East of F2: Northwest 25kt at times.",
      "Outlook for the following 72 hours:",
      "Front 40S 174W 37S 176W 33S 179W, moving east. West of Front: Westerly quarter 30kt to gale, easing by 311200UTC.",
    ].join("\n"),
  );
  // The Part 3 anchor and "Refer to latest warnings." stay one block
  // (boilerplate, dropped downstream); each named reference sentence
  // splits into its own block
  assert.ok(
    blocks.some((b) => /^Within 180 nautical miles south of F1/.test(b)),
    "distance-band reference split",
  );
  assert.ok(
    blocks.some((b) => /^Within A1:/.test(b)),
    "area reference split",
  );
  assert.ok(
    blocks.some((b) => /^East of F2: Northwest 25kt at times\.$/.test(b)),
    "side-of-feature reference split",
  );
  // The Outlook header stays fused with its front chain and the
  // West-of-Front prose: the chain is the outlook's own geometry
  const outlook = blocks.find((b) =>
    /Outlook for the following 72 hours/.test(b),
  );
  assert.ok(outlook, "outlook block found");
  assert.match(outlook, /Front 40S 174W/);
  assert.match(outlook, /West of Front/);
});

test("a fused NFFN trough declaration splits from its predecessor", () => {
  // Some wire feeds drop the blank line between the trough paragraphs:
  // the T2 declaration opens its own block the same way a blank line
  // would have made it
  const blocks = segmentBlocks(
    [
      "TROUGH T1 13S 163E 09S 172E  SLOW MOVING. POOR VISIBILITY IN",
      "OCCASIONAL SHOWERS WITHIN 090 NAUTICAL MILES OF T1.",
      "TROUGH T2 08S 180 07S 170W 09S 150W 19S 120W SLOW MOVING. POOR",
      "VISIBILITY IN SHOWERS, HEAVY AT TIMES WITHIN",
      "120 NAUTICAL MILES OF T2.",
    ].join("\n"),
  );
  const trough1 = blocks.find((b) => /^TROUGH T1/.test(b));
  const trough2 = blocks.find((b) => /^TROUGH T2/.test(b));
  assert.ok(trough1, "trough 1 leads its own block");
  assert.ok(trough2, "trough 2 splits from trough 1's paragraph");
  assert.match(trough1, /WITHIN 090 NAUTICAL MILES OF T1/);
  assert.match(trough2, /120 NAUTICAL MILES OF T2/);
});

test("mid-sentence wraps never split, even when a wrap line opens with a reference", () => {
  const blocks = segmentBlocks(
    [
      "EXPECT SOUTHEAST WINDS 25 KT OR GREATER",
      "EAST OF F2 AT 291800UTC.",
    ].join("\n"),
  );
  // The wrap line opens with a side-of-feature bound, but the previous
  // line does not end a sentence: the wrap continues the paragraph
  assert.equal(blocks.length, 1, `blocks ${JSON.stringify(blocks)}`);
});

// --- Geographic extraction ---------------------------------------------------

test("coordinate chains parse with hemisphere letters and closing", () => {
  const ring = parseCoordinateChain(
    "EAST OF AXIS 16S 170E TO 20S 178W TO 25S 175W",
  );
  assert.equal(ring.length, 4); // Closed automatically
  approx(ring[0][0], 170); // 170E
  approx(ring[0][1], -16); // 16S
  approx(ring[1][0], -178); // 178W — antimeridian west side
  approx(ring[2][0], -175);
  approx(ring[3][0], 170); // Ring closed back to start
});

test("two coordinate pairs form an open axis line", () => {
  // NFFN trough style: lat-first pairs, no TO separators
  const line = parseCoordinateChain("TROUGH T1 10S 160E 12S 166E SLOW MOVING");
  assert.equal(line.length, 2);
  approx(line[0][0], 160);
  approx(line[0][1], -10);
  approx(line[1][0], 166);
  approx(line[1][1], -12);
  assert.equal(parseCoordinateChain("10S 160E"), null); // single pair
});

test("coordinate pairs accept Fiji/NFFN bulletin conventions: bare 180 and EQT", () => {
  // The dateline takes no hemisphere letter; the equator is EQT
  const chain = parseCoordinatePoints(
    "TROUGH T3 12S 175E 14S 180 15S 177W SLOW MOVING",
  );
  assert.equal(chain.length, 3);
  approx(chain[1][0], 180); // bare 180 is east by convention
  approx(chain[1][1], -14);
  const eqt = parseCoordinatePoints("TROUGH T2 12S 172E TO L TO EQT 177E");
  assert.equal(eqt.length, 2);
  approx(eqt[1][0], 177);
  approx(eqt[1][1], 0); // EQT is the equator
});

test("coordinate pairs reject prose numbers", () => {
  assert.deepEqual(parseCoordinatePoints("AT 280600 UTC. L SLOW MOVING."), []);
  assert.deepEqual(
    parseCoordinatePoints("EXPECT SOUTHEAST WINDS 20 TO 30 KNOTS."),
    [],
  );
  // A rejected prose span must not swallow a real pair after it
  const chain = parseCoordinatePoints("TROUGH T1 09S 160E 11S 163E");
  assert.equal(chain.length, 2);
  approx(chain[0][0], 160);
  approx(chain[0][1], -9);
});

test("named features are collected from their declaring blocks", () => {
  const text = [
    "TROUGH T1 09S 160E 11S 163E SLOW MOVING.",
    "",
    "COLD FRONT CF 16S 150W 20S 140W 25S 132W SLOW MOVING.",
    "",
    " LOW PRESSURE L CENTER [1009 HPA] WAS ANALYSED NEAR 05.0S 171.0E AT",
    "280600 UTC.",
  ].join("\n");
  const features = collectFeatures(text);
  assert.deepEqual(features.get("T1"), [
    [160, -9],
    [163, -11],
  ]);
  assert.deepEqual(features.get("CF"), [
    [-150, -16],
    [-140, -20],
    [-132, -25],
  ]);
  assert.deepEqual(features.get("L"), [[171, -5]]);
  assert.equal(features.get("T2"), undefined);
});

test("WEST OF a named front composes a seam-crossing polygon", () => {
  const features = collectFeatures(
    "COLD FRONT CF 16S 150W 20S 140W 25S 132W SLOW MOVING.",
  );
  const geometry = extractGeometry(
    "IN THE AREA SOUTH OF 09S AND WEST OF CF, EXPECT SOUTHEAST WINDS.",
    features,
  );
  assert.equal(geometry.type, "polygon");
  const ring = geometry.coordinates;
  // Closed ring: front chain plus latitude caps and the open side
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  // The front itself is the eastern edge
  assert.ok(
    ring.some(([lon, lat]) => lon === -150 && lat === -16),
    "front chain included",
  );
  assert.ok(
    ring.some(([lon, lat]) => lon === -132 && lat === -25),
    "front end included",
  );
  // Caps at the stated latitude bounds
  assert.ok(ring.some(([, lat]) => lat === -9));
  assert.ok(ring.some(([, lat]) => lat === -90));
  // A Fiji vessel (178E) is west of the front: inside the ring
  assert.equal(ringContains(ring, 178, -17), true);
  // East of the front at the front's own latitude: outside
  assert.equal(ringContains(ring, -135, -23), false);
});

test("BETWEEN a meridian and a named front composes the wedge", () => {
  const features = collectFeatures(
    "COLD FRONT CF 16S 150W 20S 140W 25S 132W SLOW MOVING.",
  );
  const geometry = extractGeometry(
    "IN THE AREA SOUTH OF 10S, BETWEEN 150W AND CF, EXPECT SWELLS.",
    features,
  );
  assert.equal(geometry.type, "polygon");
  const ring = geometry.coordinates;
  // Inside the wedge: between 150W and the front at that latitude
  assert.equal(ringContains(ring, -147, -18), true);
  assert.equal(ringContains(ring, -144, -22), true);
  // West of the 150W meridian: outside
  assert.equal(ringContains(ring, 178, -17), false);
  // East of the front at the same latitude: outside
  assert.equal(ringContains(ring, -142, -18), false);
});

test("unknown feature names fall back to the hemisphere bbox", () => {
  const features = collectFeatures("TROUGH T1 09S 160E 11S 163E SLOW MOVING.");
  const geometry = extractGeometry(
    "IN THE AREA SOUTH OF 09S AND WEST OF CF, EXPECT SOUTHEAST WINDS.",
    features,
  );
  // CF is not declared: conservative full-longitude bbox remains
  assert.deepEqual(geometry, {
    type: "bbox",
    coordinates: [-180, -90, 180, -9],
  });
});

test("MetService Front F1 / Area A1 declarations collect as named features", () => {
  // Blank-line separated, as the WMO set renders Part 2; the fused
  // TGFTP rendering splits per sentence (BLOCK_START_ANCHOR) before
  // collection sees it
  const features = collectFeatures(
    [
      "Front F1 29S 179E 32S 174W 35S 170W, moving east 25kt.",
      "Area A1 bounded by 26S 170E 29S 179W 34S 179W 34S 167E 29S 170E 26S 170E, slow moving.",
      "Front F2 36S 161E 38S 166E 40S 170E, moving east 25kt.",
    ].join("\n\n"),
  );
  assert.deepEqual(features.get("F1"), [
    [179, -29],
    [-174, -32],
    [-170, -35],
  ]);
  assert.equal(features.get("A1").length, 6);
  assert.deepEqual(features.get("F2"), [
    [161, -36],
    [166, -38],
    [170, -40],
  ]);
});

test("live fqps43 TGFTP rendering: each feature collects its own chain", () => {
  const features = collectFeatures(
    stripBoilerplate(readFixture("fqps43-nzkl-2026-10-28.txt")),
  );
  // Fused Part 2 lines split per sentence, so F1 is the front's own
  // three-point chain — not the concatenation of every analysis pair
  assert.deepEqual(features.get("F1"), [
    [179, -29],
    [-174, -32],
    [-170, -35],
  ]);
  assert.deepEqual(features.get("F2"), [
    [161, -36],
    [166, -38],
    [170, -40],
  ]);
  assert.equal(features.get("A1").length, 6);
});

test("Part 3 distance-and-side bands compose from the declared front", () => {
  const features = collectFeatures(
    "Front F1 29S 179E 32S 174W 35S 170W, moving east 25kt.",
  );
  const geometry = featureReferenceGeometry(
    "Within 180 nautical miles south of F1: Poor visibility in rain, easing by 290600UTC.",
    features,
  );
  assert.equal(geometry.type, "polygon");
  const ring = geometry.coordinates;
  // South band: 180 nm = 3° below the front axis, closed at the ends
  const southLats = ring.map(([, lat]) => lat);
  assert.ok(Math.min(...southLats) < -35 - 2.5, "band extends 3° south");
  // A vessel south of the front within 180 nm is inside; north of it
  // is not — the side is the point of the grammar
  assert.equal(ringContains(ring, -176, -33.5), true);
  assert.equal(ringContains(ring, -176, -27.5), false);
  // West of the front's start (179E) the band does not exist
  assert.equal(ringContains(ring, 174.3, -33.5), false);
});

test("Within a collected area references the area's own ring", () => {
  const features = collectFeatures(
    "Area A1 bounded by 26S 170E 29S 179W 34S 179W 34S 167E 29S 170E 26S 170E, slow moving.",
  );
  const geometry = featureReferenceGeometry(
    "Within A1: Northwest 25kt at times, poor visibility in rain developing by 290000UTC.",
    features,
  );
  assert.equal(geometry.type, "polygon");
  // Inside A1 (167E–179W, 26S–34S)
  assert.equal(ringContains(geometry.coordinates, 172.8, -30), true);
  // North of A1's 26S boundary: outside
  assert.equal(ringContains(geometry.coordinates, 172.8, -24), false);
  // A distance with no stated side defers to the symmetric path
  assert.equal(
    featureReferenceGeometry(
      "WITHIN 090 NAUTICAL MILES OF T1, EXPECT POOR VISIBILITY.",
      new Map([
        [
          "T1",
          [
            [160, -9],
            [163, -11],
          ],
        ],
      ]),
    ),
    null,
  );
});

test("bare East of F2 composes the side polygon at the front's extent", () => {
  const features = collectFeatures(
    "Front F2 36S 161E 38S 166E 40S 170E, moving east 25kt.",
  );
  const geometry = featureReferenceGeometry(
    "East of F2: Northwest 25kt at times.",
    features,
  );
  // No WITHIN, no side token pair: the named branch declines, and the
  // side polygon comes from the bounds composer
  assert.equal(geometry, null);
  const composed = extractGeometry(
    "East of F2: Northwest 25kt at times.",
    features,
  );
  assert.equal(composed.type, "polygon");
  // East of the front at the front's own latitudes
  assert.equal(ringContains(composed.coordinates, 168, -38), true);
  // West of the front: outside
  assert.equal(ringContains(composed.coordinates, 155, -38), false);
  // At the ridge latitudes well north of F2: outside
  assert.equal(ringContains(composed.coordinates, 168, -30), false);
});

test("live fqps43: the Part 3 forecast sentences reach the waters they cover", () => {
  const raw = readFixture("fqps43-nzkl-2026-10-28.txt");

  // A vessel inside A1 reads A1's forecast, not the whole analysis
  const inA1 = filterBulletin({
    rawText: raw,
    source: "api",
    track: [[172.8, -30]],
  });
  const a1 = inA1.blocks.find((b) => /^Within A1:/.test(b.text));
  assert.ok(a1, "Within-A1 forecast retained for a vessel inside A1");
  assert.equal(a1.geometryType, "polygon");
  assert.ok(
    inA1.blocks.every((b) => !/^Part 2/.test(b.text)),
    "situation-analysis boilerplate on the console",
  );

  // A vessel south of F1 within 180 nm reads F1's rain band
  const southOfF1 = filterBulletin({
    rawText: raw,
    source: "api",
    track: [[-176, -33.5]],
  });
  const f1 = southOfF1.blocks.find((b) =>
    /^Within 180 nautical miles south of F1/.test(b.text),
  );
  assert.ok(f1, "F1 rain band retained south of the front");
  assert.equal(f1.geometryType, "polygon");

  // A vessel east of F2 reads F2's wind note
  const eastOfF2 = filterBulletin({
    rawText: raw,
    source: "api",
    track: [[168, -38]],
  });
  assert.ok(
    eastOfF2.blocks.some((b) => /^East of F2:/.test(b.text)),
    "East-of-F2 wind note retained east of the front",
  );

  // At Minerva (18.3S) none of the subtropic area applies: empty
  const minerva = filterBulletin({
    rawText: raw,
    source: "api",
    track: [[174.3, -18.3]],
  });
  assert.equal(minerva.blocks.length, 0);
});

test("prose around MetService feature grammar collects nothing", () => {
  const features = collectFeatures(
    [
      // The masthead's area statement: FROM carries no name
      "Area from 25S to 40S, western boundary from 40S 163E to 29S 170E then to 25S 170E, eastern boundary 170W.",
      // Area prose never leads a block
      "IN THE AREA EAST OF 170W, EXPECT MODERATE SOUTHERLY SWELLS.",
      // The Outlook's unnamed front: digit-leading, not a designator
      "Front 40S 174W 37S 176W 33S 179W, moving east.",
    ].join("\n\n"),
  );
  assert.equal(features.size, 0);
});

test("tropical systems are collected as named points under bare and prefixed names", () => {
  const features = collectFeatures(
    [
      "TROPICAL DEPRESSION 01F CENTER [1000HPA] WAS ANALYSED NEAR 10.1S",
      "163.4W AT 151800UTC. POSITION POOR. TD01F SLOW MOVING.",
    ].join("\n"),
  );
  const point = [[-163.4, -10.1]];
  assert.deepEqual(features.get("01F"), point);
  assert.deepEqual(features.get("TD01F"), point); // Reference shorthand
  assert.deepEqual(features.get("TC01F"), point);
});

test("a declared tropical system is its own point geometry", () => {
  const geometry = extractGeometry(
    "TROPICAL DEPRESSION 01F CENTER [1000HPA] WAS ANALYSED NEAR 10.1S\n163.4W AT 151800UTC. POSITION POOR. TD01F SLOW MOVING.",
  );
  assert.equal(geometry.type, "point");
  assert.deepEqual(geometry.coordinates, [-163.4, -10.1]);
});

test("WITHIN nm of a named storm resolves to a radius ring", () => {
  const features = collectFeatures(
    "TROPICAL DEPRESSION 01F CENTER [1000HPA] WAS ANALYSED NEAR 10.1S\n163.4W AT 151800UTC.",
  );
  const geometry = extractGeometry(
    "WITHIN 180 NAUTICAL MILES OF TD01F, EXPECT CLOCKWISE WINDS 20 TO 25\nKNOTS. ROUGH SEAS.",
    features,
  );
  // A radius reads as a circle, not a square (work doc #47 session):
  // the closed great-circle ring the quadrant builder draws
  assert.equal(geometry.type, "polygon");
  assert.deepEqual(
    geometry.coordinates[0],
    geometry.coordinates[geometry.coordinates.length - 1],
    "the ring closes",
  );
  // 180nm ≈ 3° of latitude around the TD centre
  const lats = geometry.coordinates.map(([, lat]) => lat);
  approx(Math.max(...lats), -7.1);
  approx(Math.min(...lats), -13.1);
  // A Neiafu vessel (18.6S) is outside the TD's wind field
  assert.equal(
    polygonIntersectsTrack(geometry.coordinates, [[-173.98, -18.65]]),
    false,
  );
  // A vessel inside the field is caught
  assert.equal(
    polygonIntersectsTrack(geometry.coordinates, [[-163, -11]]),
    true,
  );
});

test("chain endpoints referencing named systems splice their positions", () => {
  const features = collectFeatures(
    "TROPICAL DEPRESSION 01F CENTER [1000HPA] WAS ANALYSED NEAR 10.1S\n163.4W AT 151800UTC. TD01F SLOW MOVING.",
  );
  // NFFN convergence-zone style: chain ends at the depression
  const cz = extractGeometry(
    "CONVERGENCE ZONE CZ1 04S 179E 01S 170W 05S 161W TO TD01F SLOW MOVING.",
    features,
  );
  assert.equal(cz.type, "polygon");
  assert.ok(
    cz.coordinates.some(([lon, lat]) => lon === -163.4 && lat === -10.1),
    "TD endpoint spliced into the chain",
  );

  // Trough style: the chain starts at the depression
  const trough = extractGeometry(
    "TROUGH T2 FM TD01F TO 15S 166W 19S 160W 18S 150W SLOW MOVING.",
    features,
  );
  assert.deepEqual(trough.coordinates[0], [-163.4, -10.1]);
  assert.deepEqual(trough.coordinates[1], [-166, -15]);
});

test("OCR misread of zero as O still parses the latitude bound", () => {
  // Real NFFN transmission artifact: "NORTH OF O5S" — without the
  // normalization the latitude bound is lost and the area widens to
  // pole-to-pole, keeping far-away waters on the console
  const cleaned = stripBoilerplate(
    "IN THE AREA NORTH OF O5S AND BETWEEN 175W AND 160W, EXPECT WEST WINDS.",
  );
  assert.match(cleaned, /NORTH OF 05S/);
  const geometry = extractGeometry(cleaned);
  assert.deepEqual(geometry, {
    type: "bbox",
    coordinates: [-175, -5, -160, 90],
  });
  // A Neiafu vessel (18.6S) is not north of 05S: outside
  assert.equal(
    bboxIntersectsTrack(geometry.coordinates, [[-173.98, -18.65]]),
    false,
  );
});

test("cardinal bounds translate to a bbox", () => {
  // SOUTH OF x means lat ≤ x: the box extends to the south pole
  assert.deepEqual(
    parseCardinalBounds("SOUTH OF 12S AND WEST OF 173W"),
    [-180, -90, -173, -12],
  );
  // NORTH OF x means lat ≥ x: the box extends to the north pole
  assert.deepEqual(
    parseCardinalBounds("NORTH OF 25S AND EAST OF 179E"),
    [179, -25, 180, 90],
  );
  assert.equal(parseCardinalBounds("no geography here"), null);
});

/** The 2026-10-28 NFFN bulletin (work doc #57 session report): the
 * swells line's lone EAST OF published half a world, pole to pole. */
const NFFN_SWELLS_BULLETIN = [
  "FQPS01 NFFN 281800",
  "MARINE WEATHER BULLETIN FOR ISLANDS AREA",
  "EQUATOR TO 25S BETWEEN 160E AND 120W.",
  "ISSUED BY FIJI METEOROLOGICAL SERVICE OCT 282000 UTC.",
  "",
  "PART 1 : WARNING NIL.",
  "",
  "PARTS 2 AND 3 : SYNOPSIS AND FORECAST VALID UNTIL OCT 291800 UTC.",
  "",
  " TROUGH T1 13S 163E 09S 172E  SLOW MOVING. POOR VISIBILITY IN",
  "OCCASIONAL SHOWERS AND ISOLATED THUNDERSTORMS WITHIN 090 NAUTICAL",
  "MILES OF T1.",
  "",
  "TROUGH T2 08S 180 07S 170W 09S 150W 19S 120W SLOW MOVING. POOR",
  "VISIBILITY IN SHOWERS, HEAVY AT TIMES AND FEW THUNDERSTORMS WITHIN",
  "120 NAUTICAL MILES OF T2.",
  "",
  "IN THE AREA EAST OF 170W, EXPECT MODERATE SOUTHERLY SWELLS.",
].join("\n");

const FIJI_AREA = parseCoverageArea(
  [
    "MARINE WEATHER BULLETIN FOR ISLANDS AREA",
    "EQUATOR TO 25S BETWEEN 160E AND 120W.",
    "ISSUED BY FIJI METEOROLOGICAL SERVICE OCT 282000 UTC.",
  ].join("\n"),
);

test("declared area parses from the NFFN header", () => {
  // EQUATOR is Fiji's word for 0; the 160E→120W pair is the 80° arc
  // across the seam, unwrapped to maxLon 240
  assert.deepEqual(FIJI_AREA, [160, -25, 240, 0]);

  // A bulletin whose header states no area (NWS products state areas
  // per section) parses to null and behaves exactly as before
  assert.equal(
    parseCoverageArea(
      "GALE WARNING. Within 300 nm of a line 45S 170E to 50S 172E.",
    ),
    null,
  );
  // A lone latitude band is not an area
  assert.equal(parseCoverageArea("FOR WATERS SOUTH OF 25S"), null);
  // A two-band statement (AMMC style) parses to nothing usable
  assert.equal(
    parseCoverageArea(
      "High Seas Forecast for Western METAREA 10\n12S TO 30S BETWEEN 90E AND 125E, AND 30S TO 50S BETWEEN 80E AND 129E",
    ),
    null,
  );
});

test("MetService area statements parse as declared coverage", () => {
  // Boundary-walk form (Subtropic): west chain 163E–170E, east
  // meridian 170W unwraps to 190
  assert.deepEqual(
    parseCoverageArea(
      "Area from 25S to 40S, western boundary from 40S 163E to 29S 170E then to 25S 170E, eastern boundary 170W.",
    ),
    [163, -40, 190, -25],
  );
  // Forties: same walk, southern band
  assert.deepEqual(
    parseCoverageArea(
      "Area from 40S to 55S, western boundary from 40S 163E to 45S 160E then to 55S 160E, eastern boundary 170W.",
    ),
    [160, -55, 190, -40],
  );
  // Flat form (Pacific): an AND/TO longitude pair, no seam crossing
  assert.deepEqual(
    parseCoverageArea("Area from 25S to 55S and 170W to 120W."),
    [-170, -55, -120, -25],
  );
  // The ice edge quantifies to nothing usable
  assert.equal(
    parseCoverageArea(
      "Area from 55S to southern ice edge between 160E and 120W.",
    ),
    null,
  );
  // The live fixture's own masthead line parses
  assert.deepEqual(
    parseCoverageArea(
      stripBoilerplate(readFixture("fqps43-nzkl-2026-10-28.txt")),
    ),
    [163, -40, 190, -25],
  );
});

test("latitude-only bounds inside a MetService bulletin take its span", () => {
  const coverage = parseCoverageArea(
    "Area from 25S to 40S, western boundary from 40S 163E to 29S 170E then to 25S 170E, eastern boundary 170W.",
  );
  assert.deepEqual(
    parseCardinalBounds(
      "IN THE AREA SOUTH OF 35S, EXPECT ROUGH SEAS.",
      coverage,
    ),
    [163, -40, 190, -35],
  );
});

test("loose cardinal bounds clamp into the declared area", () => {
  // The report's case: EAST OF 170W is the area slice 170W→120W,
  // equator→25S — not the dateline, pole to pole
  assert.deepEqual(
    parseCardinalBounds(
      "IN THE AREA EAST OF 170W, EXPECT MODERATE SOUTHERLY SWELLS.",
      FIJI_AREA,
    ),
    [-170, -25, -120, 0],
  );

  // A lone west bound closes at the area's west edge
  assert.deepEqual(
    parseCardinalBounds(
      "IN THE AREA WEST OF 140W, EXPECT ROUGH SEAS.",
      FIJI_AREA,
    ),
    [160, -25, 220, 0],
  );
  // Latitude-only bounds take the area's longitude span
  assert.deepEqual(
    parseCardinalBounds(
      "IN THE AREA SOUTH OF 15S, EXPECT ROUGH SEAS.",
      FIJI_AREA,
    ),
    [160, -25, 240, -15],
  );
  // A well-defined box inside the area keeps its longitudes, lat
  // clamped into the area band
  assert.deepEqual(
    parseCardinalBounds("BETWEEN 165W AND 135W", FIJI_AREA),
    [-165, -25, -135, 0],
  );
  // A box outside the declared area is other ocean's text: no
  // geometry, the block's note rides text-only if at all
  assert.equal(
    parseCardinalBounds(
      "IN THE AREA EAST OF 110W, EXPECT LIGHT SWELLS.",
      FIJI_AREA,
    ),
    null,
  );
  // Without coverage the loose defaults stand, byte for byte
  assert.deepEqual(parseCardinalBounds("EAST OF 170W"), [-170, -90, 180, 90]);
});

test("longitude BETWEEN pairs pick the shorter eastward arc", () => {
  // 160E→120W is the 80° Fiji arc across the seam, not the numeric
  // min/max sweep through the Americas
  assert.deepEqual(
    parseCardinalBounds("BETWEEN 160E AND 120W"),
    [160, -90, 240, 90],
  );
  // Both-west pairs stay exactly as the numeric pair read them
  assert.deepEqual(
    parseCardinalBounds("BETWEEN 165W AND 135W"),
    [-165, -90, -135, 90],
  );
});

test("swells line clamps to the declared area (2026-10-28 report)", () => {
  // A Neiafu-style vessel east of 170W keeps the swells block with
  // the issuer's waters as its extent
  const bulletin = filterBulletin({
    rawText: NFFN_SWELLS_BULLETIN,
    source: "spool",
    track: [[-165, -18]],
  });
  const swells = bulletin.blocks.find((b) => /EAST OF 170W/.test(b.text));
  assert.ok(swells, "swells block kept");
  assert.equal(swells.geometryType, "bbox");
  assert.deepEqual(swells.geometry.coordinates, [-170, -25, -120, 0]);

  // A vessel west of 170W reads no swells block: the clamped area no
  // longer reaches halfway around the world
  const westBulletin = filterBulletin({
    rawText: NFFN_SWELLS_BULLETIN,
    source: "spool",
    track: [[178, -17]],
  });
  assert.ok(
    !westBulletin.blocks.some((b) => /EAST OF 170W/.test(b.text)),
    "swells block dropped west of its area",
  );
});

test("extractIssuer: issuing authority from the bulletin header", () => {
  // The observed NFFN phrasing, with its issue-time fragment stripped.
  assert.equal(
    extractIssuer("ISSUED BY FIJI METEOROLOGICAL SERVICE SEP 270800 UTC."),
    "FIJI METEOROLOGICAL SERVICE",
  );
  // Other observed shapes of the trailing time fragment.
  assert.equal(
    extractIssuer("ISSUED BY FIJI METEOROLOGICAL SERVICE 270800 UTC."),
    "FIJI METEOROLOGICAL SERVICE",
  );
  assert.equal(
    extractIssuer("ISSUED BY FIJI METEOROLOGICAL SERVICE 270800Z"),
    "FIJI METEOROLOGICAL SERVICE",
  );
  // No time fragment at all — name only.
  assert.equal(extractIssuer("ISSUED BY METEO-FRANCE."), "METEO-FRANCE");
  // Lowercase station style matches too.
  assert.equal(
    extractIssuer("Issued by Fiji Meteorological Service Sep 27 0800 UTC."),
    "Fiji Meteorological Service Sep 27",
  );
  // Bulletins that name no issuer: structured UKHO warnings, some NWS
  // products — null, and note consumers fall back to the publisher.
  assert.equal(extractIssuer("GALE WARNING. Within 300 nm of a line."), null);
});

test("filterBulletin carries the issuing authority", () => {
  const text = [
    "FQPS01 NFFN 270700",
    "MARINE WEATHER BULLETIN FOR ISLANDS AREA",
    "ISSUED BY FIJI METEOROLOGICAL SERVICE SEP 270800 UTC.",
    "",
    "PART 1 : WARNINGNIL.",
  ].join("\n");
  const result = filterBulletin({ rawText: text, source: "api", track: [] });
  assert.equal(result.issuer, "FIJI METEOROLOGICAL SERVICE");
  const noIssuer = filterBulletin({
    rawText: "GALE WARNING. Within 300 nm of a line 45S 170E to 50S 172E.",
    source: "api",
    track: [],
  });
  assert.equal(noIssuer.issuer, null);
});

test("live NFFN bulletin: axis lines band-filtered, cardinal areas kept", () => {
  // Real FQPS01 NFFN text as received on board 2026-09-27, vessel at
  // anchor 18.7S 174W: T1/T2 axis bands lie well north (dropped), the
  // "south of 10S and west of 169W" area contains the vessel (kept)
  const text = [
    "FQPS01 NFFN 270700",
    "MARINE WEATHER BULLETIN FOR ISLANDS AREA",
    "EQUATOR TO 25S BETWEEN 160E AND 120W.",
    "ISSUED BY FIJI METEOROLOGICAL SERVICE SEP 270800 UTC.",
    "",
    "PART 1 : WARNINGNIL.",
    "",
    "PARTS 2 AND 3 : SYNOPSIS AND FORECAST VALID UNTIL SEP 280600 UTC.",
    "",
    " TROUGH T1 10S 160E 12S 166E SLOW MOVING. POOR VISIBILITY IN",
    "OCCASIONAL SHOWERS AND FEW THUNDERSTORMS WITHIN 100 NAUTICAL MILES OF",
    "T1.",
    "",
    "TROUGH T2 08S 172E 11S 179W 13S 173W SLOW MOVING. POOR VISIBILITY IN",
    "OCCASIONAL SHOWERS AND FEW THUNDERSTORMS WITHIN 120 NAUTICAL MILES OF",
    "T2.",
    "",
    "IN THE AREA SOUTH OF 10S AND WEST OF 169W, EXPECT SOUTHEAST WINDS 25",
    "TO 30 KNOTS. ROUGH TO VERY ROUGH SEAS. MODERATE TO HEAVY SOUTH TO",
    "SOUTHEAST SWELLS. ",
  ].join("\n");
  const bulletin = filterBulletin({
    rawText: text,
    source: "api",
    track: [[-173.982, -18.658]],
  });
  const texts = bulletin.blocks.map((b) => b.text);
  assert.ok(
    texts.some((t) => t.includes("SOUTHEAST WINDS 25")),
    "area containing the vessel kept",
  );
  assert.ok(!texts.some((t) => t.includes("TROUGH T1")), "T1 band dropped");
  assert.ok(!texts.some((t) => t.includes("TROUGH T2")), "T2 band dropped");
});

/** Full FQPS01 NFFN synopsis with named features (CF, T1–T4, L). */
const NFFN_SYNOPSIS = [
  "PARTS 2 AND 3 : SYNOPSIS AND FORECAST VALID UNTIL SEP 291800 UTC.",
  "",
  " LOW PRESSURE L CENTER [1009 HPA] WAS ANALYSED NEAR 05.0S 171.0E AT",
  "280600 UTC. L SLOW MOVING. POSITION POOR.",
  "",
  "TROUGH T1 09S 160E 11S 163E 14S 167E 18S 173E SLOW MOVING. POOR",
  "VISIBILITY IN OCCASIONAL SHOWERS AND ISOLATED THUNDERSTORM WITHIN 100",
  "NAUTICAL MILES OF T1.",
  "",
  "TROUGH T2 12S 172E 07S 171E TO L TO 03S 173E EQT 177E SLOW MOVING.",
  "POOR VISIBILITY IN OCCASIONAL RAIN, HEAVY AT TIMES AND FEW",
  "THUNDERSTORMS WITHIN 140 NAUTICAL MILES OF T2.",
  "",
  "TROUGH T3 12S 175E 14S 180 15S 177W SLOW MOVING. POOR VISIBILITY IN",
  "SOME SHOWERS AND ISOLATED THUNDERSTORM WITHIN 080 NAUTICAL MILES OF",
  "T3.",
  "",
  "TROUGH T4 04S 170W 06S 168W 08S 165W SLOW MOVING. POOR VISIBILITY IN",
  "OCCASIONAL RAIN, HEAVY AT TIMES AND FEW THUNDERSTORMS WITHIN 140",
  "NAUTICAL MILES OF T4.",
  "",
  "COLD FRONT CF 16S 150W 20S 140W 25S 132W SLOW MOVING. POOR VISIBILITY",
  "IN SOME SHOWERS WITHIN 100 NAUTICAL MILES OF CF.",
  "",
  "IN THE AREA SOUTH OF 09S AND WEST OF CF, EXPECT SOUTHEAST WINDS 20 TO",
  "30 KNOTS. ROUGH TO VERY ROUGH SEAS. MODERATE SOUTHERLY SWELLS.",
  "",
  "IN THE AREA SOUTH OF 10S, BETWEEN 150W AND CF, EXPECT MODERATE TO",
  "HEAVY SOUTHERLY SWELLS.",
].join("\n");

test("named-feature areas: NFFN synopsis filtered for six vessels", () => {
  const kept = (track) =>
    filterBulletin({
      rawText: NFFN_SYNOPSIS,
      source: "spool",
      track,
    }).blocks.map((b) => b.text);
  const has = (texts, marker) => texts.some((t) => t.includes(marker));

  // Fiji: west of CF — winds warning applies, the 150W–CF swells do not
  const fiji = kept([[178, -17]]);
  assert.equal(has(fiji, "WEST OF CF"), true);
  assert.equal(has(fiji, "BETWEEN 150W AND CF"), false);

  // In the wedge between 150W and the front: both warnings apply
  const wedge = kept([[-147, -18]]);
  assert.equal(has(wedge, "WEST OF CF"), true);
  assert.equal(has(wedge, "BETWEEN 150W AND CF"), true);

  // Marquesas at 10S: east of the front's waters, nothing applies
  const marquesas = kept([[-139, -11]]);
  assert.equal(has(marquesas, "WEST OF CF"), false);
  assert.equal(has(marquesas, "BETWEEN 150W AND CF"), false);

  // The T1 band (160E–173E, 9S–18S ± 100nm) contains no test vessel
  for (const track of [[[178, -17]], [[-147, -18]]]) {
    const texts = kept(track);
    assert.equal(has(texts, "TROUGH T1"), false);
  }
});

// --- Antimeridian -------------------------------------------------------------

/** Fiji-waters rectangle crossing the seam: 170E → 178W, 16S..25S. */
const SEAM_BOX = parseCardinalBoundsWrapper();
function parseCardinalBoundsWrapper() {
  const { parseCoordinateChain } = require("../plugin/bulletin-engine.js");
  return parseCoordinateChain("16S 170E TO 16S 178W TO 25S 178W TO 25S 170E");
}

test("ringContains handles polygons spanning 180", () => {
  const ring = SEAM_BOX;
  // Inside on the west side (179W is between 180 and the 178W edge)
  assert.equal(ringContains(ring, -179, -20), true);
  // Inside on the eastern (170E..180) side
  assert.equal(ringContains(ring, 171, -20), true);
  // Outside: 177W is east of the box's 178W edge
  assert.equal(ringContains(ring, -177, -20), false);
  // Outside: before 170E
  assert.equal(ringContains(ring, 169, -20), false);
  // Outside: well beyond the seam
  assert.equal(ringContains(ring, -160, -20), false);
});

test("bbox intersection wraps around the antimeridian", () => {
  // EAST OF 179E AND WEST OF 173W: wraps from +179 through 180 to −173
  const bbox = parseCardinalBounds("EAST OF 179E AND WEST OF 173W");
  assert.deepEqual(bbox, [179, -90, 187, 90]); // maxLon unwrapped
  // Track point at 178E: west of the 179E bound → outside
  assert.equal(bboxIntersectsTrack(bbox, [[178, -20]]), false);
  // Track points through the seam: 180E and 179W (181 unwrapped)
  assert.equal(bboxIntersectsTrack(bbox, [[180, -20]]), true);
  assert.equal(bboxIntersectsTrack(bbox, [[-179, -20]]), true);
  assert.equal(bboxIntersectsTrack(bbox, [[-175, -20]]), true);
  // Track point at 150E: outside the box either way
  assert.equal(bboxIntersectsTrack(bbox, [[150, -20]]), false);
});

// --- Track discard rule ---------------------------------------------------------

test("filterBulletin retains the gale warning end-to-end", () => {
  // Subject A (navigational warning) is retained by default
  const result = filterBulletin({
    rawText: NAVAREA_FIXTURE,
    source: "spool",
    track: TONGA_TRACK,
    issuedAt: "2026-08-01T12:00:00.000Z",
  });
  assert.ok(result, "subject A retained");
  assert.equal(result.source, "spool");
  assert.equal(result.issuedAt, "2026-08-01T12:00:00.000Z");
  assert.ok(result.blocks.length > 0);
  const trough = result.blocks.find((b) => b.text.includes("TROUGH"));
  assert.ok(trough, "trough block kept");
  assert.equal(trough.geometryType, "polygon");
  assert.equal(trough.subject, "A");
});

test("retained bulletin: blocks filtered against the Tonga track", () => {
  const result = filterBulletin({
    rawText: NAVAREA_FIXTURE,
    source: "spool",
    track: TONGA_TRACK,
    issuedAt: "2026-08-01T12:00:00.000Z",
    retainedSubjects: "ABEG",
  });
  assert.ok(result, "retained with G in the set");

  // The far-away synopsis has no geography and no severity: it is
  // transmission boilerplate to the warnings console (work doc #23
  // day-one finding: NWS preamble flooded the panel)
  const synopsis = result.blocks.find((b) => b.text.includes("SITUATION"));
  assert.equal(synopsis, undefined, "no-geometry prose dropped");
});
test("ukhoBlocksFromWarnings: structured geometry vs track, point bbox", () => {
  const warnings = [
    {
      text: "BUOY OFF STATION NEAR OPUA",
      issuedAt: "2026-09-27T10:00:00Z",
      coordinates: [
        [174.0, -35.0],
        [174.6, -35.4],
        [174.2, -35.8],
      ],
    },
    {
      text: "FAR SHORE EVENT",
      issuedAt: null,
      coordinates: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    },
    { text: "POINT HAZARD", issuedAt: null, coordinates: [[174.31, -35.31]] },
  ];
  const track = [
    [174.3, -35.3],
    [174.9, -35.6],
  ];
  const blocks = ukhoBlocksFromWarnings(warnings, track);
  assert.deepEqual(
    blocks.map((b) => b.text),
    ["BUOY OFF STATION NEAR OPUA", "POINT HAZARD"],
  );
  assert.equal(blocks[0].source, "ukho");
  assert.equal(blocks[0].geometryType, "polygon");
  assert.equal(blocks[1].geometryType, "bbox");
  assert.equal(blocks[1].subject, null);
});

test("discard rule drops geographically irrelevant warnings", () => {
  // Same warning re-anchored to the Atlantic: nowhere near the track
  const atlantic = NAVAREA_FIXTURE.replace(
    "16S 170E TO 20S 178W TO 25S 175W",
    "40N 020W TO 45N 030W TO 38N 035W",
  );
  const result = filterBulletin({
    rawText: atlantic,
    source: "api",
    track: TONGA_TRACK,
    retainedSubjects: "ABEG",
  });
  const trough = result.blocks.find((b) => b.text.includes("TROUGH"));
  assert.equal(trough, undefined, "Atlantic trough dropped for Pacific track");
  assert.ok(
    !result.blocks.some((b) => b.text.includes("SITUATION")),
    "synopsis prose dropped",
  );
});

// --- Bulletin source ----------------------------------------------------------

test("bulletin cache round-trips and prunes to the newest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bulletin-cache-"));
  assert.deepEqual(await loadBulletinCache(dir), []);

  const entries = [
    { url: "https://x/a.txt", fetchedAt: "2026-08-01T00:00:00Z", text: "A" },
    { url: "https://x/b.txt", fetchedAt: "2026-08-02T00:00:00Z", text: "B" },
  ];
  await saveBulletinCache(dir, entries);
  const loaded = await loadBulletinCache(dir);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].text, "B"); // Newest first

  // Corrupt file → empty, not a crash
  writeFileSync(join(dir, "weather", "bulletins.json"), "{oops");
  assert.deepEqual(await loadBulletinCache(dir), []);
});

test("refreshBulletins fetches online sources, skips failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bulletin-fetch-"));
  const fetchImpl = async (url) => {
    if (String(url).includes("broken")) {
      throw new Error("connection refused");
    }
    return { ok: true, text: async () => NAVAREA_FIXTURE };
  };
  const { fetched, failed, entries } = await refreshBulletins({
    dataDir: dir,
    urls: ["https://met/a.txt", "https://met/broken.txt"],
    fetchImpl,
  });
  assert.deepEqual(fetched, ["https://met/a.txt"]);
  assert.deepEqual(failed, ["https://met/broken.txt"]);
  assert.equal(entries.length, 1);

  // Persisted and re-loadable
  const loaded = await loadBulletinCache(dir);
  assert.equal(loaded.length, 1);
  assert.match(loaded[0].text, /GALE WARNING/);

  // A second refresh failure keeps the cached copy
  const second = await refreshBulletins({
    dataDir: dir,
    urls: ["https://met/a.txt"],
    fetchImpl: async () => {
      throw new Error("offline now");
    },
  });
  assert.deepEqual(second.fetched, []);
  assert.equal((await loadBulletinCache(dir)).length, 1);
});

/**
 * Real-world bulletin fixtures (tests/fixtures/bulletins/): raw texts
 * as received over the wire, so regressions against the live formats
 * surface as failing parses, not silent data loss.
 */
const readFixture = (name) =>
  require("node:fs").readFileSync(
    join(__dirname, "fixtures", "bulletins", name),
    "utf8",
  );

test("FQPS01 NFFN 2026-10-15: TD01F tracked, Neiafu vessel sees the depression", () => {
  const raw = readFixture("fqps01-nffn-2026-10-15.txt");
  // Neiafu, Tonga at anchor
  const neiafu = [[-173.98, -18.65]];
  const result = filterBulletin({
    rawText: raw,
    source: "spool",
    track: neiafu,
  });
  const texts = result.blocks.map((b) => b.text);

  // The tropical depression is tracked even though its analysed
  // position sits ~650nm east: it may develop or head toward the boat
  const depression = result.blocks.find((b) =>
    /TROPICAL DEPRESSION 01F/.test(b.text),
  );
  assert.ok(depression, "TD01F declaration kept");
  assert.equal(depression.geometryType, "point");
  assert.deepEqual(depression.geometry.coordinates, [-163.4, -10.1]);

  // The TD wind-field block places itself around the TD centre: far
  // from Neiafu, so it does not ride along as an unplaceable fragment
  assert.ok(
    !texts.some((t) => t.includes("WITHIN 180 NAUTICAL MILES OF TD01F")),
    "TD wind band dropped for a vessel outside it",
  );

  // "NORTH OF O5S" (OCR zero) must not widen into a pole-to-pole band
  assert.ok(
    !texts.some((t) => t.includes("NORTH OF")),
    "OCR'd latitude bound no longer false-keeps the area",
  );

  // The gale warning area polygon itself is far north-east: the whole
  // warning dies with it — no floating header or trailer fragments
  assert.ok(
    !texts.some((t) => t.includes("GALE WARNING 004")),
    "gale header coalesced into its area and dropped with it",
  );
  assert.ok(
    !texts.some((t) => t.includes("AREA OF GALES")),
    "gale trailer dropped with its area",
  );
  assert.ok(
    !texts.some((t) => t.includes("AREA BOUNDED BY")),
    "gale area dropped for Neiafu",
  );

  // A vessel inside the gale area reads the complete warning as one
  const inside = filterBulletin({
    rawText: raw,
    source: "spool",
    track: [[-163, -6]],
  }).blocks;
  const warning = inside.find((b) => /GALE WARNING 004/.test(b.text));
  assert.ok(warning, "complete gale warning kept for a vessel inside it");
  assert.equal(warning.geometryType, "polygon");
  assert.match(warning.text, /AREA BOUNDED BY/);
  assert.match(warning.text, /CANCELS AND REPLACES/);
});

test("warning-section prose fragments coalesce into their anchored area", () => {
  const coalesce = coalesceWarningBlocks;
  // NFFN gale-warning style: header, area, trailer, cancel notice
  const merged = coalesce([
    "PART 1 : WARNING GALE WARNING 004 ISSUED FROM RSMC NADI Oct 151845\nUTC.",
    "IN THE AREA BOUNDED BY 05S 162W 07S 162W 07S 163W 07S 166W 06S 176W\n05S 162W, EXPECT NORTHWESTERLY WINDS UP TO 35 KNOTS.",
    "AREA OF GALES SLOW MOVING.",
    "THIS WARNING CANCELS AND REPLACES WARNING 003.",
  ]);
  assert.equal(merged.length, 1);
  assert.match(merged[0], /^PART 1 : WARNING/);
  assert.match(merged[0], /AREA BOUNDED BY/);
  assert.match(merged[0], /CANCELS AND REPLACES/);

  // The trailer merges into the area above it, not the area below
  const two = coalesce([
    "GALE WARNING 001 ISSUED FROM RSMC NADI 121800 UTC.",
    "AREA BOUNDED BY 05S 162W 07S 162W 07S 163W 07S 166W 06S 176W 05S 162W. GALE 35 KNOTS.",
    "AREA OF GALES SLOW MOVING.",
    "AREA BOUNDED BY 08S 165W 10S 165W 10S 168W 08S 168W 08S 165W. GALE 40 KNOTS.",
  ]);
  assert.equal(two.length, 2);
  assert.match(two[0], /AREA OF GALES/);
  assert.match(two[0], /35 KNOTS/);
  assert.doesNotMatch(two[0], /40 KNOTS/);
  assert.match(two[1], /40 KNOTS/);

  // A text-only warning (no anchored block) passes through unchanged:
  // the conservative keep stands
  const textOnly = coalesce(["GALE WARNING. EXPECT 35 KNOTS OVER WATERS."]);
  assert.deepEqual(textOnly, ["GALE WARNING. EXPECT 35 KNOTS OVER WATERS."]);

  // A bounds-only area (no coordinate pairs at all) anchors itself
  // instead of merging into a coordinate-bearing neighbour: merging
  // would trade its bbox for the neighbour's chain
  const boundsFirst = coalesce([
    ".WARNINGS.",
    ".HURRICANE RACHEL NEAR 19.8N 112.5W 977 MB AT 2100 UTC OCT 03.\nTROPICAL STORM FORCE WINDS WITHIN 100 NM W SEMICIRCLE...130 NM NE",
    "QUADRANT AND 120 NM SE QUADRANT. ELSEWHERE FROM 16N TO 22N\nBETWEEN 107W AND 116W WINDS 20 TO 33 KT.",
  ]);
  assert.equal(boundsFirst.length, 2);
  // The heading rides with the bounds block (its nearest anchor)
  assert.match(boundsFirst[1], /^\.WARNINGS\./);
  assert.match(boundsFirst[1], /BETWEEN 107W AND 116W/);
  // The coordinate-bearing half stays its own conservative keep
  assert.match(boundsFirst[0], /RACHEL NEAR 19\.8N 112\.5W/);
  assert.doesNotMatch(boundsFirst[0], /BETWEEN 107W/);

  // A coordinate-bearing block that places to null is never swallowed:
  // with no anchored block in the section at all, everything keeps the
  // conservative passthrough
  const stranded = coalesce([
    ".WARNINGS.",
    ".HURRICANE RACHEL NEAR 19.8N 112.5W 977 MB AT 2100 UTC OCT 03.\nMAXIMUM SUSTAINED WINDS 70 KT.",
    "SEAS 4 M OR GREATER WITHIN 180 NM W SEMICIRCLE WITH SEAS TO 11 M.",
  ]);
  assert.equal(stranded.length, 3);
  assert.match(stranded[1], /RACHEL NEAR/);
  assert.match(stranded[2], /SEAS 4 M OR GREATER/);
});

test("FQPS01 NFFN 2026-10-15: a track into the TD wind field keeps the band", () => {
  const raw = readFixture("fqps01-nffn-2026-10-15.txt");
  // Heading east toward the depression
  const result = filterBulletin({
    rawText: raw,
    source: "spool",
    track: [
      [-173.98, -18.65],
      [-163, -11],
    ],
  });
  const texts = result.blocks.map((b) => b.text);
  assert.ok(
    texts.some((t) => t.includes("WITHIN 180 NAUTICAL MILES OF TD01F")),
    "TD wind band kept once the track enters it",
  );
});

/** TC Wati storm warning (2026-10-16): the bulletin that must never
 * be missed — spelled-out hemispheres ("NEAR 12.1 SOUTH 163.0 WEST"),
 * a GMDSS header merged onto the declaration by coalescing, and the
 * NFFN quadrant wind lines. */
test("FQPS01 NFFN 2026-10-16: TC Wati storm warning reaches a distant vessel", () => {
  const raw = readFixture("fqps01-nffn-2026-10-16.txt");
  const neiafu = [[-173.98, -18.65]];
  const result = filterBulletin({
    rawText: raw,
    source: "spool",
    track: neiafu,
  });

  // "ISSUED BY FIJI METEOROLOGICAL SERVICE Oct 162000 UTC." parses
  assert.equal(result.issuedAt, "2026-10-16T20:00:00.000Z");
  assert.match(result.issuer, /FIJI METEOROLOGICAL SERVICE/);

  // The whole storm warning coalesces into one point-typed block:
  // the declared position must survive the spelled-out hemispheres
  const storm = result.blocks.find((b) => /TROPICAL CYCLONE WATI/.test(b.text));
  assert.ok(storm, "storm warning block kept");
  assert.equal(storm.geometryType, "point");
  assert.deepEqual(storm.geometry.coordinates, [-163, -12.1]);
  // Header, movement, wind field and quadrant lines ride along
  assert.match(storm.text, /STORM WARNING 012/);
  assert.match(storm.text, /REPEAT POSITION 12\.1S 163\.0W/);
  assert.match(storm.text, /INCREASING TO\n60 KNOTS/);
  assert.match(storm.text, /WITHIN 95 NAUTICAL MILES IN SE QUADRANT/);

  // The gale warning polygon is far from Neiafu: it dies whole, no
  // floating header or cancel notice left behind
  const texts = result.blocks.map((b) => b.text);
  assert.ok(
    !texts.some((t) => t.includes("GALE WARNING 011")),
    "gale warning coalesced into its area and dropped with it",
  );
  assert.ok(
    !texts.some((t) => t.includes("AREA OF GALES")),
    "gale trailer dropped with its area",
  );
  assert.ok(
    !texts.some((t) => t.includes("FORECAST POSITION NEAR 13.2S")),
    "forecast line dropped for a vessel outside it",
  );
});

test("FQPS01 NFFN 2026-10-16: named wind field and gale area place for vessels inside them", () => {
  const raw = readFixture("fqps01-nffn-2026-10-16.txt");

  // A vessel within 300 nm of the Wati centre reads the wind-field
  // paragraph: the named reference ("OF TROPICAL CYCLONE WATI
  // CENTER") resolves through the collected feature
  const inBand = filterBulletin({
    rawText: raw,
    source: "spool",
    track: [[-163, -15]],
  });
  const band = inBand.blocks.find((b) =>
    /WITHIN 300 NAUTICAL MILES OF TROPICAL CYCLONE WATI CENTER/.test(b.text),
  );
  assert.ok(band, "Wati wind-field band kept for a vessel inside it");
  // The 300 nm radius reads as a circle polygon, not a square
  assert.equal(band.geometryType, "polygon");

  // A vessel inside the gale polygon reads the complete warning
  const inGale = filterBulletin({
    rawText: raw,
    source: "spool",
    track: [[-160, -15]],
  });
  const gale = inGale.blocks.find((b) => /GALE WARNING 011/.test(b.text));
  assert.ok(gale, "complete gale warning kept for a vessel inside it");
  assert.equal(gale.geometryType, "polygon");
  assert.match(gale.text, /AREA BOUNDED BY 13S 159W/);
  assert.match(gale.text, /AREA OF GALES/);
  assert.match(gale.text, /CANCELS AND REPLACES/);
});

test("spelled-out hemispheres contract to the letter form", () => {
  // The NFFN cyclone-position phrasing, line-wrapped as received
  const cleaned = stripBoilerplate(
    "TROPICAL CYCLONE WATI CENTRE 994HPA CATEGORY 1 WAS LOCATED NEAR 12.1\nSOUTH 163.0 WEST AT 161800 UTC.",
  );
  assert.match(cleaned, /NEAR 12\.1S 163\.0W AT 161800 UTC\./);

  // Prose numbers with a spelled direction stay prose: only the
  // paired lat+lon form is rewritten
  assert.doesNotMatch(stripBoilerplate("VISIBILITY 5 SOUTH OF T1."), /5SOUTH/);

  // The contracted form parses through the NEAR extraction
  assert.deepEqual(stormDeclarationPoint(cleaned), [-163, -12.1]);
});

test("NFFN latitude band pair parses with the stray-OF typo", () => {
  assert.deepEqual(
    parseCardinalBounds(
      "IN THE AREA BETWEEN OF 16S AND 22S AND BETWEEN 156W AND 169W, EXPECT",
    ),
    [-169, -22, -156, -16],
  );
});

test("NHC Atlantic HSF (HSFAT2): compact coordinates, Gulf naming, issue metadata", () => {
  const raw = readFixture("hsfat2-knhc-2026-10-03.txt");

  // Compact NHC coordinate pairs (13N67W, no separator) parse
  assert.deepEqual(parseCoordinatePoints("13N67W TO 14N71W"), [
    [-67, 13],
    [-71, 14],
  ]);

  // Hemisphere-less second numbers stay prose: "07N TO 31N" is two
  // latitudes, not 7N 31E
  assert.deepEqual(parseCoordinatePoints("ATLANTIC FROM 07N TO 31N"), []);

  // The renamed Gulf is normalized back to the crew's name everywhere
  // the cleaned text is shown
  assert.match(stripBoilerplate(raw), /GULF OF MEXICO/);
  assert.doesNotMatch(stripBoilerplate(raw), /GULF OF AMERICA/);

  const track = [
    [-73.5, 12.5], // In the 13N67W Caribbean polygon
    [-86, 16.5], // In the 17N85W Caribbean polygon
    [-88, 25], // In the 24-hour Gulf polygon
    [-96.5, 27], // In the 36-hour Gulf polygon
  ];
  const result = filterBulletin({ rawText: raw, source: "api", track });

  // "0430 UTC SAT OCT 3 2026" issue line parsed (NHC style)
  assert.equal(result.issuedAt, "2026-10-03T04:30:00.000Z");
  // ".FORECASTER DELGADO." parsed as the issuer
  assert.match(result.issuer, /DELGADO/);

  const polygons = result.blocks.filter((b) => b.geometryType === "polygon");
  // All four WITHIN areas extract as polygons on a covering track
  assert.equal(polygons.length, 4);
  assert.match(polygons[0].text, /CARIBBEAN WITHIN 13N67W/);
  assert.match(polygons[1].text, /CARIBBEAN WITHIN 17N85W/);
  assert.match(polygons[2].text, /GULF OF MEXICO WITHIN 26N84W/);
  assert.match(polygons[3].text, /GULF OF MEXICO 36 HOUR FORECAST/);
  // The Gulf polygons keep their normalized naming
  assert.ok(polygons.every((b) => !/GULF OF AMERICA/.test(b.text)));
  // Ring coordinates are lon/lat with west negative
  assert.deepEqual(polygons[0].geometry.coordinates[0], [-67, 13]);
});

test("NHC Atlantic HSF: track off the bulletin's waters keeps only unfilterable blocks", () => {
  const raw = readFixture("hsfat2-knhc-2026-10-03.txt");
  const result = filterBulletin({
    rawText: raw,
    source: "api",
    // South Pacific, nowhere near the Atlantic areas
    track: [
      [178.4, -18.1],
      [179.9, -19],
    ],
  });
  // No WITHIN polygon survives the discard rule
  assert.ok(result.blocks.every((b) => b.geometryType !== "polygon"));
});

test("spool-watcher parses the NHC issue line (0430 UTC SAT OCT 3 2026)", () => {
  const { extractIssuedAt } = require("../plugin/spool-watcher.js");
  assert.equal(
    extractIssuedAt("0430 UTC SAT OCT 3 2026"),
    "2026-10-03T04:30:00.000Z",
  );
  assert.equal(
    extractIssuedAt("1645 UTC MON SEP 28 2026"),
    "2026-09-28T16:45:00.000Z",
  );
  // The existing formats still win when present
  assert.equal(
    extractIssuedAt("2026-09-28T16:45:00Z"),
    "2026-09-28T16:45:00.000Z",
  );
  assert.equal(extractIssuedAt("no timestamp here"), null);
});

/**
 * Per-fixture regression suite: one test per real-world bulletin
 * family, asserting the pieces the briefing actually consumes — issue
 * metadata, issuer, and geography extraction on a representative
 * track. The fixtures are the received texts, byte for byte.
 */
const bulletinsDir = join(__dirname, "fixtures", "bulletins");

/** Representative tracks per bulletin family (GeoJSON [lon, lat]). */
const FAMILY_TRACKS = {
  atlantic: [
    [-73.5, 12.5],
    [-86, 16.5],
    [-88, 25],
  ],
  eastPacific: [
    [-110, 10],
    [-95, 15],
    [-130, 20],
  ],
  northPacific: [
    [-155, 30],
    [-160, 25],
  ],
  southPacific: [
    [-175, -18],
    [-179, -20],
  ],
  fiji: [
    [178.4, -18.1],
    [179.9, -19],
  ],
};

for (const [file, track] of [
  ["fznt01-kwbc-hsf-at1.txt", FAMILY_TRACKS.atlantic],
  ["fzpn01-kwbc-hsf-ep1.txt", FAMILY_TRACKS.eastPacific],
  ["fzpn03-knhc-hsf-ep2.txt", FAMILY_TRACKS.eastPacific],
  ["fzpn40-phfo-hsf-np.txt", FAMILY_TRACKS.northPacific],
  ["fzps40-phfo-hsf-sp.txt", FAMILY_TRACKS.southPacific],
  ["fqps01-nffn.txt", FAMILY_TRACKS.fiji],
]) {
  test(`fixture ${file}: parses metadata and geography`, () => {
    const raw = readFixture(file);
    const result = filterBulletin({ rawText: raw, source: "api", track });
    assert.ok(result, "bulletin retained");

    // The issue time parses (no epoch-0 fallback)
    assert.notEqual(
      result.issuedAt,
      "1970-01-01T00:00:00.000Z",
      `issuedAt unparsed for ${file}`,
    );
    const issued = new Date(result.issuedAt).getTime();
    assert.ok(issued > Date.UTC(2020, 0, 1), `issuedAt ${result.issuedAt}`);

    // An issuer is identified
    assert.ok(result.issuer, `issuer missing for ${file}`);

    // Geography extracts somewhere on the covering track: the
    // formatting families differ, but none is a geometry-less blob
    assert.ok(
      result.blocks.some((b) => b.geometryType != null),
      `no geographic blocks extracted for ${file}`,
    );
    // Blocks carry the cleaned text only (renamed geography normalized)
    assert.ok(result.blocks.every((b) => !/GULF OF AMERICA/.test(b.text)));
  });
}

test("fixture fzps40 (South Pacific): the gale warning reaches the Tonga track", () => {
  const raw = readFixture("fzps40-phfo-hsf-sp.txt");
  const result = filterBulletin({
    rawText: raw,
    source: "api",
    track: FAMILY_TRACKS.southPacific,
  });
  const gale = result.blocks.find((b) => /GALE WARNING/.test(b.text));
  assert.ok(gale, "gale warning block retained");
  assert.equal(gale.geometryType, "polygon");
  // The warning's front chain interpolates into the vessel's waters
  assert.ok(
    gale.geometry.coordinates.some(([lon, lat]) => lat < 0 && lon > 160),
  );
});

test("fixture fqps01 (Fiji NAVAREA XIV): MetService-family format", () => {
  const raw = readFixture("fqps01-nffn.txt");
  const result = filterBulletin({
    rawText: raw,
    source: "api",
    track: FAMILY_TRACKS.fiji,
  });
  // "ISSUED BY ... OCT 022000 UTC." parses (month, day+hhmm, UTC)
  assert.match(result.issuedAt, /^2026-10-02T20:00/);
  assert.match(result.issuer, /FIJI METEOROLOGICAL SERVICE/);
  // The trough axis line extracts (two-point chain stays a line)
  const line = result.blocks.find((b) => b.geometryType === "line");
  assert.ok(line, "trough axis line extracted");
  assert.equal(line.geometry.coordinates.length, 2);
});

test("fixture fqps43 (MetService NZ Subtropic): WMO-set rendering, day+hhmmUTC issue line", () => {
  const raw = readFixture("fqps43-nzkl-subtropic.txt");
  const result = filterBulletin({
    rawText: raw,
    source: "api",
    // Mid-band vessel, north of the ridge
    track: [[172, -27]],
  });
  assert.ok(result, "bulletin retained");
  // "Wellington issued at 021856UTC Valid until 031200UTC." parses
  // (day+hhmm, UTC, no month/year on the wire)
  assert.notEqual(result.issuedAt, "1970-01-01T00:00:00.000Z");
  assert.match(result.issuer, /New Zealand/);
  // The masthead (title + area statement) stays off the console; its
  // content rides the bulletin header and declared-area parse instead
  assert.ok(
    result.blocks.every((b) => !isMastheadBlock(b.text)),
    "masthead on the console",
  );
  // The situation-analysis features still collect for named-bound
  // resolution (Ridge R1's axis chain), whatever the console retains
  const features = collectFeatures(stripBoilerplate(raw));
  assert.ok(features.has("R1"), "ridge feature collected");
});

test("the bulletin masthead never renders as a warning (2026-10-28 live NFFN)", () => {
  const raw = readFixture("fqps01-nffn-2026-10-28.txt");
  // Vessel at North Minerva Reef, 18.3S 174.3E — inside the masthead's
  // declared area (EQUATOR TO 25S BETWEEN 160E AND 120W, the 80°
  // eastward arc) once bounds wrap the seam correctly; the title card
  // must still not reach the console as a "warning"
  const here = filterBulletin({
    rawText: raw,
    source: "api",
    track: [[174.3, -18.3]],
  });
  assert.ok(here, "bulletin retained");
  assert.ok(
    here.blocks.every((b) => !isMastheadBlock(b.text)),
    `masthead on the console: ${here.blocks.map((b) => b.text.split(/\r?\n/)[0]).join(" | ")}`,
  );
  // Inside the declared east-of-170W swells slice the swell note serves
  const swells = filterBulletin({
    rawText: raw,
    source: "api",
    track: [[-165, -20]],
  });
  assert.ok(swells.blocks.some((b) => /EAST OF 170W/.test(b.text)));
  // An unplaced track (no route compiled yet) is the bug's exact serve
  // shape: everything placeable keeps, the masthead does not
  const unplaced = filterBulletin({ rawText: raw, source: "api", track: [] });
  assert.ok(
    unplaced.blocks.every((b) => !isMastheadBlock(b.text)),
    "masthead kept on an empty track",
  );
});

test("WMO-set masthead and area statement render no console blocks either", () => {
  const raw = readFixture("fqps43-nzkl-subtropic.txt");
  const result = filterBulletin({
    rawText: raw,
    source: "api",
    track: [[172, -29]],
  });
  assert.ok(
    result.blocks.every((b) => !/MARINE WEATHER BULLETIN FOR/.test(b.text)),
  );
  assert.ok(result.blocks.every((b) => !/^Area from 25S/m.test(b.text)));
});

test("NWS masthead keeps out of the console", () => {
  const raw = readFixture("fznt01-kwbc-hsf-at1.txt");
  const result = filterBulletin({
    rawText: raw,
    source: "api",
    track: [[-73.5, 12.5]],
  });
  assert.ok(result.blocks.every((b) => !isMastheadBlock(b.text)));
});

test("fixture fqau23 (Australian BoM Western METAREA X): commencing issue line", () => {
  const raw = readFixture("fqau23-ammc-western.txt");
  const result = filterBulletin({
    rawText: raw,
    source: "api",
    // Cold-front latitudes where the Australian warnings live
    track: [
      [110, -42],
      [125, -48],
    ],
  });
  assert.ok(result, "bulletin retained");
  // "For 24 hours commencing 2300 UTC 2 October 2026" parses
  assert.equal(result.issuedAt, "2026-10-02T23:00:00.000Z");
  assert.match(result.issuer, /Bureau of Meteorology/);
  // The frontal systems extract as polygons
  assert.ok(
    result.blocks.some((b) => b.geometryType === "polygon"),
    "front polygon extracted",
  );
});

test("fixture wtpz23 (NHC hurricane forecast/advisory): quadrant radii become geometry", () => {
  const raw = readFixture("wtpz23-knhc-tcmep3.txt");
  const result = filterBulletin({
    rawText: raw,
    source: "api",
    // Inside the present 34 KT wind field
    track: [[-112.5, 20.0]],
  });
  assert.ok(result, "bulletin retained");
  assert.equal(result.issuedAt, "2026-10-03T03:00:00.000Z");
  assert.match(result.issuer, /PIERCE/);

  // The advisory is ONE block carrying the structured storm
  const block = result.blocks[0];
  assert.ok(block.storm, "structured storm data attached");
  assert.equal(block.storm.stormName, "HURRICANE RACHEL");
  assert.equal(block.storm.advisoryNumber, 24);
  assert.deepEqual(block.storm.center, { lat: 19.4, lon: -111.5 });
  assert.equal(block.storm.movementDegrees, 280);
  assert.equal(block.storm.movementSpeedKt, 4);
  assert.equal(block.storm.maxWindKt, 85);
  assert.equal(block.storm.gustKt, 105);
  assert.equal(block.storm.severityLabel, "HURRICANE FORCE");

  // Present wind fields as quadrant rings: 34/50/64 KT + 4 M SEAS
  assert.deepEqual(
    block.storm.fields.map((f) => f.label),
    ["64 KT", "50 KT", "34 KT", "4 M SEAS"],
  );
  const field34 = block.storm.fields.find((f) => f.label === "34 KT");
  assert.deepEqual(field34.radiiNm, { ne: 130, se: 120, sw: 120, nw: 130 });
  assert.equal(field34.geometry.type, "polygon");
  assert.equal(field34.geometry.coordinates.length, 73); // 5° steps + closure
  // The block geometry IS the 34 KT ring (the warning area)
  assert.equal(block.geometryType, "polygon");

  // Forecast positions with their own radii
  assert.equal(block.storm.forecastPoints.length, 6);
  const fc0 = block.storm.forecastPoints[0];
  assert.match(fc0.validText, /FORECAST VALID 03\/1200Z/);
  assert.ok(Math.abs(fc0.lat - 19.5) < 1e-9);
  assert.ok(Math.abs(fc0.lon - -112.1) < 1e-9);
  assert.equal(fc0.maxWindKt, 80);
});

test("NFFN storm warning: prose quadrant radii become storm fields (work doc #48 session)", () => {
  // The RSMC NFFN format spells the wind fields out in prose — a
  // format the NHC advisory parser never sees. The declaration's
  // radii must ride the same storm.fields structure so the map's
  // cyclone graphic and the published regions read both formats
  // alike.
  const raw = [
    "FQPS01 NFFN 181922",
    "PART 1 : WARNING STORM WARNING 026 ISSUED FROM RSMC NADI Oct 181922",
    "UTC.",
    "",
    "TROPICAL CYCLONE WATI CENTRE 980HPA CATEGORY 2 WAS LOCATED NEAR 19.1S 160.2W AT 181800 UTC.",
    "POSITION POOR.",
    "CYCLONE MOVING SOUTH SOUTHEAST AT 14 KNOTS.",
    "",
    "EXPECT SUSTAINED WINDS OF 55 KNOTS CLOSE TO THE CENTRE WEAKENING TO",
    "45 KNOTS BY 190600 UTC.",
    "",
    "EXPECT WINDS OVER 47 KNOTS WITHIN 50 NAUTICAL MILES IN NE QUADRANT",
    "                       AND WITHIN 60 NAUTICAL MILES IN SE QUADRANT",
    "                       AND WITHIN 50 NAUTICAL MILES IN SW QUADRANT",
    "                       AND WITHIN 40 NAUTICAL MILES IN NW QUADRANT",
    "",
    "EXPECT WINDS OVER 33 KNOTS WITHIN 120 NAUTICAL MILES IN NE QUADRANT",
    "                       AND WITHIN 130 NAUTICAL MILES IN SE QUADRANT",
    "                       AND WITHIN 100 NAUTICAL MILES IN SW QUADRANT",
    "                       AND WITHIN 70 NAUTICAL MILES IN NW QUADRANT",
    "NNNN",
  ].join("\n");
  const bulletin = filterBulletin({
    rawText: raw,
    source: "api",
    track: [[-161.2, -19.1]],
  });
  assert.equal(bulletin.blocks.length, 1);
  const block = bulletin.blocks[0];
  assert.equal(block.geometry.type, "point");
  assert.deepEqual(block.geometry.coordinates, [-160.2, -19.1]);
  // The storm object mirrors the advisory shape: two threshold rings
  // centred on the declared position
  assert.equal(block.storm.center.lat, -19.1);
  assert.equal(block.storm.center.lon, -160.2);
  assert.deepEqual(
    block.storm.fields.map((f) => [f.threshold, f.radiiNm]),
    [
      [47, { ne: 50, se: 60, sw: 50, nw: 40 }],
      [33, { ne: 120, se: 130, sw: 100, nw: 70 }],
    ],
  );
  for (const field of block.storm.fields) {
    assert.equal(field.geometry.type, "polygon");
    // Closed great-circle ring around the declared centre
    assert.equal(field.geometry.coordinates.length, 73);
    assert.deepEqual(
      field.geometry.coordinates[0],
      field.geometry.coordinates.at(-1),
    );
  }

  // A plain declaration without radii stays storm-less: the point
  // note is all it has
  const plain = filterBulletin({
    rawText: [
      "FQPS01 NFFN 271800",
      "TROPICAL CYCLONE WATI CENTRE 980HPA CATEGORY 2 WAS LOCATED NEAR 19.1S 160.2W AT 180600 UTC.",
      "NNNN",
    ].join("\n"),
    source: "api",
    track: [[-160.2, -19.1]],
  });
  assert.equal(plain.blocks[0].storm, undefined);
});

test("fixture wtpz23 r28: degenerate zero-radius quadrant collapses onto the center", () => {
  const storm = parseAdvisory(readFixture("wtpz23-knhc-tcmep3-r28.txt"));
  // The last outlook carries 50 KT with 0SE 0SW 0NW: only the NE arc
  // has area, the rest of the ring sits at the center
  const outlook = storm.outlookPoints.at(-1);
  const field50 = outlook.fields.find((f) => f.label === "50 KT");
  assert.deepEqual(field50.radiiNm, { ne: 30, se: 0, sw: 0, nw: 0 });
  const ring = field50.geometry.coordinates;
  // Collapsed quadrants touch the outlook's own center — each forecast
  // position's rings center on that position
  const centerPoints = ring.filter(
    ([lon, lat]) =>
      Math.abs(lon - outlook.lon) < 1e-6 && Math.abs(lat - outlook.lat) < 1e-6,
  );
  assert.ok(centerPoints.length >= 2, "collapsed quadrant touches center");
});

test("fixture wtpz23: the advisory filters like any other geometry", () => {
  const raw = readFixture("wtpz23-knhc-tcmep3-r28.txt");
  // Off-track: the whole advisory is discarded
  const off = filterBulletin({
    rawText: raw,
    source: "api",
    track: [
      [178, -21],
      [179, -22],
    ],
  });
  assert.equal(off, null);
  // Near a forecast position: kept even when the present field does
  // not reach
  const forward = filterBulletin({
    rawText: raw,
    source: "api",
    track: [[-121.5, 21.2]],
  });
  assert.ok(forward, "forecast coverage keeps the advisory");
  assert.equal(forward.blocks[0].storm.stormName, "HURRICANE RACHEL");
});

test("issue-time formats: mixed-case months from the WMO bulletin sets", () => {
  const { extractIssuedAt } = require("../plugin/spool-watcher.js");
  // WMO set rendering of the same Fiji bulletin: "Oct" not "OCT"
  assert.equal(
    extractIssuedAt("ISSUED BY FIJI METEOROLOGICAL SERVICE Oct 022000 UTC."),
    new Date(Date.UTC(new Date().getUTCFullYear(), 9, 2, 20, 0)).toISOString(),
  );
  // Full month names (Australian BoM)
  assert.equal(
    extractIssuedAt("For 24 hours commencing 0930 UTC 28 February 2026"),
    "2026-02-28T09:30:00.000Z",
  );
});

test("api.weather.gov resolver: no query params, newest issuance wins, URLs in errors", async () => {
  // The API started rejecting unknown query parameters ("limit is
  // not recognized" → 400), so the resolver must request the bare
  // locations URL and pick the newest iteration itself
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(String(url));
    if (String(url).includes("/locations/NP")) {
      if (String(url).includes("?")) {
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          text: async () => "",
        };
      }
      return {
        ok: true,
        json: async () => ({
          "@graph": [
            {
              id: "older",
              issuanceTime: "2026-10-01T11:00:00+00:00",
            },
            {
              id: "bare-uuid-newest",
              "@id": "https://api.weather.gov/products/newest",
              issuanceTime: "2026-10-03T11:25:00+00:00",
            },
          ],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({ productText: "HIGH SEAS FORECAST NAVAREA IV" }),
    };
  };
  const { text, source } = await resolveBulletinSource(
    "https://api.weather.gov/products/types/HSF/locations/NP",
    { fetchImpl },
  );
  assert.match(text, /HIGH SEAS FORECAST/);
  assert.equal(source, "api");
  // Bare URL requested; the newest issuanceTime fetched via "@id"
  // (the graph's "id" is a bare UUID, not a URL)
  assert.deepEqual(requestedUrls, [
    "https://api.weather.gov/products/types/HSF/locations/NP",
    "https://api.weather.gov/products/newest",
  ]);

  // HTTP failures carry the URL so the checklist detail says which
  // request failed (work doc #23)
  const failing = async () => ({
    ok: false,
    status: 404,
    statusText: "Not Found",
    text: async () => "",
  });
  await assert.rejects(
    resolveBulletinSource(
      "https://api.weather.gov/products/types/HSF/locations/NP",
      {
        fetchImpl: failing,
      },
    ),
    /locations\/NP returned 404/,
  );
  await assert.rejects(
    resolveBulletinSource("https://example.com/bulletin.txt", {
      fetchImpl: failing,
    }),
    /bulletin\.txt returned 404/,
  );
});

test("NHC HSFEP2 (2026-10-03): NWS API preamble stripped, hurricane warning on-track", () => {
  // As received from the api.weather.gov productText: a "000" frame
  // line and a bare WMO routing header lead the product text
  const raw = readFixture("hsfep2-knhc-2026-10-03.txt");
  const cleaned = stripBoilerplate(raw);
  assert.ok(!/^000\b/.test(cleaned), "frame line stripped");
  assert.ok(!/FZPN03 KNHC/.test(cleaned), "routing header stripped");
  assert.match(cleaned, /^HSFEP2/, "product code line survives as header");

  const onTrack = filterBulletin({
    rawText: raw,
    source: "api",
    track: [[-111.8, 19.4]], // Inside the hurricane warning polygon
  });
  assert.equal(onTrack.header, "HSFEP2");
  assert.equal(onTrack.issuedAt, "2026-10-03T10:30:00.000Z");
  assert.ok(
    /NATIONAL HURRICANE CENTER/i.test(onTrack.issuer),
    `issuer parsed (${onTrack.issuer})`,
  );
  const texts = onTrack.blocks.map((b) => b.text);
  // The hurricane warning survives with its polygon
  const warning = texts.find((t) => t.includes("HURRICANE RACHEL NEAR 19.4N"));
  assert.ok(warning, "hurricane warning kept");
  assert.equal(
    onTrack.blocks.find((b) => b.text === warning)?.geometryType,
    "polygon",
  );
  // The decimal-pair position parsed: the polygon covers the storm
  // center (19.4N 111.8W wraps into the polygon's ring)
  assert.ok(
    texts.some((t) => t.includes("24 HOUR FORECAST HURRICANE")),
    "24h forecast block with its own decimal positions kept",
  );
  // Preamble, disclaimers and footers have neither geography nor
  // severity: gone from the warnings console
  assert.ok(!texts.some((t) => t.includes("SECURITE")));
  assert.ok(!texts.some((t) => t.includes("SUPERSEDED BY NEXT ISSUANCE")));
  assert.ok(!texts.some((t) => t.includes("SEAS GIVEN AS SIGNIFICANT")));
  assert.ok(!texts.some((t) => t.includes("SHOULD BE USED WITH CAUTION")));
  assert.ok(!texts.some((t) => t.includes("FORECASTER AL")));
  assert.ok(!texts.some((t) => t.startsWith("HSFEP2")));

  // Off-track the whole warning is dropped — and the boilerplate
  // does not leak into the console in its place
  const offTrack = filterBulletin({
    rawText: raw,
    source: "api",
    track: [[178, -18]], // Fiji waters
  });
  assert.ok(
    !offTrack.blocks.some((b) => b.text.includes("HURRICANE RACHEL")),
    "hurricane off our waters dropped",
  );
  assert.ok(
    offTrack.blocks.every(
      (b) => b.geometryType != null || /HURRICANE/.test(b.text),
    ),
    "nothing without geography or severity survives off-track",
  );
});

test("no-geometry blocks without severity are boilerplate, dropped", () => {
  // "SITUATION IS MODERATE..." carries no geography and no severity:
  // it is synopsis prose, not a warning for the console
  const result = filterBulletin({
    rawText: NAVAREA_FIXTURE,
    source: "spool",
    track: TONGA_TRACK,
  });
  const texts = result.blocks.map((b) => b.text);
  assert.ok(!texts.some((t) => t.includes("SITUATION")), "synopsis dropped");
  assert.ok(
    texts.some((t) => t.includes("DEVELOPING TROUGH")),
    "geographic trough kept",
  );
  // A severity keyword without coordinates survives the rule: a
  // warning whose geography did not parse must not vanish
  const coordsFailed = NAVAREA_FIXTURE.replace(
    "16S 170E TO 20S 178W TO 25S 175W",
    "NOWHERE PARSEABLE",
  );
  const kept = filterBulletin({
    rawText: coordsFailed,
    source: "spool",
    track: TONGA_TRACK,
  });
  assert.ok(
    kept.blocks.some((b) => b.text.includes("GALE WARNING")),
    "unparseable-geometry gale warning kept by severity",
  );
});

test("EQUATOR is a real bound in NWS area headers, not a pole default", () => {
  // "NORTH PACIFIC EQUATOR TO 30N BETWEEN 140W AND 180W" used to
  // parse to a pole-to-pole box on the longitude band, intersecting
  // every water on it — the area line then leaked into consoles as
  // far away as Fiji
  const { parseCardinalBounds } = require("../plugin/bulletin-engine.js");
  assert.deepEqual(
    parseCardinalBounds("NORTH PACIFIC EQUATOR TO 30N BETWEEN 140W AND 180W"),
    [-180, 0, -140, 30],
  );
  assert.deepEqual(
    parseCardinalBounds("EQUATOR TO 03.4S"),
    [-180, -3.4, 180, 0],
  );
  // No equator mention: unchanged behavior — except that "S OF"/
  // "N OF" abbreviations now clamp the latitude band too (NWS
  // High Seas Forecasts abbreviate; the pole default leaked
  // other-ocean synopses into consoles as far away as Tonga)
  assert.deepEqual(
    parseCardinalBounds("S OF 32N BETWEEN 169W AND 178W"),
    [-178, -90, -169, 32],
  );
});

test("fixed NWS disclaimer paragraphs are stripped whole", () => {
  const raw = readFixture("fzpn01-kwbc-hsf-ep1.txt");
  const cleaned = stripBoilerplate(raw);
  assert.ok(
    !cleaned.includes("FROM OCTOBER 15 TO APRIL 1"),
    "seasonal note gone",
  );
  assert.ok(!cleaned.includes("ONLY YOU KNOW THE WEATHER"), "outreach gone");
  assert.ok(
    !cleaned.includes("ALL FORECASTS VALID OVER ICE FREE"),
    "ice note gone",
  );
  assert.ok(!cleaned.includes("SEAS GIVEN AS SIGNIFICANT"), "definition gone");
  assert.ok(
    !cleaned.includes("FORECAST WINDS IN AND NEAR ACTIVE TROPICAL CYCLONES"),
  );
  assert.ok(!cleaned.includes("FOR ANY TROPICAL CYCLONE INFORMATION"));
  // Real content survives the paragraph stripper
  assert.ok(cleaned.includes("STORM WARNING"));

  // With HURRICANE/CYCLONE in the severity keywords, the office name
  // must not count: "NATIONAL HURRICANE CENTER" is not a warning
  const { hasSevereKeyword } = require("../plugin/bulletin-engine.js");
  assert.equal(
    hasSevereKeyword("NWS NATIONAL HURRICANE CENTER MIAMI FL"),
    false,
  );
  assert.equal(hasSevereKeyword("HURRICANE RACHEL NEAR 19.4N"), true);
  assert.equal(hasSevereKeyword("TROPICAL CYCLONE FORCE WINDS"), true);
});

test("textNearTrack: wrong-ocean coordinates prove an entry elsewhere", async () => {
  const { textNearTrack } = require("../plugin/bulletin-engine.js");
  // Real Tonga: 174.2 E, 19 S
  const tonga = [[174.2, -19.0]];
  // The North Pacific synopsis bergie saw: coordinates 59N167W,
  // bounds N OF 50N BETWEEN 170W AND 180W — all far from Tonga
  const northPacific = [
    ".SYNOPSIS AND FORECAST.",
    "LOW 59N167W 1006 MB DRIFTING SE. N OF 50N BETWEEN 170W AND 180W.",
    "WINDS 20 TO 30 KT. SEAS 2.5 TO 4 M.",
    ".24 HOUR FORECAST LOW DISSIPATED.",
  ].join("\n");
  assert.equal(textNearTrack(northPacific, tonga), false);
  // The Fiji bulletin's coordinates plausibly cover Tonga waters
  const fiji = [
    "FQPS01 NFFN 011200Z AUG 26",
    "DEVELOPING TROUGH T1 WITH SQUALLS AND GALES WITHIN 120NM",
    "EAST OF AXIS 16S 170E TO 20S 178W TO 25S 175W.",
  ].join("\n");
  assert.equal(textNearTrack(fiji, tonga), true);
  // A storm named without coordinates cannot be placed: null keeps
  assert.equal(textNearTrack("HURRICANE MARIE MOVING WNW.", tonga), null);
});

test("severe blocks with far-away coordinates are discarded, not rescued", async () => {
  const { filterBulletin } = require("../plugin/bulletin-engine.js");
  const northPacific = [
    "ZCZC 2",
    "HIGH SEAS FORECAST",
    "NWS OCEAN PREDICTION CENTER",
    ".SYNOPSIS AND FORECAST.",
    "LOW 59N167W 1006 MB DRIFTING SE. N OF 50N BETWEEN 170W AND 180W.",
    "WINDS 20 TO 30 KT. SEAS 2.5 TO 4 M.",
    ".24 HOUR FORECAST LOW DISSIPATED AN.",
    "NNNN",
  ].join("\n");
  // The single 59N167W point builds no ring, but the block is placed
  // by its own coordinates: far from Tonga means gone, severity or not
  const bulletin = filterBulletin({
    rawText: northPacific,
    source: "api",
    track: [[-174.2, -19.0]],
  });
  const blocks = bulletin?.blocks ?? [];
  assert.equal(
    blocks.some((b) => b.text.includes("59N167W")),
    false,
    blocks.map((b) => b.text).join(" | "),
  );
  // A severe block with no coordinates at all stays the conservative
  // keep (a named storm without a position must not be lost)
  const named = [
    "ZCZC 3",
    "HIGH SEAS FORECAST",
    ".WARNINGS.",
    "HURRICANE MARIE MOVING WNW. WINDS 65 KT.",
    "NNNN",
  ].join("\n");
  const kept = filterBulletin({
    rawText: named,
    source: "api",
    track: [[-174.2, -19.0]],
  });
  assert.ok(kept?.blocks?.length >= 1, "unplaceable severe block kept");
});

test("FQPS01 NFFN 2026-10-17: the PART 2 continuation parses whole", () => {
  // A multi-part NFFN bulletin whose part boundary splits the
  // reports-request paragraph mid-address: the "AT MET DOT GOV DOT
  // FJ" fragment lands fused onto the cancels notice ("…DOT
  // FJTHIS WARNING CANCELS…") and the gale warning that follows
  // carries no `PART n :` GMDSS prefix (work doc #47 session parse
  // report)
  const raw = readFixture("fqps01-nffn-2026-10-17.txt");
  const cleaned = stripBoilerplate(raw);

  // The fused admin fragment is gone; the cancels notice survives as
  // its own line; the asterisk separator rule is dropped
  assert.ok(!cleaned.includes("FJTHIS"), "fused address fragment de-glued");
  assert.match(cleaned, /^PART 2 OF 3\nTHIS WARNING CANCELS AND REPLACES/m);
  assert.ok(!/\*\*\*\*/.test(cleaned), "asterisk separator rule dropped");

  // The warning section is typed by the bare RSMC header: the gale
  // warning coalesces into one complete block — header, area
  // polygon, trailer and both cancel notices
  const result = filterBulletin({
    rawText: raw,
    source: "spool",
    track: [[-161.2, -14.5]],
  });
  const gale = result.blocks.find((b) => /GALE WARNING 020/.test(b.text));
  assert.ok(gale, "gale warning kept for a vessel inside its area");
  assert.equal(gale.geometryType, "polygon");
  assert.match(gale.text, /CANCELS AND REPLACES WARNING 018/);
  assert.match(gale.text, /IN THE AREA BOUNDED BY 13S 162W/);
  assert.match(gale.text, /AREA OF GALES SLOW MOVING/);
  assert.match(gale.text, /CANCELS AND REPLACES WARNING 017/);
  assert.deepEqual(gale.geometry.coordinates[0], [-162, -13]);
  assert.deepEqual(
    gale.geometry.coordinates[gale.geometry.coordinates.length - 1],
    [-162, -13],
    "the area ring closes",
  );
});

test("FQPS01 NFFN 2026-10-17: synopsis features and radius bands", () => {
  const raw = readFixture("fqps01-nffn-2026-10-17.txt");
  const cleaned = stripBoilerplate(raw);
  const features = collectFeatures(cleaned);

  // The cyclone moved: spelled hemispheres line-wrapped across the
  // part boundary
  assert.deepEqual(features.get("WATI"), [[-163, -14.7]]);
  assert.deepEqual(features.get("TCWATI"), [[-163, -14.7]]);
  // The shallow low is a declared letter feature
  assert.deepEqual(features.get("L"), [[-130, -22.1]]);

  // The convergence zone chains through the cyclone mid-chain ("TO
  // TC WATI TO") — the splice lands Wati's position in the ring
  const cz1 = extractGeometry(
    "CONVERGENCE ZONE CZ1 04S 166E 02S 180E 01S 170W 05S 164W 12S\n159W TO TC WATI TO 16S 165W 18S 160W 15S 152W. CZ1 SLOW MOVING. POOR\nVISIBILITY IN PERIODS OF RAIN, HEAVY AT TIMES AND SQUALLY\nTHUNDERSTORMS WITHIN 180 NAUTICAL MILES OF CZ1.",
    features,
  );
  assert.equal(cz1.type, "polygon");
  assert.ok(
    cz1.coordinates.some(([lon, lat]) => lon === -163 && lat === -14.7),
    "TC WATI position spliced into the chain",
  );
  assert.equal(cz1.bufferNm, 180);

  // The trough chains through the low ("TO L TO")
  const t1 = extractGeometry(
    "TROUGH T1 18S 124W 22S 125W 23S 128W TO L TO 25S 130W 24S 120W.",
    features,
  );
  assert.ok(
    t1.coordinates.some(([lon, lat]) => lon === -130 && lat === -22.1),
    "L position spliced into the trough chain",
  );

  // The wind-field band: a radius reads as a circle around Wati's
  // new position
  const band = extractGeometry(
    "WITHIN 300 NAUTICAL MILES OF TROPICAL CYCLONE WATI CENTRE AND OUTSIDE\nHURRICANE WARNING 019 AND GALE WARNING 020 AREAS, EXPECT CLOCKWISE\nWINDS UP TO 30 KNOTS.",
    features,
  );
  assert.equal(band.type, "polygon");
  const lats = band.coordinates.map(([, lat]) => lat);
  approx(Math.max(...lats), -9.7);
});
