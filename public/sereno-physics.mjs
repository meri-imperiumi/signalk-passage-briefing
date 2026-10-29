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
 * 2. **Motion** — rated from one of two kernels (work doc #56). With
 *    a complete hull description (waterline, beam, canoe draught,
 *    displacement, from plugin config and Signal K design.*) the
 *    spectral kernel applies the Jensen, Mansour & Olsen (2004)
 *    closed-form heave/pitch/roll transfer functions on a
 *    Pierson–Moskowitz spectrum and bands the ISO 2631-1 W_f-weighted
 *    acceleration; roll rides PredictWind's deck-work limits. Without
 *    the hull data the hour falls back to the legacy kernel below —
 *    RMS vertical acceleration from the wave encounter period,
 *    adjusted for heel-induced roll and hull-length pitching
 *    resonance, calibrated against the vessel's own history. The
 *    slatting & roll-dampening penalty (work doc #14) scales the
 *    motion of light air in a residual swell — the "washing machine"
 *    a raw acceleration number reads as calm — whichever kernel ran.
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
 * Departure-day candidates (work doc #34, before-departure half):
 * the daylight-anchored window of today, tomorrow and the day after —
 * the same work doc #15 rules applied to each candidate day, so a
 * +24 h variant is “the same decision, one day later”, anchored to
 * that day's dawn, not to a raw clock offset. The crew browses the
 * variants as alternate plans of the active route; underway there is
 * nothing to compare — the passage is happening (the current departure
 * is enough).
 *
 * Pure: no Signal K, no DOM — the webapp computes the candidates from
 * the payload's first waypoint, the same place {@link
 * assumedDepartureTime} reads.
 *
 * @param {object} params
 * @param {Date} [params.now] - Reference instant
 * @param {number} params.lat - Start position latitude
 * @param {number} params.lon - Start position longitude
 * @param {boolean} [params.underway=false] - Navigation state outside
 *   the moored/anchored set — underway yields the single now-departure
 * @param {number} [params.prepHours] - Prep delay (hours)
 * @param {number} [params.dawnAltitudeDeg] - Dawn anchor (degrees)
 * @param {number} [params.days=3] - Candidate days to enumerate
 * @returns {Array<{time: Date, reason: "underway"|"daylight_prep"|
 *   "next_dawn"|"no_dawn", dayOffset: number}>} Candidates in day
 *   order; `dayOffset` is the 24 h step from the reference day
 */
export function departureCandidates({
  now = new Date(),
  lat,
  lon,
  underway = false,
  prepHours = DEPARTURE_PREP_HOURS,
  dawnAltitudeDeg = DEPARTURE_DAWN_ALTITUDE_DEG,
  days = 3,
}) {
  if (underway) {
    return [
      {
        ...assumedDepartureTime({ now, lat, lon, underway: true }),
        dayOffset: 0,
      },
    ];
  }
  const candidates = [];
  const seen = new Set();
  for (let day = 0; day < Math.max(1, days); day++) {
    const reference = new Date(now.getTime() + day * 24 * 3600000);
    const departure = assumedDepartureTime({
      now: reference,
      lat,
      lon,
      underway: false,
      prepHours,
      dawnAltitudeDeg,
    });
    // Degenerate rules (polar no_dawn falls back to the reference
    // instant) would list the same time thrice — one candidate says it
    const key = departure.time.getTime();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push({ ...departure, dayOffset: day });
  }
  return candidates;
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

/* ------------------------------------------------------------------ *
 * Hull-grounded spectral motion kernel (work doc #56; SPEC §5.2 alt).
 *
 * The legacy kernel above rates motion from a single sinusoid at the
 * encounter period, tuned with hand-picked heel and pitch multipliers.
 * This kernel replaces the guesstimation with published physics when
 * the boat's hull is known, and falls back to the legacy kernel
 * per-hour when it is not — the simulation never invents a hull.
 *
 * Transfer functions: Jensen, Mansour & Olsen (2004), "Estimation of
 * ship motions using closed-form expressions", Ocean Engineering
 * 31(1) 61–85, https://doi.org/10.1016/S0029-8018(03)00108-2 —
 * closed-form heave, pitch and roll RAOs for a box-shaped uniformly
 * loaded displacement monohull, driven here at the encounter frequency
 * the legacy math already computes. Implemented from the paper's
 * published formulas; the DTU NetSSE transcription
 * (netsse/model/ship.py, GPL-3) was used as a notation cross-check
 * only, no code taken.
 *
 * Spectrum: Pierson–Moskowitz (Bretschneider form) from combined Hs
 * and Tp; response RMS values are ∫ TF²(ω)·S(ω) dω over the
 * encounter-mapped spectrum. Forecasts publish the ECMWF energy
 * period Tm−1 (mwp), so the peak period is derived via the PM
 * relation Tm−1 = Γ(5/4)·(4/5)^¼/ωp (≈ 0.857·Tp).
 *
 * Banding: the ISO 2631-1 comfort bands were always defined on
 * frequency-*weighted* acceleration; this kernel applies the W_f
 * motion-sickness weighting (ISO 2631-1 Annex A / ISO 8041 filter
 * set) to the acceleration spectrum before the bands see it, so the
 * Miserable tier means what the standard says.
 * ------------------------------------------------------------------ */

/** Seawater density (kg/m³), JMO/NetSSE convention. */
export const RHO_SEAWATER_KG_M3 = 1025;

/**
 * Ratio of the PM peak period to the energy (first-moment-minus-one)
 * period: Tp / Tm−1 = 2π / (Γ(5/4)·(4/5)^¼) ≈ 1.167. ECMWF's `mwp`
 * field is Tm−1, so forecasts need this conversion before the
 * spectrum can be built. Derived analytically from the PM shape (see
 * the kernel header); verified numerically against the moment
 * integrals.
 */
export const PM_PEAK_OVER_ENERGY_PERIOD = 1.167;

/**
 * ISO 2631-1 W_f weighting, vertical motion-sickness filter (Annex A
 * parameters, per ISO 8041 band-limit + transition + step filters).
 * Parameter set: f1 0.08 Hz, f2 0.63 Hz (band limits, Butterworth
 * Q = 1/√2), f4 0.25 Hz Q4 0.86 (transition), f5 0.0625 Hz Q5 0.80,
 * f6 0.10 Hz Q6 0.80 (upward step). Implemented from the published
 * filter cascade; reproduces the standard's 1/3-octave W_f table to
 * better than 0.01 dB at 0.1–2 Hz (tested).
 */
export const ISO2631_WF_F1_HZ = 0.08;
export const ISO2631_WF_F2_HZ = 0.63;
export const ISO2631_WF_F4_HZ = 0.25;
export const ISO2631_WF_Q4 = 0.86;
export const ISO2631_WF_F5_HZ = 0.0625;
export const ISO2631_WF_Q5 = 0.8;
export const ISO2631_WF_F6_HZ = 0.1;
export const ISO2631_WF_Q6 = 0.8;

/**
 * Magnitude of the ISO 2631-1 W_f weighting at a frequency.
 *
 * @param {number} frequencyHz - Frequency (Hz), clamped positive
 * @returns {number} Linear weighting factor (peak ≈ 1 around 0.2 Hz)
 */
export function iso2631WfWeighting(frequencyHz) {
  const f = Math.max(Number(frequencyHz) || 0, 1e-6);
  // Band limits: 2nd-order Butterworth high-pass (f1) and low-pass
  // (f2), Q = 1/√2 — with that Q the magnitude reduces to the
  // fc⁴/(f⁴ + fc⁴) forms below.
  const butterworthHp = (fc) => Math.sqrt(f ** 4 / (f ** 4 + fc ** 4));
  const butterworthLp = (fc) => Math.sqrt(fc ** 4 / (f ** 4 + fc ** 4));
  // Transition (f4, Q4) and the upward step's numerator/denominator
  // sections: general 2nd-order magnitudes.
  const secondOrder = (fc, q) => {
    const w = 2 * Math.PI * f;
    const wc = 2 * Math.PI * fc;
    return Math.sqrt(wc ** 4 / ((wc ** 2 - w ** 2) ** 2 + ((w * wc) / q) ** 2));
  };
  const step = (fa, qa, fb, qb) => {
    const w = 2 * Math.PI * f;
    const wa = 2 * Math.PI * fa;
    const wb = 2 * Math.PI * fb;
    return Math.sqrt(
      ((wa ** 2 - w ** 2) ** 2 + ((w * wa) / qa) ** 2) /
        ((wb ** 2 - w ** 2) ** 2 + ((w * wb) / qb) ** 2),
    );
  };
  return (
    butterworthHp(ISO2631_WF_F1_HZ) *
    butterworthLp(ISO2631_WF_F2_HZ) *
    secondOrder(ISO2631_WF_F4_HZ, ISO2631_WF_Q4) *
    step(ISO2631_WF_F5_HZ, ISO2631_WF_Q5, ISO2631_WF_F6_HZ, ISO2631_WF_Q6)
  );
}

/**
 * Peak period of a Pierson–Moskowitz sea from its energy period
 * (ECMWF `mwp`): Tp ≈ {@link PM_PEAK_OVER_ENERGY_PERIOD} · Tm−1.
 *
 * @param {number} energyPeriodS - Energy period Tm−1 (s)
 * @returns {number} Peak period Tp (s)
 */
export function peakPeriodFromEnergyPeriod(energyPeriodS) {
  return energyPeriodS * PM_PEAK_OVER_ENERGY_PERIOD;
}

/**
 * Pierson–Moskowitz (Bretschneider) spectrum value: S(ω) = (5/16) ·
 * Hs² · ωp⁴/ω⁵ · exp(−5/4·(ωp/ω)⁴). Normalizes to m0 = Hs²/16.
 *
 * @param {number} omegaRadS - Absolute wave frequency (rad/s)
 * @param {number} hsMeters - Significant wave height (m)
 * @param {number} peakPeriodS - Peak period Tp (s)
 * @returns {number} Spectral density (m²·s)
 */
export function piersonMoskowitzSpectrum(omegaRadS, hsMeters, peakPeriodS) {
  const omegaP = (2 * Math.PI) / peakPeriodS;
  const coefficient = (5 / 16) * hsMeters * hsMeters * omegaP ** 4;
  return (
    (coefficient / omegaRadS ** 5) * Math.exp(-1.25 * (omegaP / omegaRadS) ** 4)
  );
}

/**
 * JMO 2004 heave transfer function |η3/a| (m/m), wave amplitude to
 * heave amplitude, for a box-shaped displacement monohull.
 *
 * @param {number} omegaRadS - Absolute wave frequency (rad/s)
 * @param {number} betaRad - Encounter angle: heading relative to the
 *   wave travel direction (rad; 0 = following, ±π = head seas)
 * @param {number} speedMs - Vessel speed (m/s)
 * @param {number} lengthM - Waterline length (m)
 * @param {number} beamM - Beam (m)
 * @param {number} draughtM - Hull body (canoe) draught (m)
 * @param {number} blockCoeff - Block coefficient C_B (−)
 * @returns {number} Heave transfer amplitude (m/m)
 */
export function jmoHeaveTF(
  omegaRadS,
  betaRad,
  speedMs,
  lengthM,
  beamM,
  draughtM,
  blockCoeff,
) {
  const k = Math.max(omegaRadS ** 2 / G, 1e-9);
  const B = beamM * Math.min(Math.max(blockCoeff, 0.1), 1);
  const alpha =
    1 -
    (speedMs / Math.sqrt(G * lengthM)) *
      Math.sqrt(k * lengthM) *
      Math.cos(betaRad);
  const omegaE = omegaRadS - k * speedMs * Math.cos(betaRad);
  const A =
    2 *
    Math.sin((omegaE * omegaE * B) / (2 * G)) *
    Math.exp(-((omegaE * omegaE * draughtM) / G));
  const ke = Math.abs(k * Math.cos(betaRad));
  const f = Math.sqrt(
    (1 - k * draughtM) ** 2 + ((A * A) / (k * B * alpha ** 3)) ** 2,
  );
  const kappaAttenuation = Math.exp(-k * draughtM);
  const F =
    ((kappaAttenuation * f * 2) / (ke * lengthM)) *
    Math.sin((ke * lengthM) / 2);
  const eta =
    1 /
    Math.sqrt(
      (1 - 2 * k * draughtM * alpha ** 2) ** 2 +
        ((A * A) / (k * B * alpha ** 2)) ** 2,
    );
  return Math.abs(eta * F);
}

/**
 * JMO 2004 pitch transfer function |η5/a| (rad/m), wave amplitude to
 * pitch amplitude. Same hull inputs as {@link jmoHeaveTF}.
 *
 * @returns {number} Pitch transfer amplitude (rad/m)
 */
export function jmoPitchTF(
  omegaRadS,
  betaRad,
  speedMs,
  lengthM,
  beamM,
  draughtM,
  blockCoeff,
) {
  const k = Math.max(omegaRadS ** 2 / G, 1e-9);
  const B = beamM * Math.min(Math.max(blockCoeff, 0.1), 1);
  const alpha =
    1 -
    (speedMs / Math.sqrt(G * lengthM)) *
      Math.sqrt(k * lengthM) *
      Math.cos(betaRad);
  const omegaE = omegaRadS - k * speedMs * Math.cos(betaRad);
  const A =
    2 *
    Math.sin((omegaE * omegaE * B) / (2 * G)) *
    Math.exp(-((omegaE * omegaE * draughtM) / G));
  const ke = Math.abs(k * Math.cos(betaRad));
  const f = Math.sqrt(
    (1 - k * draughtM) ** 2 + ((A * A) / (k * B * alpha ** 3)) ** 2,
  );
  const kappaAttenuation = Math.exp(-k * draughtM);
  const Gjmo =
    ((kappaAttenuation * f * 24) / ((ke * lengthM) ** 2 * lengthM)) *
    (Math.sin((ke * lengthM) / 2) -
      ((ke * lengthM) / 2) * Math.cos((ke * lengthM) / 2));
  const eta =
    1 /
    Math.sqrt(
      (1 - 2 * k * draughtM * alpha ** 2) ** 2 +
        ((A * A) / (k * B * alpha ** 2)) ** 2,
    );
  return Math.abs(eta * Gjmo);
}

/**
 * Default waterplane area coefficient assumed for the roll model when
 * the hull form is unknown: a typical full-bodied cruising monohull.
 * An estimate, not a measurement — the payload marks roll numbers as
 * model estimates either way (work doc #56 degradation rules).
 */
export const ROLL_WATERPLANE_COEFF_DEFAULT = 0.75;

/**
 * Ratio of the aft-body beam length to the whole length in the JMO
 * simplified two-parcel roll model, v1 default: half the waterplane
 * coefficient (a midship-neutral parcel split). Overridable per hull.
 */
export const ROLL_AFT_BODY_RATIO_FACTOR = 0.5;

/**
 * Viscous-plus-sway roll damping ratio (μ in JMO's B44) with the
 * working canvas drawing: the mainsail's aerodynamic damping. Value
 * chosen so bare-pole resonant roll roughly doubles (PredictWind's
 * published guidance) against {@link ROLL_DAMPING_BARE_POLE}; the
 * pair is this kernel's first calibration target for the backtest
 * corpus (work doc #56).
 */
export const ROLL_DAMPING_SAILING = 0.08;

/** Viscous roll damping ratio with no main drawing (bare pole / motor). */
export const ROLL_DAMPING_BARE_POLE = 0.04;

/**
 * IMO A.685 roll-period factor for vessels under 45 m (from the
 * empirical T_N = 2·f·B/√GM, as referenced by JMO 2004 via
 * ADA147598).
 */
export const ROLL_PERIOD_FACTOR_SHORT_SHIP = 0.4;

/**
 * Roll natural period from beam and stability (IMO A.685 empirical,
 * the same relation JMO 2004 adopts for T_N): T_N = 2·f·B/√GM.
 *
 * @param {number} beamM - Beam (m)
 * @param {number} gmMeters - Transverse metacentric height (m)
 * @returns {number} Roll natural period (s)
 */
export function rollNaturalPeriodSeconds(beamM, gmMeters) {
  return (2 * ROLL_PERIOD_FACTOR_SHORT_SHIP * beamM) / Math.sqrt(gmMeters);
}

/**
 * Roll transfer of the paper's one-degree-of-freedom roll formulation
 * (Jensen, Mansour & Olsen 2004, §roll: the roll equation driven by
 * the wave slope, with the IMO A.685 natural-period empirical and the
 * viscous damping ratio μ as its two hull parameters): the transfer
 * of wave-slope amplitude to roll angle around resonance.
 *
 * Sanity properties (checked in the test suite): quasi-static limit —
 * long swell rolls the boat only to its slope; resonance amplifies
 * the slope by 1/(2μ); head/following seas excite no roll; halving μ
 * doubles resonant roll (the mainsail-damping guidance). This is the
 * small-vessel form of the paper's roll model — the two-parcel ship
 * variant ({@link jmoRollTF}) leaves its B/T ≈ 2–3.5, C_B ≈ 0.7–0.8
 * validity class for small wide hulls (B/T > 4.5, low C_B) and
 * over-predicts low-frequency excitation there; it is retained as
 * reference code, not used (work doc #56, implementation finding).
 *
 * Linear near-resonance over-predicts (real hulls saturate); the
 * number is labeled a model estimate in the payload either way.
 *
 * @param {number} omega0RadS - Absolute wave frequency (rad/s)
 * @param {number} omegaERadS - Encounter frequency (rad/s)
 * @param {number} betaRad - Encounter angle (rad; 0 = following)
 * @param {number} naturalPeriodS - Roll natural period T_N (s)
 * @param {number} dampingRatio - Viscous damping ratio μ
 * @returns {number} Roll transfer (rad per m of wave amplitude)
 */
export function rollTransfer1dof(
  omega0RadS,
  omegaERadS,
  betaRad,
  naturalPeriodS,
  dampingRatio,
) {
  const r = (omegaERadS * naturalPeriodS) / (2 * Math.PI);
  const slopePerAmp = (omega0RadS * omega0RadS) / G;
  const denominator = Math.sqrt((1 - r * r) ** 2 + (2 * dampingRatio * r) ** 2);
  return (Math.abs(Math.sin(betaRad)) * slopePerAmp) / denominator;
}

/**
 * Shape factor of the JMO two-parcel roll excitation moment: the sin(...)²
 * interference of the two hull parcels, normalized by the 2/ke
 * division it accompanies. In beam seas ke = k·cos(β) → 0 and the
 * raw quotient is a 0/0 limit — analytically finite (the sines scale
 * with ke too) — so small-ke cases take the closed limit
 * (δ + κ(1−δ))·L/2 · (2/ke) folded in. Retained with the two-parcel
 * variant for reference; see {@link rollTransfer1dof} for what the
 * kernel actually uses.
 *
 * @param {number} lengthM - Waterline length (m)
 * @param {number} ke - |k·cos β| (rad/m)
 * @param {number} delta - Aft-body length fraction δ (−)
 * @param {number} kappaParcel - Fore/aft parcel damping ratio κ (−)
 * @returns {number} (2/ke)·shape — the full multiplier, finite at ke=0
 */
function rollExcitationShape(lengthM, ke, delta, kappaParcel) {
  const halfL = (lengthM * ke) / 2;
  if (halfL < 1e-6) {
    // lim ke→0: sqrt(...) ≈ (δ + κ(1−δ))·L·ke/2; times 2/ke:
    return (delta + kappaParcel * (1 - delta)) * lengthM;
  }
  const a = delta * halfL;
  const b = (1 - delta) * halfL;
  const shape = Math.sqrt(
    Math.sin(a) ** 2 +
      kappaParcel ** 2 * Math.sin(b) ** 2 +
      2 * kappaParcel * Math.sin(a) * Math.sin(b) * Math.cos(2 * halfL),
  );
  return shape / ke;
}

/**
 * JMO 2004 roll transfer function |φ/a| (rad/m), wave amplitude to
 * roll angle amplitude. The viscous damping ratio follows the sail
 * state — the mainsail damps roll; bare-pole resonant roll roughly
 * doubles (PredictWind guidance, see the damping constants).
 *
 * @param {number} omegaRadS - Absolute wave frequency (rad/s)
 * @param {number} betaRad - Encounter angle (rad; 0 = following)
 * @param {number} speedMs - Vessel speed (m/s)
 * @param {number} lengthM - Waterline length (m)
 * @param {number} beamM - Beam (m)
 * @param {number} draughtM - Hull body draught (m)
 * @param {number} blockCoeff - Block coefficient C_B (−)
 * @param {number} waterplaneCoeff - Waterplane area coefficient C_WP (−)
 * @param {number} gmMeters - Transverse metacentric height (m)
 * @param {number} aftBodyRatio - Aft-body beam length ratio κ (0..C_WP)
 * @param {number} dampingRatio - Viscous damping ratio μ
 * @returns {number} Roll transfer amplitude (rad/m)
 */
export function jmoRollTF(
  omegaRadS,
  betaRad,
  speedMs,
  lengthM,
  beamM,
  draughtM,
  blockCoeff,
  waterplaneCoeff,
  gmMeters,
  aftBodyRatio,
  dampingRatio,
) {
  const rho = RHO_SEAWATER_KG_M3;
  // JMO's simplified roll hull needs the draught inside the beam
  // validity window: clamp to [B/6, min(B0, B1)] per the model's
  // construction (NetSSE transcription of the paper's bounds).
  const delta = Math.max(waterplaneCoeff - aftBodyRatio, 0);
  const gamma = Math.max(aftBodyRatio / (1 - delta), 1 / 6);
  const B1 = gamma * beamM;
  const T = Math.max(Math.min(draughtM, beamM, B1), beamM / 6, B1 / 6);
  const displacementKg = lengthM * beamM * T * blockCoeff * rho;
  const naturalPeriod = rollNaturalPeriodSeconds(beamM, gmMeters);
  const C44 = G * displacementKg * gmMeters;
  const B44crit = (C44 * naturalPeriod) / Math.PI;
  const A0 = (blockCoeff * beamM * T) / (delta + gamma * (1 - delta));
  const A1 = gamma * A0;

  // Hull-form wave damping polynomials, valid B/T ∈ [0.99, 6]
  // (JMO's validity window — clamped, noted in the payload when the
  // clamp bites is not tracked; the estimate label covers it).
  const dampingPoly = (overT) => {
    const bOverT = Math.min(Math.max(overT, 0.99), 6);
    if (bOverT >= 3) {
      return {
        a: 0.256 * bOverT - 0.286,
        b: -0.11 * bOverT - 2.55,
        d: 0.033 * bOverT - 1.419,
      };
    }
    return {
      a: -3.94 * bOverT + 13.69,
      b: -2.12 * bOverT - 1.89,
      d: 1.16 * bOverT - 7.97,
    };
  };
  const poly0 = dampingPoly(beamM / T);
  const poly1 = dampingPoly(B1 / T);

  const k = Math.max(omegaRadS ** 2 / G, 1e-100);
  const omegaE = Math.max(
    Math.abs(omegaRadS - k * speedMs * Math.cos(betaRad)),
    1e-100,
  );
  const ke = Math.max(Math.abs(k * Math.cos(betaRad)), 1e-100);

  const parcelDamping = (Aparcel, Bparcel, poly) =>
    Math.max(
      rho *
        Aparcel *
        Bparcel ** 2 *
        Math.sqrt((2 * G) / Bparcel) *
        poly.a *
        Math.exp(poly.b * omegaE ** -1.3) *
        omegaE ** poly.d,
      1e-100,
    );
  const b44_0 = parcelDamping(A0, beamM, poly0);
  const b44_1 = parcelDamping(A1, B1, poly1);
  const kappaParcel = Math.sqrt(1 + (b44_1 - b44_0) / b44_0);
  const B44inviscid =
    lengthM * b44_0 * (delta + kappaParcel ** 2 * (1 - delta));
  const B44total = B44inviscid + dampingRatio * B44crit;

  const excitation =
    Math.abs(Math.sin(betaRad)) *
    Math.sqrt((rho * G ** 2) / omegaE) *
    Math.sqrt(b44_0) *
    rollExcitationShape(lengthM, ke, delta, kappaParcel);
  return (
    excitation /
    Math.sqrt(
      (-(omegaE ** 2) * (naturalPeriod / (2 * Math.PI)) ** 2 + 1) ** 2 *
        C44 ** 2 +
        omegaE ** 2 * B44total ** 2,
    )
  );
}

/**
 * Block coefficient of a resolved hull: displacement over the
 * box L·B·T·ρ — the definition, not an estimate, when all four hull
 * numbers are known. Clamped into (0, 1] (the box bound).
 *
 * @param {object} hull - See {@link resolveHull}
 * @returns {number|null} C_B (−), null when the hull is incomplete
 */
export function blockCoefficientOf(hull) {
  if (!hullMotionReady(hull)) {
    return null;
  }
  const boxKg =
    hull.lengthWaterlineM *
    hull.beamM *
    hull.canoeDraughtM *
    RHO_SEAWATER_KG_M3;
  if (!(boxKg > 0)) {
    return null;
  }
  return Math.min(Math.max(hull.displacementKg / boxKg, 0.1), 1);
}

/**
 * Whether the hull description is complete enough for the spectral
 * motion kernel: waterline, beam, canoe draught and displacement all
 * finite and positive. Nothing is guessed — a missing number keeps
 * the hour on the legacy kernel (work doc #56 degradation rules).
 *
 * @param {object|null} hull - See {@link resolveHull}
 * @returns {boolean}
 */
export function hullMotionReady(hull) {
  return (
    hull != null &&
    [
      hull.lengthWaterlineM,
      hull.beamM,
      hull.canoeDraughtM,
      hull.displacementKg,
    ].every((v) => Number.isFinite(v) && v > 0)
  );
}

/**
 * Whether the resolved hull also carries what the roll model needs
 * beyond the motion kernel: a roll natural period — either measured
 * directly (the dock roll test, preferred: the IMO A.685 derivation
 * from GM is ship-calibrated and runs short for heavy full-keel
 * yachts) or derived from a metacentric height. Signal K publishes
 * neither field, so these are override settings — without one the
 * hour still gets spectral vertical acceleration but roll stays null
 * and the deck-work verdict reports its absence.
 *
 * @param {object|null} hull
 * @returns {boolean}
 */
export function hullRollReady(hull) {
  return (
    hullMotionReady(hull) &&
    ((Number.isFinite(hull.gmMeters) && hull.gmMeters > 0) ||
      (Number.isFinite(hull.rollNaturalPeriodS) && hull.rollNaturalPeriodS > 0))
  );
}

/**
 * Whether the hull form is one this monohull-adapted scale may judge:
 * hull type unknown (proceed — the scale is declared monohull) or
 * explicitly monohull. A known catamaran or trimaran refuses the
 * spectral kernel — the numbers would be silently wrong (work doc
 * #56), and the payload carries the mismatch so the UI can say why.
 *
 * @param {object|null} hull
 * @returns {boolean}
 */
export function hullTypeUsable(hull) {
  return (
    hull == null ||
    hull.hullType == null ||
    hull.hullType === "" ||
    hull.hullType === "monohull"
  );
}

/**
 * Resolves the hull description from Signal K `design.*` data and
 * plugin configuration: the vessel's published value wins (the boat
 * is the source of truth for its own hull), a configuration value is
 * the gap-filler for what the boat does not publish (displacement
 * and GM are the usual gaps), and what is left missing stays
 * missing. LWL has one extra published fallback: a boat that gives
 * its LOA but not its waterline gets the LOA as the coarsest LWL
 * stand-in (LWL ≤ LOA always), because a length wrong by ~15% keeps
 * the kernel running where a missing one would silently drop it to
 * the legacy fallback. Each carried field records its source so the
 * briefing can say which hull numbers are grounded and which are
 * absent.
 *
 * @param {object} cfg - Plugin/simulation config subset: `hull_lwl_m`,
 *   `hull_beam_m`, `hull_canoe_draft_m`, `hull_displacement_kg`,
 *   `hull_gm_m`, `hull_accel_point_m`, `hull_type` (string), plus
 *   the legacy `waterline_length_m` override (0 = follow the boat)
 * @param {object|null} [design] - Signal K `design.*` snapshot:
 *   `{lengthWaterlineM, lengthOverallM, beamM, canoeDraughtM, maxDraughtM, displacementKg}`
 * @returns {{lengthWaterlineM: number|null, beamM: number|null,
 *   canoeDraughtM: number|null, displacementKg: number|null,
 *   gmMeters: number|null, accelPointM: number, hullType: string|null,
 *   sources: object}} Resolved hull with per-field provenance
 */
export function resolveHull(cfg, design = null) {
  const pick = (override, published) => {
    if (Number.isFinite(published) && published > 0) {
      return { value: published, source: "signalk" };
    }
    if (Number.isFinite(override) && override > 0) {
      return { value: override, source: "config" };
    }
    return { value: null, source: "missing" };
  };
  // LWL chain: published waterline > config gap-filler > published
  // LOA as the coarsest stand-in > missing
  const lwlPublished = design?.lengthWaterlineM;
  const lwlOverride = cfg.hull_lwl_m ?? cfg.waterline_length_m;
  let lwl;
  if (Number.isFinite(lwlPublished) && lwlPublished > 0) {
    lwl = { value: lwlPublished, source: "signalk" };
  } else if (Number.isFinite(lwlOverride) && lwlOverride > 0) {
    lwl = { value: lwlOverride, source: "config" };
  } else if (
    Number.isFinite(design?.lengthOverallM) &&
    design.lengthOverallM > 0
  ) {
    lwl = { value: design.lengthOverallM, source: "signalk" };
  } else {
    lwl = { value: null, source: "missing" };
  }
  const beam = pick(cfg.hull_beam_m, design?.beamM);
  const canoe = pick(cfg.hull_canoe_draft_m, design?.canoeDraughtM);
  const displacement = pick(cfg.hull_displacement_kg, design?.displacementKg);
  const gm = pick(cfg.hull_gm_m, null);
  const rollPeriod = pick(cfg.hull_roll_period_s, null);
  return {
    lengthWaterlineM: lwl.value,
    beamM: beam.value,
    canoeDraughtM: canoe.value,
    displacementKg: displacement.value,
    gmMeters: gm.value,
    rollNaturalPeriodS: rollPeriod.value,
    accelPointM: Number.isFinite(cfg.hull_accel_point_m)
      ? cfg.hull_accel_point_m
      : 0,
    hullType:
      typeof cfg.hull_type === "string" && cfg.hull_type !== ""
        ? cfg.hull_type
        : null,
    sources: {
      lengthWaterlineM: lwl.source,
      beamM: beam.source,
      canoeDraughtM: canoe.source,
      displacementKg: displacement.source,
      gmMeters: gm.source,
      rollNaturalPeriodS: rollPeriod.source,
    },
  };
}

/**
 * Wraps an angle to [−π, π). Local helper of the spectral kernel —
 * this module stays import-free (shared browser/Node).
 *
 * @param {number} rad - Angle (rad)
 * @returns {number} Wrapped angle (rad)
 */
function wrapAnglePi(rad) {
  const wrapped =
    ((((rad + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) -
    Math.PI;
  return wrapped;
}

/** Low end of the spectral integration grid (rad/s, ≈ 31 s waves). */
export const MOTION_SPECTRUM_OMEGA_MIN = 0.2;
/** High end of the spectral integration grid (rad/s, ≈ 2.6 s waves). */
export const MOTION_SPECTRUM_OMEGA_MAX = 2.4;
/** Log-spaced bin count of the spectral integration grid. */
export const MOTION_SPECTRUM_BINS = 48;

/**
 * Spectral RMS motions of the resolved hull in one sea state (the
 * work doc #56 kernel): Pierson–Moskowitz spectrum from Hs and Tp,
 * JMO 2004 transfer functions at the encounter frequency, response
 * moments integrated over the spectrum. Vertical acceleration is
 * taken at a longitudinal point on board (default amidships) and
 * returned both raw and ISO 2631-1 W_f-weighted — the weighted value
 * is what the comfort bands rate. Roll needs a metacentric height;
 * without one it stays null and the caller knows why.
 *
 * @param {object} params
 * @param {number} params.hsMeters - Combined significant wave height (m)
 * @param {number} params.peakPeriodSeconds - Peak period Tp (s; use
 *   {@link peakPeriodFromEnergyPeriod} for ECMWF `mwp` inputs)
 * @param {number} params.waveTravelDirectionRad - Direction the waves
 *   travel toward (rad, true)
 * @param {number} params.headingRad - Vessel heading (rad, true)
 * @param {number} params.speedKnots - Speed over ground (kn)
 * @param {object} params.hull - Resolved hull, see {@link resolveHull}
 * @param {string|null} [params.sailState] - 'sailing' | 'motoring' |
 *   null: selects the roll damping ratio (main drawing or not)
 * @returns {{azMs2: number, azWeightedMs2: number, rmsRollDeg:
 *   number|null, rmsHeaveM: number, rmsPitchDeg: number,
 *   encounterOmegaPeak: number}} Spectral motion assessment
 */
export function hullMotionResponse({
  hsMeters,
  peakPeriodSeconds,
  waveTravelDirectionRad,
  headingRad,
  speedKnots,
  hull,
  sailState = null,
}) {
  const out = {
    azMs2: 0,
    azWeightedMs2: 0,
    rmsRollDeg: null,
    rmsHeaveM: 0,
    rmsPitchDeg: 0,
    encounterOmegaPeak: null,
  };
  if (!hullMotionReady(hull) || !(hsMeters > 0) || !(peakPeriodSeconds > 0)) {
    return out;
  }
  const betaRad = wrapAnglePi(waveTravelDirectionRad - headingRad);
  const speedMs = speedKnots * KN_TO_MS;
  const lengthM = hull.lengthWaterlineM;
  const beamM = hull.beamM;
  const draughtM = hull.canoeDraughtM;
  const cb = blockCoefficientOf(hull);
  const rollUsable = hullRollReady(hull);
  const rollParams = rollUsable
    ? {
        // Measured period wins over the GM-derived one — the dock
        // test is the boat telling you its own T_N, while the IMO
        // A.685 factor behind the derivation is ship-calibrated and
        // runs short for heavy full-keel yachts.
        naturalPeriod:
          Number.isFinite(hull.rollNaturalPeriodS) &&
          hull.rollNaturalPeriodS > 0
            ? hull.rollNaturalPeriodS
            : rollNaturalPeriodSeconds(beamM, hull.gmMeters),
        mu:
          sailState === "motoring"
            ? ROLL_DAMPING_BARE_POLE
            : ROLL_DAMPING_SAILING,
      }
    : null;

  let mAz = 0;
  let mAzWeighted = 0;
  let mRoll = 0;
  let mHeave = 0;
  let mPitch = 0;
  let peakWeightedRao = 0;
  let peakOmegaE = null;
  const n = MOTION_SPECTRUM_BINS;
  const logMin = Math.log(MOTION_SPECTRUM_OMEGA_MIN);
  const logMax = Math.log(MOTION_SPECTRUM_OMEGA_MAX);
  let previousOmega = null;
  let previousAz2S = null;
  let previousAz2SW = null;
  let previousRoll2S = null;
  let previousHeave2S = null;
  let previousPitch2S = null;
  for (let i = 0; i <= n; i++) {
    const omega =
      i === 0
        ? MOTION_SPECTRUM_OMEGA_MIN
        : Math.exp(logMin + ((logMax - logMin) * i) / n);
    const s = piersonMoskowitzSpectrum(omega, hsMeters, peakPeriodSeconds);
    const k = omega ** 2 / G;
    const omegaE = omega - k * speedMs * Math.cos(betaRad);
    const wf = iso2631WfWeighting(omegaE > 0 ? omegaE / (2 * Math.PI) : 0);
    let az2S = 0;
    let roll2S = 0;
    let heave2S = 0;
    let pitch2S = 0;
    if (omegaE > 0.01) {
      const heave = jmoHeaveTF(
        omega,
        betaRad,
        speedMs,
        lengthM,
        beamM,
        draughtM,
        cb,
      );
      const pitch = jmoPitchTF(
        omega,
        betaRad,
        speedMs,
        lengthM,
        beamM,
        draughtM,
        cb,
      );
      // Vertical displacement at the point: heave minus the pitch
      // lever (x forward of CoG); acceleration amplitude ωe²·|z|.
      const lever = Number.isFinite(hull.accelPointM) ? hull.accelPointM : 0;
      const zAmp = Math.abs(heave - lever * pitch);
      const azRao = omegaE * omegaE * zAmp;
      const rollRao = rollParams
        ? rollTransfer1dof(
            omega,
            omegaE,
            betaRad,
            rollParams.naturalPeriod,
            rollParams.mu,
          )
        : null;
      az2S = azRao * azRao * s;
      heave2S = heave * heave * s;
      pitch2S = pitch * pitch * s;
      if (rollRao != null) {
        roll2S = rollRao * rollRao * s;
      }
      if (azRao * wf > peakWeightedRao) {
        peakWeightedRao = azRao * wf;
        peakOmegaE = omegaE;
      }
    }
    if (previousOmega != null) {
      const dOmega = omega - previousOmega;
      mAz += ((previousAz2S + az2S) / 2) * dOmega;
      mAzWeighted += ((previousAz2SW + az2S * wf ** 2) / 2) * dOmega;
      mRoll += ((previousRoll2S + roll2S) / 2) * dOmega;
      mHeave += ((previousHeave2S + heave2S) / 2) * dOmega;
      mPitch += ((previousPitch2S + pitch2S) / 2) * dOmega;
    }
    previousOmega = omega;
    previousAz2S = az2S;
    previousAz2SW = az2S * wf ** 2;
    previousRoll2S = roll2S;
    previousHeave2S = heave2S;
    previousPitch2S = pitch2S;
  }
  out.azMs2 = Math.sqrt(mAz);
  out.azWeightedMs2 = Math.sqrt(mAzWeighted);
  out.rmsRollDeg = rollParams ? Math.sqrt(mRoll) * (180 / Math.PI) : null;
  out.rmsHeaveM = Math.sqrt(mHeave);
  out.rmsPitchDeg = Math.sqrt(mPitch) * (180 / Math.PI);
  out.encounterOmegaPeak = peakOmegaE;
  return out;
}

/**
 * PredictWind's operational RMS roll limit: 4°, the amplitude at
 * which a crew can still move around the boat and complete tasks
 * safely on deck (PredictWind wave-polar help page, as cited in work
 * doc #56).
 */
export const DECK_WORK_ROLL_LIMIT_DEG = 4;

/**
 * PredictWind's operational vertical acceleration limit: 0.2 g, at
 * or below which tasks can be performed safely and seasickness stays
 * unlikely.
 */
export const TASKS_ACCELERATION_LIMIT_G = 0.2;

/**
 * Roll RMS bands (degrees) at or above which the roll metric votes a
 * Sereno tier of its own (work doc #56, Minerva calibration): ≥ 5°
 * caps the hour at Sporty, ≥ 9° at Rough, ≥ 13° at Miserable; below 5°
 * roll does not vote at all.
 *
 * Provenance: the 4° line is PredictWind's published RMS deck-work
 * limit (below it the crew works on deck freely — comfort is not the
 * constraint, so no vote); the 5° floor sits just above it. The upper
 * cuts are calibrated against this crew's own day-level verdicts on
 * the Minerva passage (2026-10-23/24/25) with the measured roll
 * period: 8.6° RMS → "sporty", 12.4° RMS → "rough"/"miserable" —
 * three data points, so the cuts are a first calibration to be
 * refined by the corpus backtest, and the payload labels roll
 * figures as model estimates.
 */
export const ROLL_BANDS_DEG = [5, 9, 13];

/**
 * Rates an RMS roll angle on the Sereno scale ({@link ROLL_BANDS_DEG}).
 * Below the first band roll does not vote — the hour is judged on the
 * other vectors alone.
 *
 * @param {number|null} rollDeg - RMS roll (degrees), null when unknown
 * @returns {string|null} "sporty" | "rough" | "miserable" | null
 */
export function rateRoll(rollDeg) {
  if (!Number.isFinite(rollDeg)) {
    return null;
  }
  if (rollDeg < ROLL_BANDS_DEG[0]) {
    return null;
  }
  if (rollDeg < ROLL_BANDS_DEG[1]) {
    return "sporty";
  }
  if (rollDeg < ROLL_BANDS_DEG[2]) {
    return "rough";
  }
  return "miserable";
}

/**
 * Crew-action verdict for an hour: do the spectral motion numbers
 * allow deck work? Two independent PredictWind limits — RMS roll for
 * moving on deck, weighted acceleration for tasks and seasickness —
 * compose into one label: "ok" (both met), "roll_limit" (roll over,
 * acceleration fine: hold the rail), "accel_limit" (acceleration
 * over: hatches shut, cooking dubious), "both_limits" (nobody goes
 * out). Null when the numbers are unavailable (legacy kernel or no
 * GM for roll — the flag never invents).
 *
 * @param {number|null} rmsRollDeg - RMS roll (degrees), null unknown
 * @param {number|null} azMs2 - RMS vertical acceleration (m/s²)
 * @returns {"ok"|"roll_limit"|"accel_limit"|"both_limits"|null}
 */
export function deckWorkOf(rmsRollDeg, azMs2) {
  if (!Number.isFinite(rmsRollDeg) || !Number.isFinite(azMs2)) {
    return null;
  }
  const rollOver = rmsRollDeg > DECK_WORK_ROLL_LIMIT_DEG;
  const accelOver = azMs2 > TASKS_ACCELERATION_LIMIT_G * G;
  if (rollOver && accelOver) return "both_limits";
  if (rollOver) return "roll_limit";
  if (accelOver) return "accel_limit";
  return "ok";
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
  // Motion amplitude: half the significant wave height — the crest
  // amplitude of the sea the boat rides — driven at the encounter
  // frequency (ω²·a, ω = 2π/Te), floored at the period the hull starts
  // bridging instead of following. This is deliberately the crest
  // amplitude, not the pure sinusoid's RMS elevation (Hs/(2√2)): the
  // factor and the AZ band constants were calibrated together against
  // the vessel's own history (SPEC §7), so they move as a pair — do
  // not change one without re-running the backtest.
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
  // Motion kernel selection (work doc #56): with a complete hull and
  // a usable hull type the spectral JMO kernel judges the hour —
  // W_f-weighted acceleration against the ISO bands, RMS roll against
  // the deck-work limits. Anything missing (a hull number, a GM for
  // roll, or a known non-monohull form) keeps the hour on the legacy
  // kernel, and the breakdown says which ran.
  const hullUsable =
    hullTypeUsable(vessel.hull) &&
    hullMotionReady(vessel.hull) &&
    Number.isFinite(sea.hsMeters) &&
    sea.hsMeters > 0 &&
    Number.isFinite(sea.tpSeconds) &&
    sea.tpSeconds > 0;
  let acceleration;
  if (hullUsable) {
    const motion = hullMotionResponse({
      hsMeters: sea.hsMeters,
      peakPeriodSeconds: sea.tpSeconds,
      waveTravelDirectionRad: sea.waveTravelDirectionRad ?? vessel.headingRad,
      headingRad: vessel.headingRad,
      speedKnots: vessel.sogKnots,
      hull: vessel.hull,
      sailState: vessel.sailState ?? null,
    });
    acceleration = {
      kernel: "jmo",
      encounterPeriod: motion.encounterOmegaPeak
        ? (2 * Math.PI) / motion.encounterOmegaPeak
        : Infinity,
      base: motion.azMs2,
      value: motion.azWeightedMs2,
      rmsRollDeg: motion.rmsRollDeg,
      rmsHeaveM: motion.rmsHeaveM,
      rmsPitchDeg: motion.rmsPitchDeg,
      hullMismatch: !hullTypeUsable(vessel.hull) ? vessel.hull.hullType : null,
      deckWork: deckWorkOf(motion.rmsRollDeg, motion.azWeightedMs2),
    };
  } else {
    acceleration = verticalAcceleration(sea, vessel, wind);
    acceleration.kernel = "legacy";
    acceleration.rmsRollDeg = null;
    acceleration.deckWork = null;
    acceleration.hullMismatch =
      vessel.hull && !hullTypeUsable(vessel.hull) ? vessel.hull.hullType : null;
  }
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
  // The damping is physical — the sail actually damps the motion —
  // so the returned acceleration value carries it too (the rows'
  // azMs2 shows the measured reality), not just the tier.
  const motionValue = vessel.downwindStabilized
    ? acceleration.value * DOWNWIND_STABILIZER_DAMPING
    : acceleration.value;
  // The roll metric votes its own tier (work doc #56, Minerva
  // calibration): a_z cannot see roll, and the crew's worst days were
  // roll days. The downwind-sail damping applies to the roll figure
  // too — the stabilizer's whole purpose is roll — though the 0.78
  // ratio was measured on a_z pairs, so this is the documented
  // assumption of that reuse. The slatting multiplier stays out: bare
  // poles already double roll through the damping ratio, and the
  // three-way rule suppresses the slatting flag for drawing sails.
  const rollDeg =
    acceleration.rmsRollDeg == null
      ? null
      : vessel.downwindStabilized
        ? acceleration.rmsRollDeg * DOWNWIND_STABILIZER_DAMPING
        : acceleration.rmsRollDeg;
  const rollComfort = rateRoll(rollDeg);
  let motionComfort = rateAcceleration(
    slatting ? motionValue * SLATTING_MULTIPLIER : motionValue,
  );
  if (rollComfort != null) {
    motionComfort = worseComfort(motionComfort, rollComfort);
  }
  const comfort = worseComfort(awsComfort, motionComfort);
  return {
    awsKnots,
    awsComfort,
    acceleration: { ...acceleration, value: motionValue, rollComfort },
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
