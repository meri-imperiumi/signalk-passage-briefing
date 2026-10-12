/**
 * Offline ephemeris engine (work doc #3, Phase 2).
 *
 * Everything predictable in the sky is computed locally with
 * `@openwaters/almanac` (MIT, zero transitive dependencies — the
 * migration work doc #35 replaces astronomy-engine, its upstream
 * source): no network, no bandwidth budget spent. The module produces
 *
 * - planetary conjunctions and oppositions during nautical night,
 * - meteor-shower peaks (static annual calendar) gated by moonlight
 *   and horizon,
 * - daily twilight times and moon context (`celestialNights`) for the
 *   briefing payload — the webapp timeline picks its night glyph
 *   (waxing/waning/full) from the moon phase instead of a fixed
 *   crescent,
 * - the full tactical visibility gate the work document specifies:
 *   nautical-night time window, cloud cover under 30 %, altitude over
 *   15° to clear the marine boundary layer, and moon set or crescent
 *   for meteors and faint auroras.
 *
 * Unlike the Phase-1 sources this module never fetches: it is a hard
 * require, and a failure in one computation degrades only that event.
 *
 * The visibility gate also backs the Phase-1 aurora alert
 * (`celestial-source.js`), replacing its coarse local-night check.
 *
 * Almanac serves 1950 through 2100 and throws
 * `AlmanacOutOfRangeError` outside that window; the event builders
 * degrade those failures to null bounds or empty lists like any other
 * missing crossing (polar day/night behaves the same way).
 *
 * Beyond the migration (work doc #35), the module also emits events
 * astronomy-engine had no off-the-shelf answer for: discrete moon
 * phase instants, and lunar/solar eclipses with built-in observer
 * visibility — the timeline's sky items and the strategic dark-sky
 * notes read these.
 *
 * @file celestial-ephemeris.js
 */

const {
  lunarEclipseVisibility,
  lunarEclipses,
  moonAltAz,
  moonIllumination: almanacMoonIllumination,
  moonEvents,
  planetAltAz,
  planetIllumination,
  searchMoonPhases,
  solarEclipses,
  sunAltAz,
  sunEvents,
} = require("@openwaters/almanac");

/**
 * Sun altitude (degrees) below which it is nautical night: the
 * visibility gate's time window (bright event horizon, dark sky).
 */
const NAUTICAL_TWILIGHT_DEG = -12;

/**
 * Angular separation (degrees) below which two planets count as in
 * conjunction.
 */
const CONJUNCTION_SEPARATION_DEG = 2.0;

/**
 * Elongation from the Sun (degrees) at or above which a superior
 * planet counts as at opposition (peak brightness, up all night).
 */
const OPPOSITION_ELONGATION_DEG = 178;

/**
 * Altitude (degrees) a sky object must clear to be worth reporting:
 * marine boundary-layer haze eats anything lower.
 */
const MIN_ALTITUDE_DEG = 15;

/**
 * Moon illumination fraction at or below which the sky counts as dark
 * enough for faint events (meteor showers, faint auroras).
 */
const MAX_MOON_ILLUMINATION = 0.3;

/**
 * Maximum altitude a meteor radiant can reach from the vessel's
 * latitude (90° − |lat − dec|) for the shower to be worth reporting.
 */
const MIN_RADIANT_ALTITUDE_DEG = 20;

/**
 * Forecast cloud cover (percent) at or below which the sky is
 * considered clear enough for a sky event.
 */
const CLOUD_COVER_MAX_PERCENT = 30;

/**
 * Watch-note copy for the discrete moon phases (work doc #35): the
 * new moon names the darkest skies, the full moon the moonlit
 * watches; the quarters mark the half-lit evenings.
 */
const MOON_PHASE_LABELS = {
  new: "New Moon — darkest skies of the passage",
  firstQuarter: "First Quarter Moon",
  full: "Full Moon — moonlit night watches",
  lastQuarter: "Last Quarter Moon",
};

/**
 * Watch-note copy for visible eclipses (work doc #35), keyed by the
 * almanac eclipse kinds.
 */
