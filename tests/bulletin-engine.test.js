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
  filterBulletin,
  navtexSubject,
  parseCardinalBounds,
  parseCoordinateChain,
  segmentBlocks,
  shouldRetainSubject,
  stripBoilerplate,
  bboxIntersectsTrack,
  ringContains,
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

test("cardinal bounds translate to a bbox", () => {
  // West-of only: half a world against the fixed bound
  assert.deepEqual(
    parseCardinalBounds("SOUTH OF 12S AND WEST OF 173W"),
    [-180, -12, -173, 90],
  );
  // East-of only
  assert.deepEqual(
    parseCardinalBounds("NORTH OF 25S AND EAST OF 179E"),
    [179, -90, 180, -25],
  );
  assert.equal(parseCardinalBounds("no geography here"), null);
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
