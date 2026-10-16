/**
 * Sereno comfort scale & monohull motion math (SPEC §5.2).
 *
 * Shared between the routing web worker (browser) and the backtest CLI
 * (server), so this module is a plain ES module with no imports: the
 * webapp loads it directly from the plugin's static directory, and Node
 * consumes the same file with `import()`.
 *
 * The comfort model rates a passage hour on the Sereno scale
 * (Champagne > Easy > Sporty > Rough > Miserable) from two independent
 * vectors, the worse of which sets the level:
 *
 * 1. **Wind over the deck** — apparent wind speed bands derived from
 *    reef points (SPEC §5.2 vector 1).
 * 2. **Motion** — RMS vertical acceleration from the wave encounter
 *    period, adjusted for heel-induced roll and hull-length pitching
 *    resonance (SPEC §5.2 vector 2), rated against the comfort bands of
 *    ISO 2631-1. The slatting & roll-dampening penalty (work doc #14)
 *    scales the motion of light air in a residual swell — the
 *    "washing machine" a raw acceleration number reads as calm.
 *
 * The physics follows SV Sabado's `passage-weather` planner
 * (https://github.com/sailing12388/passage-weather, MIT), adapted for a
 * monohull: the catamaran beam-roll and bridgedeck-slam factors are
 * replaced by a heel multiplier and a waterline pitching resonance
 * term. This is a modified Sereno scale, not a direct copy — the
 * slatting penalty is this project's own addition, upstream has
 * nothing like it (a catamaran slats far less, and light-air
 * discomfort rarely gets modeled at all). Not calibrated against a
 * logged passage until the backtest CLI (SPEC §7) tunes k_heel/k_pitch
 * against the vessel's own history.
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
export const COMFORT_TIERS = [
  "champagne",
  "easy",
  "sporty",
  "rough",
  "miserable",
];

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
    tier: "sporty",
    maxAws: 23,
    maxAz: 0.63,
    text: "Lively enough that a hot coffee needs a firm grip.",
  },
  {
    tier: "rough",
    maxAws: 33,
    maxAz: 1.25,
    text: "One hand for the boat — loose objects go flying.",
  },
  {
    tier: "miserable",
    maxAws: null,
    maxAz: null,
    text: "Nobody is enjoying this. Seasickness very likely.",
  },
];

/**
 * Apparent wind speed (knots) at or above which each tier is lost
 * (Champagne, Easy, Sporty, Rough). SPEC §5.2 vector 1.
 */
export const AWS_BANDS_KNOTS = [12, 18, 23, 33];

/**
 * RMS vertical acceleration (m/s²) at or above which each tier is lost
 * (Champagne, Easy, Sporty, Rough). SPEC §5.2 vector 2, ISO 2631-1.
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
 * Default prep delay (hours) between "we could leave now" and actual
 * departure in the daylight-anchored departure logic (work doc #15):
 * stowing, hoisting, casting off.
 */
export const DEPARTURE_PREP_HOURS = 1.5;

/** Clamp bounds for the configured prep delay (hours). */
export const DEPARTURE_PREP_MIN_HOURS = 0.5;
export const DEPARTURE_PREP_MAX_HOURS = 3;

/**
 * Sun altitude (degrees) defining "first light" for the
 * daylight-anchored departure (work doc #15): civil dawn/dusk, −6°.
 * The whole point of waiting for light is defeated by leaving right
 * before dark, so the dawn anchor bounds both directions.
 */
export const DEPARTURE_DAWN_ALTITUDE_DEG = -6;

/** Dawn search: 5-minute steps bounded at 18 h (one full night). */
export const DEPARTURE_SEARCH_STEP_MINUTES = 5;
export const DEPARTURE_SEARCH_BOUND_HOURS = 18;

/**
 * Daylight-anchored assumed departure time (work doc #15). While the
 * boat is moored, the forecast timeline should anchor to a realistic
 * departure, not to "now" — nobody casts off at 02:40 because the
 * forecast said so. Pure function: no Signal K, no DOM.
 *
 * Rules (auto mode):
 *
 * 1. **Underway**: depart now — the forecast is already sailing.
 * 2. **Night at the start position**: next first light — the sun
 *    crossing the dawn altitude (civil dawn, −6°) at that position.
 * 3. **Day at the start position**: now plus the prep delay — but
 *    only while the sun stays above the dawn threshold: if it sets
 *    within the prep window, the answer is the next dawn (never an
 *    immediate departure right before dark — the recorded decision).
 *
 * The answer says what was assumed (`reason`) so the UI can state it
 * instead of silently shifting numbers. Polar degeneracy (no dawn
 * within the search bound) falls back to now and says so via the
 * `no_dawn` reason — an addition to the work doc's three-reason set.
 *
 * @param {object} params
 * @param {Date} [params.now] - Reference instant
 * @param {number} params.lat - Start position latitude (route first
 *   waypoint, fallback vessel position)
 * @param {number} params.lon - Start position longitude
 * @param {boolean} [params.underway=false] - Navigation state outside
 *   the moored/anchored set
 * @param {number} [params.prepHours] - Prep delay (hours; clamped to
 *   0.5–3 by the caller per configuration)
 * @param {number} [params.dawnAltitudeDeg] - Dawn anchor (degrees)
 * @returns {{time: Date, reason: "underway"|"daylight_prep"|
 *   "next_dawn"|"no_dawn"}}
 */