const ECLIPSE_DESCRIPTIONS = {
  lunar: {
    penumbral: "Penumbral lunar eclipse — faint shading of the Moon at peak",
    partial: "Partial lunar eclipse — a bite out of the Moon at peak",
    total: "Total lunar eclipse — copper Moon at peak",
  },
  solar: {
    partial: "Partial",
    annular: "Annular",
  },
};

/**
 * Major annual meteor showers with well-behaved peaks. `peakHourUtc`
 * is the typical shower maximum expressed in UTC hours on the peak
 * date (approximate — the gate is a night-level screen, not an
 * ephemeris of the maximum itself); `dec` is the radiant declination;
 * `zhr` the nominal zenith hourly rate.
 */
const METEOR_SHOWERS = [
  { name: "Quadrantids", month: 1, day: 3, peakHourUtc: 21, dec: 49, zhr: 110 },
  { name: "Lyrids", month: 4, day: 22, peakHourUtc: 14, dec: 34, zhr: 18 },
  { name: "Eta Aquariids", month: 5, day: 6, peakHourUtc: 2, dec: -1, zhr: 50 },
  {
    name: "Delta Aquariids",
    month: 7,
    day: 30,
    peakHourUtc: 20,
    dec: -22,
    zhr: 25,
  },
  { name: "Perseids", month: 8, day: 12, peakHourUtc: 20, dec: 58, zhr: 100 },
  { name: "Orionids", month: 10, day: 21, peakHourUtc: 21, dec: 15, zhr: 20 },
  { name: "Leonids", month: 11, day: 17, peakHourUtc: 6, dec: 22, zhr: 15 },
  { name: "Geminids", month: 12, day: 14, peakHourUtc: 13, dec: 32, zhr: 120 },
  { name: "Ursids", month: 12, day: 22, peakHourUtc: 10, dec: 76, zhr: 10 },
];

/**
 * Naked-eye planets the module watches for conjunctions; oppositions
 * only apply to the superior ones. Bodies use almanac's lowercase
 * planet identifiers; the altitude helpers also accept astronomy-
 * engine-style capitalized body names for compatibility.
 */
const PLANETS = [
  { body: "venus", name: "Venus", superior: false },
  { body: "mars", name: "Mars", superior: true },
  { body: "jupiter", name: "Jupiter", superior: true },
  { body: "saturn", name: "Saturn", superior: true },
];

/**
 * Search-window length (milliseconds) for the next rise, set, or
 * twilight crossing: the 1.5-day limit the astronomy-engine searches
 * used, kept so a missing crossing degrades at the same boundary.
 */
const SEARCH_WINDOW_MS = 1.5 * 86400000;

/**
 * Builds an almanac observer for a vessel position.
 *
 * @param {number} lat - Degrees
 * @param {number} lon - Degrees east
 * @returns {{latitudeDeg: number, longitudeDeg: number}} Observer
 */
function observerAt(lat, lon) {
  return { latitudeDeg: lat, longitudeDeg: lon };
}

/**
 * Resolves a body name to an almanac position function. Accepts the
 * astronomy-engine-style capitalized names (`Sun`, `Moon`, `Venus`)
 * and almanac's lowercase planet identifiers.
 *
 * @param {string} body - Body name
 * @returns {function(Date, object): {altDeg: number, azDeg: number}}
 */
function altAzFunctionFor(body) {
  if (body === "Sun") {
    return sunAltAz;
  }
  if (body === "Moon") {
    return moonAltAz;
  }
  const planet = body.toLowerCase();
  if (planet === "earth") {
    throw new RangeError(`Invalid body: ${body}`);
  }
  return (time, observer) => planetAltAz(planet, time, observer);
}

/**
 * Altitude of a solar-system body above the local horizon, refraction
 * included (the gate compares against haze, not against geometric
 * sunrise lines).
 *
 * @param {string} body - Body name (`Sun`, `Moon`, or a planet)
 * @param {Date} date - Instant
 * @param {number} lat - Degrees
 * @param {number} lon - Degrees east
 * @returns {number} Altitude in degrees (negative below horizon)
 */
