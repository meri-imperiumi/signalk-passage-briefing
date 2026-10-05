const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const S = require("../plugin/satellite-source.js");

/** Historical ISS elements (satellite.js verification TLE). */
const ISS_TLE =
  "ISS (ZARYA)\n1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927\n2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537";

describe("satellite passes (doc #3 Phase 2)", () => {
  test("parseTLEs keeps the tracked stations, drops the rest", () => {
    const tles = S.parseTLEs(
      `${ISS_TLE}\nCSS (TIANHE)\n1 48274U 21035A   23001.00000000  .00000000  00000-0  00000-0 0  9990\n2 48274  41.4730 100.0000 0001000 000.0000 000.0000 15.90000000000000\nNOAA 19\n1 33591U 09005A   23001.00000000  .00000000  00000-0  00000-0 0  9993\n2 33591  99.1000 200.0000 0013000 000.0000 000.0000 14.12000000000000`,
    );
    assert.deepEqual(
      tles.map((t) => t.displayName),
      ["ISS", "Tiangong"],
    );
    assert.equal(tles[1].name, "CSS (TIANHE)");
    assert.deepEqual(S.parseTLEs(""), []);
    assert.deepEqual(S.parseTLEs(null), []);
    assert.deepEqual(S.parseTLEs("garbage\n1 25544U\n2 25544"), []);
  });

  test("parseTLEs collapses a station's modules into one element set", () => {
    // CelesTrak lists every docked module separately; ISS (NAUKA)
    // sorts before the core (ZARYA), which must still win
    const tles = S.parseTLEs(
      `ISS (NAUKA)\n1 48274U 21035A   23001.00000000  .00000000  00000-0  00000-0 0  9990\n2 48274  41.4730 100.0000 0001000 000.0000 000.0000 15.90000000000000\nISS (ZARYA)\n${ISS_TLE.slice(ISS_TLE.indexOf("1 25544"))}\nCSS (TIANHE)\n1 48274U 21035A   23001.00000000  .00000000  00000-0  00000-0 0  9990\n2 48274  41.4730 100.0000 0001000 000.0000 000.0000 15.90000000000000\nCSS (WENTIAN)\n1 48274U 21035A   23001.00000000  .00000000  00000-0  00000-0 0  9990\n2 48274  41.4730 100.0000 0001000 000.0000 000.0000 15.90000000000000`,
    );
    assert.deepEqual(
      tles.map((t) => t.name),
      ["ISS (ZARYA)", "CSS (TIANHE)"],
    );
    assert.deepEqual(
      tles.map((t) => t.displayName),
      ["ISS", "Tiangong"],
    );
  });

  test("magnitude estimate reads −1.0 overhead and dims with range", () => {
    assert.equal(S.magnitudeEstimate(420), -1.0);
    assert.ok(Math.abs(S.magnitudeEstimate(420 * 2) - 0.505) < 0.01);
    assert.equal(S.magnitudeEstimate(42), -1.0); // clamped
    assert.equal(S.magnitudeEstimate(42000), 4.0); // clamped
    assert.equal(S.magnitudeEstimate(0), 4.0);
  });

  test("azimuth compass covers the 8-point rose", () => {
    assert.equal(S.azimuthCompass(0), "N");
    assert.equal(S.azimuthCompass(45), "NE");
    assert.equal(S.azimuthCompass(90), "E");
    assert.equal(S.azimuthCompass(135), "SE");
    assert.equal(S.azimuthCompass(180), "S");
    assert.equal(S.azimuthCompass(225), "SW");
    assert.equal(S.azimuthCompass(270), "W");
    assert.equal(S.azimuthCompass(315), "NW");
  });

  test("propagates ISS passes over a known position (2008 verification TLE)", () => {
    const tles = S.parseTLEs(ISS_TLE);
    const events = S.computeSatelliteEvents({
      tles,
      lat: 60,
      lon: -147,
      from: new Date("2008-09-20T00:00:00Z"),
      hours: 48,
    });
    // Two passes clear the 15° gate during nautical night in this
    // window (verified against the propagator)
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, "satellite");
    assert.equal(events[0].name, "ISS");
    assert.equal(events[0].timestamp, "2008-09-20T07:48:30.000Z");
    assert.equal(events[0].maxElevationDeg, 16);
    assert.match(events[0].description, /approaching from SW/);
    assert.match(events[0].description, /peaks 16° up/);
    assert.match(events[0].description, /mag/);
    assert.equal(events[1].timestamp, "2008-09-21T08:14:30.000Z");
    assert.equal(events[0].tactical, true);
    // Provenance (work doc #31): NORAD catalog number from TLE line 1
    // keys the live-tracker verification link
    assert.equal(events[0].catalogNumber, "25544");
    assert.equal(events[0].provenance.kind, "feed");
    assert.equal(
      events[0].provenance.url,
      "https://www.n2yo.com/satellite/?s=25544",
    );
  });

  test("catalogNumber reads TLE line 1 columns", () => {
    assert.equal(S.catalogNumber(ISS_TLE.split("\n")[1]), "25544");
    // Five-digit alphanumeric catalog numbers parse too; garbage does
    // not
    assert.equal(
      S.catalogNumber(
        "1 99999U 21035A   23001.00000000  .00000000  00000-0  00000-0 0  9990",
      ),
      "99999",
    );
    assert.equal(S.catalogNumber("bad"), null);
    assert.equal(S.catalogNumber(undefined), null);
  });

  test("overridden night gate lets bright daytime passes through", () => {
    const tles = S.parseTLEs(ISS_TLE);
    const events = S.computeSatelliteEvents({
      tles,
      lat: 20,
      lon: -160,
      from: new Date("2008-09-20T00:00:00Z"),
      hours: 48,
      nightFn: () => true,
    });
    // Four passes clear the gate in 48 h when night is not enforced
    assert.equal(events.length, 4);
    assert.equal(events[0].maxElevationDeg, 73);
    assert.match(events[0].description, /mag −1\.0/);
  });

  test("cloud gate suppresses passes under overcast forecasts", () => {
    const tles = S.parseTLEs(ISS_TLE);
    const events = S.computeSatelliteEvents({
      tles,
      lat: 60,
      lon: -147,
      from: new Date("2008-09-20T00:00:00Z"),
      hours: 48,
      cloudCoverAt: () => 80,
    });
    assert.deepEqual(events, []);
  });

  test("no events without elements or in a quiet window", () => {
    assert.deepEqual(
      S.computeSatelliteEvents({
        tles: [],
        lat: 60,
        lon: -147,
        from: new Date("2008-09-20T00:00:00Z"),
        hours: 48,
      }),
      [],
    );
    assert.deepEqual(
      S.computeSatelliteEvents({
        tles: [{ name: "X", displayName: "X", line1: "bad", line2: "bad" }],
        lat: 60,
        lon: -147,
        from: new Date("2008-09-20T00:00:00Z"),
        hours: 48,
      }),
      [],
    );
  });

  test("fetchTrackedTLEs degrades to null on any failure", async () => {
    const ok = await S.fetchTrackedTLEs({
      fetchImpl: async () => ({
        ok: true,
        text: async () => ISS_TLE,
      }),
      timeoutMs: 500,
    });
    assert.equal(ok.length, 1);

    const httpFail = await S.fetchTrackedTLEs({
      fetchImpl: async () => ({ ok: false, status: 503 }),
      timeoutMs: 500,
    });
    assert.equal(httpFail, null);

    const networkFail = await S.fetchTrackedTLEs({
      fetchImpl: async () => {
        throw new Error("down");
      },
      timeoutMs: 500,
    });
    assert.equal(networkFail, null);

    const empty = await S.fetchTrackedTLEs({
      fetchImpl: async () => ({ ok: true, text: async () => "nothing here" }),
      timeoutMs: 500,
    });
    assert.equal(empty, null);
  });
});
