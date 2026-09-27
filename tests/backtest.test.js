/**
 * Unit tests for the backtest & calibration engine (SPEC §7):
 * history parsing, measured acceleration reconstruction, the
 * Nelder-Mead optimizer, parameter recovery on synthetic data, and
 * the comfort confusion matrix.
 *
 * @file backtest.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSamples,
  cellNumber,
  confusionMatrix,
  evaluationPoints,
  lossAt,
  measuredAz,
  nelderMead,
  parseColumns,
  predictedAzAt,
  queryHistoryValues,
  runBacktest,
  trueFromApparent,
  variance,
  waveFromWind,
} = require("../plugin/backtest.js");

const approx = (actual, expected, epsilon = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} ≈ ${expected} (±${epsilon})`,
  );

// --- History parsing ------------------------------------------------------

const HISTORY_RESPONSE = {
  values: [
    { path: "navigation.attitude.roll", method: "average" },
    { path: "navigation.attitude.pitch", method: "average" },
    { path: "environment.wind.speedApparent", method: "average" },
    { path: "environment.water.wave.height", method: "average" },
  ],
  data: [
    ["2026-08-01T00:00:00.000Z", 0.05, 0.02, 6.0, 1.2],
    ["2026-08-01T00:00:10.000Z", 0.06, null, 6.2, 1.2],
    ["2026-08-01T00:00:20.000Z", { value: 0.07 }, 0.03, null, null],
  ],
};

test("parseColumns maps bare paths to column indexes", () => {
  const columns = parseColumns(HISTORY_RESPONSE);
  assert.equal(columns.get("navigation.attitude.roll"), 0);
  assert.equal(columns.get("environment.water.wave.height"), 3);
  assert.equal(columns.size, 4);
});

test("cellNumber reads scalars and {value} wrappers, skips nulls", () => {
  const row = HISTORY_RESPONSE.data[2];
  assert.equal(cellNumber(row, 0), 0.07);
  assert.equal(cellNumber(row, 2), null);
  assert.equal(cellNumber(row, null), null);
});

test("buildSamples merges components, keeps SI speed in knots", () => {
  const samples = buildSamples(HISTORY_RESPONSE);
  assert.equal(samples.length, 3);
  assert.equal(samples[0].stwKnots, null); // Not queried
  assert.equal(samples[0].hsMeters, 1.2);
  assert.equal(samples[1].pitchRad, null); // Gap tolerated
  approx(samples[2].rollRad, 0.07);
});

// --- Physics helpers --------------------------------------------------------

test("trueFromApparent: dead-ahead wind loses the boat speed", () => {
  // Boat 5 kn north, 10 kn wind dead ahead (awa 0): TW = 5 kn from ahead
  const tw = trueFromApparent({
    awsKnots: 10,
    awaRad: 0,
    stwKnots: 5,
    headingRad: 0,
  });
  approx(tw.twsKnots, 5, 1e-9);
  approx(tw.twaRad, 0, 1e-9);
});

test("waveFromWind follows the Pierson-Moskowitz relations", () => {
  const waves = waveFromWind(20); // 20 kn ≈ 10.29 m/s
  approx(waves.hsMeters, 0.0246 * 10.28888 ** 2, 1e-3);
  approx(waves.tpSeconds, 0.725 * 10.28888, 1e-3);
});

// --- Measured acceleration ---------------------------------------------------

test("measuredAz matches the analytic sinusoid value", () => {
  // roll = A·sin(2π t/T), 1 s uniform sampling. The uniform central
  // second difference of a sinusoid is closed-form: it scales the
  // amplitude by 2(1−cos h) (h = ω·dt) rather than h² — exact for
  // quadratics, slightly under for sinusoids. Compute both variance
  // components analytically over the same point sets the
  // implementation uses (interior points only).
  const amplitude = 0.1; // rad
  const period = 10; // s
  const omega = (2 * Math.PI) / period;
  const h = omega; // dt = 1 s
  const gain = 2 * (1 - Math.cos(h)); // discrete ≈ h² but not equal
  const samples = Array.from({ length: 41 }, (_, i) => ({
    tMs: i * 1000,
    rollRad: amplitude * Math.sin(omega * i),
    pitchRad: 0,
  }));
  const rollAcc = [];
  for (let i = 1; i < 40; i++) {
    rollAcc.push(-gain * amplitude * Math.sin(omega * i) * 1.5);
  }
  const expected = Math.sqrt(
    variance(rollAcc) +
      9.81 *
        9.81 *
        variance(samples.slice(1, 40).map((s) => Math.sin(s.rollRad))),
  );
  approx(measuredAz(samples), expected, 1e-9);
});

test("measuredAz tolerates gaps but not empty attitude", () => {
  assert.equal(measuredAz([]), null);
  assert.equal(
    measuredAz([
      { tMs: 0, rollRad: 0.1, pitchRad: 0 },
      { tMs: 1000, rollRad: 0.2, pitchRad: 0 },
    ]),
    null,
  );
  // A single null sample only removes the triplets through it
  const gapped = Array.from({ length: 10 }, (_, i) => ({
    tMs: i * 1000,
    rollRad: i === 5 ? null : 0.1 * Math.sin(i),
    pitchRad: 0.05 * Math.sin(i),
  }));
  const az = measuredAz(gapped);
  assert.ok(az != null && Number.isFinite(az));

  // Almost no attitude: fewer than two usable triplets → null
  const sparse = Array.from({ length: 10 }, (_, i) => ({
    tMs: i * 1000,
    rollRad: i === 3 || i === 6 ? 0.1 : null,
    pitchRad: null,
  }));
  assert.equal(measuredAz(sparse), null);
});

// --- Optimizer ---------------------------------------------------------------

test("nelderMead minimizes a convex quadratic", () => {
  const result = nelderMead(([x, y]) => (x - 3) ** 2 + (y + 1) ** 2, [0, 0]);
  approx(result.x[0], 3, 1e-3);
  approx(result.x[1], -1, 1e-3);
  assert.ok(result.f < 1e-5);
});

test("lossAt rejects invalid candidates with Infinity", () => {
  const points = [
    { measuredAz: 1, base: 1, sinHeel: 0.5, resonance: 0.2, steepness: 0.1 },
  ];
  assert.equal(lossAt(points, -0.1, 0.4), Infinity);
  assert.equal(lossAt(points, 0.35, 3), Infinity);
  assert.equal(lossAt([], 0.35, 0.4), Infinity);
});

test("evaluationPoints invariants reproduce the physics at any k", async () => {
  const physics = await import("../public/sereno-physics.mjs");
  // A steady-condition sample series: 15 min at 10 s resolution
  const samples = Array.from({ length: 90 }, (_, i) => ({
    tMs: Date.parse("2026-08-01T00:00:00Z") + i * 10000,
    rollRad: 0.05 * Math.sin(i / 3),
    pitchRad: 0.02 * Math.sin(i / 2),
    stwKnots: 5,
    headingRad: 0,
    awsKnots: 20,
    awaRad: Math.PI / 2,
    hsMeters: 2,
    tpSeconds: 7,
    waveTravelRad: Math.PI,
  }));
  const points = await evaluationPoints(samples, { windowMinutes: 15 });
  assert.equal(points.length, 1);
  const point = points[0];

  for (const [kHeel, kPitch] of [
    [0, 0],
    [0.35, 0.4],
    [0.9, 1.2],
  ]) {
    const viaInvariant = predictedAzAt(point, kHeel, kPitch);
    const direct = physics.verticalAcceleration(
      {
        hsMeters: 2,
        tpSeconds: 7,
        waveTravelDirectionRad: Math.PI,
      },
      {
        sogKnots: 5,
        headingRad: 0,
        waterlineLengthM: 9.4,
        kHeel,
        kPitch,
      },
      // tws/twa from apparent: boat 5 kn, aws 20 kn, awa 90°
      trueFromApparent({
        awsKnots: 20,
        awaRad: Math.PI / 2,
        stwKnots: 5,
        headingRad: 0,
      }),
    ).value;
    approx(viaInvariant, direct, 1e-9);
  }
});

// --- Calibration recovery ------------------------------------------------------

/**
 * Synthetic evaluation points generated from the model at known
 * multipliers: measuredAz is the model value at the TRUE constants
 * (the fiction under test: perfect boat), spread across seas and
 * wind angles.
 */
