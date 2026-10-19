/**
 * Tests for the METAREA notes publisher (work doc #12): one note per
 * placeable block, title/position/timestamp mapping (including an
 * antimeridian case), content-addressed ids across re-publishes,
 * expiry deletions, and the disabled-clear path.
 *
 * @file notes-publisher.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  geometryPosition,
  geometryToRegionGeometry,
  blockToRegionGeometry,
  corridorRing,
  splitSeamRing,
  noteId,
  regionId,
  noteTitle,
  publishNotes,
  clearNotes,
} = require("../plugin/notes-publisher.js");
const { createNotesStore } = require("../plugin/notes-store.js");
const { createRegionsStore } = require("../plugin/regions-store.js");

function dataDir() {
  return mkdtempSync(join(tmpdir(), "notes-"));
}

function stubStore() {
  return createNotesStore(dataDir());
}

async function notesIn(store) {
  return store.list({});
}

const ISSUED = "2026-09-27T19:42:19.033Z";

const BULLETIN = {
  header: "FQPS01 NFFN 270700",
  issuedAt: ISSUED,
  issuer: "FIJI METEOROLOGICAL SERVICE",
  bulletinText: "…",
  source: "api",
  blocks: [
    {
      text: "FQPS01 NFFN 270700 MARINE WEATHER BULLETIN FOR ISLANDS AREA.",
      subject: null,
      geometryType: null,
      geometry: null,
      source: "api",
    },
    {
      text: "IN THE AREA SOUTH OF 10S AND WEST OF 169W, EXPECT SOUTHEAST WINDS 25 TO 30 KNOTS. ROUGH TO VERY ROUGH SEAS.",
      subject: null,
      geometryType: "bbox",
      geometry: { type: "bbox", coordinates: [-180, -90, -169, -10] },
      source: "api",
    },
    {
      text: "TROUGH T2 08S 172E 11S 179W 13S 173W SLOW MOVING.",
      subject: null,
      geometryType: "line",
      geometry: {
        type: "line",
        coordinates: [
          [172, -8],
          [-179, -11],
          [-173, -13],
        ],
      },
      source: "api",
    },
  ],
};

test("geometryPosition: bbox center, wrapped line midpoint", () => {
  const bbox = geometryPosition({
    type: "bbox",
    coordinates: [-180, -90, -169, -10],
  });
  assert.equal(bbox.longitude, -174.5);
  assert.equal(bbox.latitude, -50);

  // T2 crosses the antimeridian: unfold 172E..173W → 172..181..187,
  // mean 180 → normalized to -180 (the dateline itself)
  const line = geometryPosition({
    type: "line",
    coordinates: [
      [172, -8],
      [-179, -11],
      [-173, -13],
    ],
  });
  assert.equal(line.longitude, -180);
  assert.equal(line.latitude, -10.6667);

  // A named-system declaration places at the analysed position
  // itself: TD01F's note belongs on the storm centre
  const point = geometryPosition({
    type: "point",
    coordinates: [-163.4, -10.1],
  });
  assert.ok(Math.abs(point.longitude + 163.4) < 1e-9);
  assert.equal(point.latitude, -10.1);
});

test("noteTitle: first sentence, truncated on a word boundary", () => {
  assert.equal(noteTitle("GALE WARNING.\nEXPECT WINDS."), "GALE WARNING");
  const long = noteTitle(
    "IN THE AREA SOUTH OF 10S AND WEST OF 169W, EXPECT SOUTHEAST WINDS",
  );
  assert.ok(long.length <= 49);
  assert.ok(long.endsWith("…"));
});

test("publishNotes: one note per placeable block, mapped fields", async () => {
  const store = stubStore();
  const result = await publishNotes({
    store,
    bulletin: BULLETIN,
    zone: 14,
    synopticChartFor: () => ({
      url: "/plugins/signalk-passage-briefing/api/synoptic?zone=14",
      mimeType: "image/gif",
    }),
  });
  assert.equal(result.published.length, 2); // no-geometry block skipped
  const notes = await notesIn(store);
  const [first] = Object.values(notes);
  assert.match(first.title, /SOUTH OF 10S AND WEST OF 169W/);
  assert.equal(first.description, BULLETIN.blocks[1].text);
  assert.equal(first.position.latitude, -50);
  assert.equal(first.properties.category, "meteorological-warning");
  assert.equal(first.properties.zone, 14);
  assert.equal(first.properties.sourcePlugin, "signalk-passage-briefing");
  // Provenance: who issued the bulletin, when it was issued.
  assert.equal(first.properties.publishedBy, "FIJI METEOROLOGICAL SERVICE");
  assert.equal(first.properties.publishedAt, ISSUED);
  assert.equal(first.timestamp, ISSUED);
  assert.equal(first.mimeType, "image/gif"); // chart linked when cached
});

test("re-publish updates in place; expiry prunes dropped blocks", async () => {
  const store = stubStore();
  const params = { store };

  await publishNotes({ ...params, bulletin: BULLETIN, zone: 14 });
  const idBefore = noteId(BULLETIN.blocks[1].text, ISSUED);
  assert.ok((await notesIn(store))[idBefore]);

  // Same blocks again: same ids, still exactly two notes
  await publishNotes({ ...params, bulletin: BULLETIN, zone: 14 });
  assert.equal(Object.keys(await notesIn(store)).length, 2);

  // Only one block survives the next filter pass: the others expire
  const partial = {
    ...BULLETIN,
    issuedAt: "2026-09-27T20:42:19.033Z",
    blocks: [BULLETIN.blocks[1]],
  };
  const result = await publishNotes({ ...params, bulletin: partial, zone: 14 });
  assert.equal(result.published.length, 1);
  const remaining = await notesIn(store);
  assert.equal(Object.keys(remaining).length, 1);
  assert.ok(remaining[noteId(BULLETIN.blocks[1].text, partial.issuedAt)]);
});

test("publishNotes without an issuer: plugin publishes on its own account", async () => {
  // Structured UKHO warnings and some NWS products name no issuing
  // service — the note still carries provenance: the plugin itself.
  const store = stubStore();
  const anonymous = { ...BULLETIN, issuer: null };
  await publishNotes({ store, bulletin: anonymous, zone: 14 });
  const notes = await notesIn(store);
  const [note] = Object.values(notes);
  assert.equal(note.properties.publishedBy, "signalk-passage-briefing");
  assert.equal(note.properties.publishedAt, ISSUED);
});

test("clearNotes empties the store", async () => {
  const store = stubStore();
  await publishNotes({ store, bulletin: BULLETIN, zone: 14 });
  await clearNotes(store);
  assert.deepEqual((await notesIn(store)) ?? {}, {});
});

test("geometryToRegionGeometry: bbox ring, seam-crossing split, polygon passthrough", () => {
  // A plain bbox becomes a closed four-corner ring
  const plain = geometryToRegionGeometry({
    type: "bbox",
    coordinates: [0, -10, 10, 10],
  });
  assert.equal(plain.type, "Polygon");
  assert.deepEqual(plain.coordinates[0], [
    [0, -10],
    [0, 10],
    [10, 10],
    [10, -10],
    [0, -10],
  ]);

  // A seam-crossing bbox splits into two spec-clean rectangles,
  // one touching each side of the antimeridian
  const seam = geometryToRegionGeometry({
    type: "bbox",
    coordinates: [170, -10, -170, 10],
  });
  assert.equal(seam.type, "MultiPolygon");
  assert.deepEqual(seam.coordinates[0][0][0], [170, -10]);
  assert.deepEqual(seam.coordinates[0][0][2], [180, 10]);
  assert.deepEqual(seam.coordinates[1][0][0], [-180, -10]);
  assert.deepEqual(seam.coordinates[1][0][2], [-170, 10]);

  // A parsed polygon rides as-is
  const polygon = geometryToRegionGeometry({
    type: "polygon",
    coordinates: [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 0],
    ],
  });
  assert.equal(polygon.type, "Polygon");
  // GeoJSON: the coordinates wrap the ring (a bare ring here produced
  // malformed published regions that crashed the queries)
  assert.equal(polygon.coordinates.length, 1);
  assert.equal(polygon.coordinates[0].length, 4);

  // Point and line geometry cannot become regions
  assert.equal(
    geometryToRegionGeometry({ type: "point", coordinates: [0, 0] }),
    null,
  );
  assert.equal(
    geometryToRegionGeometry({
      type: "line",
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    }),
    null,
  );
  assert.equal(geometryToRegionGeometry(null), null);
  assert.equal(
    geometryToRegionGeometry({ type: "bbox", coordinates: [NaN, 0, 1, 1] }),
    null,
  );
});

test("blockToRegionGeometry: corridor bands and storm quadrant rings", () => {
  // An axis band expands into the corridor ring the map draws — and
  // a band across the dateline splits into spec-clean parts
  const corridor = blockToRegionGeometry({
    text: "TROUGH T2",
    geometry: {
      type: "line",
      coordinates: [
        [172, -8],
        [-179, -11],
      ],
      bufferNm: 120,
    },
  });
  assert.equal(corridor.type, "MultiPolygon");
  assert.equal(corridor.derived, "corridor");
  // Every part is a closed ring inside the normal frame, and some
  // edge carries the band width (2° of latitude, 120 nm / 60)
  let bandWide = false;
  for (const part of corridor.coordinates) {
    const ring = part[0];
    assert.deepEqual(ring[0], ring.at(-1));
    for (const [lon] of ring) {
      assert.ok(lon >= -180 && lon <= 180, `lon ${lon} in range`);
    }
    for (let i = 1; i < ring.length; i++) {
      if (Math.abs(ring[i][1] - ring[i - 1][1]) > 1.9) {
        bandWide = true;
      }
    }
  }
  assert.ok(bandWide, "the band width is preserved");

  // An axis without a stated band has no area — no region
  assert.equal(
    blockToRegionGeometry({
      geometry: {
        type: "line",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    }),
    null,
  );

  // Advisory storm: the present wind/seas quadrant rings become a
  // MultiPolygon; fields without polygons are skipped
  const storm = blockToRegionGeometry({
    text: "TROPICAL CYCLONE RACHEL",
    geometry: { type: "point", coordinates: [-163.4, -10.1] },
    geometryType: "point",
    storm: {
      center: { lat: -10.1, lon: -163.4 },
      fields: [
        {
          label: "64 KT",
          threshold: 64,
          kind: "wind",
          geometry: {
            type: "polygon",
            coordinates: [
              [-163.4, -9.1],
              [-162.4, -10.1],
              [-163.4, -11.1],
              [-164.4, -10.1],
              [-163.4, -9.1],
            ],
          },
        },
        {
          label: "34 KT",
          threshold: 34,
          kind: "wind",
          geometry: {
            type: "polygon",
            coordinates: [
              [-163.4, -7.1],
              [-160.4, -10.1],
              [-163.4, -13.1],
              [-166.4, -10.1],
              [-163.4, -7.1],
            ],
          },
        },
        {
          label: "12 FT SEAS",
          threshold: 12,
          kind: "seas",
          geometry: null,
        },
      ],
      forecastPoints: [],
    },
  });
  assert.equal(storm.type, "MultiPolygon");
  assert.equal(storm.derived, "quadrant-rings");
  assert.equal(storm.coordinates.length, 2);

  // A text-only storm declaration (NFFN style) keeps its plain point:
  // the note alone carries it
  assert.equal(
    blockToRegionGeometry({
      geometry: { type: "point", coordinates: [-163.4, -10.1] },
      storm: {
        center: { lat: -10.1, lon: -163.4 },
        fields: [],
        forecastPoints: [],
      },
    }),
    null,
  );
});

test("splitSeamRing: crossing rings publish spec-clean parts", () => {
  // A ring entirely west of the seam stays whole
  assert.equal(
    splitSeamRing([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]),
    null,
  );

  // The CZ1 shape: a chain crossing the seam (166E → 180 → 170W …)
  // splits into a west part and a normalized east part
  const crossing = splitSeamRing([
    [166, -4],
    [180, -2],
    [-170, -1],
    [-164, -5],
    [-159, -12],
    [-161, -16],
    [166, -4],
  ]);
  assert.equal(crossing.length, 2);
  const westLons = crossing[0].map(([lon]) => lon);
  const eastLons = crossing[1].map(([lon]) => lon);
  assert.ok(Math.min(...westLons) >= -180 && Math.max(...westLons) <= 180);
  assert.ok(Math.max(...westLons) === 180, "west part touches the seam");
  assert.ok(Math.max(...eastLons) <= 0, "east part normalized below zero");
  assert.ok(Math.min(...eastLons) >= -180);
  // Both parts close
  assert.deepEqual(crossing[0][0], crossing[0].at(-1));
  assert.deepEqual(crossing[1][0], crossing[1].at(-1));

  // A ring already carrying unfolded longitudes (CAP polygons can be
  // written as 178..182) splits the same way
  const unfolded = splitSeamRing([
    [178, -20],
    [182, -20],
    [182, -22],
    [178, -22],
    [178, -20],
  ]);
  assert.equal(unfolded.length, 2);
  assert.deepEqual(unfolded[1][1], [-178, -20]);

  // A west-side crossing normalizes its far part upward
  const westCross = splitSeamRing([
    [-175, -10],
    [-185, -10],
    [-185, -14],
    [-175, -14],
    [-175, -10],
  ]);
  assert.equal(westCross.length, 2);
  const normLons = westCross.map((part) => part.map(([lon]) => lon));
  for (const part of normLons) {
    for (const lon of part) {
      assert.ok(lon >= -180 && lon <= 180, `lon ${lon} in range`);
    }
  }

  // Degenerate inputs pass through as null
  assert.equal(splitSeamRing(null), null);
  assert.equal(splitSeamRing([[0, 0]]), null);
});

test("blockToRegionGeometry: seam-crossing shapes publish as split MultiPolygons", () => {
  // A corridor band crossing the dateline
  const corridor = blockToRegionGeometry({
    text: "TROUGH T2",
    geometry: {
      type: "line",
      coordinates: [
        [178, -8],
        [-178, -11],
      ],
      bufferNm: 60,
    },
  });
  assert.equal(corridor.type, "MultiPolygon");
  assert.equal(corridor.derived, "corridor");
  assert.ok(corridor.coordinates.length >= 2);

  // A cyclone's quadrant ring centred near the seam
  const storm = blockToRegionGeometry({
    text: "TROPICAL CYCLONE RACHEL",
    geometry: { type: "point", coordinates: [179.5, -10] },
    geometryType: "point",
    storm: {
      center: { lat: -10, lon: 179.5 },
      fields: [
        {
          label: "33 KT",
          threshold: 33,
          kind: "wind",
          geometry: {
            type: "polygon",
            coordinates: [
              [179.5, -7.6],
              [181.9, -10],
              [179.5, -12.4],
              [177.1, -10],
              [179.5, -7.6],
            ],
          },
        },
      ],
      forecastPoints: [],
    },
  });
  assert.equal(storm.type, "MultiPolygon");
  assert.equal(storm.derived, "quadrant-rings");
  // The 2.4°-radius ring spans the seam: two parts, both in range
  assert.equal(storm.coordinates.length, 2);
  for (const poly of storm.coordinates) {
    for (const [lon] of poly[0]) {
      assert.ok(lon >= -180 && lon <= 180, `lon ${lon} in range`);
    }
  }
});

test("corridorRing matches the briefing map's expansion (work doc #47 parity)", async () => {
  const { corridorRing: mapCorridorRing } = await import(
    "../public/components/map-model.mjs"
  );
  const points = [
    [172, -8],
    [-179, -11],
    [-173, -13],
  ];
  assert.deepEqual(corridorRing(points, 120), mapCorridorRing(points, 120));
  assert.deepEqual(corridorRing(points, 15), mapCorridorRing(points, 15));
});

test("publishNotes: shaped blocks pair a note with a region", async () => {
  const store = stubStore();
  const regionsStore = createRegionsStore(dataDir());
  const result = await publishNotes({
    store,
    regionsStore,
    bulletin: BULLETIN,
    zone: 14,
  });
  // The bbox block gains a region; the no-geometry and line blocks do not
  assert.equal(result.published.length, 2);
  assert.equal(result.regionsPublished.length, 1);
  const rid = result.regionsPublished[0];
  assert.equal(rid, regionId(BULLETIN.blocks[1].text, ISSUED));
  assert.ok(rid.startsWith("metarea-area-"));

  const noteIdForBlock = noteId(BULLETIN.blocks[1].text, ISSUED);
  const note = (await notesIn(store))[noteIdForBlock];
  // The pairing the region panel lists: the note points at its shape
  assert.equal(note.href, `/resources/regions/${rid}`);

  const region = await regionsStore.get(rid);
  assert.equal(region.name, note.title);
  assert.equal(region.description, BULLETIN.blocks[1].text);
  assert.equal(region.feature.geometry.type, "Polygon");
  // The FULL warning area: the note's quadrant-center placement is
  // an aid, the region is the extent
  assert.deepEqual(region.feature.geometry.coordinates[0][0], [-180, -90]);
  assert.deepEqual(region.feature.geometry.coordinates[0][2], [-169, -10]);
  assert.equal(region.feature.properties.category, "meteorological-warning");
  assert.equal(
    region.feature.properties.publishedBy,
    "FIJI METEOROLOGICAL SERVICE",
  );
  assert.equal(region.feature.properties.publishedAt, ISSUED);
  assert.equal(region.feature.properties.zone, 14);

  // Drop the block from the filtered set: note and region expire
  // together; a foreign region survives
  await regionsStore.set("user-region-foreign", {
    name: "foreign",
    feature: {
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    },
  });
  const partial = {
    ...BULLETIN,
    issuedAt: "2026-09-27T20:42:19.033Z",
    blocks: [BULLETIN.blocks[0]],
  };
  const expiry = await publishNotes({
    store,
    regionsStore,
    bulletin: partial,
    zone: 14,
  });
  assert.equal(expiry.regionsPruned.length, 1);
  assert.ok(!expiry.regionsPruned.includes("user-region-foreign"));
  assert.equal(await regionsStore.get(rid), null);
  assert.ok(await regionsStore.get("user-region-foreign"));
});

test("publishNotes prune is scoped: hazard, cap and client notes survive", async () => {
  const store = stubStore();
  await publishNotes({ store, bulletin: BULLETIN, zone: 14 });
  // Notes from the other feeds and a client-written note predate
  // the next METAREA pass
  await store.set("hazard-abc123", { title: "hazard" });
  await store.set("cap-abc123", { title: "cap" });
  await store.set("urn:mrn:signalk:uuid:01234567-89ab-4cde-8f01-23456789abcd", {
    title: "client note",
  });

  // Only one block survives the next pass: its own stale note
  // expires, everything else stays
  const partial = {
    ...BULLETIN,
    issuedAt: "2026-09-27T20:42:19.033Z",
    blocks: [BULLETIN.blocks[0]],
  };
  const result = await publishNotes({ store, bulletin: partial, zone: 14 });
  const remaining = await notesIn(store);
  assert.ok(remaining["hazard-abc123"], "hazard note untouched");
  assert.ok(remaining["cap-abc123"], "cap note untouched");
  assert.ok(
    remaining["urn:mrn:signalk:uuid:01234567-89ab-4cde-8f01-23456789abcd"],
    "client-written note untouched",
  );
  assert.ok(
    !Object.keys(remaining).some((id) => id.startsWith("metarea-")),
    "stale metarea notes pruned",
  );
  assert.equal(result.pruned.length, 2);
});

test("publishNotes without a regions store keeps notes point-only", async () => {
  const store = stubStore();
  const result = await publishNotes({ store, bulletin: BULLETIN, zone: 14 });
  assert.equal(result.regionsPublished.length, 0);
  const notes = await notesIn(store);
  assert.ok(!Object.values(notes).some((n) => n.href));
});

test("publishNotes: wider-area warnings publish as coverage-marked regions", async () => {
  const store = stubStore();
  const regionsStore = createRegionsStore(dataDir());
  const widerBlock = {
    text: "GALE WARNING 011. IN THE AREA SOUTH OF 25S AND WEST OF 170W, EXPECT WEST WINDS 35 KNOTS. ROUGH SEAS.",
    subject: null,
    geometryType: "polygon",
    geometry: {
      type: "polygon",
      coordinates: [
        [-170, -25],
        [-170, -35],
        [-160, -35],
        [-160, -25],
        [-170, -25],
      ],
    },
    source: "api",
  };
  const bulletin = { ...BULLETIN, wider: [widerBlock] };
  const result = await publishNotes({
    store,
    regionsStore,
    bulletin,
    zone: 14,
  });
  // Wider regions ride their own id arm and carry the coverage marker
  assert.equal(result.widerPublished.length, 1);
  const rid = result.widerPublished[0];
  assert.ok(rid.startsWith("metarea-wide-"));
  const region = await regionsStore.get(rid);
  assert.equal(region.feature.properties.coverage, "wider");
  assert.equal(region.feature.properties.category, "meteorological-warning");
  // No notes for the wider set: the notes feed means on-track warnings
  const notes = await notesIn(store);
  assert.ok(!Object.keys(notes).some((id) => id.includes("wide")));

  // Wider regions expire with their own pass: drop it from the set
  const result2 = await publishNotes({
    store,
    regionsStore,
    bulletin: { ...BULLETIN, wider: [] },
    zone: 14,
  });
  assert.equal(result2.regionsPruned.length, 1);
  assert.equal(await regionsStore.get(rid), null);
});
