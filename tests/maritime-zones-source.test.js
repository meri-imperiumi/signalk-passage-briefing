const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const mzSource = require("../plugin/maritime-zones-source.js");

/**
 * A synthetic reader standing in for @openwaters/maritime-zones:
 * Tongan sovereign waters south of 20°S, high seas everywhere north.
 * The EEZ layer rides along to prove it is filtered out.
 */
function fakeZonesApi() {
  const zone = (layer, iso, name) => ({
    layer,
    iso_ter: iso,
    territory: name ?? "Tonga",
    name: name ?? "Tongan waters",
  });
  return {
    downloads: [],
    download: async function (box) {
      this.downloads.push(box);
      return { tiles: 2, bytes: 1024 };
    },
    whereAmI: async (lat, _lon) =>
      lat < -20
        ? [zone("12nm", "TON"), zone("eez", "TON")]
        : [{ layer: "high_seas", iso_ter: null, territory: null }],
  };
}

describe("territorial waters transitions (work doc #17)", () => {
  test("sovereign layers only: EEZ and high seas are not territories", () => {
    const map = mzSource.sovereignTerritories([
      { layer: "internal", iso_ter: "TON", territory: "Tonga" },
      { layer: "archipelagic", iso_ter: "FJI", territory: "Fiji" },
      { layer: "12nm", iso_ter: "TON", territory: "Tonga" },
      { layer: "contiguous", iso_ter: "TON", territory: "Tonga" },
      { layer: "eez", iso_ter: "TON", territory: "Tonga" },
      { layer: "high_seas", iso_ter: null, territory: null },
    ]);
    assert.deepEqual([...map.keys()].sort(), ["FJI", "TON"]);
  });

  test("southbound route enters Tongan waters at the boundary", async () => {
    const zonesApi = fakeZonesApi();
    const transitions = await mzSource.detectTransitions({
      dataDir: "/tmp",
      waypoints: [
        { lat: -19, lon: -175.2, distanceFromStartNm: 0 },
        { lat: -20.5, lon: -175.2, distanceFromStartNm: 90 },
        { lat: -21, lon: -175.2, distanceFromStartNm: 120 },
      ],
      zonesApi,
    });
    assert.equal(transitions.length, 1);
    const enter = transitions[0];
    assert.equal(enter.kind, "enter");
    assert.equal(enter.territory.iso_ter, "TON");
    assert.equal(enter.territory.name, "Tonga");
    assert.equal(enter.distanceFromStartNm, 90);
    assert.equal(enter.connectivity, undefined);
  });

  test("northbound route leaves with the connectivity note", async () => {
    const zonesApi = fakeZonesApi();
    const transitions = await mzSource.detectTransitions({
      dataDir: "/tmp",
      waypoints: [
        { lat: -21, lon: -175.2, distanceFromStartNm: 0 },
        { lat: -20.5, lon: -175.2, distanceFromStartNm: 30 },
        { lat: -19, lon: -175.2, distanceFromStartNm: 120 },
      ],
      zonesApi,
    });
    assert.equal(transitions.length, 1);
    const leave = transitions[0];
    assert.equal(leave.kind, "leave");
    assert.equal(leave.territory.iso_ter, "TON");
    assert.equal(leave.connectivity, "ocean");
  });

  test("a route starting inside a territory announces no entering", async () => {
    const zonesApi = fakeZonesApi();
    const transitions = await mzSource.detectTransitions({
      dataDir: "/tmp",
      waypoints: [
        { lat: -21, lon: -175.2, distanceFromStartNm: 0 },
        { lat: -21.5, lon: -175.2, distanceFromStartNm: 30 },
      ],
      zonesApi,
    });
    assert.deepEqual(transitions, []);
  });

  test("corridor prefetch covers the route box plus margin", async () => {
    const zonesApi = fakeZonesApi();
    const report = await mzSource.prefetchCorridor({
      dataDir: "/tmp",
      waypoints: [
        { lat: -19, lon: 178 },
        { lat: -21, lon: 180 },
      ],
      zonesApi,
    });
    assert.deepEqual(report, { tiles: 2, bytes: 1024 });
    assert.deepEqual(zonesApi.downloads, [
      {
        minLat: -22,
        maxLat: -18,
        minLon: 177,
        maxLon: 181,
      },
    ]);
  });

  test("positionZones filters to sovereign layers", async () => {
    const zones = await mzSource.positionZones({
      dataDir: "/tmp",
      lat: -21,
      lon: -175.2,
      zonesApi: fakeZonesApi(),
    });
    assert.deepEqual(
      zones.map((z) => z.layer),
      ["12nm"],
    );
    assert.equal(zones[0].territory, "Tonga");
  });

  test("missing tiles at the first sample: no data, not 'all high seas'", async () => {
    const zonesApi = {
      download: async () => ({ tiles: 0, bytes: 0 }),
      whereAmI: async () => {
        const error = new Error("tile missing");
        error.code = "MISSING_TILE";
        throw error;
      },
    };
    const transitions = await mzSource.detectTransitions({
      dataDir: "/tmp",
      waypoints: [
        { lat: -19, lon: -175.2, distanceFromStartNm: 0 },
        { lat: -21, lon: -175.2, distanceFromStartNm: 120 },
      ],
      zonesApi,
    });
    assert.equal(transitions, null);
  });

  test("missing tiles mid-route keeps the transitions found so far", async () => {
    let calls = 0;
    const zonesApi = {
      download: async () => ({ tiles: 0, bytes: 0 }),
      whereAmI: async (lat) => {
        calls++;
        if (calls >= 3) {
          throw new Error("DOWNLOAD_FAILED");
        }
        return lat < -20
          ? [{ layer: "12nm", iso_ter: "TON", territory: "Tonga" }]
          : [{ layer: "high_seas", iso_ter: null, territory: null }];
      },
    };
    const transitions = await mzSource.detectTransitions({
      dataDir: "/tmp",
      waypoints: [
        { lat: -19, lon: -175.2, distanceFromStartNm: 0 },
        { lat: -20.5, lon: -175.2, distanceFromStartNm: 90 },
        { lat: -21, lon: -175.2, distanceFromStartNm: 120 },
        { lat: -21.5, lon: -175.2, distanceFromStartNm: 150 },
      ],
      zonesApi,
    });
    // The enter at 90 nm was found before the walk lost the tiles
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].kind, "enter");
    assert.equal(transitions[0].distanceFromStartNm, 90);
  });

  test("degenerate inputs", async () => {
    assert.equal(
      await mzSource.detectTransitions({
        dataDir: "/tmp",
        waypoints: [{ lat: -19, lon: -175.2, distanceFromStartNm: 0 }],
        zonesApi: fakeZonesApi(),
      }),
      null,
    );
    assert.equal(
      await mzSource.detectTransitions({ dataDir: "/tmp", waypoints: null }),
      null,
    );
    assert.equal(
      await mzSource.prefetchCorridor({
        dataDir: "/tmp",
        waypoints: [],
        zonesApi: fakeZonesApi(),
      }),
      null,
    );
  });
});

