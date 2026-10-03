/**
 * Offline ephemeris engine (work doc #3, Phase 2).
 *
 * Everything predictable in the sky is computed locally with
 * `astronomy-engine` (MIT, zero transitive dependencies): no network,
 * no bandwidth budget spent. The module produces
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
 * @file celestial-ephemeris.js
 */

const A = require("astronomy-engine");

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
  { name: "Orionids", month: 10, day: 21, peakHourUtc: 23, dec: 15, zhr: 20 },
  { name: "Leonids", month: 11, day: 17, peakHourUtc: 6, dec: 22, zhr: 15 },
  { name: "Geminids", month: 12, day: 14, peakHourUtc: 13, dec: 32, zhr: 120 },
  { name: "Ursids", month: 12, day: 22, peakHourUtc: 10, dec: 76, zhr: 10 },
];

/**
 * Naked-eye planets the module watches for conjunctions; oppositions
 * only apply to the superior ones.
 */
const PLANETS = [
  { body: A.Body.Venus, name: "Venus", superior: false },
  { body: A.Body.Mars, name: "Mars", superior: true },
  { body: A.Body.Jupiter, name: "Jupiter", superior: true },
  { body: A.Body.Saturn, name: "Saturn", superior: true },
];

/**
 * Builds an Observer for a vessel position.
 *
 * @param {number} lat - Degrees
 * @param {number} lon - Degrees east
 * @returns {object} astronomy-engine Observer
 */
function observerAt(lat, lon) {
  return new A.Observer(lat, lon, 0);
}

/**
 * Altitude of a solar-system body above the local horizon, refraction
 * included (the gate compares against haze, not against geometric
 * sunrise lines).
 *
 * @param {string} body - astronomy-engine Body constant
 * @param {Date} date - Instant
 * @param {number} lat - Degrees
 * @param {number} lon - Degrees east
 * @returns {number} Altitude in degrees (negative below horizon)
 */
function bodyAltitudeDeg(body, date, lat, lon) {
  const observer = observerAt(lat, lon);
  const time = A.MakeTime(date);
  const eqd = A.Equator(body, time, observer, true, true);
  const hor = A.Horizon(time, observer, eqd.ra, eqd.dec, "normal");
  return hor.altitude;
}

/**
 * Moon phase angle at an instant: 0 = new, 90 = first quarter,
 * 180 = full, 270 = third quarter. The webapp maps this onto its
 * night glyphs (work doc #3: actual moon phase instead of a fixed
 * crescent).
 *
 * @param {Date} date - Instant
 * @returns {number} Phase angle 0..360 degrees
 */
function moonPhaseDeg(date) {
  return A.MoonPhase(date);
}

/**
 * Moon illumination fraction at an instant, derived from the phase
 * angle (accurate to well under a percent — the gate compares against
 * a 30 % crescent threshold, not an almanac).
 *
 * @param {Date} date - Instant
 * @returns {number} Illuminated fraction 0..1
 */
function moonIllumination(date) {
  return (1 - Math.cos(A.MoonPhase(date) * (Math.PI / 180))) / 2;
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
  return bodyAltitudeDeg(A.Body.Sun, date, lat, lon) < NAUTICAL_TWILIGHT_DEG;
}

