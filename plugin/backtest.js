/**
 * Backtest & calibration engine (SPEC §7).
 *
 * Replays the vessel's own history through the Sereno motion model:
 * attitude telemetry (roll, pitch) is reconstructed into a measured
 * RMS vertical acceleration per sliding window, the model's predicted
 * acceleration is computed for the same windows, and a Nelder-Mead
 * simplex tunes (k_heel, k_pitch) to minimize the mean absolute
 * error. A 5×5 confusion matrix compares the predicted vs measured
 * Sereno comfort tiers at the tuned parameters.
 *
 * History contract (matches the signalk-polar-tools replays and the
 * server's History API):
 *
 * - `GET /signalk/v2/api/history/values?paths=&from=&to=&resolution=`
 *   replies `{values: [{path, method}], data: [[ts, cell, ...]]}` in
 *   request column order; `null` cells mean no data in the bucket.
 * - `navigation.attitude` is only recorded as its component paths
 *   (`navigation.attitude.roll` / `.pitch`), so those are queried
 *   directly, with `:average` methods on numeric paths.
 * - Stored resolution is ~10 s on this installation, not the SPEC's
 *   aspirational 1 Hz: the discrete second derivative uses the actual
 *   sample spacing, so coarser history just attenuates the high
 *   frequency content (reported as `resolutionSeconds`).
 *
 * When no wave height/period history exists (common), the sea state
 * is approximated from apparent wind with the fully-developed
 * Pierson-Moskowitz relations (hs = 0.0246·U², tp = 0.725·U) —
 * documented pessimism for a wind-driven sea, not a swell claim.
 *
 * Pure logic plus one injectable `fetchImpl` — unit-testable without
 * a server.
 *
 * @file backtest.js
 */

/** History paths queried for a backtest run, with column methods. */
const HISTORY_PATHS = [
  "navigation.attitude.roll:average",
  "navigation.attitude.pitch:average",
  "navigation.speedThroughWater:average",
  "navigation.headingTrue:average",
  "environment.wind.speedApparent:average",
  "environment.wind.angleApparent:average",
  "environment.water.wave.height:average",
  "environment.water.wave.period:average",
  "environment.water.wave.directionTrue:average",
  "environment.water.swell.height:average",
  "environment.water.swell.period:average",
];

/** Default history resolution (seconds): what this server stores. */
const DEFAULT_RESOLUTION_SECONDS = 10;

/** Minimum samples in a window for a usable second derivative. */
const MIN_WINDOW_SAMPLES = 4;

/** Default waterline length (m) — Lille Ø, matches plugin defaults. */
const DEFAULT_WATERLINE_M = 9.4;

const KN_TO_MS = 0.514444;

let physicsModule = null;

/**
 * Loads the shared physics module (ESM in `public/`, consumed from
 * CJS via dynamic import — same pattern as the history backfill).
 *
 * @returns {Promise<object>} sereno-physics module
 */
async function loadPhysics() {
  if (!physicsModule) {
    physicsModule = await import("../public/sereno-physics.mjs");
  }
  return physicsModule;
}

/**
 * Parses a `/values` response into a Map of bare path → column index.
 * The API reports each column's method in `values[].method`, stripped
 * from `values[].path`.
 *
 * @param {object} historyData - History API `/values` response
 * @returns {Map<string, number>} Bare path → column index (0-based
 *   within the row, the timestamp being column −1)
 */
function parseColumns(historyData) {
  const columns = new Map();
  (historyData?.values ?? []).forEach((spec, index) => {
    if (spec?.path) {
      columns.set(String(spec.path), index);
    }
  });
  return columns;
}

/**
 * Reads one numeric cell from a data row. The timestamp occupies
 * `row[0]`; the queried columns start at `row[1]` (the same
 * `row[col + 1]` offset as the replay tools).
 *
 * @param {Array} row - `[timestamp, cell0, ...]`
 * @param {number|null} column - Column index, null when unqueried
 * @returns {number|null}
 */
