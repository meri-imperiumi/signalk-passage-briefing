const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { sampleRoutePoints } = require("../plugin/fetch-engine.js");

const simPromise = import("../public/route-sim.mjs");
const polarPromise = import("../public/polar.mjs");

const approx = (actual, expected, epsilon = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} ≈ ${expected} (±${epsilon})`,
  );

/**
 * Builds a UnifiedWeatherPayload fixture along a 180 nm meridian
 * route with steady conditions.
 */
function buildPayload({
  route = [
    [0, 0],
    [0, 3],
  ],
  hours = 72,
  tws = 10,
  /** Per-hour TWS overrides (bin-edge chatter fixtures). */
  twsByHour = null,
  twd = 45,
  hs = 1.5,
  tp = 8,
  cape = 100,
  kIndex = 20,
  drift = 0,
  set = 0,
  steepHour = null,
  convectiveHour = null,
} = {}) {
  const track = sampleRoutePoints(route);
  const waypoints = track.map((w) => ({
    ...w,
    forecasts: Array.from({ length: hours }, (_, h) => {
      const steep = steepHour != null && h === steepHour;
      const convective = convectiveHour != null && h === convectiveHour;
      return {
        timestamp: new Date(Date.UTC(2026, 5, 21, h)).toISOString(),
        surface: {
          tws: twsByHour != null ? (twsByHour[h] ?? tws) : tws,
          twd,
          mslp: 1013,
          gust: tws + 5,
        },
        marine: {
          hsCombined: steep ? 3 : hs,
          tpCombined: steep ? 8 : tp,
          dirCombined: 45,
          hsSwell: hs * 0.6,
          tpSwell: tp + 1,
          dirSwell: 50,
          hsWindSea: hs * 0.4,
          tpWindSea: 5,
          dirWindSea: 40,
        },
        upperAir: {
          cape: convective ? 1800 : cape,
          kIndex: convective ? 30 : kIndex,
          rh700: 55,
          wind850kts: tws + 8,
        },
        current: { drift, set },
      };
    }),
  }));
  return {
    metadata: {
      fetchedAt: "2026-06-21T00:00:00.000Z",
      source: "api",
      models: ["forecast:best_match"],
    },
    waypoints,
  };
}

const MATRIX = {
  twsBinsKnots: [0, 5, 10, 15, 20, 25, 30, 35, 40],
  twaBinsDegrees: [0, 30, 60, 90, 120, 150, 180],
  matrix: [
    {
      twsBin: 2,
      twaBin: 1,
      night: false,
      preferredSailState: "GENOA_1_MAIN",
      minTwsGustTrigger: 12,
      samplesCount: 3,
    },
    {
      twsBin: 2,
      twaBin: 1,
      night: true,
      preferredSailState: "STAYSAIL_MAIN_1_REEF",
      minTwsGustTrigger: 12,
      samplesCount: 4,
    },
  ],
};

describe("weatherAt", () => {
  test("interpolates linearly between hours", async () => {
    const { weatherAt } = await simPromise;
    const forecasts = [
      {
        timestamp: "2026-06-21T00:00:00.000Z",
        surface: { tws: 12, twd: 350, mslp: 1013, gust: 17 },
        marine: { hsCombined: 1, tpCombined: 8 },
        upperAir: { cape: 100 },
        current: { drift: 0.5, set: 90 },
      },
      {
        timestamp: "2026-06-21T01:00:00.000Z",
        surface: { tws: 14, twd: 10, mslp: 1012, gust: 19 },
        marine: { hsCombined: 2, tpCombined: 9 },
        upperAir: { cape: 200 },
        current: { drift: 1, set: 90 },
      },
    ];
    const mid = weatherAt(forecasts, new Date("2026-06-21T00:30:00Z"));
    approx(mid.surface.tws, 13);
    // Angle interpolation goes the short way through north: 350 → 360/0 → 10
    approx(mid.surface.twd, 0);
    approx(mid.marine.hsCombined, 1.5);
    approx(mid.current.drift, 0.75);
    assert.equal(mid.surface.gust, 18);

    const before = weatherAt(forecasts, new Date("2026-06-20T23:00:00Z"));
    assert.equal(before.clamped, true);
    approx(before.surface.tws, 12);

    const after = weatherAt(forecasts, new Date("2026-06-21T05:00:00Z"));
    assert.equal(after.clamped, true);
    approx(after.surface.tws, 14);
  });
});

describe("simulateRun", () => {
  const START = new Date("2026-06-21T06:00:00Z"); // Daytime at lon 0

  test("sails the route and arrives within expectations", async () => {
    const { simulateRun } = await simPromise;
    const run = simulateRun({
      payload: buildPayload(),
      startTime: START,
      config: {},
    });
    // ~180 nm at ~5.7 kn close reach
    assert.ok(run.etaHours > 25 && run.etaHours < 40, `eta ${run.etaHours}`);
    assert.equal(run.motoringHours, 0);
    assert.equal(run.fuelLiters, 0);
    assert.ok(run.hourly.length > 20);
    assert.ok(run.hourly[0].stwKnots > 3, "under sail");
    assert.equal(run.hourly[0].motoring, false);
    // Comfort evaluated every hour
    for (const block of run.hourly) {
      assert.ok(
        ["champagne", "easy", "coffee", "rough", "sick"].includes(
          block.comfortLevel,
        ),
      );
    }
  });

  test("drift mode: below the wind threshold the boat drifts with zero fuel", async () => {
    const { simulateRun } = await simPromise;
    const run = simulateRun({
      payload: buildPayload(),
      startTime: START,
      config: { motoring_tws_threshold: 20, drift_mode_enabled: true },
      maxHours: 48,
    });
    assert.equal(run.etaHours, 48);
    assert.equal(run.hourly[0].stwKnots, 0);
    assert.equal(run.motoringHours, 0);
    assert.equal(run.fuelLiters, 0);
  });

  test("motor mode: below the threshold the engine pushes at 4.5 kn", async () => {
    const { simulateRun } = await simPromise;
    const run = simulateRun({
      payload: buildPayload(),
      startTime: START,
      config: { motoring_tws_threshold: 20, drift_mode_enabled: false },
    });
    // 180 nm at 4.5 kn ≈ 40 h, burning 1.8 l/h
    assert.ok(run.etaHours > 35 && run.etaHours < 45, `eta ${run.etaHours}`);
    assert.equal(run.hourly[0].stwKnots, 4.5);
    assert.ok(run.motoringHours > 35);
    assert.ok(
      run.fuelLiters > run.motoringHours * 1.79 &&
        run.fuelLiters < run.motoringHours * 1.81,
      `fuel ${run.fuelLiters} for ${run.motoringHours} motor hours`,
    );
  });

  test("learns sail suggestions from the matrix, day and night bucketed", async () => {
    const { simulateRun } = await simPromise;
    const day = simulateRun({
      payload: buildPayload(),
      startTime: START,
      matrix: MATRIX,
      maxHours: 2,
    });
    assert.equal(day.sailEvents[0].sailState, "GENOA_1_MAIN");
    assert.equal(day.sailEvents[0].night, false);
    // 10 kn TWS is above the motoring threshold: the boat sails
    assert.equal(day.sailEvents[0].propulsion, "sailing");

    // Equator, 22:00 UTC: after sunset
    const night = simulateRun({
      payload: buildPayload(),
      startTime: new Date("2026-06-21T22:00:00Z"),
      matrix: MATRIX,
      maxHours: 2,
    });
    assert.equal(night.sailEvents[0].sailState, "STAYSAIL_MAIN_1_REEF");
    assert.equal(night.sailEvents[0].night, true);
  });

  test("sail events say drifting or motoring when sails are down", async () => {
    const { simulateRun } = await simPromise;
    // Wind below the (raised) motoring threshold the whole way, still
    // inside the matrix's learned 10-15 kn bin
    const driftRun = simulateRun({
      payload: buildPayload({ tws: 10 }),
      startTime: START,
      matrix: MATRIX,
      config: { motoring_tws_threshold: 20, drift_mode_enabled: true },
      maxHours: 3,
    });
    assert.ok(driftRun.sailEvents.length >= 1);
    assert.equal(driftRun.sailEvents[0].propulsion, "adrift");

    const motorRun = simulateRun({
      payload: buildPayload({ tws: 10 }),
      startTime: START,
      matrix: MATRIX,
      config: { motoring_tws_threshold: 20, drift_mode_enabled: false },
      maxHours: 3,
    });
    assert.ok(motorRun.sailEvents.length >= 1);
    assert.equal(motorRun.sailEvents[0].propulsion, "motor");
  });

  test("bin-edge chatter does not flap the sail-change queue", async () => {
    const { simulateRun } = await simPromise;
    // TWS alternating across the 10 kn bin edge every hour: the
    // suggestions flip each step, so only the first rig may emit —
    // no change is ever held a full step
    const run = simulateRun({
      payload: buildPayload({
        twsByHour: [8, 12, 8, 12, 8, 12, 8, 12],
        hours: 8,
      }),
      startTime: START,
      matrix: MATRIX,
      maxHours: 8,
    });
    assert.equal(run.sailEvents.length, 1, `events ${run.sailEvents.length}`);
  });

  test("collects steep-sea and convective anomalies", async () => {
    const { simulateRun } = await simPromise;
    const run = simulateRun({
      payload: buildPayload({ steepHour: 7, convectiveHour: 9 }),
      startTime: START,
      maxHours: 12,
    });
    assert.ok(run.seaStateAnomalies.length >= 1);
    assert.ok(run.seaStateAnomalies[0].steepnessRatio < 3.28);
    assert.ok(run.upperAirAnomalies.some((a) => a.cape > 1000));
    assert.ok(run.upperAirAnomalies.some((a) => a.kIndex > 28));
  });

  test("current pushes the boat off the heading line", async () => {
    const { simulateRun } = await simPromise;
    const withCurrent = simulateRun({
      payload: buildPayload({ drift: 1, set: 90 }), // 1 kn set east
      startTime: START,
      maxHours: 6,
    });
    // Heading north with current set east: the boat makes easting
    assert.ok(
      withCurrent.hourly[0].lon > 0.005,
      `lon ${withCurrent.hourly[0].lon}`,
    );
    // SOG exceeds STW when the current is (partly) fair
    assert.ok(withCurrent.hourly[0].sogKnots > withCurrent.hourly[0].stwKnots);
  });
});

describe("hazardAlerts", () => {
  test("point and polygon notes raise alerts, distant ones do not", async () => {
    const { hazardAlerts } = await simPromise;
    const positions = [
      { hoursFromNow: 1, timestamp: "2026-06-21T07:00:00Z", lat: 1.0, lon: 0 },
      { hoursFromNow: 2, timestamp: "2026-06-21T08:00:00Z", lat: 2.0, lon: 0 },
    ];
    const notes = [
      {
        id: "near",
        description: "Fishing grounds",
        position: { latitude: 1.0, longitude: 0.02 },
      },
      {
        id: "area",
        description: "Firing range",
        feature: {
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-0.5, 1.9],
                [-0.5, 2.1],
                [0.5, 2.1],
                [0.5, 1.9],
                [-0.5, 1.9],
              ],
            ],
          },
        },
      },
      {
        id: "far",
        description: "Far away",
        position: { latitude: 5.0, longitude: 5.0 },
      },
    ];
    const alerts = hazardAlerts(notes, positions);
    assert.deepEqual(
      alerts.map((a) => a.noteId),
      ["near", "area"],
    );
    assert.equal(alerts[0].hoursFromNow, 1);
    assert.equal(alerts[0].distanceNm, 1.2); // 0.02° lon at lat 1
    assert.equal(alerts[1].distanceNm, 0); // Containment
  });

  test("pointInPolygon ray casting", async () => {
    const { pointInPolygon } = await simPromise;
    const square = [
      [0, 1],
      [1, 1],
      [1, 2],
      [0, 2],
      [0, 1],
    ];
    assert.equal(pointInPolygon(1.5, 0.5, square), true);
    assert.equal(pointInPolygon(1.5, 1.5, square), false);
  });
});

describe("simulatePassage", () => {
  test("eta percentiles ordered, energy summarized, exceptions filtered", async () => {
    const { filterExceptions, simulatePassage } = await simPromise;
    const startTime = new Date("2026-06-21T06:00:00Z");
    const result = simulatePassage({
      payload: buildPayload(),
      startTime,
      matrix: MATRIX,
      energyHourly: Array.from({ length: 30 }, (_, h) => ({
        timestamp: new Date(Date.UTC(2026, 5, 21, 6 + h)).toISOString(),
        solarWh: 500,
        loadWh: 600,
      })),
    });

    const p10 = new Date(result.eta.p10).getTime();
    const p50 = new Date(result.eta.p50).getTime();
    const p90 = new Date(result.eta.p90).getTime();
    assert.ok(p10 <= p50 && p50 <= p90, `${p10} <= ${p50} <= ${p90}`);
    // Day/night bucket per arrival, computed at the destination
    assert.deepEqual(Object.keys(result.eta.night), ["p10", "p50", "p90"]);
    for (const flag of Object.values(result.eta.night)) {
      assert.equal(typeof flag, "boolean");
    }

    // 24 h × (500 − 600) Wh
    assert.equal(result.energy.netSolar24h, 12);
    assert.equal(result.energy.netBalance24h, -2.4);

    const exceptions = filterExceptions(result);
    assert.ok(exceptions.next24h.comfortBlocks.length <= 24);
    assert.ok(exceptions.passageSummary.sailChanges.length >= 1);
    assert.equal(exceptions.next24h.solarYieldKwh, 12);
    assert.equal(exceptions.next24h.energyDeficitAlert, true);
    assert.equal(exceptions.passageSummary.etaP50, result.eta.p50);
    assert.equal(
      exceptions.passageSummary.totalMotorHours,
      result.motoringHours,
    );
    assert.ok(exceptions.passageSummary.macroSeaAnomalies.length === 0);
    assert.ok(exceptions.passageSummary.convectiveWarnings.length === 0);
    assert.ok(Array.isArray(exceptions.passageSummary.hazards));
  });

  test("lines of interest ride the simulated track (work doc #1)", async () => {
    const { filterExceptions, simulatePassage } = await simPromise;
    const startTime = new Date("2026-06-21T06:00:00Z");
    // 240 nm meridian leg from 1°S to 1°N: crosses the equator
    const payload = buildPayload({
      route: [
        [179, -1],
        [179, 1],
      ],
    });
    const exceptions = filterExceptions(
      simulatePassage({ payload, startTime }),
    );
    const lines = exceptions.passageSummary.linesOfInterest;
    assert.equal(lines.length, 1);
    const equator = lines[0];
    assert.equal(equator.lineId, "equator");
    assert.equal(equator.lat, 0);
    assert.equal(equator.lon, 179);
    // ETA from the simulated schedule, not the fetch window: the
    // crossing sits within the passage's own duration
    const eta = new Date(equator.eta).getTime();
    assert.ok(eta > startTime.getTime(), `eta ${equator.eta}`);
    assert.ok(
      eta <= new Date(exceptions.passageSummary.etaP90).getTime(),
      `eta ${equator.eta} within passage`,
    );
    assert.ok(
      equator.distanceFromStartNm > 50 && equator.distanceFromStartNm < 70,
      `distance ${equator.distanceFromStartNm}`,
    );
  });

  test("lines of interest disabled by config stays empty", async () => {
    const { filterExceptions, simulatePassage } = await simPromise;
    const payload = buildPayload({
      route: [
        [179, -1],
        [179, 1],
      ],
    });
    const exceptions = filterExceptions(
      simulatePassage({
        payload,
        startTime: new Date("2026-06-21T06:00:00Z"),
        config: { lines_of_interest_enabled: false },
      }),
    );
    assert.deepEqual(exceptions.passageSummary.linesOfInterest, []);
  });

  test("convective warnings surface in the passage summary", async () => {
    const { filterExceptions, simulatePassage } = await simPromise;
    const result = simulatePassage({
      payload: buildPayload({ convectiveHour: 7 }),
      startTime: new Date("2026-06-21T06:00:00Z"),
    });
    const exceptions = filterExceptions(result);
    assert.ok(exceptions.passageSummary.convectiveWarnings.length >= 1);
    assert.equal(exceptions.passageSummary.convectiveWarnings[0].cape, 1800);
  });

  test("anomalies merge into episodes with peak values, marginal band drops", async () => {
    const { filterExceptions } = await simPromise;
    const result = {
      hourlyComfort: [],
      sailEvents: [],
      hazardAlerts: [],
      seaStateAnomalies: [
        {
          hoursFromNow: 5,
          timestamp: "2026-06-21T11:00:00Z",
          steepnessRatio: 2.4,
          hsMeters: 1.2,
          tpSeconds: 7,
        },
        {
          hoursFromNow: 6.2,
          timestamp: "2026-06-21T12:12:00Z",
          steepnessRatio: 2.1,
          hsMeters: 1.5,
          tpSeconds: 8,
        },
        {
          hoursFromNow: 20,
          timestamp: "2026-06-22T02:00:00Z",
          steepnessRatio: 2.8,
          hsMeters: 1.0,
          tpSeconds: 6,
        },
      ],
      upperAirAnomalies: [
        {
          hoursFromNow: 38.7,
          timestamp: "2026-06-22T20:42:00Z",
          cape: 500,
          kIndex: 31,
        },
        {
          hoursFromNow: 39.6,
          timestamp: "2026-06-22T21:36:00Z",
          cape: 100,
          kIndex: 33,
        },
        {
          hoursFromNow: 40.6,
          timestamp: "2026-06-22T22:36:00Z",
          cape: 200,
          kIndex: 32,
        },
        // Marginal band: CAPE < 400 and K < 30 never reaches the UI
        {
          hoursFromNow: 44.4,
          timestamp: "2026-06-23T02:24:00Z",
          cape: 0,
          kIndex: 28.3,
        },
        {
          hoursFromNow: 45.4,
          timestamp: "2026-06-23T03:24:00Z",
          cape: 7.7,
          kIndex: 28.2,
        },
        // Isolated CAPE spike beyond the merged band
        {
          hoursFromNow: 60,
          timestamp: "2026-06-23T18:00:00Z",
          cape: 1200,
          kIndex: null,
        },
      ],
      energy: {},
      runs: [],
    };
    const exceptions = filterExceptions(result);

    const conv = exceptions.passageSummary.convectiveWarnings;
    assert.equal(conv.length, 3);
    assert.equal(conv[0].hoursFromNow, 38.7);
    assert.equal(conv[0].untilHoursFromNow, 40.6);
    assert.equal(conv[0].untilTimestamp, "2026-06-22T22:36:00Z");
    assert.equal(conv[0].cape, 500); // Peak of the band
    assert.equal(conv[0].kIndex, 33);
    assert.equal(conv[0].marginal, false);
    // The marginal band still shows, tagged non-severe
    assert.equal(conv[1].hoursFromNow, 44.4);
    assert.equal(conv[1].untilHoursFromNow, 45.4);
    assert.equal(conv[1].cape, 7.7);
    assert.equal(conv[1].kIndex, 28.3); // Peak of the band
    assert.equal(conv[1].marginal, true);
    assert.equal(conv[2].hoursFromNow, 60);
    assert.equal(conv[2].cape, 1200);
    assert.equal(conv[2].marginal, false);

    const sea = exceptions.passageSummary.macroSeaAnomalies;
    assert.equal(sea.length, 2);
    assert.equal(sea[0].steepnessRatio, 2.1); // Most severe of the band
    assert.equal(sea[0].hsMeters, 1.5);
    assert.equal(sea[0].untilHoursFromNow, 6.2);
    assert.equal(sea[1].hoursFromNow, 20);
  });

  test("planned tack merges into sailEvents, sorted, and reaches the summary (doc #5)", async () => {
    const { filterExceptions, simulatePassage } = await simPromise;
    // Steady beat north on starboard tack (TWA +45); at hour 12 the
    // wind veers to −45 and the plan's tack side flips between
    // adjacent hours — the tack the crew has to do.
    const track = sampleRoutePoints([
      [0, 0],
      [0, 3],
    ]);
    const payload = {
      metadata: {
        fetchedAt: new Date(Date.UTC(2026, 5, 21, 0)).toISOString(),
        source: "api",
      },
      waypoints: track.map((w) => ({
        ...w,
        forecasts: Array.from({ length: 72 }, (_, h) => ({
          timestamp: new Date(Date.UTC(2026, 5, 21, h)).toISOString(),
          surface: { tws: 10, twd: h < 12 ? 45 : -45, mslp: 1013, gust: 15 },
          marine: {
            hsCombined: 1.5,
            tpCombined: 8,
            dirCombined: 45,
            hsSwell: 1,
            tpSwell: 9,
            dirSwell: 50,
            hsWindSea: 0.5,
            tpWindSea: 5,
            dirWindSea: 40,
          },
          upperAir: { cape: 100, kIndex: 20 },
          current: { drift: 0, set: 0 },
        })),
      })),
    };
    const result = simulatePassage({
      payload,
      startTime: new Date("2026-06-21T06:00:00Z"),
    });
    const maneuvers = result.sailEvents.filter((e) => e.maneuver);
    assert.ok(maneuvers.length >= 1, "at least one maneuver detected");
    const tack = maneuvers.find((e) => e.maneuver === "tack");
    assert.ok(tack, "a tack is detected at the wind shift");
    assert.equal(tack.fromTack, "starboard");
    assert.equal(tack.toTack, "port");
    assert.ok(tack.sailState.endsWith("@port"), tack.sailState);
    assert.ok(tack.lat != null && tack.lon != null);
    assert.ok(tack.distanceFromStartNm > 0);
    assert.ok(tack.twsAtManeuver != null);

    // Merged queue stays time-sorted
    const hours = result.sailEvents.map((e) => e.hoursFromNow);
    for (let i = 1; i < hours.length; i++) {
      assert.ok(hours[i - 1] <= hours[i], "sailEvents sorted");
    }

    // Every event carries the forecast conditions at the change
    // point: the crew is rigging into 10 kn TWS on this payload
    for (const event of result.sailEvents) {
      assert.ok(event.conditions, "conditions attached");
      assert.equal(event.conditions.twsKnots, 10);
      assert.ok(event.conditions.comfortLevel != null);
    }

    const exceptions = filterExceptions(result);
    assert.ok(exceptions.passageSummary.sailChanges.length >= 1);
    assert.ok(
      exceptions.passageSummary.sailChanges.some((e) => e.maneuver === "tack"),
      "maneuvers reach the strategic summary",
    );
  });
});

describe("polar lookup", () => {
  test("canonical table: bilinear interpolation and TWA folding", async () => {
    const { polarSpeedKnots } = await polarPromise;
    assert.equal(polarSpeedKnots(null, 10, 0), 0); // In irons
    const stw = polarSpeedKnots(null, 10, (45 * Math.PI) / 180);
    assert.ok(stw > 5 && stw < 6.5, `stw ${stw}`);
    // Symmetric across the bow
    assert.equal(polarSpeedKnots(null, 10, (-45 * Math.PI) / 180), stw);
    // Grid nodes pass through (within the kn→m/s roundtrip)
    approx(polarSpeedKnots(null, 10, Math.PI / 3), 6.4, 1e-3);
    // Out-of-grid TWS clamps to hull speed
    approx(polarSpeedKnots(null, 99, Math.PI / 2), 8.5, 1e-3);
  });

  test("light wind scales toward zero, performance factor derates", async () => {
    const { polarSpeedKnots } = await polarPromise;
    // Below the table's 4 kn floor: half the wind, half the speed
    const full = polarSpeedKnots(null, 4, Math.PI / 2);
    const half = polarSpeedKnots(null, 2, Math.PI / 2);
    approx(half, full / 2, 1e-3);
    const derated = polarSpeedKnots(null, 10, Math.PI / 2, {
      performanceFactor: 0.8,
    });
    approx(derated, polarSpeedKnots(null, 10, Math.PI / 2) * 0.8, 1e-3);
  });

  test("malformed table yields zero instead of sailing on fiction", async () => {
    const { isInterpolatableTable, polarSpeedKnots } = await polarPromise;
    assert.equal(isInterpolatableTable(null), false);
    assert.equal(
      isInterpolatableTable({
        axes: { tws: [5], twa: [1] },
        values: { boatSpeedMatrix: [[1, 2]] },
      }),
      false,
    );
    assert.equal(polarSpeedKnots({ axes: {} }, 10, 1), 0);
  });

  test("bearing helper", async () => {
    const { bearingRad } = await polarPromise;
    const north = bearingRad(0, 0, 1, 0);
    approx(north, 0, 1e-9);
    const east = bearingRad(0, 0, 0, 1);
    approx(east, Math.PI / 2, 1e-9);
  });
});

describe("antimeridian", () => {
  // Tonga → Opua crosses 180°; the geometry must take the short arc
  const TONGA_TO_OPUA = [
    [-175.2, -21.1],
    [-179.0, -25.0],
    [179.0, -30.0],
    [174.3, -35.3],
  ];

  test("distanceNm takes the short way across 180", async () => {
    const { distanceNm } = await simPromise;
    // 2° of longitude at 18.5S ≈ 113.3 nm, not ~20400 nm
    const nm = distanceNm(-18.5, -179, -18.5, 179);
    assert.ok(nm > 110 && nm < 117, `nm ${nm}`);
  });

  test("route distance and sampling stay on the short arc", async () => {
    const { routeDistanceNm } = require("../plugin/fetch-engine.js");
    const { sampleRoutePoints } = require("../plugin/fetch-engine.js");
    const total = routeDistanceNm(TONGA_TO_OPUA);
    // Real passage ≈ 1100 nm; the long way would be ~23000
    assert.ok(total > 950 && total < 1250, `total ${total}`);

    const track = sampleRoutePoints(TONGA_TO_OPUA, 60);
    assert.ok(track.length > 15, `waypoints ${track.length}`);
    // Strict: every sampled lon stays on the Pacific side of the
    // seam — none swept the long way through the 0±140°E band
    for (const w of track) {
      const inWrongHalf = w.lon > -35 && w.lon < 165;
      assert.equal(inWrongHalf, false, `lon ${w.lon} swept the long way`);
    }
  });

  test("simulation crosses 180 without teleporting", async () => {
    const { simulateRun } = await simPromise;
    // Route leg across the seam: 1° lon apart across 180 at −20 lat
    const payload = {
      metadata: {},
      waypoints: [
        { lat: -20, lon: 179, distanceFromStartNm: 0 },
        { lat: -20.5, lon: -179, distanceFromStartNm: 60 },
      ],
      forecasts: undefined,
    };
    payload.waypoints = payload.waypoints.map((w) => ({
      ...w,
      forecasts: Array.from({ length: 24 }, (_, h) => ({
        timestamp: new Date(Date.UTC(2026, 5, 21, h)).toISOString(),
        surface: { tws: 10, twd: 90, mslp: 1013, gust: 15 },
        marine: { hsCombined: 1.5, tpCombined: 8, dirCombined: 45 },
        upperAir: { cape: 100, kIndex: 20 },
        current: { drift: 0, set: 0 },
      })),
    }));
    const run = simulateRun({
      payload,
      startTime: new Date("2026-06-21T06:00:00Z"),
      config: {},
    });
    assert.ok(run.etaHours < 14 * 24, `eta ${run.etaHours}`);
    const lastLon = run.hourly[run.hourly.length - 1].lon;
    // Arrival on the −180 side of the seam
    assert.ok(lastLon < 0, `last lon ${lastLon}`);
  });
});

describe("anchorSailChanges", () => {
  const HOUR = 3600000;

  /** Hourly rows with night falling 18:00–06:00, 48 hours long. */
  function buildRows() {
    const rows = [];
    for (let h = 0; h <= 48; h++) {
      const hourOfDay = (6 + h) % 24; // starts 06:00 local-ish
      rows.push({
        hoursFromNow: h,
        timestamp: new Date(Date.UTC(2026, 5, 21, 6) + h * HOUR).toISOString(),
        night: hourOfDay >= 12,
        sailState: "MAIN_FULL",
      });
    }
    return rows;
  }

  test("watchBoundaries extrapolates rotation cycles both ways", async () => {
    const { watchBoundaries } = await simPromise;
    const watch = {
      active: true,
      startedAt: Date.UTC(2026, 5, 20, 0),
      cycleMs: 4 * HOUR,
      shifts: [{ startTime: Date.UTC(2026, 5, 21, 12), endTime: 0 }],
    };
    const from = Date.UTC(2026, 5, 21, 0);
    const until = Date.UTC(2026, 5, 23, 0);
    const boundaries = watchBoundaries(watch, from, until);
    // Every 4 h across the window, none before the watch started
    assert.equal(boundaries.length, 13); // 00:00..48:00 step 4h
    assert.equal(boundaries[0], from);
    assert.equal(boundaries[1], from + 4 * HOUR);
    for (const b of boundaries) {
      assert.ok(b >= watch.startedAt, "no boundary before watch start");
    }
    // No cycle info: only published shifts inside the window
    assert.deepEqual(
      watchBoundaries({ ...watch, cycleMs: null }, from, until),
      [Date.UTC(2026, 5, 21, 12)],
    );
    // Inactive watch: no boundaries at all
    assert.deepEqual(
      watchBoundaries({ ...watch, active: false }, from, until),
      [],
    );
  });

  test("twilight mode anchors detections to the next night flip", async () => {
    const { anchorSailChanges } = await simPromise;
    const rows = buildRows();
    // Night falls at row 12 (18:00) and lifts at row 24 (06:00)
    const events = [
      {
        hoursFromNow: 2,
        timestamp: rows[2].timestamp,
        sailState: "MAIN_1_REEF",
        previousSailState: "MAIN_FULL",
      },
      {
        hoursFromNow: 3,
        timestamp: rows[3].timestamp,
        sailState: "MAIN_2_REEFS",
        previousSailState: "MAIN_1_REEF",
      },
      {
        hoursFromNow: 14,
        timestamp: rows[14].timestamp,
        sailState: "MAIN_2_REEFS",
        previousSailState: "MAIN_2_REEFS",
      },
      {
        hoursFromNow: 7,
        timestamp: rows[7].timestamp,
        sailState: "MAIN_FULL",
        previousSailState: "MAIN_2_REEFS",
        maneuver: "tack",
      },
    ];
    const anchored = anchorSailChanges(events, rows);
    // First two collapse onto the row-6 boundary (night falls there)
    // with the last state; the third re-rigs the same canvas at the
    // next boundary (dawn, row 18) and is dropped; the maneuver is
    // untouched
    assert.equal(anchored.length, 2);
    assert.equal(anchored[0].hoursFromNow, 6);
    assert.equal(anchored[0].sailState, "MAIN_2_REEFS");
    assert.equal(anchored[0].anchor, "dusk");
    assert.equal(anchored[0].night, true);
    assert.equal(anchored[1].hoursFromNow, 7);
    assert.equal(anchored[1].maneuver, "tack");
    assert.equal(anchored[1].anchor, undefined);
    // Rows rewritten to the anchored schedule
    assert.equal(rows[2].sailState, "MAIN_FULL");
    assert.equal(rows[6].sailState, "MAIN_2_REEFS");
    assert.equal(rows[7].sailState, "MAIN_2_REEFS");
  });

  test("watch mode anchors to the previous watch change", async () => {
    const { anchorSailChanges } = await simPromise;
    const rows = buildRows();
    const watch = {
      active: true,
      startedAt: Date.UTC(2026, 5, 20, 0),
      cycleMs: 4 * HOUR,
      shifts: [{ startTime: Date.UTC(2026, 5, 21, 12), endTime: 0 }],
    };
    const events = [
      {
        hoursFromNow: 2,
        timestamp: rows[2].timestamp,
        sailState: "MAIN_1_REEF",
        previousSailState: "MAIN_FULL",
      },
      {
        hoursFromNow: 3.5,
        timestamp: rows[3].timestamp,
        sailState: "MAIN_2_REEFS",
        previousSailState: "MAIN_1_REEF",
      },
    ];
    const anchored = anchorSailChanges(events, rows, watch);
    // Boundaries repeat every 4 h from 12:00 UTC; both detections
    // land after the hour-2 handover, so one change at that handover
    // carries the last suggested state
    assert.equal(anchored.length, 1);
    assert.equal(anchored[0].sailState, "MAIN_2_REEFS");
    assert.equal(anchored[0].anchor, "watch");
    assert.ok(anchored[0].hoursFromNow <= 2, "anchored before detection");
    assert.ok(anchored[0].hoursFromNow > 0, "still in the future");
    // Rows at or after the handover carry the new rig
    assert.equal(
      rows[Math.round(anchored[0].hoursFromNow)].sailState,
      "MAIN_2_REEFS",
    );
    assert.equal(rows[1].sailState, "MAIN_FULL");
  });

  test("unanchored detections keep their time when no boundary is in reach", async () => {
    const { anchorSailChanges } = await simPromise;
    // Constant night: no flips, no watch — events pass through
    const rows = buildRows().map((row) => ({ ...row, night: true }));
    const events = [
      {
        hoursFromNow: 4,
        timestamp: rows[4].timestamp,
        sailState: "MAIN_1_REEF",
        previousSailState: "MAIN_FULL",
      },
    ];
    const anchored = anchorSailChanges(events, rows);
    assert.equal(anchored.length, 1);
    assert.equal(anchored[0].hoursFromNow, 4);
  });
});
