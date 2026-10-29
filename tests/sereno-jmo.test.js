const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const physicsPromise = import("../public/sereno-physics.mjs");
const physics = async () => physicsPromise;

const dB = (linear) => 20 * Math.log10(linear);

// Published ISO 2631-1 W_f 1/3-octave values (dB), as reproduced in
// Virtins' "Frequency Weightings for Sound and Vibration Perceived by
// Humans" (2024) from the ISO 8041 filter set — the same anchors the
// issue #67 analysis validated to 0.01 dB.
const WF_TABLE_DB = {
  0.1: -3.16,
  0.125: -0.96,
  0.16: 0.05,
  0.2: -0.07,
  0.25: -1.37,
  0.315: -4.17,
  0.4: -8.31,
  0.5: -13.0,
  0.63: -18.69,
  0.8: -25.51,
  1.0: -32.57,
  2.0: -56.19,
};

// A resolved test hull: 9.4 m waterline, 3.05 m beam, 0.6 m canoe
// draught, 4.2 t displacement (the plugin's default boat class)
const HULL_ARGS = {
  waterline_length_m: 9.4,
  hull_beam_m: 3.05,
  hull_canoe_draft_m: 0.6,
  hull_displacement_kg: 4200,
  hull_gm_m: 0.9,
};

describe("ISO 2631-1 W_f weighting", () => {
  test("reproduces the published 1/3-octave table to 0.01 dB", async () => {
    const { iso2631WfWeighting } = await physics();
    for (const [f, db] of Object.entries(WF_TABLE_DB)) {
      const mine = dB(iso2631WfWeighting(Number(f)));
      assert.ok(
        Math.abs(mine - db) < 0.01,
        `W_f(${f} Hz): ${mine.toFixed(3)} dB vs published ${db} dB`,
      );
    }
  });

  test("peaks near 0.2 Hz and rolls off both ways", async () => {
    const { iso2631WfWeighting } = await physics();
    const peak = iso2631WfWeighting(0.18);
    assert.ok(peak > 1.0, "peak gain above unity near the sickness band");
    assert.ok(
      iso2631WfWeighting(0.04) < 0.3,
      "very low frequencies strongly attenuated",
    );
    assert.ok(iso2631WfWeighting(1.5) < 0.05, "short chop strongly attenuated");
  });
});

describe("Pierson–Moskowitz spectrum", () => {
  test("energy period to peak period follows the PM relation", async () => {
    const { peakPeriodFromEnergyPeriod, PM_PEAK_OVER_ENERGY_PERIOD } =
      await physics();
    assert.ok(Math.abs(PM_PEAK_OVER_ENERGY_PERIOD - 1.167) < 0.001);
    // ECMWF mwp 7 s → Tp ≈ 8.17 s
    const { strictEqual } = assert;
    strictEqual(Math.round(peakPeriodFromEnergyPeriod(7) * 100) / 100, 8.17);
  });

  test("normalizes to m0 = Hs²/16", async () => {
    const { piersonMoskowitzSpectrum, peakPeriodFromEnergyPeriod } =
      await physics();
    const hs = 2;
    const tp = peakPeriodFromEnergyPeriod(8);
    let m0 = 0;
    let prevW = null;
    let prevS = null;
    for (let i = 0; i <= 2000; i++) {
      const w = 0.05 + (3.95 * i) / 2000;
      const s = piersonMoskowitzSpectrum(w, hs, tp);
      if (prevW != null) m0 += ((prevS + s) / 2) * (w - prevW);
      prevW = w;
      prevS = s;
    }
    assert.ok(
      Math.abs(m0 - (hs * hs) / 16) < 0.01 * ((hs * hs) / 16),
      `m0 ${m0.toFixed(5)} vs Hs²/16 ${((hs * hs) / 16).toFixed(5)}`,
    );
  });
});

