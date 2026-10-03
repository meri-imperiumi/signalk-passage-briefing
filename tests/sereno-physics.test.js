const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const physicsPromise = import("../public/sereno-physics.mjs");
const physics = async () => physicsPromise;

const approx = (actual, expected, epsilon = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} ≈ ${expected} (±${epsilon})`,
  );

describe("comfort bands (SPEC §5.2)", () => {
  test("band constants", async () => {
    const p = await physics();
    assert.deepEqual(p.AWS_BANDS_KNOTS, [12, 18, 23, 33]);
    assert.deepEqual(p.AZ_BANDS_MS2, [0.15, 0.315, 0.63, 1.25]);
    assert.deepEqual(p.COMFORT_TIERS, [
      "champagne",
      "easy",
      "coffee",
      "rough",
      "sick",
    ]);
    assert.deepEqual(p.STEEPNESS_RATIO_THRESHOLD, 3.28);
  });

  test("apparent wind bands", async () => {
    const { rateApparentWind } = await physics();
    assert.equal(rateApparentWind(11.9), "champagne");
    assert.equal(rateApparentWind(12), "easy");
    assert.equal(rateApparentWind(18), "coffee");
    assert.equal(rateApparentWind(23), "rough");
    assert.equal(rateApparentWind(33), "sick");
  });

  test("acceleration bands", async () => {
    const { rateAcceleration } = await physics();
    assert.equal(rateAcceleration(0.149), "champagne");
    assert.equal(rateAcceleration(0.15), "easy");
    assert.equal(rateAcceleration(0.315), "coffee");
    assert.equal(rateAcceleration(0.63), "rough");
    assert.equal(rateAcceleration(1.25), "sick");
  });
});

describe("apparent wind", () => {
  test("head wind adds boat speed, following wind subtracts", async () => {
    const { apparentWindSpeedKnots } = await physics();
    // TWA 0 (dead ahead): AWS = TWS + STW
    approx(
      apparentWindSpeedKnots({ twsKnots: 15, stwKnots: 5, twaRad: 0 }),
      20,
    );
    // TWA π (dead astern): AWS = TWS − STW
    approx(
      apparentWindSpeedKnots({ twsKnots: 15, stwKnots: 5, twaRad: Math.PI }),
      10,
    );
    // Beam reach: quadrature, per the SPEC formula
    approx(
      apparentWindSpeedKnots({
        twsKnots: 15,
        stwKnots: 5,
        twaRad: Math.PI / 2,
      }),
      Math.sqrt(15 * 15 + 5 * 5),
    );
  });
});

describe("wave math", () => {
  test("deep-water wavelength and phase speed", async () => {
    const { waveLengthMeters, wavePhaseSpeedMs } = await physics();
    approx(waveLengthMeters(7), (9.81 * 49) / (2 * Math.PI));
    approx(wavePhaseSpeedMs(7), (9.81 * 7) / (2 * Math.PI));
    // L = c·T
    approx(waveLengthMeters(5), wavePhaseSpeedMs(5) * 5);
  });

  test("encounter period: bow seas arrive faster, astern seas slower", async () => {
    const { encounterPeriodSeconds } = await physics();
    // Wave travel convention: seas from astern travel with the boat's
    // heading (travel ≈ heading), seas on the bow against it.
    const bow = encounterPeriodSeconds({
      tpSeconds: 7,
      sogKnots: 6,
      waveTravelDirectionRad: Math.PI,
      headingRad: 0,
    });
    assert.ok(bow < 7, `bow Te ${bow} < Tp`);
    const astern = encounterPeriodSeconds({
      tpSeconds: 7,
      sogKnots: 6,
      waveTravelDirectionRad: 0,
      headingRad: 0,
    });
    assert.ok(astern > 7, `astern Te ${astern} > Tp`);
    // Same train met from the opposite heading: symmetric stretch
    const reversed = encounterPeriodSeconds({
      tpSeconds: 7,
      sogKnots: 6,
      waveTravelDirectionRad: Math.PI,
      headingRad: Math.PI,
    });
    approx(reversed, astern);
  });

  test("surfing a slower train cannot drive Te to zero", async () => {
    const { encounterPeriodSeconds } = await physics();
    // 8.2 kn boat overtakes a 3 s train it matches 90% of the phase
    // speed of: stretch |1 − 0.907| = 0.093 → floored at 0.15
    const te = encounterPeriodSeconds({
      tpSeconds: 3,
      sogKnots: 8.2,
      waveTravelDirectionRad: 0,
      headingRad: 0,
    });
    approx(te, 3 / 0.15); // factor floor
  });

  test("from-conversion helper", async () => {
    const { travelDirection } = await physics();
    approx(travelDirection(0), Math.PI);
    approx(travelDirection(Math.PI), 0);
  });

  test("steepness ratio", async () => {
    const { steepnessRatio, STEEPNESS_RATIO_THRESHOLD } = await physics();
    assert.equal(steepnessRatio(3.28, 1), STEEPNESS_RATIO_THRESHOLD);
    assert.equal(steepnessRatio(6, 0), Infinity);
  });
});

describe("monohull corrections (SPEC §5.2 vector 2)", () => {
  test("heel peaks on a beam reach and scales with apparent wind", async () => {
    const { heelAngleDeg } = await physics();
    approx(heelAngleDeg({ awsKnots: 25, twaRad: Math.PI / 2 }), 25);
    approx(heelAngleDeg({ awsKnots: 12.5, twaRad: Math.PI / 2 }), 12.5);
    approx(heelAngleDeg({ awsKnots: 25, twaRad: 0 }), 0);
    approx(heelAngleDeg({ awsKnots: 25, twaRad: Math.PI }), 0);
    // Never beyond φ_max even in extreme wind
    approx(heelAngleDeg({ awsKnots: 60, twaRad: Math.PI / 2 }), 25);
  });

  test("heel multiplier", async () => {
    const { heelMultiplier } = await physics();
    approx(heelMultiplier(0, 0.35), 1);
    approx(heelMultiplier(25, 0.35), 1 + 0.35 * Math.sin((25 * Math.PI) / 180));
  });

  test("pitch multiplier resonates at hull length and punishes steep seas", async () => {
    const { pitchMultiplier, waveLengthMeters, STEEPNESS_RATIO_THRESHOLD } =
      await physics();
    // L_wave ≈ L_wl (9.4 m) → Tp ≈ 2.45 s: full resonance term
    const resonantTp = Math.sqrt((2 * Math.PI * 9.4) / 9.81);
    const calm = { tpSeconds: 12, hsMeters: 1, waterlineLengthM: 9.4 };
    const resonant = {
      tpSeconds: resonantTp,
      hsMeters: 1,
      waterlineLengthM: 9.4,
    };
    const steep = { tpSeconds: 4, hsMeters: 2.5, waterlineLengthM: 9.4 };
    assert.ok(pitchMultiplier(resonant, 0.4) > pitchMultiplier(calm, 0.4));
    // Tp/Hs = 1.6 → steepness term (3.28 − 1.6)/3.28 plus the residual
    // resonance of the 25 m wave train
    const resonance = Math.exp(-(((waveLengthMeters(4) - 9.4) / 9.4) ** 2));
    approx(
      pitchMultiplier(steep, 0.4),
      1 +
        0.4 * resonance +
        (STEEPNESS_RATIO_THRESHOLD - 1.6) / STEEPNESS_RATIO_THRESHOLD,
      1e-9,
    );
    // Long gentle swell: essentially unity
    assert.ok(pitchMultiplier(calm, 0.4) < 1.01);
  });

  test("vertical acceleration grows with head seas and sea height", async () => {
    const { verticalAcceleration, heelAngleDeg, apparentWindSpeedKnots } =
      await physics();
    const sea = (tpSeconds, hsMeters, waveTravelDirectionRad) => ({
      tpSeconds,
      hsMeters,
      waveTravelDirectionRad,
    });
    const vessel = {
      sogKnots: 6,
      headingRad: 0,
      waterlineLengthM: 9.4,
      kHeel: 0.35,
      kPitch: 0.4,
    };
    const wind = { twsKnots: 15, twaRad: Math.PI / 2 };
    const head = verticalAcceleration(sea(7, 2, Math.PI), vessel, wind);
    const astern = verticalAcceleration(sea(7, 2, 0), vessel, wind);
    assert.ok(head.value > astern.value);
    // Proportional to Hs at fixed Te (heel/pitch identical here)
    const mild = verticalAcceleration(sea(7, 1, Math.PI), vessel, wind);
    assert.ok(Math.abs(head.value / mild.value - 2) < 0.05);
    // Calm sea: no acceleration
    approx(verticalAcceleration(sea(7, 0, 0), vessel, wind).value, 0);
    // Beam reach heel comes out of the wind vector via AWS
    const assessment = verticalAcceleration(sea(7, 2, 0), vessel, wind);
    approx(
      assessment.heelDeg,
      heelAngleDeg({
        awsKnots: apparentWindSpeedKnots({
          twsKnots: wind.twsKnots,
          stwKnots: vessel.sogKnots,
          twaRad: wind.twaRad,
        }),
        twaRad: wind.twaRad,
      }),
    );
  });
});

describe("serenoComfort", () => {
  test("the worse vector sets the level", async () => {
    const { serenoComfort } = await physics();
    const vessel = {
      sogKnots: 5,
      headingRad: 0,
      waterlineLengthM: 9.4,
      kHeel: 0.35,
      kPitch: 0.4,
    };
    // Gusty but flat: wind vector dominates (AWS ≈ 31 kt → Rough)
    const gusty = serenoComfort(
      { tpSeconds: 10, hsMeters: 0.5, waveTravelDirectionRad: 0 },
      vessel,
      { twsKnots: 26, twaRad: 0.2 },
    );
    assert.equal(gusty.comfort, "rough");
    assert.equal(gusty.motionComfort, "champagne");
    // Gentle wind but big steep head seas: motion dominates
    const rough = serenoComfort(
      { tpSeconds: 5, hsMeters: 3, waveTravelDirectionRad: 0 },
      vessel,
      { twsKnots: 6, twaRad: 0.3 },
    );
    assert.ok(
      ["rough", "sick"].includes(rough.comfort),
      `expected rough/sick, got ${rough.comfort}`,
    );
    // Champagne glass conditions: light following breeze, gentle swell
    const idyllic = serenoComfort(
      { tpSeconds: 9, hsMeters: 0.3, waveTravelDirectionRad: 0 },
      vessel,
      { twsKnots: 8, twaRad: 2.4 },
    );
    assert.equal(idyllic.comfort, "champagne");
  });
});

describe("day/night bucket", () => {
  test("sun altitude: equator equinox solar noon overhead, midnight below", async () => {
    const { sunAltitudeDeg } = await physics();
    // Solar noon at longitude 0 late March (equation of time ≈ −7 min)
    const noon = sunAltitudeDeg(new Date("2026-03-20T12:07:00Z"), 0, 0);
    approx(noon, 90, 1);
    const midnight = sunAltitudeDeg(new Date("2026-03-21T00:07:00Z"), 0, 0);
    approx(midnight, -90, 1);
  });

  test("Helsinki: midsummer noon is day, midnight is night", async () => {
    const { sunAltitudeDeg, isNight } = await physics();
    const lat = 60.17;
    const lon = 24.94;
    // Solar noon at 24.94°E in late June ≈ 10:21Z
    const noon = sunAltitudeDeg(new Date("2026-06-21T10:21:00Z"), lat, lon);
    approx(noon, 90 - lat + 23.44, 1.5);
    // Solar midnight ≈ 22:21Z
    const midnight = sunAltitudeDeg(new Date("2026-06-21T22:21:00Z"), lat, lon);
    approx(midnight, lat + 23.44 - 90, 1.5);
    assert.ok(!isNight(new Date("2026-06-21T10:21:00Z"), lat, lon));
    assert.ok(isNight(new Date("2026-06-21T22:21:00Z"), lat, lon));
    // Threshold parameterization: with a −10° threshold the Helsinki
    // midsummer midnight (sun ≈ −6.4°) is *not* night
    assert.ok(!isNight(new Date("2026-06-21T22:21:00Z"), lat, lon, -10));
  });

  test("default threshold is sunset", async () => {
    const { NIGHT_SUN_ALTITUDE_DEG } = await physics();
    assert.equal(NIGHT_SUN_ALTITUDE_DEG, 0);
  });
});

describe("suggestSailState", () => {
  const matrix = {
    twsBinsKnots: [0, 5, 10, 15, 20, 25, 30, 35, 40],
    twaBinsDegrees: [0, 30, 60, 90, 120, 150, 180],
    matrix: [
      {
        twsBin: 3,
        twaBin: 4,
        night: false,
        preferredSailState: "GENOA_1_MAIN",
        minTwsGustTrigger: 16,
        samplesCount: 2,
      },
      {
        twsBin: 3,
        twaBin: 4,
        night: true,
        preferredSailState: "STAYSAIL_MAIN_1_REEF",
        minTwsGustTrigger: 16,
        samplesCount: 3,
      },
    ],
  };

  test("picks the bin by folded TWA and day/night bucket", async () => {
    const { suggestSailState } = await physics();
    const day = suggestSailState(matrix, 16, 140, false);
    assert.equal(day.preferredSailState, "GENOA_1_MAIN");
    const night = suggestSailState(matrix, 16, 140, true);
    assert.equal(night.preferredSailState, "STAYSAIL_MAIN_1_REEF");
    // Signed TWA folds onto the magnitude range
    assert.equal(suggestSailState(matrix, 16, -220, false).twsBin, 3);
    // Unknown bin and missing matrix
    assert.equal(suggestSailState(matrix, 50, 10), null);
    assert.equal(suggestSailState(null, 16, 140), null);
  });
});

test("binIndexFor clamps to the last bin", async () => {
  const { binIndexFor } = await physics();
  assert.equal(binIndexFor(0, [0, 5, 10]), 0);
  assert.equal(binIndexFor(7, [0, 5, 10]), 1);
  assert.equal(binIndexFor(99, [0, 5, 10]), 2);
});

describe("slatting & roll-dampening penalty (work doc #14)", () => {
  test("glassy calm bypasses the penalty entirely", async () => {
    const { slattingRisk } = await physics();
    // Calm sea: no slatting regardless of wind
    assert.equal(
      slattingRisk({ hsMeters: 0.59, twsKnots: 2, twaRad: 0 }),
      false,
    );
    assert.equal(
      slattingRisk({ hsMeters: 0.3, twsKnots: 0, twaRad: 0 }),
      false,
    );
  });

  test("upwind loses dampening below 7 kn, downwind below 12 kn", async () => {
    const { slattingRisk } = await physics();
    const swell = 1.2;
    // Upwind / reaching (|TWA| < 90°)
    assert.equal(
      slattingRisk({ hsMeters: swell, twsKnots: 6.9, twaRad: 0.5 }),
      true,
    );
    assert.equal(
      slattingRisk({ hsMeters: swell, twsKnots: 7.0, twaRad: 0.5 }),
      false,
    );
    // Downwind / running (|TWA| ≥ 90°)
    assert.equal(
      slattingRisk({ hsMeters: swell, twsKnots: 11.9, twaRad: 2.5 }),
      true,
    );
    assert.equal(
      slattingRisk({ hsMeters: swell, twsKnots: 12.0, twaRad: 2.5 }),
      false,
    );
    // The ±90° boundary itself counts as downwind
    assert.equal(
      slattingRisk({ hsMeters: swell, twsKnots: 11.0, twaRad: Math.PI / 2 }),
      true,
    );
  });

  test("serenoComfort forces at least Rough and tags the hour", async () => {
    const { serenoComfort, COMFORT_TIERS, comfortSeverity } = await physics();
    const vessel = {
      sogKnots: 5,
      headingRad: 0,
      waterlineLengthM: 9.4,
      kHeel: 0.35,
      kPitch: 0.4,
    };
    // Light air upwind in a 1.2 m swell: raw motion reads calm, but
    // the snap-roll regime forces Rough and flags slatting
    const washing = serenoComfort(
      { tpSeconds: 9, hsMeters: 1.2, waveTravelDirectionRad: 0 },
      vessel,
      { twsKnots: 5, twaRad: 0.5 },
    );
    assert.equal(washing.slatting, true);
    assert.ok(
      comfortSeverity(washing.comfort) >= comfortSeverity("rough"),
      `expected at least rough, got ${washing.comfort}`,
    );
    // Champagne-ish conditions without the swell: same wind, no tag
    const glassy = serenoComfort(
      { tpSeconds: 9, hsMeters: 0.4, waveTravelDirectionRad: 0 },
      vessel,
      { twsKnots: 5, twaRad: 0.5 },
    );
    assert.equal(glassy.slatting, false);
    assert.equal(glassy.comfort, "champagne");
  });
});

describe("daylight-anchored departure (work doc #15)", () => {
  test("underway passes now through", async () => {
    const { assumedDepartureTime } = await physics();
    const now = new Date("2026-10-04T20:00:00Z"); // Night in the Gulf
    const result = assumedDepartureTime({
      now,
      lat: -21.1,
      lon: -175.2,
      underway: true,
    });
    assert.equal(result.time, now);
    assert.equal(result.reason, "underway");
  });

  test("night at the start position waits for next civil dawn", async () => {
    const { assumedDepartureTime, sunAltitudeDeg } = await physics();
    // 12:00 UTC at 175°W ≈ 23:40 local: deep night
    const now = new Date("2026-10-04T12:00:00Z");
    const result = assumedDepartureTime({
      now,
      lat: -21.1,
      lon: -175.2,
    });
    assert.ok(result.time > now, "dawn is in the future");
    assert.ok(result.time <= new Date(now.getTime() + 18 * 3600000));
    assert.equal(result.reason, "next_dawn");
    // The returned time sits just past the −6° crossing
    const alt = sunAltitudeDeg(result.time, -21.1, -175.2);
    assert.ok(alt > -6 && alt < 0, `dawn altitude ${alt}`);
  });

  test("day + prep window inside daylight: prep delay, stated as such", async () => {
    const { assumedDepartureTime } = await physics();
    // Local noon at Tonga (≈ 23:40 UTC): deep day, sun far up hours later
    const now = new Date("2026-10-04T23:00:00Z");
    const result = assumedDepartureTime({
      now,
      lat: -21.1,
      lon: -175.2,
      prepHours: 1.5,
    });
    assert.equal(result.reason, "daylight_prep");
    assert.equal(result.time.getTime(), now.getTime() + 1.5 * 3600000);
  });

  test("day but sunset inside the prep window: next dawn, never a dusk departure", async () => {
    const { assumedDepartureTime } = await physics();
    // Late afternoon with < 1.5 h of daylight left
    const { sunAltitudeDeg } = await physics();
    // Find a "day now, dusk within prep" instant: scan for one
    let chosen = null;
    for (let m = 0; m < 24 * 60; m += 5) {
      const t = new Date("2026-10-04T00:00:00Z").getTime() + m * 60000;
      const alt = sunAltitudeDeg(new Date(t), -21.1, -175.2);
      const prepAlt = sunAltitudeDeg(
        new Date(t + 1.5 * 3600000),
        -21.1,
        -175.2,
      );
      if (alt > -6 && prepAlt <= -6) {
        chosen = new Date(t);
        break;
      }
    }
    assert.ok(chosen, "fixture: found a dusk-inside-prep instant");
    const result = assumedDepartureTime({
      now: chosen,
      lat: -21.1,
      lon: -175.2,
      prepHours: 1.5,
    });
    assert.equal(result.reason, "next_dawn");
    // The dawn is the *next* morning: well beyond the prep window
    assert.ok(result.time.getTime() > chosen.getTime() + 8 * 3600000);
    assert.ok(sunAltitudeDeg(result.time, -21.1, -175.2) > -6);
  });

  test("polar night: no dawn in the bound falls back to now and says so", async () => {
    const { assumedDepartureTime } = await physics();
    // High Arctic mid-winter: the sun never rises
    const now = new Date("2026-12-21T12:00:00Z");
    const result = assumedDepartureTime({
      now,
      lat: 78,
      lon: 15,
    });
    assert.equal(result.reason, "no_dawn");
    assert.equal(result.time, now);
  });
});
