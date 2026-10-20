/**
 * Unit tests for the landfall map source availability (work doc #50
 * session): the corridor DEM and Shortbread gazetteer layers the
 * landfall sightings need, reported on the data-source checklist
 * instead of silently rendering nothing.
 *
 * @file landfall-source.test.js
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  LANDFALL_SOURCE,
  pickLandfallCharts,
  checkLandfallCharts,
  recordLandfallSource,
} = require("../plugin/landfall-source.js");

/** A chart resource set as the corridor downloader publishes it. */
function charts({ elevation = true, base = true, extra = [] } = {}) {
  const entries = [];
  if (elevation) {
    entries.push({
      name: "Mapterhorn elevation DEM",
      identifier: "mapterhorn",
      format: "webp",
      tilemapUrl: "https://tiles/{z}/{x}/{y}.webp",
    });
  }
  if (base) {
    entries.push({
      name: "versatiles-shortbread",
      identifier: "shortbread",
      format: "pbf",
      tilemapUrl: "https://tiles/{z}/{x}/{y}.pbf",
    });
  }
  entries.push(
    ...extra,
    // A raster chart must not satisfy either match
    {
      name: "OpenSeaChart",
      format: "png",
      tilemapUrl: "https://tiles/{z}/{x}/{y}.png",
    },
  );
  return Object.fromEntries(entries.map((c, i) => [`chart-${i}`, c]));
}

describe("landfall source availability (work doc #50 session)", () => {
  test("picks the elevation and shortbread layers", () => {
    const picked = pickLandfallCharts(charts({}));
    assert.deepEqual(picked, { elevation: true, base: true });
  });

  test("missing layers report individually", () => {
    assert.deepEqual(pickLandfallCharts(charts({ elevation: false })), {
      elevation: false,
      base: true,
    });
    assert.deepEqual(pickLandfallCharts(charts({ base: false })), {
      elevation: true,
      base: false,
    });
    assert.deepEqual(
      pickLandfallCharts(charts({ elevation: false, base: false })),
      {
        elevation: false,
        base: false,
      },
    );
    assert.deepEqual(pickLandfallCharts(null), {
      elevation: false,
      base: false,
    });
    assert.deepEqual(pickLandfallCharts({}), { elevation: false, base: false });
  });

  test("an unreadable resources API degrades to missing, never throws", async () => {
    const availability = await checkLandfallCharts({
      resourcesApi: {
        listResources: async () => {
          throw new Error("resources down");
        },
      },
    });
    assert.deepEqual(availability, { elevation: false, base: false });
  });

  test("records ok with a note when both layers are on board", async () => {
    const records = [];
    const availability = await recordLandfallSource(
      { resourcesApi: { listResources: async () => charts({}) } },
      (r) => records.push(r),
    );
    assert.deepEqual(availability, { elevation: true, base: true });
    assert.equal(records.length, 1);
    assert.equal(records[0].id, LANDFALL_SOURCE.id);
    assert.equal(records[0].absent, undefined);
    assert.ok(records[0].note.includes("corridor DEM"));
  });

  test("records absent naming the missing layer", async () => {
    const records = [];
    await recordLandfallSource(
      {
        resourcesApi: {
          listResources: async () => charts({ elevation: false }),
        },
      },
      (r) => records.push(r),
    );
    assert.equal(records[0].absent, true);
    assert.ok(records[0].note.includes("elevation tiles"), records[0].note);
    assert.ok(!records[0].note.includes("Shortbread"), records[0].note);
  });

  test("absent without any chart resources names both layers", async () => {
    const records = [];
    await recordLandfallSource(
      { resourcesApi: { listResources: async () => ({}) } },
      (r) => records.push(r),
    );
    assert.equal(records[0].absent, true);
    assert.ok(
      records[0].note.includes("elevation tiles") &&
        records[0].note.includes("Shortbread"),
      records[0].note,
    );
  });
});