function cellNumber(row, column) {
  if (column == null || !Array.isArray(row)) {
    return null;
  }
  const raw = row[column + 1];
  if (raw == null) {
    return null;
  }
  const value =
    typeof raw === "object" && !Array.isArray(raw) ? raw.value : raw;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Merges the queried history into a chronological sample series.
 * Missing values stay null — later steps tolerate gaps.
 *
 * @param {object} historyData - History API `/values` response
 * @returns {Array<{tMs: number, rollRad: number|null, pitchRad: number|null,
 *   stwKnots: number|null, headingRad: number|null, awsKnots: number|null,
 *   awaRad: number|null, hsMeters: number|null, tpSeconds: number|null,
 *   waveTravelRad: number|null}>}
 */
function buildSamples(historyData) {
  const columns = parseColumns(historyData);
  const col = (path) => columns.get(path) ?? null;
  const rollC = col("navigation.attitude.roll");
  const pitchC = col("navigation.attitude.pitch");
  const stwC = col("navigation.speedThroughWater");
  const headingC = col("navigation.headingTrue");
  const awsC = col("environment.wind.speedApparent");
  const awaC = col("environment.wind.angleApparent");
  const waveH = col("environment.water.wave.height");
  const waveP = col("environment.water.wave.period");
  const waveD = col("environment.water.wave.directionTrue");
  const swellH = col("environment.water.swell.height");
  const swellP = col("environment.water.swell.period");

  const samples = [];
  for (const row of historyData?.data ?? []) {
    if (!Array.isArray(row) || row.length < 2) {
      continue;
    }
    const tMs = Date.parse(row[0]);
    if (Number.isNaN(tMs)) {
      continue;
    }
    const waveHeight = cellNumber(row, waveH);
    const swellHeight = cellNumber(row, swellH);
    const hs =
      waveHeight != null
        ? waveHeight
        : swellHeight != null
          ? Math.max(swellHeight, 0.3) // wind sea floor when only swell logged
          : null;
    const wavePeriod = cellNumber(row, waveP);
    const swellPeriod = cellNumber(row, swellP);
    const stwMs = cellNumber(row, stwC);
    const awsMs = cellNumber(row, awsC);
    samples.push({
      tMs,
      rollRad: cellNumber(row, rollC),
      pitchRad: cellNumber(row, pitchC),
      stwKnots: stwMs == null ? null : stwMs / KN_TO_MS,
      headingRad: cellNumber(row, headingC),
      // History stores SI (m/s); the model works in knots
      awsKnots: awsMs == null ? null : awsMs / KN_TO_MS,
      awaRad: cellNumber(row, awaC),
      hsMeters: hs,
      tpSeconds: wavePeriod ?? swellPeriod,
      waveTravelRad: cellNumber(row, waveD),
    });
  }
  return samples;
}

/**
 * Converts apparent wind over deck into true wind, given the boat's
 * speed through water and heading (no-leeway approximation).
 *
 * @param {object} params
 * @param {number} params.awsKnots - Apparent wind speed (kn)
 * @param {number} params.awaRad - Apparent wind angle (rad, signed,
 *   from the bow)
 * @param {number} params.stwKnots - Speed through water (kn)
 * @param {number} params.headingRad - Heading (rad, true)
 * @returns {{twsKnots: number, twaRad: number}} True wind (kn, rad
 *   signed from the bow)
 */
function trueFromApparent({ awsKnots, awaRad, stwKnots, headingRad }) {
  const appN = awsKnots * Math.cos(headingRad + awaRad);
  const appE = awsKnots * Math.sin(headingRad + awaRad);
  const boatN = stwKnots * Math.cos(headingRad);
  const boatE = stwKnots * Math.sin(headingRad);
  const trueN = appN - boatN;
  const trueE = appE - boatE;
  const tws = Math.hypot(trueN, trueE);
  let twa = Math.atan2(trueE, trueN) - headingRad;
  if (twa > Math.PI) {
    twa -= 2 * Math.PI;
  } else if (twa < -Math.PI) {
    twa += 2 * Math.PI;
  }
  return { twsKnots: tws, twaRad: twa };
}

/**
 * Approximates the sea state from apparent wind when the history has
 * no wave recordings: fully-developed Pierson-Moskowitz relations
 * (Carter): hs = 0.0246·U10², tp = 0.725·U10 (U10 in m/s). Waves
 * assumed to oppose the apparent wind direction (wind sea).
 *
 * @param {number} awsKnots
 * @returns {{hsMeters: number, tpSeconds: number}}
 */
function waveFromWind(awsKnots) {
  const u10 = awsKnots * KN_TO_MS;
  return {
    hsMeters: 0.0246 * u10 * u10,
    tpSeconds: 0.725 * u10,
  };
}

/**
 * Population variance.
 *
 * @param {number[]} values
 * @returns {number}
 */
function variance(values) {
  if (values.length < 2) {
    return 0;
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return (
    values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / values.length
  );
}

/**
 * Reconstructs the measured RMS vertical acceleration over a sliding
 * window of attitude samples (SPEC §7.2 step 2):
 *
 *   a_z = sqrt( Var(3.5·d²pitch/dt²) + Var(1.5·d²roll/dt²)
 *               + g²·Var(sin roll) )
 *
 * Second derivatives use central differences with the samples' actual
 * time spacing (history resolution is coarser than the SPEC's 1 Hz).
 *
 * @param {Array<{tMs: number, rollRad: number|null, pitchRad: number|null}>|
 *   null} windowSamples - Chronological samples inside the window
 * @param {object} [params]
 * @param {number} [params.pitchArmM=3.5] - Pitch lever arm from the
 *   pivot point
 * @param {number} [params.rollArmM=1.5] - Roll lever arm
 * @param {number} [params.g=9.81]
 * @returns {number|null} Measured a_z (m/s²), null when too few
 *   attitude samples
 */
function measuredAz(
  windowSamples,
  { pitchArmM = 3.5, rollArmM = 1.5, g = 9.81 } = {},
) {
  if (!windowSamples || windowSamples.length < MIN_WINDOW_SAMPLES) {
    return null;
  }
  const pitchAcc = [];
  const rollAcc = [];
  const sinRoll = [];
  for (let i = 1; i < windowSamples.length - 1; i++) {
    const prev = windowSamples[i - 1];
    const cur = windowSamples[i];
    const next = windowSamples[i + 1];
    if (
      cur.rollRad == null ||
      cur.pitchRad == null ||
      prev.rollRad == null ||
      prev.pitchRad == null ||
      next.rollRad == null ||
      next.pitchRad == null
    ) {
      continue;
    }
    const dtPrev = (cur.tMs - prev.tMs) / 1000;
    const dtNext = (next.tMs - cur.tMs) / 1000;
    if (!(dtPrev > 0) || !(dtNext > 0)) {
      continue;
    }
    // Central second difference (handles the uneven spacing that gaps
    // in the history leave behind):
    //   d2v/dt2 ≈ 2·[(v2−v1)/dtNext − (v1−v0)/dtPrev] / (dtPrev+dtNext)
    const d2 = (v0, v1, v2) =>
      (2 * ((v2 - v1) / dtNext - (v1 - v0) / dtPrev)) / (dtPrev + dtNext);
    pitchAcc.push(pitchArmM * d2(prev.pitchRad, cur.pitchRad, next.pitchRad));
    rollAcc.push(rollArmM * d2(prev.rollRad, cur.rollRad, next.rollRad));
    sinRoll.push(Math.sin(cur.rollRad));
  }
  if (pitchAcc.length < MIN_WINDOW_SAMPLES - 2) {
    return null;
  }
  const az = Math.sqrt(
    variance(pitchAcc) + variance(rollAcc) + g * g * variance(sinRoll),
  );
  return Number.isFinite(az) ? az : null;
}

/**
 * Slides a window across the samples and evaluates the measured
 * acceleration (from attitude) plus the model invariants needed to
 * predict it. Windows overlap by half their span.
 *
 * The k multipliers only enter the model multiplicatively:
 *
 *   a_z(k) = base · (1 + k_heel·|sin(heelDeg)|) ·
 *            (1 + k_pitch·resonance + steepness)
 *
 * so each window stores the k-independent invariants and
 * {@link predictedAzAt} evaluates any candidate in closed form —
 * no physics calls inside the optimizer loop.
 *
 * A window yields an evaluation point only when the attitude
 * reconstruction works AND the window carries enough context (wind +
 * heading) for the model.
 *
 * @param {object[]} samples - Full sample series
 * @param {object} [params]
 * @param {number} [params.windowMinutes=15] - SPEC §7.2 window span
 * @param {number} [params.waterlineLengthM] - Vessel waterline (m)
 * @param {number} [params.g] - Gravity override for the measured side
 * @returns {Promise<Array<{tMs: number, measuredAz: number, base: number,
 *   sinHeel: number, resonance: number, steepness: number}>>}
 */
async function evaluationPoints(
  samples,
  { windowMinutes = 15, waterlineLengthM = DEFAULT_WATERLINE_M, g } = {},
) {
  const physics = await loadPhysics();
  const windowMs = windowMinutes * 60000;
  const stepMs = windowMs / 2;
  const points = [];
  if (samples.length === 0) {
    return points;
  }
  const start = samples[0].tMs;
  const end = samples[samples.length - 1].tMs;
  for (let t = start; t + windowMs / 2 <= end; t += stepMs) {
    const inWindow = samples.filter((s) => s.tMs >= t && s.tMs < t + windowMs);
    const measured = measuredAz(inWindow, { g });
    if (measured == null) {
      continue;
    }
    // Model state: mid-window sample; wave data from the recording
    // when present, PM approximation otherwise
    const mid = inWindow[Math.floor(inWindow.length / 2)];
    if (mid.awsKnots == null || mid.awaRad == null || mid.headingRad == null) {
      continue;
    }
    const stw = mid.stwKnots ?? 0;
    const { twsKnots, twaRad } = trueFromApparent({
      awsKnots: mid.awsKnots,
      awaRad: mid.awaRad,
      stwKnots: stw,
      headingRad: mid.headingRad,
    });
    const waves =
      mid.hsMeters != null && mid.tpSeconds != null
        ? { hsMeters: mid.hsMeters, tpSeconds: mid.tpSeconds }
        : waveFromWind(mid.awsKnots);
    // Unrecorded wave direction: assume wind sea running against the
    // apparent wind
    const waveTravelRad =
      mid.waveTravelRad ??
      (mid.headingRad + mid.awaRad + Math.PI) % (2 * Math.PI);

    // Model invariants (k-independent parts of the §5.2 breakdown)
    const awsKnots = physics.apparentWindSpeedKnots({
      twsKnots,
      stwKnots: stw,
      twaRad,
    });
    const heelDeg = physics.heelAngleDeg({ awsKnots, twaRad });
    const base = physics.verticalAcceleration(
      {
        hsMeters: waves.hsMeters,
        tpSeconds: waves.tpSeconds,
        waveTravelDirectionRad: waveTravelRad,
      },
      {
        sogKnots: stw,
        headingRad: mid.headingRad,
        waterlineLengthM,
        kHeel: 0,
        kPitch: 0,
      },
      { twsKnots, twaRad },
    ).base;
    const wavelength = physics.waveLengthMeters(waves.tpSeconds);
    const resonance = Math.exp(
      -(((wavelength - waterlineLengthM) / waterlineLengthM) ** 2),
    );
    const ratio =
      waves.hsMeters > 0 ? waves.tpSeconds / waves.hsMeters : Infinity;
    const steepness = Math.max(
      0,
      (physics.STEEPNESS_RATIO_THRESHOLD - ratio) /
        physics.STEEPNESS_RATIO_THRESHOLD,
    );
    points.push({
      tMs: t + windowMs / 2,
      measuredAz: measured,
      base,
      sinHeel: Math.abs(Math.sin((heelDeg * Math.PI) / 180)),
      resonance,
      steepness,
    });
  }
  return points;
}

/**
 * Model prediction for an evaluation point at candidate multipliers.
 *
 * @param {{base: number, sinHeel: number, resonance: number, steepness: number}} point
 * @param {number} kHeel
 * @param {number} kPitch
 * @returns {number} Predicted RMS vertical acceleration (m/s²)
 */
function predictedAzAt(point, kHeel, kPitch) {
  return (
    point.base *
    (1 + kHeel * point.sinHeel) *
    (1 + kPitch * point.resonance + point.steepness)
  );
}

/**
 * Loss function (SPEC §7.2 step 3): mean absolute error between
 * predicted and measured a_z across all evaluation points. Negative
 * or oversized candidates are rejected with Infinity — the physics
 * expects multipliers in [0, 2].
 *
 * @param {Array<{measuredAz: number}>} points
 * @param {number} kHeel
 * @param {number} kPitch
 * @returns {number} MAE (m/s²), or Infinity for invalid candidates
 */
function lossAt(points, kHeel, kPitch) {
  if (!(kHeel >= 0) || !(kPitch >= 0) || kHeel > 2 || kPitch > 2) {
    return Infinity;
  }
  if (points.length === 0) {
    return Infinity;
  }
  let total = 0;
  for (const point of points) {
    total += Math.abs(predictedAzAt(point, kHeel, kPitch) - point.measuredAz);
  }
  return total / points.length;
}

/**
 * Nelder-Mead simplex minimizer (SPEC §7.2 step 4). Standard
 * coefficients (reflection 1, expansion 2, contraction 0.5, shrink
 * 0.5) on a 2-parameter simplex.
 *
 * @param {(x: [number, number]) => number} f - Objective (returns Infinity
 *   for invalid regions)
 * @param {[number, number]} x0 - Starting point
 * @param {object} [opts]
 * @param {number} [opts.initialStep=0.1]
 * @param {number} [opts.maxIterations=200]
 * @param {number} [opts.tolerance=1e-6] - Simplex size tolerance
 * @returns {{x: [number, number], f: number, iterations: number}}
 */
function nelderMead(
  f,
  x0,
  { initialStep = 0.1, maxIterations = 200, tolerance = 1e-6 } = {},
) {
  // Initial simplex: x0 and both axis perturbations
  const simplex = [
    { x: [...x0], f: f(x0) },
    { x: [x0[0] + initialStep, x0[1]], f: f([x0[0] + initialStep, x0[1]]) },
    { x: [x0[0], x0[1] + initialStep], f: f([x0[0], x0[1] + initialStep]) },
  ];
  let iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    simplex.sort((a, b) => a.f - b.f);
    const spread = Math.abs(simplex[0].f - simplex[2].f);
    const size = Math.max(
      Math.abs(simplex[2].x[0] - simplex[0].x[0]),
      Math.abs(simplex[2].x[1] - simplex[0].x[1]),
    );
    if (spread < tolerance && size < tolerance) {
      break;
    }
    // Centroid of the best two
    const cx = (simplex[0].x[0] + simplex[1].x[0]) / 2;
    const cy = (simplex[0].x[1] + simplex[1].x[1]) / 2;
    const reflect = [cx + (cx - simplex[2].x[0]), cy + (cy - simplex[2].x[1])];
    const fr = f(reflect);
    if (fr < simplex[0].f) {
      // Expand
      const expand = [
        cx + 2 * (cx - simplex[2].x[0]),
        cy + 2 * (cy - simplex[2].x[1]),
      ];
      const fe = f(expand);
      Object.assign(
        simplex[2],
        fe < fr ? { x: expand, f: fe } : { x: reflect, f: fr },
      );
    } else if (fr < simplex[1].f) {
      simplex[2] = { x: reflect, f: fr };
    } else {
      // Contract
      const outside = [
        cx + 0.5 * (simplex[2].x[0] - cx),
        cy + 0.5 * (simplex[2].x[1] - cy),
      ];
      const fo = f(outside);
      if (fo < fr) {
        simplex[2] = { x: outside, f: fo };
      } else {
        // Shrink toward the best point
        for (let i = 1; i < 3; i++) {
          simplex[i] = {
            x: [
              simplex[0].x[0] + 0.5 * (simplex[i].x[0] - simplex[0].x[0]),
              simplex[0].x[1] + 0.5 * (simplex[i].x[1] - simplex[0].x[1]),
            ],
            f: 0,
          };
          simplex[i].f = f(simplex[i].x);
        }
      }
    }
  }
  simplex.sort((a, b) => a.f - b.f);
  return { x: simplex[0].x, f: simplex[0].f, iterations };
}

/**
 * Builds the 5×5 confusion matrix (SPEC §7.2 step 5): rows are the
 * predicted Sereno tiers, columns the tiers measured from the
 * reconstructed acceleration. Both classified with the same AZ band
 * thresholds.
 *
 * @param {Array<{measuredAz: number, base: number, sinHeel: number,
 *   resonance: number, steepness: number}>} points
 * @param {number} kHeel
 * @param {number} kPitch
 * @returns {Promise<{tiers: string[], matrix: number[][]}>} Matrix
 *   [predictedIndex][measuredIndex] of window counts
 */
async function confusionMatrix(points, kHeel, kPitch) {
  const physics = await loadPhysics();
  const matrix = physics.COMFORT_TIERS.map(() =>
    physics.COMFORT_TIERS.map(() => 0),
  );
  for (const point of points) {
    const predicted = physics.rateAcceleration(
      predictedAzAt(point, kHeel, kPitch),
    );
    const measured = physics.rateAcceleration(point.measuredAz);
    matrix[physics.comfortSeverity(predicted)][
      physics.comfortSeverity(measured)
    ] += 1;
  }
  return { tiers: physics.COMFORT_TIERS, matrix };
}

/**
 * Queries one chunk of history (same contract as the replay tools:
 * `/signalk/v2/api/history/values` with `paths`/`from`/`to`/
 * `resolution`).
 *
 * @param {object} params
 * @param {string} params.baseUrl - Server base URL
 * @param {string} [params.token] - Bearer token (SIGNALK_TOKEN env)
 * @param {string} [params.provider] - History provider ID
 * @param {Date} params.from
 * @param {Date} params.to
 * @param {number} params.resolution - Seconds
 * @param {typeof fetch} [params.fetchImpl]
 * @returns {Promise<object>} `/values` response
 */
async function queryHistoryValues({
  baseUrl,
  token = process.env.SIGNALK_TOKEN,
  provider,
  from,
  to,
  resolution,
  fetchImpl = fetch,
}) {
  const url = new URL("/signalk/v2/api/history/values", baseUrl);
  url.searchParams.set("paths", HISTORY_PATHS.join(","));
  url.searchParams.set("from", from.toISOString());
  url.searchParams.set("to", to.toISOString());
  url.searchParams.set("resolution", String(resolution));
  if (provider) {
    url.searchParams.set("provider", provider);
  }
  const headers = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    throw new Error(
      `History API returned ${response.status}: ${response.statusText}`,
    );
  }
  return response.json();
}

