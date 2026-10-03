const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const cs = require("../plugin/celestial-source.js");

/**
 * SWPC planetary K-index forecast fixture (verified live shape:
 * array of {time_tag, kp, observed} rows at 3-hour steps).
 */
function kpFixture() {
  return [
    { time_tag: "2026-09-27T00:00:00", kp: 2.33, observed: "observed" },
    { time_tag: "2026-09-27T09:00:00", kp: 4.0, observed: "observed" },
    { time_tag: "2026-09-27T12:00:00", kp: 6.33, observed: "predicted" },
    { time_tag: "2026-09-27T15:00:00", kp: 5.67, observed: "predicted" },
    { time_tag: "2026-09-27T18:00:00", kp: 3.0, observed: "predicted" },
    { time_tag: "2026-09-30T00:00:00", kp: 8.0, observed: "predicted" },
  ];
}

/** SBDB query fixture (documented {fields, rows} response shape). */
function sbdbFixture() {
  return {
    fields: ["full_name", "M1", "K1", "r", "dist"],
    rows: [
      // m = 4.0 + 5·log10(0.5) + 10·log10(1.2) ≈ 5.12 → naked eye
      ["C/2026 A1 (Fixture)", 4.0, 10, 1.2, 0.5],
      // m ≈ 9.75 → too faint
      ["C/2025 B2 (Faint)", 7.0, 10, 2.0, 1.5],
      // Missing numbers → skipped
      ["C/2024 C3 (Broken)", null, null, null, null],
    ],
  };
}

test("parseComets falls back to perihelion estimate without r/dist", () => {
  // The live SBDB endpoint rejects r/dist for sb-kind=c: with q only,
  // the parse screens on perihelion brightness and flags the estimate
  const comets = cs.parseComets({
    fields: ["full_name", "M1", "K1", "q", "tp_cal"],
    rows: [
      // mPeri = 4.0 + 15·log10(0.9) ≈ 3.31 → naked eye at perihelion
      ["C/2026 D1 (Peri)", 4.0, 10, 0.9, "2026-Nov-03.1"],
      // mPeri = 9 + 15·log10(3) ≈ 16.2 → never naked eye
      ["C/2020 E4 (Faint)", 9.0, 10, 3.0, "2020-Aug-01.5"],
    ],
  });
  assert.equal(comets.length, 1);
  assert.equal(comets[0].name, "C/2026 D1 (Peri)");
  assert.equal(comets[0].estimate, "perihelion");
  assert.equal(comets[0].perihelion, "2026-Nov-03.1");
});

test("fetchComets negotiates invalid fields away and retries", async () => {
  const attempted = [];
  const responses = [
    // 1st: full list rejected on r
    {
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ message: "invalid field specified: 'r'" }),
    },
    // 2nd: dist rejected too
    {
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ message: "invalid field specified: 'dist'" }),
    },
    // 3rd: accepted
    {
      ok: true,
      status: 200,
      json: async () => ({ fields: ["ok"], rows: [] }),
    },
  ];
  const comets = await cs.fetchComets({
    fetchImpl: async (url) => {
      attempted.push(String(url));
      return responses[attempted.length - 1];
    },
    timeoutMs: 500,
  });
  assert.deepEqual(comets, { fields: ["ok"], rows: [] });
  assert.equal(attempted.length, 3);
  assert.match(attempted[0], /fields=full_name,M1,K1,r,dist,q,tp_cal/);
  assert.match(attempted[1], /fields=full_name,M1,K1,dist,q,tp_cal/);
  assert.match(attempted[2], /fields=full_name,M1,K1,q,tp_cal/);
});

test("fetchComets returns null when the endpoint never answers", async () => {
  const comets = await cs.fetchComets({
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => "" }),
    timeoutMs: 500,
  });
  assert.equal(comets, null);
});

const NIGHT = (_date, _lat, _lon) => true;
const DAY = (_date, _lat, _lon) => false;

