/**
 * Tests for the regions store and resource provider (work doc #48):
 * antimeridian-safe geometry bbox, query filtering (bbox intersect
 * incl. seam-crossing boxes on either side, distance to the geometry),
 * durability across store instances, scoped prune, and provider
 * registration behavior (listing empties when stopped, reads throw on
 * unknown ids).
 *
 * @file regions-store.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  bboxesIntersect,
  createRegionsStore,
  matchesQuery,
  regionBbox,
  regionDistanceMeters,
  ringBbox,
} = require("../plugin/regions-store.js");

function dataDir() {
  return mkdtempSync(join(tmpdir(), "regions-"));
}

function storeWith(entries) {
  const store = createRegionsStore(dataDir());
  store.loaded = true;
  for (const [id, ring] of entries) {
    store.regions[id] = {
      name: id,
      feature: { geometry: { type: "Polygon", coordinates: [ring] } },
    };
  }
  return store;
}

test("ringBbox: plain ring, seam-crossing ring unfolds continuously", () => {
  assert.deepEqual(
    ringBbox([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]),
    [0, 0, 10, 10],
  );
  // Fiji waters: 170E..175E and 175W..170W straddle the seam — one
  // continuous box 170..190, normalized edges 170 and -170
  assert.deepEqual(
    ringBbox([
      [170, -20],
      [178, -20],
      [-178, -22],
      [-170, -22],
    ]),
    [170, -22, -170, -20],
  );
  assert.equal(ringBbox([]), null);
  assert.equal(ringBbox(null), null);
});

test("regionBbox: reads the feature's outer ring", () => {
  const r = {
    feature: {
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [4, 0],
            [4, 4],
            [0, 0],
          ],
        ],
      },
    },
  };
  assert.deepEqual(regionBbox(r), [0, 0, 4, 4]);
  assert.equal(regionBbox({}), null);
});

test("bboxesIntersect: normal, seam-crossing on either and both sides", () => {
  // Plain overlap
  assert.ok(bboxesIntersect([0, 0, 10, 10], [5, 5, 15, 15]));
  // Disjoint
  assert.ok(!bboxesIntersect([0, 0, 10, 10], [20, 0, 30, 10]));
  // Region crosses the seam, query does not: query on the west side
  assert.ok(bboxesIntersect([170, -22, -170, -20], [175, -30, 178, -10]));
  // …on the east side
  assert.ok(bboxesIntersect([170, -22, -170, -20], [-178, -30, -175, -10]));
  // …nowhere near
  assert.ok(!bboxesIntersect([170, -22, -170, -20], [0, -30, 10, -10]));
  // Both cross the seam
  assert.ok(bboxesIntersect([170, -22, -170, -20], [172, -40, -175, -10]));
  // Both cross, disjoint
  assert.ok(!bboxesIntersect([170, -22, -170, -20], [150, -40, 160, -10]));
  // Latitude ranges disjoint
  assert.ok(!bboxesIntersect([0, 0, 10, 10], [5, 20, 15, 30]));
});

test("regions match near-me queries as MultiPolygons (work doc #48 session)", () => {
  // The cyclone's quadrant rings publish as a MultiPolygon whose
  // parts straddle the seam — the distance query must read the union
  // of every part's bbox, not the first polygon's (the bug that made
  // /resources/regions?position=… return {} while the notes answered)
  const storm = {
    name: "STORM WARNING 026",
    feature: {
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [161.5, -19.1],
              [161.5, -18.5],
              [161.9, -18.5],
              [161.9, -19.1],
              [161.5, -19.1],
            ],
          ],
          [
            [
              [-158.9, -19.1],
              [-158.9, -18.5],
              [-158.5, -18.5],
              [-158.5, -19.1],
              [-158.9, -19.1],
            ],
          ],
        ],
      },
    },
  };
  // The union spans both parts across the seam (float noise and all)
  const bbox = regionBbox(storm);
  assert.ok(Math.abs(bbox[0] + 158.9) < 1e-9);
  assert.ok(Math.abs(bbox[2] - 161.9) < 1e-9);
  const ref = { latitude: -21.199806566925382, longitude: -165.24202648632937 };
  const d = regionDistanceMeters(storm, ref);
  assert.ok(Number.isFinite(d), "MultiPolygon distance is finite");
  assert.ok(
    matchesQuery(storm, {
      position: [ref.longitude, ref.latitude],
      distance: 2695374,
    }),
  );

  // A region without a usable ring matches nothing (NaN must not
  // slip through the filter)
  assert.equal(
    matchesQuery(
      { feature: { geometry: { type: "Polygon", coordinates: [] } } },
      { position: [0, 0], distance: 1000 },
    ),
    false,
  );
});

test("regionDistanceMeters: inside is zero, edge distance outside", () => {
  const r = {
    feature: {
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [178, -21],
            [-178, -21],
            [-178, -22],
            [178, -22],
          ],
        ],
      },
    },
  };
  // Inside the box (and the seam-straddling span)
  assert.equal(regionDistanceMeters(r, { latitude: -21.5, longitude: 179 }), 0);
  assert.equal(
    regionDistanceMeters(r, { latitude: -21.5, longitude: -179.5 }),
    0,
  );
  // Just south of the box: ~0.5° of latitude, about 55 km
  const south = regionDistanceMeters(r, { latitude: -22.5, longitude: 179 });
  assert.ok(south > 50000 && south < 60000, `south distance ${south}`);
  // Far away
  const far = regionDistanceMeters(r, { latitude: 0, longitude: 0 });
  assert.ok(far > 2_000_000, `far distance ${far}`);
  // No geometry: no distance
  assert.equal(regionDistanceMeters({}, { latitude: 0, longitude: 0 }), null);
});

test("matchesQuery: bbox intersect and distance against geometry", () => {
  const store = storeWith([
    [
      "fiji",
      [
        [170, -22],
        [178, -22],
        [-178, -24],
        [-170, -24],
      ],
    ],
  ]);
  const regions = store.regions;
  const fiji = regions.fiji;
  const inside = { latitude: -23, longitude: 179 };
  assert.ok(
    matchesQuery(fiji, { position: [inside.longitude, inside.latitude] }),
  );
  assert.ok(
    matchesQuery(fiji, {
      distance: 10000,
      position: [inside.longitude, inside.latitude],
    }),
  );
  assert.ok(!matchesQuery(fiji, { distance: 10000, position: [0, 0] }));
  assert.ok(matchesQuery(fiji, { bbox: [175, -25, -175, -20] }));
  assert.ok(!matchesQuery(fiji, { bbox: [0, -25, 10, -20] }));
  // A placement-less query position matches nothing
  assert.ok(!matchesQuery(fiji, { position: [NaN, NaN] }));
});

test("store: roundtrip, durability, limit", async () => {
  const dir = dataDir();
  const store = createRegionsStore(dir);
  await store.set("metarea-area-a", {
    name: "a",
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
  await store.set("metarea-area-b", {
    name: "b",
    feature: {
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [10, 0],
            [11, 0],
            [11, 1],
            [10, 0],
          ],
        ],
      },
    },
  });
  assert.equal(Object.keys(await store.list()).length, 2);
  assert.equal((await store.get("metarea-area-a")).name, "a");

  // A fresh instance reads the same file
  const second = createRegionsStore(dir);
  assert.equal((await second.get("metarea-area-b")).name, "b");

  const limited = await store.list({ limit: 1 });
  assert.equal(Object.keys(limited).length, 1);

  await store.delete("metarea-area-a");
  assert.equal(await store.get("metarea-area-a"), null);
});

test("scoped prune: only this feed's stale ids drop", async () => {
  const store = storeWith([
    [
      "metarea-area-keep",
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
    [
      "metarea-area-stale",
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
    [
      "cap-area-keep",
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
    [
      "cap-area-stale",
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
    [
      "user-region",
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  ]);
  await store.prune(["metarea-area-keep", "cap-area-keep"], "metarea-area-");
  const after = Object.keys(await store.list());
  assert.ok(after.includes("metarea-area-keep"));
  assert.ok(after.includes("cap-area-keep"));
  assert.ok(after.includes("cap-area-stale"), "other feed untouched");
  assert.ok(after.includes("user-region"), "user regions untouched");
  assert.ok(!after.includes("metarea-area-stale"));

  await store.clear();
  assert.deepEqual(await store.list(), {});
});

test("a malformed published region cannot break the listing", async () => {
  // A pre-fix publication could store a bare point list where the
  // ring nesting belongs — one bad region must not poison the whole
  // query (it silently emptied /resources/regions on the boat)
  const store = storeWith([
    [
      "broken",
      [
        [-168, 0],
        [-164, -4],
        [-161, -9],
      ],
    ],
    [
      "good",
      [
        [-168, -21],
        [-164, -21],
        [-164, -22],
        [-168, -21],
      ],
    ],
  ]);
  const listed = await store.list({
    position: [-166, -21.5],
    distance: 500000,
  });
  assert.deepEqual(Object.keys(listed), ["good"]);
  // The unfiltered listing survives the broken entry too
  assert.equal(Object.keys(await store.list({})).length, 2);
});

test("provider registration: serves the store, read-only, stops clean", async () => {
  const registered = [];
  const app = {
    registerResourceProvider: (p) => registered.push(p),
  };
  const { registerRegionsProvider } = require("../plugin/regions-store.js");
  const store = storeWith([
    [
      "metarea-area-x",
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  ]);
  const teardown = registerRegionsProvider(app, {
    id: "signalk-passage-briefing",
    store,
  });
  assert.equal(registered.length, 1);
  const provider = registered[0];
  assert.equal(provider.type, "regions");

  const listed = await provider.methods.listResources({
    bbox: [-1, -1, 2, 2],
  });
  assert.deepEqual(Object.keys(listed), ["metarea-area-x"]);

  const fetched = await provider.methods.getResource("metarea-area-x");
  assert.equal(fetched.name, "metarea-area-x");
  await assert.rejects(() => provider.methods.getResource("nope"));
  await assert.rejects(() =>
    provider.methods.setResource("metarea-area-x", {}),
  );
  await assert.rejects(() => provider.methods.deleteResource("metarea-area-x"));

  teardown();
  const afterStop = await provider.methods.listResources();
  assert.deepEqual(afterStop, {});
});

test("provider registration skips servers without the registry", () => {
  const { registerRegionsProvider } = require("../plugin/regions-store.js");
  const teardown = registerRegionsProvider(
    { debug: () => {} },
    { id: "x", store: storeWith([]) },
  );
  assert.equal(typeof teardown, "function");
  teardown();
});
