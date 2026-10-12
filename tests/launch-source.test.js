const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const launches = require("../plugin/launch-source.js");

const fixture = require("./fixtures/ll2-upcoming.json");

/** The Vandenberg SLC-4E launch from the fixture. */
const VANDENBERG = launches.parseLaunches(
  fixture,
  new Date("2026-10-01T00:00:00Z"),
)[0];

describe("visible launches (work doc #36)", () => {
  test("parseLaunches: keeps future watchable launches with pad coordinates", () => {
    assert.ok(VANDENBERG, "a parseable launch exists");
    assert.ok(Math.abs(VANDENBERG.padLat - 34.632) < 0.01);
    assert.ok(Math.abs(VANDENBERG.padLon + 120.611) < 0.01);
    assert.equal(VANDENBERG.status, "Go");
    assert.match(VANDENBERG.rocket, /Falcon 9/);
    assert.ok(VANDENBERG.url.startsWith("https://ll.thespacedevs.com/"));
  });

  test("parseLaunches: past launches and missing pads are dropped", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    const past = launches.parseLaunches(
      {
        results: [
          { ...fixture.results[0], net: "2026-09-01T00:11:47Z" },
          {
            ...fixture.results[0],
            pad: { ...fixture.results[0].pad, latitude: null },
          },
          {
            ...fixture.results[0],
            status: { ...fixture.results[0].status, abbrev: "Hold" },
          },
        ],
      },
      now,
    );
    assert.deepEqual(past, []);
  });

  test("twilight launch within range fires; deep night, daylight and range stay quiet", () => {
    const vessel = { lat: 34.0, lon: -119.5 }; // ~130 km from SLC-4E
    const twilight = launches.gateLaunch({
      launch: VANDENBERG,
      vessel,
      sunAltDeg: -4,
      cloudOk: true,
    });
    assert.ok(twilight, "twilight launch fires");
    assert.equal(twilight.kind, "launch");
    assert.equal(twilight.tactical, true);
    assert.match(twilight.description, /twilight plume low toward/);
    assert.match(twilight.description, /launch windows slip/);
    assert.equal(twilight.provenance.label, "Launch Library 2");

    assert.equal(
      launches.gateLaunch({
        launch: VANDENBERG,
        vessel,
        sunAltDeg: -20,
        cloudOk: true,
      }),
      null,
      "deep night: the plume sits in Earth's shadow",
    );
    assert.equal(
      launches.gateLaunch({
        launch: VANDENBERG,
        vessel,
        sunAltDeg: 20,
        cloudOk: true,
      }),
      null,
      "daylight washes the plume out",
    );
    assert.equal(
      launches.gateLaunch({
        launch: VANDENBERG,
        vessel: { lat: -19, lon: -165 },
        sunAltDeg: -4,
        cloudOk: true,
      }),
      null,
      "half a world away is not an event",
    );
    assert.equal(
      launches.gateLaunch({
        launch: VANDENBERG,
        vessel,
        sunAltDeg: -4,
        cloudOk: false,
      }),
      null,
      "cloud gate applies",
    );
  });

  test("computeLaunchEvents sorts by instant", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    const parsed = launches.parseLaunches(fixture, now);
    const events = launches.computeLaunchEvents({
      launches: parsed,
      lat: 34.0,
      lon: -119.5,
      sunAltAt: () => -4,
    });
    const stamps = events.map((e) => e.timestamp);
    assert.deepEqual([...stamps].sort(), stamps);
  });

  test("fetchLaunchEvents: fresh cache answers without a round-trip; failure falls back to stale", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "launch-"));
    try {
      await fs.writeFile(
        path.join(dataDir, "launches.json"),
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          payload: fixture,
        }),
      );
      let fetchCalls = 0;
      const events = await launches.fetchLaunchEvents({
        dataDir,
        lat: 34.0,
        lon: -119.5,
        from: new Date("2026-10-01T00:00:00Z"),
        sunAltAt: () => -4,
        fetchImpl: async () => {
          fetchCalls++;
          throw new Error("should use the cache");
        },
      });
      assert.equal(fetchCalls, 0);
      assert.ok(Array.isArray(events));

      // Stale cache + dead network: the old schedule still answers
      await fs.writeFile(
        path.join(dataDir, "launches.json"),
        JSON.stringify({
          fetchedAt: "2026-01-01T00:00:00.000Z",
          payload: fixture,
        }),
      );
      const stale = await launches.fetchLaunchEvents({
        dataDir,
        lat: 34.0,
        lon: -119.5,
        from: new Date("2026-10-01T00:00:00Z"),
        sunAltAt: () => -4,
        fetchImpl: async () => {
          throw new Error("network down");
        },
      });
      assert.equal(stale.length, events.length);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("fetchLaunchEvents: no data at all degrades to no events", async () => {
    const events = await launches.fetchLaunchEvents({
      dataDir: undefined,
      lat: 34,
      lon: -119.5,
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    assert.deepEqual(events, []);
  });
});
