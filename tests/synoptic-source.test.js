/**
 * Unit tests for the synoptic surface-analysis chart source (work
 * doc #11): zone+hour URL selection with 12Z boundaries, static
 * filenames, missing zones, TIFF→PNG conversion via the vendored
 * UTIF, cache/skip behaviour, and offline reads.
 *
 * @file synoptic-source.test.js
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const UTIF = require("../public/vendor/utif/UTIF.js");
const {
  chartUrlForZone,
  chartsForZones,
  loadSynoptic,
  loadSynopticMap,
  refreshSynoptics,
} = require("../plugin/synoptic-source.js");
const { convertToPng, detectFormat } = require("../plugin/raster-convert.js");

function dataDir() {
  return mkdtempSync(join(tmpdir(), "synoptic-"));
}

/** Builds a tiny uncompressed RGBA TIFF as agencies would ship. */
function fixtureTif(width = 8, height = 4) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const value = i % 3 === 0 ? 0 : 255; // black/white line art
    rgba[i * 4] = value;
    rgba[i * 4 + 1] = value;
    rgba[i * 4 + 2] = value;
    rgba[i * 4 + 3] = 255;
  }
  return Buffer.from(UTIF.encodeImage(rgba, width, height));
}

describe("chart URL selection", () => {
  const map = loadSynopticMap();

  test("hour boundaries pick 00Z before noon, 12Z from noon", () => {
    const before = chartUrlForZone(map, 14, new Date("2026-09-27T11:59:00Z"));
    const at = chartUrlForZone(map, 14, new Date("2026-09-27T12:00:00Z"));
    assert.match(before.urls[0], /IDX0032\.TIF$/);
    assert.equal(before.urls.length, 2); // candidate mirrors
    assert.equal(before.validHour, "00");
    assert.match(at.urls[0], /IDX0532\.TIF$/);
    assert.equal(at.validHour, "12");
  });

  test("static filenames skip the hour logic", () => {
    const pick = chartUrlForZone(map, 10, new Date("2026-09-27T18:00:00Z"));
    assert.match(pick.urls[0], /IDX0102\.TIF$/);
    assert.equal(pick.validHour, "static");
  });

  test("missing hour variant falls back, missing zones resolve-and-skip", () => {
    const map2 = {
      3: { name: "x", source: "t", hours: { "00": "http://a/00.TIF" } },
    };
    // From 12Z with no 12Z variant: falls back to the 00Z chart
    const pick = chartUrlForZone(map2, 3, new Date("2026-09-27T18:00:00Z"));
    assert.deepEqual(pick.urls, ["http://a/00.TIF"]);
    assert.equal(pick.validHour, "00");
    assert.equal(chartUrlForZone(map2, 14), null); // not in this map
    assert.deepEqual(chartsForZones(map2, [3, 14]), [
      { zone: 3, urls: ["http://a/00.TIF"], validHour: "00" },
    ]);
  });
});

describe("conversion and cache", () => {
  test("tiff converts to grayscale png; png passes through; gif rejected", () => {
    const png = convertToPng(fixtureTif());
    assert.equal(detectFormat(png.png), "png");
    assert.equal(png.converted, true);
    assert.equal(png.width, 8);
    assert.equal(png.height, 4);

    assert.equal(convertToPng(Buffer.from("GIF89a whatever")), null);
  });

  test("refresh fetches, caches, then skips the same chart", async () => {
    const dir = dataDir();
    let fetches = 0;
    const fetchImpl = async () => {
      fetches++;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => fixtureTif(16, 8),
      };
    };
    const zones = [10]; // static URL entry
    const first = await refreshSynoptics({
      dataDir: dir,
      zones,
      fetchImpl,
    });
    assert.deepEqual(first.fetched, [10]);
    assert.equal(fetches, 1);
    assert.ok(existsSync(join(dir, "synoptic-10.png")));
    const cached = await loadSynoptic(dir, 10);
    assert.equal(detectFormat(cached.png), "png");
    assert.ok(cached.fetchedAt);

    const second = await refreshSynoptics({
      dataDir: dir,
      zones,
      fetchImpl,
    });
    assert.deepEqual(second.skipped, [10]);
    assert.equal(fetches, 1);
  });

  test("failed charts are isolated and the cache survives", async () => {
    const dir = dataDir();
    const fetchImpl = async (url) => {
      if (String(url).includes("IDX0102")) {
        return { ok: true, status: 200, arrayBuffer: async () => fixtureTif() };
      }
      return { ok: false, status: 404, statusText: "Not Found" };
    };
    const result = await refreshSynoptics({
      dataDir: dir,
      zones: [10, 11], // 11 fails
      fetchImpl,
    });
    assert.deepEqual(result.fetched, [10]);
    assert.deepEqual(
      result.failed.map((f) => f.zone),
      [11],
    );
    assert.match(result.failed[0].error, /404/);
    assert.ok(await loadSynoptic(dir, 10));
    assert.equal(await loadSynoptic(dir, 11), null);
  });
});

test("convertToPng output is a well-formed grayscale PNG", () => {
  const { png } = convertToPng(fixtureTif(6, 3));
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
  assert.equal(png.readUInt32BE(16), 6); // width
  assert.equal(png.readUInt32BE(20), 3); // height
  assert.equal(png[25], 0); // bit depth 8
  assert.equal(png[26], 0); // color type: grayscale
  // IDAT chunk follows the IHDR: inflate it and check the filtered
  // raw size (height * (filter byte + width))
  const dataLen = png.readUInt32BE(33);
  assert.equal(png.toString("ascii", 37, 41), "IDAT");
  const raw = require("node:zlib").inflateSync(png.subarray(41, 41 + dataLen));
  assert.equal(raw.length, 3 * (6 + 1));
});