/**
 * Runs the full backtest (SPEC §7.2): chunked history extraction,
 * sliding-window evaluation, Nelder-Mead calibration from the plugin
 * defaults, and the comfort confusion matrix at the tuned parameters.
 *
 * @param {object} params
 * @param {string} params.baseUrl - Signal K server base URL
 * @param {Date} params.from - Window start
 * @param {Date} params.to - Window end
 * @param {object} [params.options]
 * @param {number} [params.options.chunkHours=24] - History query chunk
 * @param {number} [params.options.resolution] - Seconds (default 10)
 * @param {number} [params.options.windowMinutes=15]
 * @param {number} [params.options.waterlineLengthM]
 * @param {number} [params.options.kHeel=0.35] - Starting guess
 * @param {number} [params.options.kPitch=0.4] - Starting guess
 * @param {string} [params.options.token]
 * @param {string} [params.options.provider]
 * @param {typeof fetch} [params.fetchImpl]
 * @returns {Promise<object>} Report (see bin/backtest-cli.js)
 */
async function runBacktest({
  baseUrl,
  from,
  to,
  options = {},
  fetchImpl = fetch,
}) {
  const {
    chunkHours = 24,
    resolution = DEFAULT_RESOLUTION_SECONDS,
    windowMinutes = 15,
    waterlineLengthM = options.waterline_length_m ?? DEFAULT_WATERLINE_M,
    kHeel: startHeel = 0.35,
    kPitch: startPitch = 0.4,
    token,
    provider,
  } = options;

  // Chunked extraction keeps each query bounded on satellite links
  const samples = [];
  const chunkMs = chunkHours * 3600000;
  for (let t = from.getTime(); t < to.getTime(); t += chunkMs) {
    const chunkTo = new Date(Math.min(t + chunkMs, to.getTime()));
    const historyData = await queryHistoryValues({
      baseUrl,
      token,
      provider,
      from: new Date(t),
      to: chunkTo,
      resolution,
      fetchImpl,
    });
    samples.push(...buildSamples(historyData));
  }
  samples.sort((a, b) => a.tMs - b.tMs);

  const points = await evaluationPoints(samples, {
    windowMinutes,
    waterlineLengthM,
  });

  const startLoss = lossAt(points, startHeel, startPitch);
  const optimized = nelderMead(
    ([heel, pitch]) => lossAt(points, heel, pitch),
    [startHeel, startPitch],
  );
  const [kHeel, kPitch] = optimized.x;
  const tuned = points.length > 0 ? lossAt(points, kHeel, kPitch) : null;
  const matrix =
    points.length > 0
      ? await confusionMatrix(points, kHeel, kPitch)
      : { tiers: [], matrix: [] };

  return {
    generatedAt: new Date().toISOString(),
    range: { from: from.toISOString(), to: to.toISOString() },
    resolutionSeconds: resolution,
    windowMinutes,
    samples: samples.length,
    windowsEvaluated: points.length,
    start: { kHeel: startHeel, kPitch: startPitch, mae: startLoss },
    tuned: {
      kHeel: round4(kHeel),
      kPitch: round4(kPitch),
      mae: tuned == null ? null : round4(tuned),
      iterations: optimized.iterations,
    },
    confusionMatrix: matrix,
  };
}

/**
 * @param {number} value
 * @returns {number} Rounded to 4 decimals
 */
function round4(value) {
  return Math.round(value * 10000) / 10000;
}

module.exports = {
  HISTORY_PATHS,
  DEFAULT_RESOLUTION_SECONDS,
  DEFAULT_WATERLINE_M,
  MIN_WINDOW_SAMPLES,
  parseColumns,
  cellNumber,
  buildSamples,
  trueFromApparent,
  waveFromWind,
  variance,
  measuredAz,
  evaluationPoints,
  predictedAzAt,
  lossAt,
  nelderMead,
  confusionMatrix,
  queryHistoryValues,
  runBacktest,
};