function syntheticPoints(kHeel, kPitch, noise = 0) {
  const points = [];
  for (let i = 0; i < 40; i++) {
    const hs = 0.8 + (i % 8) * 0.25;
    const tp = 5 + (i % 6) * 1.2;
    const aws = 8 + (i % 10) * 1.8;
    const twa = ((i % 12) - 6) * 0.35;
    const base = ((4 * Math.PI * Math.PI) / (tp * tp)) * (hs / 2) * 0.8; // head-ish seas
    const heelDeg = Math.min(25, 25 * (aws / 25) * Math.abs(Math.sin(twa)));
    const sinHeel = Math.abs(Math.sin((heelDeg * Math.PI) / 180));
    const wavelength = 1.56 * tp * tp; // Deep water λ ≈ 1.56·Tp²
    const resonance = Math.exp(-(((wavelength - 9.4) / 9.4) ** 2));
    const ratio = tp / hs;
    const steepness = Math.max(0, (3.28 - ratio) / 3.28);
    const trueAz =
      base * (1 + kHeel * sinHeel) * (1 + kPitch * resonance + steepness);
    points.push({
      tMs: i * 3600000,
      measuredAz: trueAz * (1 + noise * Math.sin(i * 7.3)),
      base,
      sinHeel,
      resonance,
      steepness,
    });
  }
  return points;
}