describe("JMO hull transfer functions", () => {
  test("block coefficient is the displacement over the box", async () => {
    const { resolveHull, blockCoefficientOf } = await physics();
    const hull = resolveHull(HULL_ARGS, null);
    const cb = blockCoefficientOf(hull);
    const expected = 4200 / (9.4 * 3.05 * 0.6 * 1025);
    assert.ok(Math.abs(cb - expected) < 1e-9);
  });

  test("heave follows long waves, bridges short ones", async () => {
    const { jmoHeaveTF } = await physics();
    const speed = 4 * 0.514444;
    const head = Math.PI;
    // Long swell: the boat rides the contour (RAO → 1)
    const long = jmoHeaveTF(
      (2 * Math.PI) / 12,
      head,
      speed,
      9.4,
      3.05,
      0.6,
      0.28,
    );
    // Short chop below the waterline: bridged, not followed
    const short = jmoHeaveTF(
      (2 * Math.PI) / 2,
      head,
      speed,
      9.4,
      3.05,
      0.6,
      0.28,
    );
    assert.ok(long > 0.9, `long-wave heave RAO ${long.toFixed(3)} near unity`);
    assert.ok(
      short < 0.1,
      `short-wave heave RAO ${short.toFixed(3)} suppressed`,
    );
  });

  test("head seas meet waves faster than following seas", async () => {
    // The encounter mapping must drive the response: at the same
    // absolute frequency, head-seas transfer differs from following
    const { jmoHeaveTF } = await physics();
    const omega = 1.1;
    const head = jmoHeaveTF(omega, Math.PI, 2.5, 9.4, 3.05, 0.6, 0.28);
    const following = jmoHeaveTF(omega, 0, 2.5, 9.4, 3.05, 0.6, 0.28);
    assert.notEqual(head, following);
  });
});