describe("celestial & space weather (doc #3 Phase 1)", () => {
  test("aurora magnetic-latitude threshold tightens with Kp", () => {
    assert.equal(cs.auroraMagLatThreshold(5), 65);
    assert.equal(cs.auroraMagLatThreshold(8), 50);
    assert.equal(cs.auroraMagLatThreshold(9), 45);
    assert.equal(cs.auroraMagLatThreshold(12), 40); // Clamped
  });

  test("magnetic latitude: known hemisphere sanity", () => {
    // Opua NZ: geographic -35.3 → dipole about -37 (coarse)
    const opua = cs.magneticLatitudeDeg(-35.3, 174.3);
    assert.ok(opua < -30 && opua > -45, `Opua mag lat ${opua}`);
    // Tromsø, Norway: high northern magnetic latitude
    const tromso = cs.magneticLatitudeDeg(69.6, 18.9);
    assert.ok(tromso > 55, `Tromsø mag lat ${tromso}`);
  });

  test("parseKpForecast keeps the forward window only", () => {
    const from = new Date("2026-09-27T06:00:00Z");
    const entries = cs.parseKpForecast(kpFixture(), { from, hours: 24 });
    assert.deepEqual(
      entries.map((e) => e.timestamp),
      [
        "2026-09-27T09:00:00.000Z",
        "2026-09-27T12:00:00.000Z",
        "2026-09-27T15:00:00.000Z",
        "2026-09-27T18:00:00.000Z",
      ],
    );
    // The Kp 8 entry three days out is outside the window
    assert.ok(entries.every((e) => e.kp < 8));
    assert.equal(entries[1].predicted, true);
    assert.deepEqual(cs.parseKpForecast(null), []);
  });

  test("comet apparent magnitude follows m = M1 + 5log Δ + K1 log r", () => {
    const m = cs.cometApparentMagnitude({ M1: 4, K1: 10, r: 1.2, delta: 0.5 });
    approx(m, 4 + 5 * Math.log10(0.5) + 10 * Math.log10(1.2));
    assert.equal(cs.cometApparentMagnitude({ M1: 4 }), null);
    assert.equal(
      cs.cometApparentMagnitude({ M1: 4, K1: 10, r: 0, delta: 1 }),
      null,
    );
  });

  test("parseComets keeps only naked-eye comets, brightest first", () => {
    const comets = cs.parseComets(sbdbFixture());
    assert.equal(comets.length, 1);
    assert.equal(comets[0].name, "C/2026 A1 (Fixture)");
    assert.ok(comets[0].magnitude < 6);
    // Broken row numbers are skipped, not fatal
    assert.equal(cs.parseComets({ fields: [], rows: [] }).length, 0);
    assert.equal(cs.parseComets(null).length, 0);
  });

  test("buildSpaceEvents gates aurora by Kp, magnetic latitude and night", async () => {
    const kpEntries = cs.parseKpForecast(kpFixture(), {
      from: new Date("2026-09-27T06:00:00Z"),
      hours: 24,
    });
    const comets = cs.parseComets(sbdbFixture());

    // Tonga (-21): far too equatorial for Kp 6
    const tonga = await cs.buildSpaceEvents({
      kpEntries,
      comets,
      lat: -21.1,
      lon: -175.2,
      nightFn: NIGHT,
    });
    assert.ok(tonga.every((e) => e.kind !== "aurora"));
    assert.equal(tonga.length, 1); // The comet
    assert.equal(tonga[0].kind, "comet");
    assert.equal(tonga[0].tactical, false);

    // Subantarctic south (−54): inside the Kp 6.33 → 55°? No: 68 mag
    // lat threshold at 6.33... use a Kp 9 window instead. Moon and
    // cloud gates pinned clear so the Kp/magnetic-latitude pair is
    // what the test exercises (both gates unit-tested separately).
    const storm = [
      { timestamp: "2026-09-27T12:00:00.000Z", kp: 9, predicted: true },
    ];
    const farSouth = await cs.buildSpaceEvents({
      kpEntries: storm,
      comets: [],
      lat: -50,
      lon: 170,
      nightFn: NIGHT,
      moonGateFn: () => true,
      cloudCoverAt: () => 10,
    });
    assert.equal(farSouth.length, 1);
    assert.equal(farSouth[0].kind, "aurora");
    assert.equal(farSouth[0].tactical, true);
    assert.match(farSouth[0].description, /Look south/);

    // Daylight at the peak kills the aurora alert
    const daytime = await cs.buildSpaceEvents({
      kpEntries: storm,
      comets: [],
      lat: -50,
      lon: 170,
      nightFn: DAY,
    });
    assert.equal(daytime.length, 0);

    // Northern hemisphere looks north
    const north = await cs.buildSpaceEvents({
      kpEntries: storm,
      comets: [],
      lat: 55,
      lon: 20,
      nightFn: NIGHT,
      moonGateFn: () => true,
      cloudCoverAt: () => 10,
    });
    assert.match(north[0].description, /Look north/);

    // Sub-storm Kp: nothing even at high latitude
    const quiet = await cs.buildSpaceEvents({
      kpEntries: [{ timestamp: "2026-09-27T12:00:00.000Z", kp: 4 }],
      comets: [],
      lat: -50,
      lon: 170,
      nightFn: NIGHT,
    });
    assert.equal(quiet.length, 0);
  });

  test("aurora passes the full Phase-2 visibility gate", async () => {
    const storm = [{ timestamp: "2026-09-27T12:00:00.000Z", kp: 9 }];
    const base = {
      kpEntries: storm,
      comets: [],
      lat: -50,
      lon: 170,
      nightFn: NIGHT,
    };

    // Moonlit night suppresses faint auroras (moon above horizon,
    // not a crescent)
    const moonlit = await cs.buildSpaceEvents({
      ...base,
      moonGateFn: () => false,
    });
    assert.ok(moonlit.every((e) => e.kind !== "aurora"));

    // Overcast sky suppresses the alert when the lookup answers
    const overcast = await cs.buildSpaceEvents({
      ...base,
      cloudCoverAt: () => 80,
    });
    assert.ok(overcast.every((e) => e.kind !== "aurora"));

    // Clear, dark, moonless: the alert fires
    const clear = await cs.buildSpaceEvents({
      ...base,
      moonGateFn: () => true,
      cloudCoverAt: () => 10,
    });
    assert.equal(clear.filter((e) => e.kind === "aurora").length, 1);

    // No cloud lookup available (Weather API path): gate stays open
    const noLookup = await cs.buildSpaceEvents({
      ...base,
      moonGateFn: () => true,
      cloudCoverAt: () => null,
    });
    assert.equal(noLookup.filter((e) => e.kind === "aurora").length, 1);
  });

  test("fetchSpaceEvents degrades per source and on total failure", async () => {
    const originalFetch = globalThis.fetch;
    try {
      // Only SWPC answers: aurora gating still runs (comets skipped)
      globalThis.fetch = async (url) => {
        if (String(url).includes("swpc.noaa.gov")) {
          return { ok: true, json: async () => kpFixture() };
        }
        throw new Error("network down");
      };
      const events = await cs.fetchSpaceEvents({
        lat: -50,
        lon: 170,
        now: new Date("2026-09-27T06:00:00Z"),
        nightFn: NIGHT,
        ephemeris: false,
      });
      assert.ok(events.every((e) => ["aurora", "comet"].includes(e.kind)));

      // Everything fails: empty list, never throws
      globalThis.fetch = async () => {
        throw new Error("network down");
      };
      const none = await cs.fetchSpaceEvents({
        lat: -50,
        lon: 170,
        now: new Date("2026-09-27T06:00:00Z"),
        ephemeris: false,
      });
      assert.deepEqual(none, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function approx(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} ≈ ${expected} (±${epsilon})`,
  );
}