function bodyAltitudeDeg(body, date, lat, lon) {
  return altAzFunctionFor(body)(date, observerAt(lat, lon)).altDeg;
}

/**
 * Moon phase angle at an instant: 0 = new, 90 = first quarter,
 * 180 = full, 270 = third quarter. The webapp maps this onto its
 * night glyphs (work doc #3: actual moon phase instead of a fixed
 * crescent). Almanac carries the phase as a 0..1 cycle (0 = new,
 * 0.5 = full); the degree form is its 360° mapping.
 *
 * @param {Date} date - Instant
 * @returns {number} Phase angle 0..360 degrees
 */
function moonPhaseDeg(date) {
  return almanacMoonIllumination(date).phase * 360;
}

/**
 * Moon illumination fraction at an instant.
 *
 * @param {Date} date - Instant
 * @returns {number} Illuminated fraction 0..1
 */
function moonIllumination(date) {
  return almanacMoonIllumination(date).fraction;
}

/**
 * Whether the instant falls in nautical night (Sun below the nautical
 * twilight line): the visibility gate's time-of-day check.
 *
 * @param {Date} date - Instant
 * @param {number} lat - Degrees
 * @param {number} lon - Degrees east
 * @returns {boolean}
 */
function isNauticalNight(date, lat, lon) {
  return bodyAltitudeDeg("Sun", date, lat, lon) < NAUTICAL_TWILIGHT_DEG;
}

/**
 * Twilight times for the night starting at or after `date` at a
 * position: the crossings of the civil (−6°), nautical (−12°) and
 * astronomical (−18°) Sun-altitude lines. A night that misses a
 * crossing (polar day/night) degrades that bound to null.
 *
 * Dusk chain first: the first falling crossing of each line, each
 * nested inside the previous one, then the dawn chain searches after
 * the dusk anchor so both sides belong to the same night. One
 * `sunEvents` call per side replaces the astronomy-engine search
 * chain; almanac returns every crossing in the window already sorted.
 *
 * @param {Date} date - Instant the search starts from
 * @param {number} lat - Degrees
 * @param {number} lon - Degrees east
 * @returns {{civilDusk: string|null, nauticalDusk: string|null,
 *   astronomicalDusk: string|null, astronomicalDawn: string|null,
 *   nauticalDawn: string|null, civilDawn: string|null}} ISO stamps
 */
function twilightTimes(date, lat, lon) {
  const observer = observerAt(lat, lon);
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  try {
    const duskEvents = sunEvents(
      date,
      new Date(date.getTime() + SEARCH_WINDOW_MS),
      observer,
    );
    const firstAfter = (kind, after) =>
      duskEvents.find(
        (e) => e.kind === kind && (after == null || e.time > after),
      )?.time ?? null;
    const civilDusk = firstAfter("civilDusk");
    const nauticalDusk = civilDusk
      ? firstAfter("nauticalDusk", civilDusk)
      : null;
    const astronomicalDusk = nauticalDusk
      ? firstAfter("astroDusk", nauticalDusk)
      : null;

    // The dawn chain starts after the dusk anchor; almanac's crossings
    // are exact roots, so the astronomy-engine +2 min tangency skip is
    // unnecessary — distinct kinds are distinct instants.
    const anchor = astronomicalDusk ?? nauticalDusk ?? civilDusk ?? date;
    const anchorMs = new Date(anchor).getTime() + 120000;
    const dawnEvents = sunEvents(
      new Date(anchorMs),
      new Date(anchorMs + SEARCH_WINDOW_MS),
      observer,
    );
    const astronomicalDawn =
      dawnEvents.find((e) => e.kind === "astroDawn")?.time ?? null;
    const nauticalDawn =
      (astronomicalDawn
        ? dawnEvents.find(
            (e) => e.kind === "nauticalDawn" && e.time > astronomicalDawn,
          )?.time
        : null) ??
      dawnEvents.find((e) => e.kind === "nauticalDawn")?.time ??
      null;
    const civilDawn =
      (nauticalDawn
        ? dawnEvents.find(
            (e) => e.kind === "civilDawn" && e.time > nauticalDawn,
          )?.time
        : null) ??
      dawnEvents.find((e) => e.kind === "civilDawn")?.time ??
      null;

    return {
      civilDusk: iso(civilDusk),
      nauticalDusk: iso(nauticalDusk),
      astronomicalDusk: iso(astronomicalDusk),
      astronomicalDawn: iso(astronomicalDawn),
      nauticalDawn: iso(nauticalDawn),
      civilDawn: iso(civilDawn),
    };
  } catch (_error) {
    return {
      civilDusk: null,
      nauticalDusk: null,
      astronomicalDusk: null,
      astronomicalDawn: null,
      nauticalDawn: null,
      civilDawn: null,
    };
  }
}