describe("hull motion response", () => {
  const response = async (overrides = {}) => {
    const p = await physics();
    const hull = p.resolveHull(HULL_ARGS, null);
    return p.hullMotionResponse({
      hsMeters: 2,
      peakPeriodSeconds: p.peakPeriodFromEnergyPeriod(7),
      waveTravelDirectionRad: 0,
      headingRad: Math.PI,
      speedKnots: 5,
      hull,
      sailState: "sailing",
      ...overrides,
    });
  };

  test("calm sea gives zero motion", async () => {
    const r = await response({ hsMeters: 0 });
    assert.equal(r.azMs2, 0);
    assert.equal(r.azWeightedMs2, 0);
    assert.equal(r.rmsHeaveM, 0);
  });

  test("weighted acceleration grows with sea height", async () => {
    const r1 = await response({ hsMeters: 1 });
    const r3 = await response({ hsMeters: 3 });
    assert.ok(r3.azWeightedMs2 > r1.azWeightedMs2);
  });

  test("head seas hit harder than following seas", async () => {
    const head = await response({ headingRad: Math.PI });
    const following = await response({ headingRad: 0 });
    assert.ok(head.azWeightedMs2 > following.azWeightedMs2);
  });

  test("W_f weighting attenuates toward the raw acceleration", async () => {
    const r = await response();
    // Long-swell accelerations sit below the 0.1–0.5 Hz sickness
    // band, so the weighted value drops under the raw one
    assert.ok(r.azWeightedMs2 > 0 && r.azWeightedMs2 < r.azMs2);
  });

  test("roll needs GM or a measured period, and vanishes in pure head/following seas", async () => {
    const p = await physics();
    const full = await response({ headingRad: Math.PI / 2 });
    assert.ok(full.rmsRollDeg != null && full.rmsRollDeg > 0);
    const head = await response({ headingRad: Math.PI });
    assert.ok(Math.abs(head.rmsRollDeg) < 1e-9);
    const noGm = p.resolveHull({ ...HULL_ARGS, hull_gm_m: 0 }, null);
    const r = await p.hullMotionResponse({
      hsMeters: 2,
      peakPeriodSeconds: 8,
      waveTravelDirectionRad: 0,
      headingRad: Math.PI / 2,
      speedKnots: 5,
      hull: noGm,
      sailState: "sailing",
    });
    assert.equal(r.rmsRollDeg, null);
  });

  test("a measured roll period alone enables roll, and wins over GM", async () => {
    const p = await physics();
    // No GM, measured period: the dock roll test is enough
    const measuredOnly = p.resolveHull(
      { ...HULL_ARGS, hull_gm_m: 0, hull_roll_period_s: 4.5 },
      null,
    );
    assert.equal(p.hullRollReady(measuredOnly), true);
    const r = await p.hullMotionResponse({
      hsMeters: 2,
      peakPeriodSeconds: 8,
      waveTravelDirectionRad: 0,
      headingRad: Math.PI / 2,
      speedKnots: 5,
      hull: measuredOnly,
      sailState: "sailing",
    });
    assert.ok(r.rmsRollDeg != null && r.rmsRollDeg > 0);
    // And the measured period beats the GM-derived one: T_N from
    // GM 0.9 via the IMO factor is ~2.6 s (near the chop band), a
    // heavy full-keeler's real 4.5 s sits far off it — the responses
    // must differ
    const fromGm = await p.hullMotionResponse({
      hsMeters: 2,
      peakPeriodSeconds: 8,
      waveTravelDirectionRad: 0,
      headingRad: Math.PI / 2,
      speedKnots: 5,
      hull: p.resolveHull(HULL_ARGS, null),
      sailState: "sailing",
    });
    assert.ok(Math.abs(r.rmsRollDeg - fromGm.rmsRollDeg) > 1e-9);
  });

  test("bare pole rolls worse than a drawing mainsail", async () => {
    const sailing = await response({
      headingRad: Math.PI / 2,
      sailState: "sailing",
    });
    const bare = await response({
      headingRad: Math.PI / 2,
      sailState: "motoring",
    });
    const ratio = bare.rmsRollDeg / sailing.rmsRollDeg;
    // The damping pair is chosen for roughly doubled resonant roll
    // (PredictWind guidance); spectrum-averaged it lands lower
    assert.ok(ratio > 1.05, `bare/sailed ratio ${ratio.toFixed(2)} > 1`);
    assert.ok(ratio < 2.2, `ratio ${ratio.toFixed(2)} stays physical`);
  });

  test("beam seas roll more than quartering, which beats head", async () => {
    const beam = await response({ headingRad: Math.PI / 2 });
    const quarter = await response({ headingRad: (Math.PI * 3) / 4 });
    const head = await response({ headingRad: Math.PI });
    assert.ok(beam.rmsRollDeg > quarter.rmsRollDeg);
    assert.ok(quarter.rmsRollDeg > head.rmsRollDeg);
  });

  test("heave RMS stays inside the sea it rides", async () => {
    const r = await response();
    // The boat follows the waves at most: RMS heave under Hs
    assert.ok(r.rmsHeaveM > 0 && r.rmsHeaveM < 2);
  });
});