export function assumedDepartureTime({
  now = new Date(),
  lat,
  lon,
  underway = false,
  prepHours = DEPARTURE_PREP_HOURS,
  dawnAltitudeDeg = DEPARTURE_DAWN_ALTITUDE_DEG,
}) {
  if (underway) {
    return { time: now, reason: "underway" };
  }
  const dayNow =
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    sunAltitudeDeg(now, lat, lon) > dawnAltitudeDeg;
  if (dayNow) {
    const prep = new Date(
      now.getTime() +
        Math.min(
          Math.max(prepHours, DEPARTURE_PREP_MIN_HOURS),
          DEPARTURE_PREP_MAX_HOURS,
        ) *
          3600000,
    );
    if (sunAltitudeDeg(prep, lat, lon) > dawnAltitudeDeg) {
      return { time: prep, reason: "daylight_prep" };
    }
  }
  // Next first light: the first *rising* crossing of the dawn anchor —
  // in daylight the sun is already above it, so the plain "first
  // instant above" would return a few minutes from now instead of the
  // next dawn. Requiring the previous step below the anchor makes the
  // scan find the actual dawn from either side.
  const stepMs = DEPARTURE_SEARCH_STEP_MINUTES * 60000;
  const boundMs = DEPARTURE_SEARCH_BOUND_HOURS * 3600000;
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    let previousAbove = dayNow;
    for (
      let t = now.getTime() + stepMs;
      t <= now.getTime() + boundMs;
      t += stepMs
    ) {
      const above = sunAltitudeDeg(new Date(t), lat, lon) > dawnAltitudeDeg;
      if (above && !previousAbove) {
        return { time: new Date(t), reason: "next_dawn" };
      }
      previousAbove = above;
    }
  }
  // Polar day/night: no dawn within the bound — say so, keep now
  return { time: now, reason: "no_dawn" };
}

/**
 * Floor for the encounter-period stretch factor. A boat surfing along
 * with a wave train it overtakes would otherwise drive Te to zero and
 * the acceleration to infinity; the floor caps the stretch. Value from
 * passage-weather's comfort model.
 */
export const ENCOUNTER_FACTOR_FLOOR = 0.15;

/**
 * Combined significant wave height (m) below which the sea is glassy
 * calm and the slatting penalty never applies: not enough wave energy
 * to roll the hull (work doc #14, gate step 1).
 */
export const SLATTING_HS_MAX_M = 0.6;

/**
 * True wind speed (knots) below which aerodynamic roll-dampening is
 * lost upwind / reaching (TWA within ±90°): not enough sail pressure
 * to hold the rig steady against a residual swell (work doc #14, gate
 * step 2).
 */
export const SLATTING_TWS_UPWIND_KNOTS = 7;

/**
 * True wind speed (knots) below which aerodynamic roll-dampening is
 * lost downwind / running (TWA beyond ±90°): the boat sails away from
 * the wind, dropping apparent wind too low to keep flow attached
 * (work doc #14, gate step 2).
 */
export const SLATTING_TWS_DOWNWIND_KNOTS = 12;

/**
 * Discomfort multiplier of the vertical acceleration when the
 * slatting regime is detected (work doc #14, μ_slat): the snap-roll
 * and boom shock-loading of light air in a residual swell.
 */
export const SLATTING_MULTIPLIER = 2.5;

/**
 * Wave steepness (Hs/Tp²) at or above which motoring into head seas
 * keeps the slatting forced-Rough floor (work doc #38 three-way
 * rule). The 470-day backtest separated the motoring-into-head-seas
 * hours by steepness, not period: the archetypal banging day
 * (2022-09-12, broken cars) ran Hs/Tp² 0.026–0.035, while the
 * comfortable motoring-in-head-swell hours sat at p50 0.014. Long
 * gentle head swell under motor is slow pitching, not the washing
 * machine.
 */