test("calibration recovers the generating constants from clean data", async () => {
  const K_HEEL = 0.35;
  const K_PITCH = 0.4;
  const points = syntheticPoints(K_HEEL, K_PITCH);
  const start = lossAt(points, 0.2, 0.6);
  const optimized = nelderMead(
    ([heel, pitch]) => lossAt(points, heel, pitch),
    [0.2, 0.6],
  );
  assert.ok(start > optimized.f, "optimizer improves the loss");
  approx(optimized.x[0], K_HEEL, 1e-3);
  approx(optimized.x[1], K_PITCH, 1e-3);
});

test("confusion matrix is 5×5 and mostly diagonal on clean data", async () => {
  const points = syntheticPoints(0.35, 0.4);
  const { tiers, matrix } = await confusionMatrix(points, 0.35, 0.4);
  assert.equal(tiers.length, 5);
  assert.equal(matrix.length, 5);
  for (const row of matrix) {
    assert.equal(row.length, 5);
  }
  const total = matrix.flat().reduce((a, b) => a + b, 0);
  assert.equal(total, points.length);
  const diagonal = matrix.reduce((acc, row, i) => acc + row[i], 0);
  assert.ok(diagonal / total > 0.8, `diagonal dominance ${diagonal}/${total}`);
});

// --- Orchestration -------------------------------------------------------------

/**
 * Builds a mock `/values` response covering `hours` with a sinusoidal
 * roll/pitch and steady wind — enough for a couple of windows.
 */
function mockHistoryChunk(fromIso, hours) {
  const rows = [];
  const start = Date.parse(fromIso);
  for (let i = 0; i < hours * 900; i++) {
    const t = start + i * 4000; // 4 s resolution
    const phase = (2 * Math.PI * (i * 4)) / 9;
    rows.push([
      new Date(t).toISOString(),
      0.08 * Math.sin(phase), // roll
      0.03 * Math.sin(phase * 1.5), // pitch
      3.0, // STW m/s
      0, // heading true rad
      8.0, // AWS m/s
      1.0, // AWA rad
      1.5, // wave height
      8.0, // wave period
      0, // wave direction
      null,
      null,
    ]);
  }
  return {
    values: [
      { path: "navigation.attitude.roll", method: "average" },
      { path: "navigation.attitude.pitch", method: "average" },
      { path: "navigation.speedThroughWater", method: "average" },
      { path: "navigation.headingTrue", method: "average" },
      { path: "environment.wind.speedApparent", method: "average" },
      { path: "environment.wind.angleApparent", method: "average" },
      { path: "environment.water.wave.height", method: "average" },
      { path: "environment.water.wave.period", method: "average" },
      { path: "environment.water.wave.directionTrue", method: "average" },
      { path: "environment.water.swell.height", method: "average" },
      { path: "environment.water.swell.period", method: "average" },
    ],
    data: rows,
  };
}