/**
 * Daily night context for the briefing payload (`celestialNights`):
 * one entry per day with the twilight times of that night, the moon
 * phase/illumination at nightfall, and the sun/moon rise and set
 * stamps bracketing the night (work doc #33 — the sky line reads
 * these instead of re-deriving astronomy in the browser). The
 * timeline's night glyph and any future "when is it really dark"
 * display read this instead of re-deriving astronomy in the browser.
 *
 * Rise/set semantics: sunset is the setting crossing before the
 * night's civil dusk, sunrise the rising crossing after the dusk
 * anchor; moonrise/moonset are the moon's next crossings after dusk
 * (a moon already up at dusk reports tomorrow's rise — the set stamp
 * is tonight's). Polar day/night and missing crossings degrade to
 * null like the twilight bounds.
 *
 * @param {object} params
 * @param {Date} params.from - Window start
 * @param {number} [params.days=8] - Number of nights
 * @param {number} params.lat - Degrees
 * @param {number} params.lon - Degrees east
 * @param {number} [params.eyeHeightM=0] - Eye height above the water
 *   (meters, work doc #35): rise/set stamps shift for the dip of the
 *   vessel's raised horizon. Twilight lines are altitude angles, not
 *   horizon crossings, so they stay put; only the rise/set stamps
 *   move (a couple of minutes at cockpit height).
 * @returns {Array<{timestamp: string, moonPhaseDeg: number,
 *   moonIllumination: number, civilDusk: string|null,
 *   nauticalDusk: string|null, astronomicalDusk: string|null,
 *   astronomicalDawn: string|null, nauticalDawn: string|null,
 *   civilDawn: string|null, sunrise: string|null, sunset: string|null,
 *   moonrise: string|null, moonset: string|null}>}
 */
function celestialNights({ from, days = 8, lat, lon, eyeHeightM = 0 }) {
  const nights = [];
  const observer = observerAt(lat, lon);
  // Eye height drives the dip of the apparent horizon: 0 keeps the
  // geometric sea-level crossing, a cockpit height shifts the stamps
  const eye =
    Number.isFinite(eyeHeightM) && eyeHeightM > 0 && eyeHeightM <= 10000
      ? eyeHeightM
      : 0;
  // First crossing of a body after `start`; missing crossings (polar
  // day/night, no crossing within the window) degrade to null
  const riseSet = (body, direction, start) => {
    try {
      const events = (body === "Moon" ? moonEvents : sunEvents)(
        start,
        new Date(start.getTime() + SEARCH_WINDOW_MS),
        observer,
        eye,
      );
      const kind = direction < 0 ? "set" : "rise";
      return events.find((e) => e.kind === kind)?.time.toISOString() ?? null;
    } catch (_error) {
      return null;
    }
  };
  for (let d = 0; d < days; d++) {
    const base = new Date(from.getTime() + d * 86400000);
    const twilights = twilightTimes(base, lat, lon);
    const anchor = twilights.nauticalDusk
      ? new Date(twilights.nauticalDusk)
      : base;
    // Sunset: the setting crossing before this night's civil dusk —
    // search from 18 hours back so the forward window covers it
    const civilDuskMs = twilights.civilDusk
      ? new Date(twilights.civilDusk).getTime()
      : null;
    const sunset = civilDuskMs
      ? riseSet("Sun", -1, new Date(civilDuskMs - 18 * 3600000))
      : null;
    // Dawn side: the next rising after the dusk anchor (the same
    // night's sunrise)
    const afterDusk = new Date(anchor.getTime() + 120000);
    const sunrise = riseSet("Sun", 1, afterDusk);
    // Moon brackets (work docs #32/#33): the next set and rise after
    // dusk — a moon already up at dusk reports tomorrow's rise
    const moonset = riseSet("Moon", -1, afterDusk);
    const moonrise = riseSet("Moon", 1, afterDusk);
    nights.push({
      timestamp: anchor.toISOString(),
      moonPhaseDeg: Math.round(moonPhaseDeg(anchor) * 10) / 10,
      moonIllumination: Math.round(moonIllumination(anchor) * 1000) / 1000,
      ...twilights,
      sunset,
      sunrise,
      moonrise,
      moonset,
    });
  }
  return nights;
}

