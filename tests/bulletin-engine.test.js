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
  extractGeometry,
  filterBulletin,
  navtexSubject,
  parseCardinalBounds,
  parseCoordinateChain,
  parseCoordinatePoints,
  resolveBulletinSource,
  segmentBlocks,
  shouldRetainSubject,
  stripBoilerplate,
  bboxIntersectsTrack,
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

  // The far-away synopsis has no geography: kept conservatively
  const synopsis = result.blocks.find((b) => b.text.includes("SITUATION"));
  assert.ok(synopsis, "no-geometry block kept");
  assert.equal(synopsis.geometryType, null);
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
  assert.ok(result.blocks.some((b) => b.text.includes("SITUATION")));
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
    // Inside the polygon the area definition parses to (the band's
    // western corner — the ring is a coarse 3-point approximation of
    // the stated 25S–40S / 163E–170E area)
    track: [[166, -34]],
  });
  assert.ok(result, "bulletin retained");
  // "Wellington issued at 021856UTC Valid until 031200UTC." parses
  // (day+hhmm, UTC, no month/year on the wire)
  assert.notEqual(result.issuedAt, "1970-01-01T00:00:00.000Z");
  assert.match(result.issuer, /New Zealand/);
  // The situation-analysis ridge chain extracts as a feature line
  const geoms = result.blocks.filter((b) => b.geometryType);
  assert.ok(geoms.length >= 1, "ridge/low geometry extracted");
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

test("fixture wtpz23 (NHC hurricane forecast/advisory): metadata parses, advisory family acknowledged", () => {
  const raw = readFixture("wtpz23-knhc-tcmep3.txt");
  const result = filterBulletin({
    rawText: raw,
    source: "api",
    track: [[-111, 19.4]],
  });
  assert.ok(result, "bulletin retained");
  // "0300 UTC SAT OCT 03 2026" parses
  assert.equal(result.issuedAt, "2026-10-03T03:00:00.000Z");
  assert.ok(result.issuer, "issuer identified");
  // KNOWN LIMITATION (documented here as the regression tripwire): the
  // forecast/advisory geography encodes wind/sea radii per quadrant
  // ("64 KT....... 40NE  35SE  25SW  40NW"), which the coordinate-chain
  // extractor does not yet translate into areas — no geometry today.
  // Building that translation is future work on the hurricane family.
  assert.ok(
    result.blocks.every((b) => b.geometryType == null),
    "advisory still geometry-less; flip this when quadrant radii are supported",
  );
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
