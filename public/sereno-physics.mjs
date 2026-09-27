/**
 * Sereno comfort scale & monohull motion math (SPEC §5.2).
 *
 * Shared between the routing web worker (browser) and the backtest CLI
 * (server), so this module is a plain ES module with no imports: the
 * webapp loads it directly from the plugin's static directory, and Node
 * consumes the same file with `import()`.
 *
 * The comfort model rates a passage hour on the Sereno scale
 * (Champagne > Easy > Coffee > Rough > Sick) from two independent
 * vectors, the worse of which sets the level:
 *
 * 1. **Wind over the deck** — apparent wind speed bands derived from
 *    reef points (SPEC §5.2 vector 1).
 * 2. **Motion** — RMS vertical acceleration from the wave encounter
 *    period, adjusted for heel-induced roll and hull-length pitching
 *    resonance (SPEC §5.2 vector 2), rated against the comfort bands of
 *    ISO 2631-1.
 *
 * The physics follows SV Sabado's `passage-weather` planner
 * (https://github.com/sailing12388/passage-weather, MIT), adapted for a
 * monohull: the catamaran beam-roll and bridgedeck-slam factors are
 * replaced by a heel multiplier and a waterline pitching resonance
 * term. Not calibrated against a logged passage until the backtest CLI
 * (SPEC §7) tunes k_heel/k_pitch against the vessel's own history.
 *
 * Conventions:
 * - wind speeds and boat speeds in knots, angles in radians unless a
 *   parameter name says otherwise;
 * - true wind angle is signed, 0 = wind from dead ahead, ±π = from
 *   dead astern (`environment.wind.angleTrue` convention);
 * - heading and wave directions are radians, true;
 * - wave direction parameters come in the *travel* convention
 *   (direction the waves move toward). Signal K and forecast APIs use
 *   the *from* convention — convert once with {@link travelDirection}.
 *
 * @module sereno-physics
 */

/**
 * Gravitational acceleration (m/s²).
 */
export const G = 9.81;

/**
 * Meters per second per knot.
 */
export const KN_TO_MS = 0.514444;

/**
 * Comfort tiers, best first. The index in this array is the severity
 * rank used when combining vectors.
 */
export const COMFORT_TIERS = ["champagne", "easy", "coffee", "rough", "sick"];

/**
 * One-line meaning per comfort tier, display order best first, with
 * the band lines that drop the tier (mirrors AWS_BANDS_KNOTS and
 * AZ_BANDS_MS2). For the webapp explainer.
 */
export const COMFORT_SCALE_INFO = [
  {
    tier: "champagne",
    maxAws: 12,
    maxAz: 0.15,
    text: "Barely any motion — champagne stays in the glass.",
  },
  {
    tier: "easy",
    maxAws: 18,
    maxAz: 0.315,
    text: "Comfortable: moving around below is easy.",
  },
  {
    tier: "coffee",
    maxAws: 23,
    maxAz: 0.63,
    text: "You can still hold a hot coffee without wearing it.",
  },
  {
    tier: "rough",
    maxAws: 33,
    maxAz: 1.25,
    text: "One hand for the boat — loose objects go flying.",
  },
  {
    tier: "sick",
    maxAws: null,
    maxAz: null,
    text: "Beyond rough: seasickness very likely — think shelter or a course change.",
  },
];

/**
 * Apparent wind speed (knots) at or above which each tier is lost
 * (Champagne, Easy, Coffee, Rough). SPEC §5.2 vector 1.
 */
export const AWS_BANDS_KNOTS = [12, 18, 23, 33];

/**
 * RMS vertical acceleration (m/s²) at or above which each tier is lost
 * (Champagne, Easy, Coffee, Rough). SPEC §5.2 vector 2, ISO 2631-1.
 */
export const AZ_BANDS_MS2 = [0.15, 0.315, 0.63, 1.25];

/**
 * Heel angle (degrees) reached at 25 kt apparent wind on a beam reach
 * (SPEC §5.2: φ_max).
 */
export const HEEL_MAX_DEG = 25;

/**
 * Ratio threshold of peak period to significant wave height below
 * which a sea is considered anomalously steep (SPEC §6.2
 * `steepnessRatio < 3.28`).
 */
export const STEEPNESS_RATIO_THRESHOLD = 3.28;

