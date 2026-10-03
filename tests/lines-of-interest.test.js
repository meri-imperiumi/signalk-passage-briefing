const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

describe("lines of interest (work doc #1)", () => {
  // Loaded per-test: the module is ESM shared with the browser worker
  test("equator crossing interpolates position, distance and ETA", async () => {
    const { detectLineCrossings } = await import(
      "../public/lines-of-interest.js"
    );
    const crossings = detectLineCrossings([
      {
        lat: -2,
        lon: 179,
        distanceFromStartNm: 100,
        timestamp: "2026-06-21T00:00:00Z",
      },
      {
        lat: 6,
        lon: -179,
        distanceFromStartNm: 300,
        timestamp: "2026-06-22T00:00:00Z",
      },
    ]);
    // The segment hops the antimeridian too; the equator comes first
    // at a quarter of the segment, the Date Line halfway
    assert.deepEqual(
      crossings.map((c) => c.lineId),
      ["equator", "antimeridian"],
    );
    const c = crossings[0];
    assert.equal(c.lat, 0);
    assert.ok(Math.abs(c.lon - 179.5) < 0.001, `lon ${c.lon}`);
    assert.equal(c.distanceFromStartNm, 150);
    assert.equal(c.eta, "2026-06-21T06:00:00.000Z");
    assert.match(c.ceremony, /Shellback/);
  });

  test("antimeridian crossing detected, prime meridian not", async () => {
    const { detectLineCrossings } = await import(
      "../public/lines-of-interest.js"
    );
    const crossings = detectLineCrossings([
      { lat: -21, lon: 175, distanceFromStartNm: 0, forecasts: [] },
      { lat: -21, lon: -175, distanceFromStartNm: 60, forecasts: [] },
    ]);
    assert.deepEqual(
      crossings.map((c) => c.lineId),
      ["antimeridian"],
    );
    assert.equal(crossings[0].lat, -21);
    assert.equal(crossings[0].lon, -180);
    assert.equal(crossings[0].distanceFromStartNm, 30);
    assert.match(crossings[0].ceremony, /Golden Dragon/);
    assert.match(crossings[0].note, /24 h/);
    assert.equal(crossings[0].eta, null);
  });

  test("prime meridian crossing on a normal segment", async () => {
    const { detectLineCrossings } = await import(
      "../public/lines-of-interest.js"
    );
    const crossings = detectLineCrossings([
      { lat: 50, lon: -5, distanceFromStartNm: 0, forecasts: [] },
      { lat: 50, lon: 5, distanceFromStartNm: 120, forecasts: [] },
    ]);
    assert.deepEqual(
      crossings.map((c) => c.lineId),
      ["prime-meridian"],
    );
    assert.equal(crossings[0].lon, 0);
    assert.equal(crossings[0].distanceFromStartNm, 60);
    assert.equal(crossings[0].ceremony, null);
  });

  test("tropics and polar circles, sorted by distance from start", async () => {
    const { detectLineCrossings } = await import(
      "../public/lines-of-interest.js"
    );
    // Northbound leg crosses Cancer (+23.4366) then the Arctic Circle
    const northbound = detectLineCrossings([
      { lat: 10, lon: 150, distanceFromStartNm: 0, forecasts: [] },
      { lat: 70, lon: 150, distanceFromStartNm: 3600, forecasts: [] },
    ]);
    assert.deepEqual(
      northbound.map((c) => c.lineId),
      ["tropic-cancer", "arctic-circle"],
    );
    const cancer = northbound[0];
    assert.ok(Math.abs(cancer.lat - 23.4366) < 0.0001);
    assert.ok(
      cancer.distanceFromStartNm > 0 && cancer.distanceFromStartNm < 3600,
    );
    assert.ok(northbound[1].distanceFromStartNm > cancer.distanceFromStartNm);

    // Southbound leg from the tropics into the south Pacific crosses
    // the equator first, then the Tropic of Capricorn
    const southbound = detectLineCrossings([
      { lat: 5, lon: 150, distanceFromStartNm: 0, forecasts: [] },
      { lat: -30, lon: 150, distanceFromStartNm: 2100, forecasts: [] },
    ]);
    assert.deepEqual(
      southbound.map((c) => c.lineId),
      ["equator", "tropic-capricorn"],
    );
    assert.equal(southbound[1].ceremony, null);
  });

  test("no crossings on a route that stays clear of every line", async () => {
    const { detectLineCrossings } = await import(
      "../public/lines-of-interest.js"
    );
    assert.deepEqual(
      detectLineCrossings([
        { lat: -18, lon: 175, distanceFromStartNm: 0, forecasts: [] },
        { lat: -19, lon: 176, distanceFromStartNm: 60, forecasts: [] },
        { lat: -20, lon: 177, distanceFromStartNm: 120, forecasts: [] },
      ]),
      [],
    );
  });

  test("degenerate inputs", async () => {
    const { detectLineCrossings } = await import(
      "../public/lines-of-interest.js"
    );
    assert.deepEqual(detectLineCrossings([]), []);
    assert.deepEqual(detectLineCrossings(null), []);
    assert.deepEqual(
      detectLineCrossings([{ lat: -5, lon: 179, distanceFromStartNm: 0 }]),
      [],
    );
  });

  test("a track grazing a line does not chatter crossings", async () => {
    const { detectLineCrossings } = await import(
      "../public/lines-of-interest.js"
    );
    // Oscillating within ±0.005° of the equator: noise, not crossings
    assert.deepEqual(
      detectLineCrossings([
        { lat: -0.005, lon: 179, distanceFromStartNm: 0, forecasts: [] },
        { lat: 0.005, lon: 179.1, distanceFromStartNm: 1, forecasts: [] },
        { lat: -0.004, lon: 179.2, distanceFromStartNm: 2, forecasts: [] },
        { lat: 0.006, lon: 179.3, distanceFromStartNm: 3, forecasts: [] },
      ]),
      [],
    );
  });

  test("ceremonies attach only to the traditional lines", async () => {
    const { LINES_OF_INTEREST } = await import(
      "../public/lines-of-interest.js"
    );
    const withCeremony = LINES_OF_INTEREST.filter((l) => l.ceremony);
    assert.deepEqual(
      withCeremony.map((l) => l.id),
      ["equator", "arctic-circle", "antarctic-circle", "antimeridian"],
    );
  });
});