/**
 * The cloud half of the visibility gate: pass when no lookup is
 * available (the Weather API provider carries no cloud cover), else
 * when the interpolated cover is at or under the threshold.
 *
 * @param {string} timestamp - Event instant (ISO)
 * @param {((timestamp: string) => number|null)|undefined} cloudCoverAt
 * @returns {boolean}
 */
function passesCloudGate(timestamp, cloudCoverAt) {
  if (typeof cloudCoverAt !== "function") {
    return true;
  }
  const cover = cloudCoverAt(timestamp);
  if (cover == null) {
    return true;
  }
  return cover <= CLOUD_COVER_MAX_PERCENT;
}

/**
 * The lunar half of the visibility gate for faint events (meteors,
 * faint auroras): moon either set or a crescent.
 *
 * @param {Date} date - Instant
 * @param {number} lat - Degrees
 * @param {number} lon - Degrees east
 * @returns {boolean}
 */
function passesMoonGate(date, lat, lon) {
  return (
    bodyAltitudeDeg("Moon", date, lat, lon) <= 0 ||
    moonIllumination(date) < MAX_MOON_ILLUMINATION
  );
}

/**
 * Angular separation between two bodies as seen from a position,
 * from their refracted topocentric alt/az (same sky separation as the
 * astronomy-engine vector angle it replaces).
 *
 * @param {string} bodyA - Body name
 * @param {string} bodyB - Body name
 * @param {Date} date - Instant
 * @param {number} lat - Degrees
 * @param {number} lon - Degrees east
 * @returns {number} Separation in degrees
 */
function angularSeparationDeg(bodyA, bodyB, date, lat, lon) {
  const observer = observerAt(lat, lon);
  const a = altAzFunctionFor(bodyA)(date, observer);
  const b = altAzFunctionFor(bodyB)(date, observer);
  const rad = Math.PI / 180;
  const cos = Math.min(
    1,
    Math.max(
      -1,
      Math.sin(a.altDeg * rad) * Math.sin(b.altDeg * rad) +
        Math.cos(a.altDeg * rad) *
          Math.cos(b.altDeg * rad) *
          Math.cos((a.azDeg - b.azDeg) * rad),
    ),
  );
  return Math.acos(cos) / rad;
}

/**
 * Scans the window for planetary conjunctions and oppositions.
 *
 * Hourly steps: conjunction pairs are tracked at their closest night
 * hour (separation under {@link CONJUNCTION_SEPARATION_DEG}, both
 * bodies above the haze line); oppositions fire once per superior
 * planet when it stands opposite the Sun during nautical night. Each
 * event must pass the cloud gate before it is reported.
 *
 * @param {object} params
 * @param {Date} params.from - Window start
 * @param {number} params.hours - Window length
 * @param {number} params.lat - Degrees
 * @param {number} params.lon - Degrees east
 * @param {((timestamp: string) => number|null)|undefined} [params.cloudCoverAt]
 * @returns {Array<{kind: string, timestamp: string, tactical: boolean,
 *   description: string}>}
 */