export const SLATTING_HEAD_STEEPNESS = 0.02;

/**
 * Whether the hour sits in the slatting & roll-dampening regime (work
 * doc #14, refined by the #38 three-way rule from the 470-day
 * backtest): a residual swell (combined Hs at or over
 * {@link SLATTING_HS_MAX_M}) with too little true wind to keep the
 * sails loaded — the threshold depends on the point of sail, upwind
 * losing dampening sooner than downwind. A glassy calm bypasses the
 * penalty entirely; this is the "washing machine", not the gale.
 *
 * The three-way refinement of the sail-state-joined flagged hours:
 * when the sails are drawing the flag is a false alarm (89% of
 * drawing + following hours sat on champagne/easy days) and is
 * suppressed; motoring keeps the forced floor only when banging
 * into steep head seas — long swell rides fine under motor in
 * either direction, where the plain motion evaluation already covers
 * the discomfort; without sail-state knowledge the legacy behavior
 * stands (conservative).
 *
 * @param {object} params
 * @param {number} params.hsMeters - Combined significant wave height (m)
 * @param {number} params.twsKnots - True wind speed (knots)
 * @param {number} params.twaRad - True wind angle (rad, signed, 0 =
 *   wind from dead ahead)
 * @param {number} [params.tpSeconds] - Wave period (s)
 * @param {number} [params.waveTravelDirectionRad] - Direction the
 *   waves travel toward (rad)
 * @param {number} [params.headingRad] - Vessel heading (rad)
 * @param {string} [params.sailState] - 'sailing' | 'motoring' | null
 *   when unknown
 * @returns {boolean}
 */
