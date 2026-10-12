const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const satellite = require("satellite.js");

const reentry = require("../plugin/reentry-source.js");

const sambaTLE = require("./fixtures/cluster-26410-omm.json");
const tangoTLE = require("./fixtures/cluster-26464-omm.json");
const tipFixture = require("./fixtures/tip-messages.json");

/** Real Cluster II element sets from the committed fixtures. */
const CLUSTER_TLES = new Map(
  [
    ["26410", sambaTLE.at(-1)],
    ["26464", tangoTLE.at(-1)],
  ].map(([catnr, omm]) => [
    catnr,
    { name: omm.OBJECT_NAME, line1: omm.TLE_LINE1, line2: omm.TLE_LINE2 },
  ]),
);

describe("reentry watch (work doc #36)", () => {
  test("horizon cap: the SAMBA/TANGO sighting ranges from the backtest", () => {
    assert.ok(
      Math.abs(reentry.horizonCapKm(62) - 894) < 3,
      `62 km cap ${reentry.horizonCapKm(62)}`,
    );
    assert.ok(
      Math.abs(reentry.horizonCapKm(93) - 1098) < 3,
      `93 km cap ${reentry.horizonCapKm(93)}`,
    );
  });

  test("PoC backtest: the Cluster II deorbits were unobservable from the Aitutaki→Niue track", async () => {
    // Real TLEs (committed fixtures), real Sun positions — the same
    // computation the backtest ran, now permanent: the gate must not
    // cry wolf on geometry that is below the horizon in daylight.
    const from = new Date("2026-08-30T00:00:00Z");
    const tips = [
      {
        catnr: "26410",
        name: "CLUSTER II-FM7 (SAMBA)",
        msgEpoch: new Date("2026-08-31T12:00:00Z"),
        decayEpoch: new Date("2026-08-31T22:58:00Z"),
        windowMin: 60,
        lat: -29.77,
        lon: 174.03,
      },
      {
        catnr: "26464",
        name: "CLUSTER II-FM8 (TANGO)",
        msgEpoch: new Date("2026-09-01T12:00:00Z"),
        decayEpoch: new Date("2026-09-01T21:32:00Z"),
        windowMin: 60,
        lat: -29.32,
        lon: -166.77,
      },
    ];
    const route = [
      { lat: -18.856, lon: -159.787 }, // Aitutaki
      { lat: -18.95, lon: -164.85 }, // midway
      { lat: -19.054, lon: -169.919 }, // Niue
    ];
    const realSun = (date, lat, lon) =>
      require("../plugin/celestial-ephemeris.js").bodyAltitudeDeg(
        "Sun",
        date,
        lat,
        lon,
      );
    for (const vessel of route) {
      const events = reentry.computeReentryEvents({
        tips,
        tles: CLUSTER_TLES,
        lat: vessel.lat,
        lon: vessel.lon,
        from,
        sunAltAt: realSun,
      });
      assert.deepEqual(events, [], `no event from ${vessel.lon}`);
    }
    // The numbers behind the verdict: closest approaches and the pass
    // geometry match the backtest
    const satrec = satellite.twoline2satrec(
      tangoTLE.at(-1).TLE_LINE1,
      tangoTLE.at(-1).TLE_LINE2,
    );
    const pass = reentry.lowestPassNear({
      satrec,
      decayEpoch: new Date("2026-09-01T21:32:00Z"),
      windowMin: 60,
    });
    assert.ok(pass, "TANGO's decaying pass is found near its epoch");
    assert.ok(
      Math.abs(pass.minAltKm - 62) < 8,
      `dip altitude ${pass.minAltKm}`,
    );
    const closest = Math.min(
      ...pass.points.map((p) => reentry.distanceKm(route[2], p)),
    );
    assert.ok(
      Math.abs(closest - 1075) < 40,
      `closest approach from Niue ${closest.toFixed(0)} km`,
    );
    assert.ok(closest > reentry.horizonCapKm(62), "below the horizon");
  });

  test("fireball regime: a pass over the vessel at night fires an event", () => {
    const satrec = satellite.twoline2satrec(
      tangoTLE.at(-1).TLE_LINE1,
      tangoTLE.at(-1).TLE_LINE2,
    );
    const pass = reentry.lowestPassNear({
      satrec,
      decayEpoch: new Date("2026-09-01T21:32:00Z"),
      windowMin: 60,
    });
    const dip = pass.points.reduce((a, b) => (b.altKm < a.altKm ? b : a));
    const tips = [
      {
        catnr: "26464",
        name: "CLUSTER II-FM8 (TANGO)",
        msgEpoch: new Date("2026-09-01T12:00:00Z"),
        decayEpoch: new Date("2026-09-01T21:32:00Z"),
        windowMin: 60,
        lat: dip.lat,
        lon: dip.lon,
      },
    ];
    const events = reentry.computeReentryEvents({
      tips,
      tles: CLUSTER_TLES,
      lat: dip.lat,
      lon: dip.lon,
      from: new Date("2026-08-30T00:00:00Z"),
      sunAltAt: () => -20, // night
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "reentry");
    assert.equal(events[0].tactical, true);
    assert.match(events[0].description, /fireball watch/);
    assert.match(events[0].description, /CLUSTER II-FM8/);
  });

  test("daylight regime: a very close daytime deorbit names the smoke streak; far ones stay quiet", () => {
    const tips = [
      {
        catnr: "99999",
        name: "TESTSAT",
        msgEpoch: new Date("2026-08-30T00:00:00Z"),
        decayEpoch: new Date("2026-08-31T12:00:00Z"),
        windowMin: 30,
        lat: -19.0,
        lon: -164.0,
      },
    ];
    const noTles = new Map();
    // ~250 km from the tip point in broad daylight: inside the
    // daylight-trail cap, so the ESA-style cruiser observation fires
    const close = reentry.computeReentryEvents({
      tips,
      tles: noTles,
      lat: -19.05,
      lon: -161.6,
      from: new Date("2026-08-30T00:00:00Z"),
      sunAltAt: () => 30,
    });
    assert.equal(close.length, 1);
    assert.match(close[0].description, /smoke streak/);
    assert.match(close[0].description, /ground track uncertain/);
    // ~370 km away in daylight: beyond the daylight-trail cap, no
    // event even though the geometry would clear the horizon
    const far = reentry.computeReentryEvents({
      tips,
      tles: noTles,
      lat: -19.05,
      lon: -167.5,
      from: new Date("2026-08-30T00:00:00Z"),
      sunAltAt: () => 30,
    });
    assert.deepEqual(far, []);
    // The same geometry at night: the fireball cap (~1000 km) allows it
    const night = reentry.computeReentryEvents({
      tips,
      tles: noTles,
      lat: -19.05,
      lon: -167.5,
      from: new Date("2026-08-30T00:00:00Z"),
      sunAltAt: () => -20,
    });
    assert.equal(night.length, 1);
    assert.match(night[0].description, /fireball watch/);
  });

  test("cloud gate applies to reentry events", () => {
    const tips = [
      {
        catnr: "99999",
        name: "TESTSAT",
        msgEpoch: new Date("2026-08-30T00:00:00Z"),
        decayEpoch: new Date("2026-08-31T12:00:00Z"),
        windowMin: 30,
        lat: -19.0,
        lon: -164.0,
      },
    ];
    const events = reentry.computeReentryEvents({
      tips,
      tles: new Map(),
      lat: -19.05,
      lon: -164.0,
      from: new Date("2026-08-30T00:00:00Z"),
      sunAltAt: () => -20,
      cloudCoverAt: () => 80,
    });
    assert.deepEqual(events, []);
  });

  test("parseTipMessages: dedupes per object, keeps the latest message, normalizes 0..360 longitudes", () => {
    const tips = reentry.parseTipMessages(tipFixture);
    assert.equal(tips.length, 2, "12907 appears twice, latest wins");
    const first = tips.find((t) => t.catnr === "12907");
    assert.equal(first.windowMin, 2, "the ±2 min report is the newest");
    assert.equal(
      first.decayEpoch.toISOString(),
      "2026-09-03T17:34:00.000Z",
      "space-separated stamp parses as UTC",
    );
    assert.ok(Math.abs(first.lon - 171.9) < 1e-6);
    // A 0..360 longitude lands in -180..180
    const shifted = reentry.parseTipMessages([
      { ...tipFixture[2], LON: "260" },
    ]);
    assert.ok(Math.abs(shifted[0].lon + 100) < 1e-6);
  });

  test("fetchReentryEvents: no credentials degrades to off without fetching", async () => {
    let calls = 0;
    const events = await reentry.fetchReentryEvents({
      identity: "",
      password: "",
      lat: -19,
      lon: -165,
      fetchImpl: async () => {
        calls++;
        throw new Error("should not fetch");
      },
    });
    assert.deepEqual(events, []);
    assert.equal(calls, 0);
  });

  test("fetchReentryEvents: fresh cache answers without a Space-Track round-trip", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "reentry-"));
    try {
      await fs.writeFile(
        path.join(dataDir, "reentry-tip.json"),
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          rows: tipFixture,
        }),
      );
      let spaceTrackCalls = 0;
      const events = await reentry.fetchReentryEvents({
        identity: "u",
        password: "p",
        dataDir,
        lat: -19.05,
        lon: -160.5,
        from: new Date("2026-08-30T00:00:00Z"),
        sunAltAt: () => 30,
        fetchImpl: async (url) => {
          if (String(url).includes("space-track.org")) {
            spaceTrackCalls++;
            throw new Error("should use the cache");
          }
          return { ok: false, status: 404 };
        },
      });
      assert.equal(spaceTrackCalls, 0);
      // The cached 12907 object has no TLE; its TIP point is ~1000 km
      // from the test position, so the daylight gate keeps it quiet —
      // what matters here is that the pipeline ran from the cache
      assert.ok(Array.isArray(events));
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("fetchReentryEvents: fetch failure falls back to a stale cache", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "reentry-"));
    try {
      await fs.writeFile(
        path.join(dataDir, "reentry-tip.json"),
        JSON.stringify({
          fetchedAt: "2026-01-01T00:00:00.000Z", // long stale
          rows: [
            {
              ...tipFixture[2],
              DECAY_EPOCH: "2026-08-31 12:00:00",
              MSG_EPOCH: "2026-08-30 08:00:00",
              LAT: "-19.0",
              LON: "-164.0",
            },
          ],
        }),
      );
      const events = await reentry.fetchReentryEvents({
        identity: "u",
        password: "p",
        dataDir,
        lat: -19.05,
        lon: -164.0,
        from: new Date("2026-08-30T00:00:00Z"),
        sunAltAt: () => -20,
        fetchImpl: async () => {
          throw new Error("network down");
        },
      });
      assert.equal(events.length, 1, "stale cache still predicts");
      assert.match(events[0].description, /fireball watch/);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("fetchCelesTrakTLE: decayed objects read as missing, not failed", async () => {
    const tle = await reentry.fetchCelesTrakTLE("26410", {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => "No GP data found",
      }),
    });
    assert.equal(tle, null);
  });
});