function planetaryEvents({ from, hours, lat, lon, cloudCoverAt }) {
  const events = [];
  const seenOppositions = new Set();
  const closest = new Map();
  const end = from.getTime() + hours * 3600000;
  for (let t = from.getTime(); t < end; t += 3600000) {
    const date = new Date(t);
    let nautical;
    try {
      nautical = isNauticalNight(date, lat, lon);
    } catch (_error) {
      continue;
    }
    if (!nautical) {
      continue;
    }
    // Closest night-hour separation per pair; only the final scan
    // hour decides whether the minimum was close enough
    for (let i = 0; i < PLANETS.length; i++) {
      for (let j = i + 1; j < PLANETS.length; j++) {
        const a = PLANETS[i];
        const b = PLANETS[j];
        const key = `${a.name}|${b.name}`;
        const separation = angularSeparationDeg(a.body, b.body, date, lat, lon);
        const previous = closest.get(key);
        if (!previous || separation < previous.separation) {
          closest.set(key, { separation, date });
        }
      }
    }
    for (const planet of PLANETS) {
      if (!planet.superior || seenOppositions.has(planet.name)) {
        continue;
      }
      let elongation;
      try {
        elongation = planetIllumination(planet.body, date).elongationDeg;
      } catch (_error) {
        continue;
      }
      if (
        elongation >= OPPOSITION_ELONGATION_DEG &&
        bodyAltitudeDeg(planet.body, date, lat, lon) >= MIN_ALTITUDE_DEG &&
        passesCloudGate(date.toISOString(), cloudCoverAt)
      ) {
        seenOppositions.add(planet.name);
        events.push({
          kind: "opposition",
          timestamp: date.toISOString(),
          tactical: true,
          description: `${planet.name} at opposition — up all night at its brightest`,
        });
      }
    }
  }
  for (const [key, { separation, date }] of closest) {
    if (separation >= CONJUNCTION_SEPARATION_DEG) {
      continue;
    }
    const [aName, bName] = key.split("|");
    const a = PLANETS.find((p) => p.name === aName);
    const b = PLANETS.find((p) => p.name === bName);
    if (
      bodyAltitudeDeg(a.body, date, lat, lon) >= MIN_ALTITUDE_DEG &&
      bodyAltitudeDeg(b.body, date, lat, lon) >= MIN_ALTITUDE_DEG &&
      passesCloudGate(date.toISOString(), cloudCoverAt)
    ) {
      events.push({
        kind: "conjunction",
        timestamp: date.toISOString(),
        tactical: true,
        description: `${aName} and ${bName} in conjunction: ${separation.toFixed(1)}° apart`,
      });
    }
  }
  return events;
}

/**
 * Meteor-shower peak events inside the window. The gate: peak within
 * the window, Moon set or a crescent (illumination under 30 %), the
 * radiant able to clear 20° from the vessel's latitude, nautical
 * night at the peak, and forecast sky clear enough.
 *
 * @param {object} params
 * @param {Date} params.from - Window start
 * @param {number} params.hours - Window length
 * @param {number} params.lat - Degrees
 * @param {number} params.lon - Degrees east
 * @param {((timestamp: string) => number|null)|undefined} [params.cloudCoverAt]
 * @returns {Array<{kind: string, timestamp: string, tactical: boolean,
 *   description: string}>}
 */
function meteorEvents({ from, hours, lat, lon, cloudCoverAt }) {
  const events = [];
  const end = from.getTime() + hours * 3600000;
  for (const shower of METEOR_SHOWERS) {
    for (const year of [from.getUTCFullYear(), from.getUTCFullYear() + 1]) {
      const peak = new Date(
        Date.UTC(year, shower.month - 1, shower.day, shower.peakHourUtc),
      );
      if (peak.getTime() < from.getTime() || peak.getTime() >= end) {
        continue;
      }
      let illumination;
      try {
        illumination = moonIllumination(peak);
      } catch (_error) {
        continue;
      }
      if (illumination >= MAX_MOON_ILLUMINATION) {
        continue;
      }
      const radiantMaxAlt = 90 - Math.abs(lat - shower.dec);
      if (radiantMaxAlt < MIN_RADIANT_ALTITUDE_DEG) {
        continue;
      }
      let nautical;
      try {
        nautical = isNauticalNight(peak, lat, lon);
      } catch (_error) {
        continue;
      }
      if (!nautical) {
        continue;
      }
      if (!passesCloudGate(peak.toISOString(), cloudCoverAt)) {
        continue;
      }
      events.push({
        kind: "meteor",
        timestamp: peak.toISOString(),
        tactical: true,
        description: `${shower.name} peak: up to ~${shower.zhr} meteors/h (Moon ${Math.round(illumination * 100)}% lit)`,
      });
      break;
    }
  }
  return events;
}

