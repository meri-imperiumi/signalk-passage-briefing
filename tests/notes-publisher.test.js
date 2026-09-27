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
  noteId,
  noteTitle,
  publishNotes,
  clearNotes,
} = require("../plugin/notes-publisher.js");

function stubResources() {
  const notes = {};
  const calls = { set: 0, deleted: [] };
  return {
    notes,
    calls,
    resourcesApi: {
      async setResource(type, id, value) {
        assert.equal(type, "notes");
        notes[id] = value;
        calls.set++;
      },
      async deleteResource(type, id) {
        assert.equal(type, "notes");
        delete notes[id];
        calls.deleted.push(id);
      },
      async listResources(type) {
        assert.equal(type, "notes");
        return { ...notes };
      },
    },
  };
}

function dataDir() {
  return mkdtempSync(join(tmpdir(), "notes-"));
}

const ISSUED = "2026-09-27T19:42:19.033Z";

const BULLETIN = {
  header: "FQPS01 NFFN 270700",
  issuedAt: ISSUED,
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
  const { resourcesApi, notes } = stubResources();
  const app = { resourcesApi };
  const result = await publishNotes({
    app,
    dataDir: dataDir(),
    bulletin: BULLETIN,
    zone: 14,
    synopticChartFor: () => ({
      url: "/plugins/signalk-passage-briefing/api/synoptic?zone=14",
      mimeType: "image/gif",
    }),
  });
  assert.equal(result.published.length, 2); // no-geometry block skipped
  const [first] = result.published.map((id) => notes[id]);
  assert.match(first.title, /SOUTH OF 10S AND WEST OF 169W/);
  assert.equal(first.description, BULLETIN.blocks[1].text);
  assert.equal(first.position.latitude, -50);
  assert.equal(first.properties.category, "meteorological-warning");
  assert.equal(first.properties.zone, 14);
  assert.equal(first.properties.sourcePlugin, "signalk-passage-briefing");
  assert.equal(first.timestamp, ISSUED);
  assert.equal(first.mimeType, "image/gif"); // chart linked when cached
});

test("re-publish updates in place; expiry deletes dropped blocks", async () => {
  const stub = stubResources();
  const app = { resourcesApi: stub.resourcesApi };
  const dir = dataDir();
  const params = { app, dataDir: dir };

  await publishNotes({ ...params, bulletin: BULLETIN, zone: 14 });
  const idBefore = noteId(BULLETIN.blocks[1].text, ISSUED);
  assert.ok(stub.notes[idBefore]);

  // Same blocks again: same ids, still exactly two notes
  await publishNotes({ ...params, bulletin: BULLETIN, zone: 14 });
  assert.equal(Object.keys(stub.notes).length, 2);

  // Only one block survives the next filter pass: the others expire
  const partial = {
    ...BULLETIN,
    issuedAt: "2026-09-27T20:42:19.033Z",
    blocks: [BULLETIN.blocks[1]],
  };
  const result = await publishNotes({ ...params, bulletin: partial, zone: 14 });
  assert.equal(result.published.length, 1);
  assert.equal(result.deleted.length, 2);
  assert.equal(Object.keys(stub.notes).length, 1);
  assert.ok(stub.notes[noteId(BULLETIN.blocks[1].text, partial.issuedAt)]);
});

test("clearNotes removes owned notes and empties the manifest", async () => {
  const stub = stubResources();
  const app = { resourcesApi: stub.resourcesApi };
  const dir = dataDir();
  await publishNotes({ app, dataDir: dir, bulletin: BULLETIN, zone: 14 });
  const removed = await clearNotes({ app, dataDir: dir });
  assert.equal(removed.length, 2);
  assert.deepEqual(stub.notes, {});
});