/**
 * Twilight times for the night starting at or after `date` at a
 * position: the crossing instants of the civil (−6°), nautical (−12°)
 * and astronomical (−18°) Sun-altitude lines. A search window that
 * misses a crossing (polar day/night) degrades that bound to null.
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
  const search = (direction, limitDeg, start) => {
    try {
      const found = A.SearchAltitude(
        A.Body.Sun,
        observer,
        direction,
        A.MakeTime(start),
        1.5,
        limitDeg,
      );
      return found ? found.date.toISOString() : null;
    } catch (_error) {
      return null;
    }
  };
  // Dusk chain first, then the dawn chain searches forward from the
  // dusk anchor, so both sides belong to the same night. Polar
  // day/night degrades the missing crossings to null.
  const civilDusk = search(-1, -6, date);
  const nauticalDusk = civilDusk ? search(-1, -12, new Date(civilDusk)) : null;
  const astronomicalDusk = nauticalDusk
    ? search(-1, -18, new Date(nauticalDusk))
    : null;
  const anchor = astronomicalDusk ?? nauticalDusk ?? civilDusk ?? date;
  // The dawn searches start a couple of minutes past the dusk
  // crossing: at the crossing instant itself the Sun's altitude sits
  // exactly on the limit, and the rising search would trip over the
  // numerical tangency instead of finding the morning
  const anchorMs = new Date(anchor).getTime() + 120000;
  const astronomicalDawn = search(+1, -18, new Date(anchorMs));
  const nauticalDawn = astronomicalDawn
    ? search(+1, -12, new Date(new Date(astronomicalDawn).getTime() + 120000))
    : search(+1, -12, new Date(anchorMs));
  const civilDawn = nauticalDawn
    ? search(+1, -6, new Date(new Date(nauticalDawn).getTime() + 120000))
    : search(+1, -6, new Date(anchorMs));
  return {
    civilDusk,
    nauticalDusk,
    astronomicalDusk,
    astronomicalDawn,
    nauticalDawn,
    civilDawn,
  };
}

/**
 * Daily night context for the briefing payload (`celestialNights`):
 * one entry per day with the twilight times of that night and the
 * moon phase/illumination at nightfall. The timeline's night glyph
 * and any future "when is it really dark" display read this instead
 * of re-deriving astronomy in the browser.
 *
 * @param {object} params
 * @param {Date} params.from - Window start
 * @param {number} [params.days=8] - Number of nights
 * @param {number} params.lat - Degrees
 * @param {number} params.lon - Degrees east
 * @returns {Array<{timestamp: string, moonPhaseDeg: number,
 *   moonIllumination: number, civilDusk: string|null,
 *   nauticalDusk: string|null, astronomicalDusk: string|null,
 *   astronomicalDawn: string|null, nauticalDawn: string|null,
 *   civilDawn: string|null}>}
 */
function celestialNights({ from, days = 8, lat, lon }) {
  const nights = [];
  for (let d = 0; d < days; d++) {
    const base = new Date(from.getTime() + d * 86400000);
    const twilights = twilightTimes(base, lat, lon);
    const anchor = twilights.nauticalDusk
      ? new Date(twilights.nauticalDusk)
      : base;
    nights.push({
      timestamp: anchor.toISOString(),
      moonPhaseDeg: Math.round(moonPhaseDeg(anchor) * 10) / 10,
      moonIllumination: Math.round(moonIllumination(anchor) * 1000) / 1000,
      ...twilights,
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
    bodyAltitudeDeg(A.Body.Moon, date, lat, lon) <= 0 ||
    moonIllumination(date) < MAX_MOON_ILLUMINATION
  );
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
    if (!isNauticalNight(date, lat, lon)) {
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
      const elongation = A.Elongation(planet.body, date).elongation;
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
 * Angular separation between two bodies as seen from a position.
 *
 * @param {string} bodyA - astronomy-engine Body constant
 * @param {string} bodyB - astronomy-engine Body constant
 * @param {Date} date - Instant
 * @param {number} lat - Degrees
 * @param {number} lon - Degrees east
 * @returns {number} Separation in degrees
 */
function angularSeparationDeg(bodyA, bodyB, date, lat, lon) {
  const observer = observerAt(lat, lon);
  const time = A.MakeTime(date);
  const v1 = A.Equator(bodyA, time, observer, true, true).vec;
  const v2 = A.Equator(bodyB, time, observer, true, true).vec;
  return A.AngleBetween(v1, v2);
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
      const illumination = moonIllumination(peak);
      if (illumination >= MAX_MOON_ILLUMINATION) {
        continue;
      }
      const radiantMaxAlt = 90 - Math.abs(lat - shower.dec);
      if (radiantMaxAlt < MIN_RADIANT_ALTITUDE_DEG) {
        continue;
      }
      if (!isNauticalNight(peak, lat, lon)) {
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
 * Builds the Phase-2 ephemeris events for a position and window:
 * planetary conjunctions and oppositions, meteor-shower peaks. Every
 * event has already passed the full tactical visibility gate
 * (nautical night, cloud cover, altitude, moonlight where relevant).
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
  buildEphemerisEvents,
  cloudCoverLookup,
};