describe("hull resolution and guards", () => {
  test("Signal K wins; config fills the gaps; LOA is the LWL fallback", async () => {
    const { resolveHull } = await physics();
    const h = resolveHull(
      { waterline_length_m: 9.4, hull_beam_m: 3.1 },
      {
        lengthWaterlineM: 8.7,
        lengthOverallM: 9.36,
        beamM: 3.05,
        canoeDraughtM: 0.65,
        displacementKg: 4300,
      },
    );
    assert.equal(h.lengthWaterlineM, 8.7);
    assert.equal(h.beamM, 3.05);
    assert.equal(h.canoeDraughtM, 0.65);
    assert.equal(h.displacementKg, 4300);
    assert.equal(h.sources.lengthWaterlineM, "signalk");
    assert.equal(h.sources.beamM, "signalk");
    assert.equal(h.sources.canoeDraughtM, "signalk");
    assert.equal(h.sources.displacementKg, "signalk");
  });

  test("a boat that publishes only LOA still gets a length", async () => {
    const { resolveHull } = await physics();
    // Config gap-filler unset (0 = follow the boat): LOA stands in
    const h = resolveHull(
      { waterline_length_m: 0, hull_beam_m: 3.1 },
      { beamM: 3.05, lengthOverallM: 9.36 },
    );
    assert.equal(h.lengthWaterlineM, 9.36);
    assert.equal(h.sources.lengthWaterlineM, "signalk");
    // A config gap-filler still beats the LOA stand-in
    const cfgWins = resolveHull(
      { waterline_length_m: 8.2, hull_beam_m: 3.1 },
      { beamM: 3.05, lengthOverallM: 9.36 },
    );
    assert.equal(cfgWins.lengthWaterlineM, 8.2);
    assert.equal(cfgWins.sources.lengthWaterlineM, "config");
  });

  test("config fills only what Signal K does not publish", async () => {
    const { resolveHull } = await physics();
    const h = resolveHull(
      {
        waterline_length_m: 9.4,
        hull_beam_m: 3.1,
        hull_canoe_draft_m: 0.7,
        hull_displacement_kg: 4200,
      },
      { beamM: 3.05, lengthOverallM: 9.36 },
    );
    // Published beam wins over the config beam
    assert.equal(h.beamM, 3.05);
    assert.equal(h.sources.beamM, "signalk");
    // No published LWL: the waterline_length_m gap-filler applies
    assert.equal(h.lengthWaterlineM, 9.4);
    assert.equal(h.sources.lengthWaterlineM, "config");
    // Nothing published: config values carry the hour
    assert.equal(h.canoeDraughtM, 0.7);
    assert.equal(h.displacementKg, 4200);
    assert.equal(h.sources.canoeDraughtM, "config");
    assert.equal(h.sources.displacementKg, "config");
  });

  test("missing values stay missing", async () => {
    const { resolveHull, hullMotionReady } = await physics();
    const h = resolveHull(
      { waterline_length_m: 9.4 },
      {
        beamM: 3.05,
      },
    );
    assert.equal(h.displacementKg, null);
    assert.equal(h.canoeDraughtM, null);
    assert.equal(hullMotionReady(h), false);
    assert.equal(hullMotionReady(null), false);
  });

  test("incomplete hull falls back to the legacy kernel, byte-identical", async () => {
    const { serenoComfort, resolveHull } = await physics();
    const sea = { hsMeters: 2, tpSeconds: 8, waveTravelDirectionRad: 0 };
    const vessel = {
      sogKnots: 5,
      headingRad: Math.PI,
      waterlineLengthM: 9.4,
      kHeel: 0.35,
      kPitch: 0.4,
      sailState: "sailing",
    };
    const wind = { twsKnots: 10, twaRad: Math.PI };
    const legacy = serenoComfort(sea, vessel, wind);
    const partial = serenoComfort(
      sea,
      {
        ...vessel,
        hull: resolveHull({ ...HULL_ARGS, hull_displacement_kg: 0 }, null),
      },
      wind,
    );
    assert.equal(partial.acceleration.kernel, "legacy");
    assert.equal(partial.comfort, legacy.comfort);
    assert.equal(partial.acceleration.value, legacy.acceleration.value);
    assert.equal(partial.acceleration.deckWork, null);
  });

  test("a known catamaran refuses the spectral kernel", async () => {
    const { serenoComfort, resolveHull } = await physics();
    const sea = { hsMeters: 2, tpSeconds: 8, waveTravelDirectionRad: 0 };
    const vessel = {
      sogKnots: 5,
      headingRad: Math.PI,
      waterlineLengthM: 9.4,
      kHeel: 0.35,
      kPitch: 0.4,
      sailState: "sailing",
    };
    const cat = serenoComfort(
      sea,
      {
        ...vessel,
        hull: { ...resolveHull(HULL_ARGS, null), hullType: "catamaran" },
      },
      { twsKnots: 10, twaRad: Math.PI },
    );
    assert.equal(cat.acceleration.kernel, "legacy");
    assert.equal(cat.acceleration.hullMismatch, "catamaran");
  });
});