/**
 * Discrete moon phase instants inside the window (work doc #35):
 * `searchMoonPhases` gives the exact new/quarter/full instants, the
 * timeline and strategic outlook read them as sky notes — a new moon
 * names the darkest night of the passage, a full moon the moonlit
 * watches. Informational by nature (the phase instant may fall in
 * daytime), so no night or cloud gate applies.
 *
 * @param {object} params
 * @param {Date} params.from - Window start
 * @param {number} params.hours - Window length
 * @returns {Array<{kind: string, timestamp: string, tactical: boolean,
 *   description: string}>}
 */
function moonPhaseEvents({ from, hours }) {
  try {
    return searchMoonPhases(
      from,
      new Date(from.getTime() + hours * 3600000),
    ).map((entry) => ({
      kind: "moonPhase",
      timestamp: entry.time.toISOString(),
      tactical: false,
      description: MOON_PHASE_LABELS[entry.phase] ?? "Moon phase change",
    }));
  } catch (_error) {
    return [];
  }
}

/**
 * Lunar and solar eclipses the vessel can see inside the window
 * (work doc #35). Lunar: peak within the window, visibility from the
 * eclipse geometry, the Sun below the civil twilight line at peak (an
 * eclipse is a bright event — visible through twilight, not the
 * nautical gate the faint events use) and the cloud gate. Solar:
 * almanac returns only eclipses the observer can see, gated on the
 * Sun above the horizon at peak and the cloud gate.
 *
 * @param {object} params
 * @param {Date} params.from - Window start
 * @param {number} params.hours - Window length
 * @param {number} params.lat - Degrees
 * @param {number} params.lon - Degrees east
 * @param {((timestamp: string) => number|null)|undefined} [params.cloudCoverAt]
 * @returns {Array<{kind: string, timestamp: string, tactical: boolean,
 *   description: string}>}
 */
function eclipseEvents({ from, hours, lat, lon, cloudCoverAt }) {
  const events = [];
  const end = new Date(from.getTime() + hours * 3600000);
  const observer = observerAt(lat, lon);
  try {
    for (const eclipse of lunarEclipses(from, end)) {
      let visibility;
      try {
        visibility = lunarEclipseVisibility(eclipse, observer);
      } catch (_error) {
        continue;
      }
      if (!visibility?.visibleAtPeak) {
        continue;
      }
      try {
        if (bodyAltitudeDeg("Sun", eclipse.peak, lat, lon) >= -6) {
          continue;
        }
      } catch (_error) {
        continue;
      }
      if (!passesCloudGate(eclipse.peak.toISOString(), cloudCoverAt)) {
        continue;
      }
      events.push({
        kind: "lunarEclipse",
        timestamp: eclipse.peak.toISOString(),
        tactical: true,
        description:
          ECLIPSE_DESCRIPTIONS.lunar[eclipse.kind] ??
          "Lunar eclipse peak tonight",
      });
    }
  } catch (_error) {
    // Out of almanac's range or a failed search: degrade to no events
  }
  try {
    for (const eclipse of solarEclipses(from, end, observer)) {
      const peak = eclipse.peak;
      try {
        if (sunAltAz(peak, observer).altDeg <= 0) {
          continue;
        }
      } catch (_error) {
        continue;
      }
      if (!passesCloudGate(peak.toISOString(), cloudCoverAt)) {
        continue;
      }
      events.push({
        kind: "solarEclipse",
        timestamp: peak.toISOString(),
        tactical: true,
        description:
          eclipse.obscuration === 1
            ? "Total solar eclipse — the Sun fully covered"
            : `${ECLIPSE_DESCRIPTIONS.solar[eclipse.kind] ?? "Solar"} solar eclipse — ${Math.round(eclipse.obscuration * 100)}% of the Sun covered`,
      });
    }
  } catch (_error) {
    // Out of almanac's range or a failed search: degrade to no events
  }
  return events;
}