test("grazing stints collapse instead of ping-ponging (bergie session feedback)", async () => {
  // A route that wiggles across the 12 NM line: real stints of 13 nm
  // inside, 47 nm outside, a 3 nm graze outside, 12 nm inside again —
  // plus 1 nm harbor zigzag at the very start. 1 nm samples, like the
  // real walk.
  const insideStints = [
    [12, 24],
    [72, 88],
    [92, 103],
    // Harbor zigzag, 1 nm each way
    [1, 2],
    [3, 4],
    [5, 6],
  ];
  const inside = (d) => insideStints.some(([a, b]) => d >= a && d < b);
  const zonesApi = {
    download: async () => ({ tiles: 0, bytes: 0 }),
    whereAmI: async (_lat, _lon) =>
      inside(_lon) // Reuse lon as route distance for the fixture
        ? [{ layer: "12nm", iso_ter: "TON", territory: "Tonga" }]
        : [{ layer: "high_seas", iso_ter: null, territory: null }],
  };
  const waypoints = [];
  for (let d = 0; d <= 110; d += 1) {
    waypoints.push({ lat: -21, lon: d, distanceFromStartNm: d });
  }
  const transitions = await mzSource.detectTransitions({
    dataDir: "/tmp",
    waypoints,
    zonesApi,
  });
  // The 3 nm graze (89–91) and the 1 nm harbor zigzag collapse; the
  // real stints survive as two enter/leave pairs
  // The 3 nm outside graze (89–91) fills back in — the two inside
  // stints read as one — and the 1 nm harbor zigzag collapses; the
  // real stints survive as one enter/leave pair per stint
  assert.deepEqual(
    transitions.map((t) => [t.kind, t.distanceFromStartNm]),
    [
      ["enter", 12],
      ["leave", 24],
      ["enter", 72],
      ["leave", 103],
    ],
  );
});