test("queryHistoryValues requests the attitude component paths", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      json: async () => ({ values: [], data: [] }),
    };
  };
  await queryHistoryValues({
    baseUrl: "http://sk:3000",
    from: new Date("2026-08-01T00:00:00Z"),
    to: new Date("2026-08-01T01:00:00Z"),
    resolution: 10,
    fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("/signalk/v2/api/history/values"));
  assert.ok(
    calls[0].includes(encodeURIComponent("navigation.attitude.roll:average")),
  );
  assert.ok(calls[0].includes("resolution=10"));
});

test("runBacktest end-to-end on a mocked server", async () => {
  const from = new Date("2026-08-01T00:00:00Z");
  const to = new Date("2026-08-01T02:00:00Z");
  const fetchImpl = async (url) => {
    const target = new URL(url);
    const chunkFrom = target.searchParams.get("from");
    return {
      ok: true,
      json: async () => mockHistoryChunk(chunkFrom, 2),
    };
  };
  const report = await runBacktest({
    baseUrl: "http://sk:3000",
    from,
    to,
    options: { chunkHours: 1, windowMinutes: 15 },
    fetchImpl,
  });
  assert.equal(report.samples > 0, true);
  assert.ok(report.windowsEvaluated >= 2, "windows evaluated");
  assert.ok(report.tuned.kHeel >= 0 && report.tuned.kPitch >= 0);
  assert.ok(report.tuned.mae != null && Number.isFinite(report.tuned.mae));
  assert.equal(report.confusionMatrix.tiers.length, 5);
});

// --- CLI end-to-end ------------------------------------------------------------

test("backtest CLI runs against a local history server", async () => {
  const { parseArgs, renderMatrix } = require("../bin/backtest-cli.js");
  const { spawn } = require("node:child_process");
  const http = require("node:http");
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const { readFileSync, existsSync } = require("node:fs");

  // Argument parsing
  const args = parseArgs([
    "--history-url",
    "http://localhost:3000",
    "--start",
    "2026-08-01T00:00:00Z",
    "--end",
    "2026-08-03T12:00:00Z",
    "--output",
    "./x.json",
  ]);
  assert.equal(args["history-url"], "http://localhost:3000");
  assert.equal(args.end, "2026-08-03T12:00:00Z");

  // Matrix rendering
  const rendered = renderMatrix({
    tiers: ["champagne", "easy", "coffee", "rough", "sick"],
    matrix: [
      [3, 1, 0, 0, 0],
      [0, 4, 0, 0, 0],
      [0, 0, 2, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ],
  });
  assert.match(rendered, /champagne/);
  assert.match(rendered, /pred\\/);

  // Full run against a local HTTP mock
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const body = mockHistoryChunk(url.searchParams.get("from"), 2);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const out = join(mkdtempSync(join(tmpdir(), "backtest-cli-")), "report.json");
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [
        "bin/backtest-cli.js",
        "--history-url",
        `http://127.0.0.1:${port}`,
        "--start",
        "2026-08-01T00:00:00Z",
        "--end",
        "2026-08-01T03:00:00Z",
        "--output",
        out,
      ]);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const killer = setTimeout(() => child.kill(), 60000);
      child.on("close", (status) => {
        clearTimeout(killer);
        resolve({ status, stdout, stderr });
      });
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(out));
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.ok(report.windowsEvaluated >= 2);
    assert.equal(report.confusionMatrix.tiers.length, 5);
    assert.match(result.stdout, /champagne/);
  } finally {
    server.close();
  }
});