export function slattingRisk({
  hsMeters,
  twsKnots,
  twaRad,
  tpSeconds,
  waveTravelDirectionRad,
  headingRad,
  sailState,
}) {
  if (!Number.isFinite(hsMeters) || hsMeters < SLATTING_HS_MAX_M) {
    return false;
  }
  if (!Number.isFinite(twsKnots) || !Number.isFinite(twaRad)) {
    return false;
  }
  const upwind = Math.abs(twaRad) < Math.PI / 2;
  const threshold = upwind
    ? SLATTING_TWS_UPWIND_KNOTS
    : SLATTING_TWS_DOWNWIND_KNOTS;
  if (twsKnots >= threshold) {
    return false;
  }
  // Three-way rule: drawing sails keep flow attached, no flapping
  if (sailState === "sailing") {
    return false;
  }
  if (sailState === "motoring") {
    if (
      !Number.isFinite(tpSeconds) ||
      tpSeconds <= 0 ||
      !Number.isFinite(waveTravelDirectionRad) ||
      !Number.isFinite(headingRad)
    ) {
      return false;
    }
    if (hsMeters / (tpSeconds * tpSeconds) < SLATTING_HEAD_STEEPNESS) {
      return false;
    }
    let rel = waveTravelDirectionRad - headingRad;
    if (rel > Math.PI) rel -= 2 * Math.PI;
    if (rel < -Math.PI) rel += 2 * Math.PI;
    // Head seas: the waves travel against the heading (the backtest's
    // waveRelDeg convention — 0° following, 180° head)
    return Math.abs(rel) > Math.PI / 2;
  }
  // Sail state unknown: legacy conservative behavior
  return true;
}

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
 * Apparent wind speed (knots) below which canvas will not set or hold
 * its shape: the light-air floor of the no-sails regime (work doc
 * #26). Below it the sails slat and bang — the rig comes off and the
 * engine drives. Mirrors the upwind slatting gate's 7 kt (work doc
 * #14) in apparent rather than true wind: the boat's own speed moves
 * the apparent wind, and motoring into light air is exactly when the
 * canvas would slat.
 */
export const SAILS_FILL_MIN_AWS_KNOTS = 7;

/**
 * Apparent wind speed (knots) at or above which the rig comes off for
 * wind (work doc #26): the survival regime — nothing set, the boat
 * lies ahull; nobody motors into it. Deliberately well above the top
 * of the Sereno AWS bands (33 kt): that band line marks seasickness
 * likelihood, not the rig decision — a well-found boat keeps working
 * canvas standing well into the forties. The floor sits around
 * Beaufort 9, where crews go to storm canvas or bare poles.
 */
export const SAILS_MAX_AWS_KNOTS = 45;

/**
 * Which of the two canvas-off regimes (work doc #26) the apparent
 * wind sits in: `"slatting"` below the fill floor, `"survival"` at or
 * above the scale top, null when the wind carries canvas. Mid-scale
 * apparent wind is sail-carrying weather: a `NO_SAILS` rig there is a
 * propulsion decision (motoring) or a non-passage state — not
 * something the plan should hold.
 *
 * @param {object} params
 * @param {number} params.awsKnots - Apparent wind speed
 * @returns {"slatting"|"survival"|null}
 */
export function noSailsRegime({ awsKnots }) {
  if (!Number.isFinite(awsKnots)) {
    return null;
  }
  if (awsKnots < SAILS_FILL_MIN_AWS_KNOTS) {
    return "slatting";
  }
  if (awsKnots >= SAILS_MAX_AWS_KNOTS) {
    return "survival";
  }
  return null;
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
 * Great-circle distance between two positions in nautical miles,
 * antimeridian-safe by construction (the haversine cosine folds the
 * longitude delta). Shared by the route simulation's hazard engine
 * (which keeps its own copy under the same name) and the webapp's
 * live plan trim (work doc #28).
 *
 * @param {number} lat1 - Degrees
 * @param {number} lon1 - Degrees east
 * @param {number} lat2 - Degrees
 * @param {number} lon2 - Degrees east
 * @returns {number} Distance in nautical miles
 */
export function greatCircleNm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const φ1 = lat1 * toRad;
  const φ2 = lat2 * toRad;
  const dφ = (lat2 - lat1) * toRad;
  const dλ = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
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
 * Inshore/offshore regime band for one position, combining the
 * sounding (read only to ~100 m: null in deep water, sporadic false
 * shallow echoes — use the median and shallow fraction, never the
 * mean) with the distance to land. Enclosed seas sit close to land
 * yet sail offshore — the deep-water signal decides there. This is
 * the canonical shared copy for the live sim; the backtest tool
 * carries its own pinned copy (the browser cannot import the plugin
 * tree, and the backtest's test suite pins this exact logic).
 *
 * @param {{depthMeters?: number|null, depthShallowFraction?: number|null,
 *   distanceToLandNm?: number|null}} sample
 * @returns {"archipelago"|"coastal"|"offshore"|"unknown"}
 */
export function regimeBandOf({
  depthMeters = null,
  depthShallowFraction = null,
  distanceToLandNm = null,
  depthAvailable = true,
} = {}) {
  // No sounding in this data source at all (the forecast-only
  // simulator): null depth means unknown, not deep — the distance
  // alone decides. The sounding-bearing data path (the backtest)
  // leaves the default: a null depth reading is the instrument's
  // range limit, i.e. deep water.
  if (depthAvailable === false) {
    if (distanceToLandNm == null) {
      return "unknown";
    }
    if (distanceToLandNm < 3) {
      return "archipelago";
    }
    return distanceToLandNm >= 25 ? "offshore" : "coastal";
  }
  if (depthMeters == null && distanceToLandNm == null) {
    // Neither signal — sounder off or data absent: unknown, never
    // silently offshore
    return "unknown";
  }
  const inArchipelago =
    (distanceToLandNm != null && distanceToLandNm < 3) ||
    (distanceToLandNm == null &&
      depthMeters != null &&
      depthMeters < 20 &&
      depthShallowFraction >= 0.8);
  if (inArchipelago) {
    return "archipelago";
  }
  const deepWater =
    depthMeters == null ||
    depthMeters >= 100 ||
    (distanceToLandNm != null && distanceToLandNm >= 25);
  return deepWater ? "offshore" : "coastal";
}

/**
 * Classifies a span as polar day (midnight sun) or polar night by
 * scanning the sun's altitude hourly across it: every sample below
 * the horizon means the sun does not rise in the span, every sample
 * above means it does not set. Anything in between returns null —
 * an ordinary day with both a rise and a set.
 *
 * The hourly scan is deliberately coarse: on a grazing day (the sun
 * touching the horizon for minutes) a real crossing can hide between
 * samples and read as polar night. That is the same convention the
 * crew uses — a sun that barely flickers above the horizon reads as
 * a night, not a day.
 *
 * Works on a moving vessel too: the caller passes the position the
 * span should be judged at, so a passage sailing out of the midnight
 * sun flips the kind at the right day.
 *
 * @param {number} startMs - Span start (epoch ms)
 * @param {number} endMs - Span end (epoch ms)
 * @param {number} latDeg - Degrees north
 * @param {number} lonDeg - Degrees east
 * @returns {"midnightSun"|"polarNight"|null}
 */
export function sunDayKind(startMs, endMs, latDeg, lonDeg) {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) {
    return null;
  }
  let min = Infinity;
  let max = -Infinity;
  for (let t = startMs; t <= endMs; t += 3600000) {
    const alt = sunAltitudeDeg(new Date(t), latDeg, lonDeg);
    if (alt < min) {
      min = alt;
    }
    if (alt > max) {
      max = alt;
    }
  }
  if (max <= 0) {
    return "polarNight";
  }
  if (min >= 0) {
    return "midnightSun";
  }
  return null;
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
/**
 * Encounter period floor derived from the waterline length: the wave
 * period whose deep-water wavelength equals the waterline. Waves
 * shorter than the hull are bridged, not followed — the vessel does
 * not ride their surface, so the vertical acceleration base must not
 * grow with 1/T² below this floor. Backtest finding (work doc #38):
 * sub-3 s extrapolation of the Hs/T² weighting is unphysical; a 1 m
 * @ 5 s Baltic chop is nasty while a 1 m @ 2 s ripple is nothing.
 *
 * T = sqrt(2π·L/g) with L = waterline length; 9.4 m → ≈2.45 s.
 *
 * @param {number} waterlineLengthM - Waterline length in meters
 * @returns {number} Floor for the encounter period in seconds
 */
export function encounterPeriodFloorSeconds(waterlineLengthM) {
  return Math.sqrt((2 * Math.PI * waterlineLengthM) / G);
}

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
  const encounterPeriodFloor = encounterPeriodFloorSeconds(
    vessel.waterlineLengthM,
  );
  // RMS elevation of a sinusoidal sea is Hs/4; RMS acceleration of the
  // riding vessel follows the sea at the encounter frequency, floored
  // at the period the hull starts bridging instead of following.
  const effectivePeriod = Math.max(encounterPeriod, encounterPeriodFloor);
  const base =
    ((4 * Math.PI * Math.PI) / (effectivePeriod * effectivePeriod)) *
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
    encounterPeriodFloor,
    effectivePeriod,
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
 * (the worse of the two). The slatting & roll-dampening penalty (work
 * doc #14) scales the vertical acceleration by
 * {@link SLATTING_MULTIPLIER} before banding and forces the motion
 * tier to at least Rough — the payload's `slatting` flag tells the
 * dashboard to hatch the block.
 *
 * @param {object} sea - See {@link verticalAcceleration} `sea`
 * @param {object} vessel - See {@link verticalAcceleration} `vessel`
 * @param {object} wind - See {@link verticalAcceleration} `wind`
 * @returns {{awsKnots: number, awsComfort: string, acceleration: object,
 *   motionComfort: string, comfort: string, slatting: boolean}}
 */
/**
 * Damping factor applied to the vertical acceleration when a
 * downwind stabilizer sail (Parasailor-class) is set: the measured
 * ratio of matched pairs (Parasailor hours vs working-rig hours at
 * matched TWS/TWA/Hs/wave period, 116 pairs, 2023-2024) — median
 * 0.78, the same in and out of the slatting regime. The slatting
 * regime itself must not fire for a drawing downwind sail (the
 * three-way rule suppresses it); this damping is the residual
 * stabilizing effect on top.
 */
export const DOWNWIND_STABILIZER_DAMPING = 0.78;

export function serenoComfort(sea, vessel, wind) {
  const awsKnots = apparentWindSpeedKnots({
    twsKnots: wind.twsKnots,
    stwKnots: vessel.sogKnots,
    twaRad: wind.twaRad,
  });
  const acceleration = verticalAcceleration(sea, vessel, wind);
  const slatting = slattingRisk({
    hsMeters: sea.hsMeters,
    twsKnots: wind.twsKnots,
    twaRad: wind.twaRad,
    tpSeconds: sea.tpSeconds,
    waveTravelDirectionRad: sea.waveTravelDirectionRad,
    headingRad: vessel.headingRad,
    sailState: vessel.sailState,
  });
  const awsComfort = rateApparentWind(awsKnots);
  // A downwind stabilizer damps the motion: the measured 0.78 ratio
  // applies to the base acceleration, before both the slatting
  // multiplier (which does not fire for a drawing downwind sail) and
  // the banding.
  const motionValue = vessel.downwindStabilized
    ? acceleration.value * DOWNWIND_STABILIZER_DAMPING
    : acceleration.value;
  const motionComfort = rateAcceleration(
    slatting ? motionValue * SLATTING_MULTIPLIER : motionValue,
  );
  const comfort = worseComfort(awsComfort, motionComfort);
  return {
    awsKnots,
    awsComfort,
    acceleration,
    motionComfort,
    comfort: slatting ? worseComfort(comfort, "rough") : comfort,
    slatting,
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
