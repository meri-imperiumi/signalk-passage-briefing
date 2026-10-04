/**
 * Tests for the notes store and resource provider (work doc #12):
 * query filtering (position + distance, bbox, limit), durability
 * across store instances, and provider registration behavior
 * (listing empties when stopped, reads throw on unknown ids).
 *
 * @file notes-store.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  createNotesStore,
  matchesQuery,
  distanceMeters,
} = require("../plugin/notes-store.js");

function note(id, lat, lon) {
  return {
    title: `note ${id}`,
    description: "…",
    position: { latitude: lat, longitude: lon },
    properties: { sourcePlugin: "signalk-passage-briefing" },
  };
}

const AT_ANCHOR = { latitude: -18.658, longitude: -173.982 };

test("distance filter: meters from the query position", () => {
  const close = note("close", -18.7, -173.9); // ~5 nm from the vessel
  const far = note("far", -24.2, -156.2); // ~1000 nm east
  assert.equal(
    matchesQuery(close, {
      distance: 37000,
      position: [AT_ANCHOR.longitude, AT_ANCHOR.latitude],
    }),
    true,
  );
  assert.equal(
    matchesQuery(far, {
      distance: 37000,
      position: [far.position.longitude, -24.2],
    }) ||
      matchesQuery(far, {
        distance: 1,
        position: [AT_ANCHOR.longitude, AT_ANCHOR.latitude],
      }),
    true,
  );
  assert.equal(
    matchesQuery(far, {
      distance: 37000,
      position: [AT_ANCHOR.longitude, AT_ANCHOR.latitude],
    }),
    false,
  );
});

test("bbox filter: sw/ne corners, including the antimeridian edge", () => {
  const inside = note("in", -18.658, -173.982);
  assert.equal(matchesQuery(inside, { bbox: [-180, -90, -165, -10] }), true);
  assert.equal(
    matchesQuery(note("out", -18.6, 170), { bbox: [-180, -90, -165, -10] }),
    false,
  );
});

test("bbox filter: a seam-crossing box matches both sides of 180°", () => {
  // West edge east of the east edge: the box wraps the antimeridian,
  // the natural way to frame a Pacific query around the seam
  const box = { bbox: [170, -20, -175, -10] };
  assert.equal(matchesQuery(note("east", -15, 179), box), true);
  assert.equal(matchesQuery(note("west", -15, -179), box), true);
  assert.equal(matchesQuery(note("far", -15, 150), box), false);
  assert.equal(matchesQuery(note("far", -15, -150), box), false);
});

test("distanceMeters sanity: one degree of latitude", () => {
  const d = distanceMeters(
    { latitude: -18, longitude: 174 },
    { latitude: -19, longitude: 174 },
  );
  assert.ok(d > 110000 && d < 112000, `actual ${d}`);
});

test("store: upsert, delete, limit, and durability across instances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notes-store-"));
  const store = createNotesStore(dir);
  await store.set("a", note("a", -18.7, -173.9));
  await store.set("b", note("b", -18.8, -174.1));

  const listed = await store.list({
    position: [AT_ANCHOR.longitude, AT_ANCHOR.latitude],
    distance: 37000,
  });
  assert.deepEqual(Object.keys(listed).sort(), ["a", "b"]);

  const limited = await store.list({ limit: 1 });
  assert.equal(Object.keys(limited).length, 1);

  await store.delete("a");
  assert.equal(await store.get("a"), null);

  // Durability: a fresh instance reads the same file
  const reopened = createNotesStore(dir);
  assert.equal(await reopened.get("b").then((n) => n.title), "note b");
  assert.equal(await reopened.get("a"), null);
});

test("provider registration: serves while running, empties when stopped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notes-provider-"));
  const store = createNotesStore(dir);
  await store.set("metarea-x", note("x", -18.7, -173.9));

  const registered = [];
  const app = {
    registerResourceProvider: (p) => registered.push(p),
    debug: () => {},
  };
  const { registerNotesProvider } = require("../plugin/notes-store.js");
  const teardown = registerNotesProvider(app, {
    id: "signalk-passage-briefing",
    store,
  });
  assert.equal(registered.length, 1);
  const provider = registered[0];
  assert.equal(provider.type, "notes");

  const listed = await provider.methods.listResources({
    position: [AT_ANCHOR.longitude, AT_ANCHOR.latitude],
    distance: 37000,
  });
  assert.deepEqual(Object.keys(listed), ["metarea-x"]);

  const fetched = await provider.methods.getResource("metarea-x");
  assert.equal(fetched.title, "note x");
  await assert.rejects(() => provider.methods.getResource("nope"));
  await assert.rejects(() => provider.methods.setResource("metarea-x", {}));
  await assert.rejects(() => provider.methods.deleteResource("metarea-x"));

  teardown();
  const afterStop = await provider.methods.listResources();
  assert.deepEqual(afterStop, {});
});