describe("deck-work verdicts", () => {
  test("PredictWind limits compose the flag", async () => {
    const {
      deckWorkOf,
      DECK_WORK_ROLL_LIMIT_DEG,
      TASKS_ACCELERATION_LIMIT_G,
      G,
    } = await physics();
    assert.equal(deckWorkOf(2, 0.1), "ok");
    assert.equal(deckWorkOf(DECK_WORK_ROLL_LIMIT_DEG + 0.1, 0.1), "roll_limit");
    assert.equal(
      deckWorkOf(2, TASKS_ACCELERATION_LIMIT_G * G + 0.01),
      "accel_limit",
    );
    assert.equal(
      deckWorkOf(
        DECK_WORK_ROLL_LIMIT_DEG + 0.1,
        TASKS_ACCELERATION_LIMIT_G * G + 0.01,
      ),
      "both_limits",
    );
  });

  test("unknown roll or acceleration yields null, never a guess", async () => {
    const { deckWorkOf } = await physics();
    assert.equal(deckWorkOf(null, 0.1), null);
    assert.equal(deckWorkOf(2, null), null);
  });
});

describe("serenoComfort with the hull kernel", () => {
  test("spectral kernel runs and carries its provenance", async () => {
    const { serenoComfort, resolveHull } = await physics();
    const hull = resolveHull(HULL_ARGS, null);
    const comfort = serenoComfort(
      { hsMeters: 2, tpSeconds: 8.17, waveTravelDirectionRad: 0 },
      {
        sogKnots: 5,
        headingRad: Math.PI / 2,
        waterlineLengthM: 9.4,
        kHeel: 0.35,
        kPitch: 0.4,
        sailState: "sailing",
        hull,
      },
      { twsKnots: 10, twaRad: Math.PI },
    );
    assert.equal(comfort.acceleration.kernel, "jmo");
    assert.ok(comfort.acceleration.value > 0);
    assert.ok(comfort.acceleration.rmsRollDeg > 0);
    assert.ok(comfort.acceleration.deckWork != null);
  });

  test("slatting penalty still forces Rough with the hull kernel", async () => {
    const { serenoComfort, resolveHull } = await physics();
    const hull = resolveHull(HULL_ARGS, null);
    // Light air, head swell, motoring: the slatting regime
    const comfort = serenoComfort(
      { hsMeters: 1.2, tpSeconds: 6, waveTravelDirectionRad: 0 },
      {
        sogKnots: 2,
        headingRad: Math.PI,
        waterlineLengthM: 9.4,
        kHeel: 0.35,
        kPitch: 0.4,
        sailState: "motoring",
        hull,
      },
      { twsKnots: 4, twaRad: Math.PI / 2 },
    );
    assert.equal(comfort.slatting, true);
    assert.equal(comfort.comfort, "rough");
  });

  test("calm sea rides the legacy path even with a hull", async () => {
    const { serenoComfort, resolveHull } = await physics();
    const hull = resolveHull(HULL_ARGS, null);
    const comfort = serenoComfort(
      { hsMeters: 0, tpSeconds: 8, waveTravelDirectionRad: 0 },
      {
        sogKnots: 0,
        headingRad: 0,
        waterlineLengthM: 9.4,
        kHeel: 0.35,
        kPitch: 0.4,
        sailState: "sailing",
        hull,
      },
      { twsKnots: 3, twaRad: 0 },
    );
    assert.equal(comfort.acceleration.kernel, "legacy");
    assert.equal(comfort.comfort, "champagne");
  });
});

describe("route-sim hull plumbing", () => {
  test("SIMULATION_DEFAULTS carry the follow-Signal-K hull fields", async () => {
    const routeSim = import("../public/route-sim.mjs");
    const [p, rs] = await Promise.all([physics(), routeSim]);
    assert.equal(typeof p.resolveHull, "function");
    // Zeros and the empty string mean "the boat's own design.* wins;
    // leave missing when neither source has it"
    assert.equal(rs.SIMULATION_DEFAULTS.hull_beam_m, 0);
    assert.equal(rs.SIMULATION_DEFAULTS.hull_displacement_kg, 0);
    assert.equal(rs.SIMULATION_DEFAULTS.hull_gm_m, 0);
    assert.equal(rs.SIMULATION_DEFAULTS.hull_type, "");
  });
});