/**
 * Builds the Phase-2 ephemeris events for a position and window:
 * planetary conjunctions and oppositions, meteor-shower peaks, moon
 * phase instants and visible eclipses. Every visible event has
 * already passed the full tactical visibility gate (nautical night,
 * cloud cover, altitude, moonlight); moon phases are informational.
 *
 * @param {object} params
 * @param {number} params.lat - Degrees
 * @param {number} params.lon - Degrees east
 * @param {Date} [params.from] - Window start (default now)
 * @param {number} [params.hours=24] - Window length
 * @param {((timestamp: string) => number|null)|undefined} [params.cloudCoverAt]
 * @returns {Array<object>} Space events in the payload's
 *   `spaceEvents` shape
 */
function buildEphemerisEvents({
  lat,
  lon,
  from = new Date(),
  hours = 24,
  cloudCoverAt,
}) {
  return [
    ...planetaryEvents({ from, hours, lat, lon, cloudCoverAt }),
    ...meteorEvents({ from, hours, lat, lon, cloudCoverAt }),
    ...moonPhaseEvents({ from, hours }),
    ...eclipseEvents({ from, hours, lat, lon, cloudCoverAt }),
  ];
}

/**
 * Builds a cloud-cover lookup from a briefing payload: hourly
 * `surface.cloudCover` of the first waypoint (the departure or vessel
 * position), linearly interpolated between forecast steps. Outside
 * the forecast range — or where the source carries no cloud field —
 * the lookup answers null and the gate stays open.
 *
 * @param {object|null} payload - UnifiedWeatherPayload
 * @returns {((timestamp: string) => number|null)|undefined}
 */
function cloudCoverLookup(payload) {
  const forecasts = payload?.waypoints?.[0]?.forecasts;
  if (!Array.isArray(forecasts) || forecasts.length === 0) {
    return undefined;
  }
  const steps = forecasts
    .map((f) => ({
      t: new Date(f.timestamp).getTime(),
      cloudCover: f.surface?.cloudCover,
    }))
    .filter((s) => Number.isFinite(s.t))
    .sort((a, b) => a.t - b.t);
  if (steps.length === 0) {
    return undefined;
  }
  return (timestamp) => {
    const t = new Date(timestamp).getTime();
    if (!Number.isFinite(t)) {
      return null;
    }
    for (let i = 0; i < steps.length - 1; i++) {
      if (t >= steps[i].t && t <= steps[i + 1].t) {
        const a = steps[i];
        const b = steps[i + 1];
        if (a.cloudCover == null || b.cloudCover == null) {
          return null;
        }
        const f = (t - a.t) / (b.t - a.t);
        return a.cloudCover + f * (b.cloudCover - a.cloudCover);
      }
    }
    return null;
  };
}

module.exports = {
  NAUTICAL_TWILIGHT_DEG,
  CONJUNCTION_SEPARATION_DEG,
  OPPOSITION_ELONGATION_DEG,
  MIN_ALTITUDE_DEG,
  MAX_MOON_ILLUMINATION,
  MIN_RADIANT_ALTITUDE_DEG,
  CLOUD_COVER_MAX_PERCENT,
  METEOR_SHOWERS,
  bodyAltitudeDeg,
  moonPhaseDeg,
  moonIllumination,
  isNauticalNight,
  twilightTimes,
  celestialNights,
  passesCloudGate,
  passesMoonGate,
  planetaryEvents,
  angularSeparationDeg,
  meteorEvents,
  moonPhaseEvents,
  eclipseEvents,
  buildEphemerisEvents,
  cloudCoverLookup,
};