/**
 * Sun altitude (degrees) below which it counts as night for sailing
 * decisions. The night regime is really bounded by the watch changes,
 * not by a twilight line: offshore the crew reefs down deeper at the
 * evening watch change (usually the one near sunset) than the
 * conditions alone require — both watchkeepers are awake then, so
 * sail changes are easy, windvane steering benefits, and the night
 * adds a margin for the squall you never saw in the dark. The
 * regime ends at the morning watch change. Watch changes are only
 * partly recorded, so sunset (altitude 0°) stands in for the evening
 * flip. The morning side runs late (the day bucket starts at
 * sunrise, before the actual shake-out); the threshold is a parameter
 * so the backtest CLI can calibrate the boundary from the log once we
 * know when the shakes really happen. The learned matrix keeps the
 * day and night buckets separate either way.
 */
export const NIGHT_SUN_ALTITUDE_DEG = 0;

/**
 * Floor for the encounter-period stretch factor. A boat surfing along
 * with a wave train it overtakes would otherwise drive Te to zero and
 * the acceleration to infinity; the floor caps the stretch. Value from
 * passage-weather's comfort model.
 */
export const ENCOUNTER_FACTOR_FLOOR = 0.15;

/**
 * Converts a direction from the meteorological *from* convention (the
 * direction the sea/wind comes from, Signal K and forecast API
 * convention) to the *travel* convention used by the encounter period
 * math.
 *
 * @param {number} fromDirectionRad - Direction the waves come from (rad)
 * @returns {number} Direction the waves travel toward (rad)
 */
export function travelDirection(fromDirectionRad) {
  const travel = fromDirectionRad + Math.PI;
  return ((travel % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

/**
 * Severity rank of a comfort tier (0 best … 4 worst).
 *
 * @param {string} tier - One of {@link COMFORT_TIERS}
 * @returns {number} Severity rank
 */
export function comfortSeverity(tier) {
  const index = COMFORT_TIERS.indexOf(tier);
  return index < 0 ? COMFORT_TIERS.length - 1 : index;
}

/**
 * The worse of two comfort tiers.
 *
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
export function worseComfort(a, b) {
  return comfortSeverity(a) >= comfortSeverity(b) ? a : b;
}

/**
 * Rates an apparent wind speed on the Sereno scale (SPEC §5.2
 * vector 1 bands).
 *
 * @param {number} awsKnots - Apparent wind speed
 * @returns {string} Comfort tier
 */
export function rateApparentWind(awsKnots) {
  for (let i = 0; i < AWS_BANDS_KNOTS.length; i++) {
    if (awsKnots < AWS_BANDS_KNOTS[i]) {
      return COMFORT_TIERS[i];
    }
  }
  return COMFORT_TIERS[COMFORT_TIERS.length - 1];
}

/**
 * Rates an RMS vertical acceleration on the Sereno scale (SPEC §5.2
 * vector 2 bands, ISO 2631-1).
 *
 * @param {number} azMs2 - RMS vertical acceleration (m/s²)
 * @returns {string} Comfort tier
 */
export function rateAcceleration(azMs2) {
  for (let i = 0; i < AZ_BANDS_MS2.length; i++) {
    if (azMs2 < AZ_BANDS_MS2[i]) {
      return COMFORT_TIERS[i];
    }
  }
  return COMFORT_TIERS[COMFORT_TIERS.length - 1];
}

/**
 * Apparent wind speed over the deck (SPEC §5.2 vector 1). TWA is
 * signed (0 = wind from ahead), so head winds add and following winds
 * subtract.
 *
 * @param {object} conditions
 * @param {number} conditions.twsKnots - True wind speed
 * @param {number} conditions.stwKnots - Speed through water
 * @param {number} conditions.twaRad - True wind angle (rad, signed)
 * @returns {number} Apparent wind speed (knots)
 */
export function apparentWindSpeedKnots({ twsKnots, stwKnots, twaRad }) {
  const { tws, stw } = { tws: twsKnots, stw: stwKnots };
  return Math.sqrt(tws * tws + stw * stw + 2 * tws * stw * Math.cos(twaRad));
}

/**
 * Deep-water wavelength of a wave train (L = g·T²/2π, about 1.56·T²).
 *
 * @param {number} tpSeconds - Peak period (s)
 * @returns {number} Wavelength (m)
 */
export function waveLengthMeters(tpSeconds) {
  return (G * tpSeconds * tpSeconds) / (2 * Math.PI);
}

/**
 * Deep-water phase speed of a wave train (c = g·T/2π).
 *
 * @param {number} tpSeconds - Peak period (s)
 * @returns {number} Phase speed (m/s)
 */
export function wavePhaseSpeedMs(tpSeconds) {
  return (G * tpSeconds) / (2 * Math.PI);
}

/**
 * Wave encounter period (SPEC §5.2 vector 2 step 1): how often the
 * moving boat meets crests of a wave train. Waves met on the bow
 * arrive faster (Te < Tp), waves from astern slower (Te > Tp).
 *
 * Uses the SPEC formula with two guards adopted from passage-weather:
 * the stretch factor magnitude is floored at
 * {@link ENCOUNTER_FACTOR_FLOOR} so a boat overtaking (surfing) a
 * slower train cannot drive Te to zero, and the signed factor is
 * folded with abs() — a negative denominator only means the boat
 * overtakes the train, which is a very long encounter period, not a
 * physical singularity.
 *
 * @param {object} params
 * @param {number} params.tpSeconds - Wave peak period Tp (s)
 * @param {number} params.sogKnots - Boat speed over ground
 * @param {number} params.waveTravelDirectionRad - Direction the waves
 *   travel toward (rad, true; see {@link travelDirection})
 * @param {number} params.headingRad - Vessel heading (rad, true)
 * @returns {number} Encounter period Te (s), always positive
 */
export function encounterPeriodSeconds({
  tpSeconds,
  sogKnots,
  waveTravelDirectionRad,
  headingRad,
}) {
  const phaseSpeed = wavePhaseSpeedMs(tpSeconds);
  const stretch =
    1 -
    ((sogKnots * KN_TO_MS) / phaseSpeed) *
      Math.cos(waveTravelDirectionRad - headingRad);
  return tpSeconds / Math.max(Math.abs(stretch), ENCOUNTER_FACTOR_FLOOR);
}

/**
 * Steepness ratio of a sea state: peak period over significant wave
 * height. Values below {@link STEEPNESS_RATIO_THRESHOLD} mark an
 * anomalously steep, wind-driven sea (SPEC §6.2 macro anomaly filter).
 *
 * @param {number} tpSeconds - Peak period (s)
 * @param {number} hsMeters - Significant wave height (m)
 * @returns {number} Tp/Hs ratio, Infinity for a flat sea
 */
export function steepnessRatio(tpSeconds, hsMeters) {
  if (hsMeters <= 0) {
    return Infinity;
  }
  return tpSeconds / hsMeters;
}

/**
 * Estimated heel angle (SPEC §5.2 vector 2 step 3). Peaks on a beam
 * reach (|sin TWA| = 1), vanishes upwind and downwind, and scales
 * linearly with apparent wind around the 25 kt reference.
 *
 * @param {object} params
 * @param {number} params.awsKnots - Apparent wind speed
 * @param {number} params.twaRad - True wind angle (rad, signed)
 * @returns {number} Heel angle magnitude (degrees, 0..25)
 */
export function heelAngleDeg({ awsKnots, twaRad }) {
  const phiDeg = HEEL_MAX_DEG * (awsKnots / 25.0) * Math.abs(Math.sin(twaRad));
  return Math.min(phiDeg, HEEL_MAX_DEG);
}

/**
 * Heel multiplier of the vertical acceleration (SPEC §5.2 vector 2
 * step 3): heel-induced roll bias on top of the vertical motion.
 *
 * @param {number} heelDeg - Heel angle magnitude (degrees)
 * @param {number} kHeel - Heeling acceleration multiplier constant
 * @returns {number} Multiplier (≥ 1)
 */
export function heelMultiplier(heelDeg, kHeel) {
  return 1.0 + kHeel * Math.abs(Math.sin((heelDeg * Math.PI) / 180));
}

/**
 * Pitching resonance multiplier (SPEC §5.2 vector 2 step 4). Two
 * terms on top of unity:
 *
 * - a Gaussian centered where the wave length matches the waterline
 *   (the hull pitches with the contour at resonant length);
 * - a steepness penalty that grows as the sea gets steeper than the
 *   Tp/Hs = 3.28 reference.
 *
 * @param {object} params
 * @param {number} params.tpSeconds - Combined peak period (s)
 * @param {number} params.hsMeters - Combined significant height (m)
 * @param {number} params.waterlineLengthM - Vessel waterline length (m)
 * @param {number} kPitch - Pitching acceleration multiplier constant
 * @returns {number} Multiplier (≥ 1)
 */
export function pitchMultiplier(
  { tpSeconds, hsMeters, waterlineLengthM },
  kPitch,
) {
  const wavelength = waveLengthMeters(tpSeconds);
  const resonance = Math.exp(
    -(((wavelength - waterlineLengthM) / waterlineLengthM) ** 2),
  );
  const ratio = hsMeters > 0 ? tpSeconds / hsMeters : Infinity;
  const steepness = Math.max(
    0,
    (STEEPNESS_RATIO_THRESHOLD - ratio) / STEEPNESS_RATIO_THRESHOLD,
  );
  return 1.0 + kPitch * resonance + steepness;
}

/**
 * Solar altitude (degrees) for an instant and position, using the
 * low-precision Astronomical Almanac approximation (good to a few
 * hundredths of a degree — far more than day/night bucketing needs).
 *
 * Shared so the server backfill can bucket historical sail events by
 * night and the routing worker can bucket simulated hours the same
 * way.
 *
 * @param {Date} date - Instant
 * @param {number} latDeg - Latitude (degrees, north positive)
 * @param {number} lonDeg - Longitude (degrees, east positive)
 * @returns {number} Sun altitude above the horizon (degrees; negative
 *   below)
 */
export function sunAltitudeDeg(date, latDeg, lonDeg) {
  // Days since J2000.0
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;

  const meanLongitude = (280.46 + 0.9856474 * n) * (Math.PI / 180);
  const meanAnomaly = ((357.528 + 0.9856003 * n) % 360) * (Math.PI / 180);
  const eclipticLongitude =
    meanLongitude +
    ((1.915 * Math.PI) / 180) * Math.sin(meanAnomaly) +
    ((0.02 * Math.PI) / 180) * Math.sin(2 * meanAnomaly);
  const obliquity = (23.439 - 0.0000004 * n) * (Math.PI / 180);

  const declination = Math.asin(
    Math.sin(obliquity) * Math.sin(eclipticLongitude),
  );
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  );

  // Greenwich mean sidereal time → local hour angle
  const gmstDeg = (280.46061837 + 360.98564736629 * n) % 360;
  let hourAngleDeg =
    (gmstDeg + lonDeg - (rightAscension * 180) / Math.PI) % 360;
  if (hourAngleDeg > 180) {
    hourAngleDeg -= 360;
  } else if (hourAngleDeg < -180) {
    hourAngleDeg += 360;
  }

  const latRad = (latDeg * Math.PI) / 180;
  const hourAngle = (hourAngleDeg * Math.PI) / 180;
  const altitude = Math.asin(
    Math.sin(latRad) * Math.sin(declination) +
      Math.cos(latRad) * Math.cos(declination) * Math.cos(hourAngle),
  );
  return (altitude * 180) / Math.PI;
}

/**
 * Whether it is night for sailing decisions at an instant and
 * position (sun altitude below {@link NIGHT_SUN_ALTITUDE_DEG}).
 *
 * @param {Date} date - Instant
 * @param {number} latDeg - Latitude (degrees)
 * @param {number} lonDeg - Longitude (degrees)
 * @param {number} [thresholdDeg] - Altitude threshold (degrees;
 *   default {@link NIGHT_SUN_ALTITUDE_DEG}, sunset)
 * @returns {boolean}
 */
export function isNight(
  date,
  latDeg,
  lonDeg,
  thresholdDeg = NIGHT_SUN_ALTITUDE_DEG,
) {
  return sunAltitudeDeg(date, latDeg, lonDeg) < thresholdDeg;
}

/**
 * Monohull vertical acceleration assessment (SPEC §5.2 vector 2).
 *
 * @param {object} sea
 * @param {number} sea.hsMeters - Combined significant wave height (m)
 * @param {number} sea.tpSeconds - Combined peak period (s)
 * @param {number} sea.waveTravelDirectionRad - Direction the waves
 *   travel toward (rad, true)
 * @param {object} vessel
 * @param {number} vessel.sogKnots - Speed over ground
 * @param {number} vessel.headingRad - Vessel heading (rad, true)
 * @param {number} vessel.waterlineLengthM - Waterline length (m)
 * @param {number} vessel.kHeel - Heeling multiplier constant
 * @param {number} vessel.kPitch - Pitching multiplier constant
 * @param {object} wind
 * @param {number} wind.twsKnots - True wind speed
 * @param {number} wind.twaRad - True wind angle (rad, signed)
 * @returns {{encounterPeriod: number, base: number, heel: number,
 *   pitch: number, heelDeg: number, value: number}} Acceleration
 *   breakdown; `value` is the effective RMS vertical acceleration
 *   (m/s²)
 */
export function verticalAcceleration(sea, vessel, wind) {
  const awsKnots = apparentWindSpeedKnots({
    twsKnots: wind.twsKnots,
    stwKnots: vessel.sogKnots,
    twaRad: wind.twaRad,
  });
  const heelDeg = heelAngleDeg({ awsKnots, twaRad: wind.twaRad });

  if (sea.hsMeters <= 0 || sea.tpSeconds <= 0) {
    return {
      encounterPeriod: Infinity,
      base: 0,
      heel: heelMultiplier(heelDeg, vessel.kHeel),
      pitch: pitchMultiplier(
        {
          tpSeconds: sea.tpSeconds,
          hsMeters: sea.hsMeters,
          waterlineLengthM: vessel.waterlineLengthM,
        },
        vessel.kPitch,
      ),
      heelDeg,
      value: 0,
    };
  }

  const encounterPeriod = encounterPeriodSeconds({
    tpSeconds: sea.tpSeconds,
    sogKnots: vessel.sogKnots,
    waveTravelDirectionRad: sea.waveTravelDirectionRad,
    headingRad: vessel.headingRad,
  });
  // RMS elevation of a sinusoidal sea is Hs/4; RMS acceleration of the
  // riding vessel follows the sea at the encounter frequency.
  const base =
    ((4 * Math.PI * Math.PI) / (encounterPeriod * encounterPeriod)) *
    (sea.hsMeters / 2);
  const heel = heelMultiplier(heelDeg, vessel.kHeel);
  const pitch = pitchMultiplier(
    {
      tpSeconds: sea.tpSeconds,
      hsMeters: sea.hsMeters,
      waterlineLengthM: vessel.waterlineLengthM,
    },
    vessel.kPitch,
  );
  return {
    encounterPeriod,
    base,
    heel,
    pitch,
    heelDeg,
    value: base * heel * pitch,
  };
}

/**
 * Full Sereno comfort assessment for one passage hour (SPEC §5.2):
 * apparent wind rating and motion rating, plus the combined level
 * (the worse of the two).
 *
 * @param {object} sea - See {@link verticalAcceleration} `sea`
 * @param {object} vessel - See {@link verticalAcceleration} `vessel`
 * @param {object} wind - See {@link verticalAcceleration} `wind`
 * @returns {{awsKnots: number, awsComfort: string, acceleration: object,
 *   motionComfort: string, comfort: string}}
 */
export function serenoComfort(sea, vessel, wind) {
  const awsKnots = apparentWindSpeedKnots({
    twsKnots: wind.twsKnots,
    stwKnots: vessel.sogKnots,
    twaRad: wind.twaRad,
  });
  const acceleration = verticalAcceleration(sea, vessel, wind);
  const awsComfort = rateApparentWind(awsKnots);
  const motionComfort = rateAcceleration(acceleration.value);
  return {
    awsKnots,
    awsComfort,
    acceleration,
    motionComfort,
    comfort: worseComfort(awsComfort, motionComfort),
  };
}

/**
 * Index of the bin edge a value belongs to: the greatest edge `<=`
 * value, clamped to the last bin. Mirrors the server-side helper of
 * the same name in `plugin/sqlite-db.js` — duplicated because the
 * browser cannot import from the plugin tree.
 *
 * @param {number} value - Observed quantity
 * @param {number[]} bins - Sorted ascending bin edges
 * @returns {number} Bin index into `bins`
 */
export function binIndexFor(value, bins) {
  let index = 0;
  for (let i = 1; i < bins.length; i++) {
    if (value >= bins[i]) {
      index = i;
    }
  }
  return index;
}

/**
 * Finds the learned preferred sail state for wind conditions and time
 * of day (SPEC §3.2 matrix lookup, extended with the day/night
 * bucket: the crew reefs deeper at night than the conditions require,
 * and the matrix keeps both behaviors).
 *
 * @param {object} matrix - Learned sail preference matrix
 *   (`SailPreferenceMatrix`, see `plugin/sqlite-db.js`)
 * @param {number} twsKnots - True wind speed
 * @param {number} twaDeg - True wind angle magnitude (degrees, 0..180)
 * @param {boolean} [night=false] - Night bucket
 * @returns {{preferredSailState: string, minTwsGustTrigger: number,
 *   samplesCount: number, night: boolean}|null} Matrix cell, or null
 *   when the bin was never observed
 */
export function suggestSailState(matrix, twsKnots, twaDeg, night = false) {
  if (!matrix || !Array.isArray(matrix.matrix)) {
    return null;
  }
  // TWA bins cover 0..180; fold the signed angle onto that range.
  const folded = Math.abs(((twaDeg % 360) + 360) % 360);
  const twaFolded = folded > 180 ? 360 - folded : folded;
  const twsBin = binIndexFor(twsKnots, matrix.twsBinsKnots);
  const twaBin = binIndexFor(twaFolded, matrix.twaBinsDegrees);
  return (
    matrix.matrix.find(
      (cell) =>
        cell.twsBin === twsBin &&
        cell.twaBin === twaBin &&
        Boolean(cell.night) === night,
    ) || null
  );
}
