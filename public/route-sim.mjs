/**
 * Step-forward isochrone passage simulation (SPEC §5.1).
 *
 * Sails the route one hour at a time: interpolate the weather at the
 * boat's position, pick speed through water (polars under sail,
 * motor or drift below the motoring wind threshold), add the surface
 * current as a vector, advance the position, and evaluate the
 * Sereno comfort of the hour. Along the way it collects sail-change
 * suggestions from the learned preference matrix (day/night bucketed),
 * hazard proximity alerts (SPEC §5.3), steep-sea and convective
 * anomalies, motoring hours and fuel.
 *
 * The weather payload carries deterministic forecasts, so ETA
 * percentiles come from a three-run wind perturbation (−10 %, nominal,
 * +10 % TWS) — a poor man's ensemble until ensemble members are
 * fetched. Comfort and anomalies are reported from the nominal run.
 *
 * This module is a plain ES module so the web worker (browser) and
 * the tests (Node, via dynamic import) execute the exact same code.
 *
 * @module route-sim
 */

import { meteorNightEvents } from "./components/meteors.mjs";
import { detectLineCrossings } from "./lines-of-interest.js";
import {
  bearingRad,
  DEFAULT_POLAR_TABLE,
  parsePerformanceFactor,
  polarSpeedKnots,
} from "./polar.mjs";
import {
  apparentWindSpeedKnots,
  isNight,
  noSailsRegime,
  regimeBandOf,
  SAILS_MAX_AWS_KNOTS,
  serenoComfort,
  steepnessRatio,
  suggestSailState,
  sunDayKind,
  travelDirection,
} from "./sereno-physics.mjs";
import {
  DOWNWIND_MIN_WINDOW_HOURS,
  deploymentPlan,
} from "./spinnaker-advisor.mjs";
import { detectManeuvers, wrap180 } from "./tack-gybe.js";
import tzLookup from "./vendor/tz-lookup/tz-lookup.mjs";

/**
 * Simulation time step (hours).
 */
export const STEP_HOURS = 1.0;

/**
 * Hazard alert radius around a note (SPEC §5.3).
 */
export const HAZARD_RADIUS_NM = 5.0;

/**
 * Simulation defaults, mirroring the plugin configuration defaults
 * (SPEC §2.1).
 */
export const SIMULATION_DEFAULTS = {
  motoring_tws_threshold: 3.5,
  drift_mode_enabled: true,
  motor_fuel_l_per_hour: 1.8,
  waterline_length_m: 9.4,
  k_heel: 0.35,
  k_pitch: 0.4,
  lines_of_interest_enabled: true,
  // Downwind-sail night policy (work doc #47 session): "break" — no
  // downwind sail at night; dusk strikes the sail, reefable white
  // sails carry the dark period, dawn may re-open. "continue" — night
  // hours keep an open deployment (night flying when squall risk is
  // low)
  downwind_night_policy: "break",
};

/**
 * Fuel burn of the auxiliary at its passage speed (liters per hour,
 * SI — the boat's tank and pump gauge speak liters), used when drift
 * mode is off and the wind is below the motoring threshold.
 */
export const MOTOR_FUEL_L_PER_HOUR = 1.8;

/**
 * Motor passage speed (knots) when drift mode is off.
 */
export const MOTOR_SPEED_KNOTS = 4.5;

/**
 * Wind perturbation factors of the pseudo-ensemble (SPEC §6.2 ETA
 * percentiles).
 */
export const ETA_FACTORS = [0.9, 1.0, 1.1];

const DEG = Math.PI / 180;
const EARTH_RADIUS_NM = 3440.065;

/**
 * Normalizes an angle to [−π, π).
 *
 * @param {number} rad
 * @returns {number}
 */
function normalizeAngle(rad) {
  let a = rad % (2 * Math.PI);
  if (a >= Math.PI) {
    a -= 2 * Math.PI;
  } else if (a < -Math.PI) {
    a += 2 * Math.PI;
  }
  return a;
}

/**
 * Great-circle distance between two positions (nm).
 *
 * @param {number} lat1 - Degrees
 * @param {number} lon1 - Degrees
 * @param {number} lat2 - Degrees
 * @param {number} lon2 - Degrees
 * @returns {number}
 */
export function distanceNm(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * DEG;
  const φ2 = lat2 * DEG;
  const dφ = (lat2 - lat1) * DEG;
  const dλ = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Destination position given a start, a bearing and a distance
 * (great-circle).
 *
 * @param {number} lat - Degrees
 * @param {number} lon - Degrees
 * @param {number} bearing - Radians, true
 * @param {number} distNm
 * @returns {{lat: number, lon: number}}
 */
export function destinationPoint(lat, lon, bearing, distNm) {
  const δ = distNm / EARTH_RADIUS_NM;
  const φ1 = lat * DEG;
  const λ1 = lon * DEG;
  const θ = bearing;
  const sinφ2 =
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(Math.min(1, Math.max(-1, sinφ2)));
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * sinφ2,
    );
  let lonDeg = (λ2 / DEG) % 360;
  if (lonDeg > 180) {
    lonDeg -= 360;
  } else if (lonDeg < -180) {
    lonDeg += 360;
  }
  return { lat: φ2 / DEG, lon: lonDeg };
}

/**
 * UTC offset minutes of an IANA timezone at an instant (work doc
 * #19): DST is whatever the platform's `Intl` database says for that
 * instant — no dependency, no historical tables of our own.
 *
 * @param {string} timeZone - IANA name, e.g. `Pacific/Tongatapu`
 * @param {Date} date - Instant the offset applies to
 * @returns {number|null} Minutes east of UTC, null on bad input or a
 *   platform without the `timeZoneName` support
 */
export function ianaOffsetMinutes(timeZone, date) {
  if (!timeZone || !(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    }).formatToParts(date);
    const name =
      parts.find((part) => part.type === "timeZoneName")?.value ?? "";
    if (name === "GMT") {
      return 0;
    }
    const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
    if (!match) {
      return null;
    }
    const minutes = Number(match[2]) * 60 + (match[3] ? Number(match[3]) : 0);
    return match[1] === "-" ? -minutes : minutes;
  } catch {
    return null;
  }
}

/**
 * Zone meridians (multiples of 15° of longitude) crossed between two
 * positions (work doc #19). The longitudes are a simulated step
 * apart, so the short-arc delta decides the direction; the
 * antimeridian is the ±180 meridian and labels as `180°`.
 *
 * @param {number} fromLon - Degrees
 * @param {number} toLon - Degrees
 * @returns {Array<{meridianDeg: number, label: string, eastbound: boolean}>}
 *   In crossing order
 */
export function meridianCrossings(fromLon, toLon) {
  if (!Number.isFinite(fromLon) || !Number.isFinite(toLon)) {
    return [];
  }
  let d = toLon - fromLon;
  if (d > 180) {
    d -= 360;
  } else if (d <= -180) {
    d += 360;
  }
  if (d === 0) {
    return [];
  }
  const lo = Math.min(fromLon, fromLon + d);
  const hi = Math.max(fromLon, fromLon + d);
  const crossings = [];
  for (let k = Math.floor(lo / 15) + 1; k <= Math.floor(hi / 15); k++) {
    const m = k * 15;
    const norm = ((((m + 180) % 360) + 360) % 360) - 180; // [-180, 180)
    const label =
      norm === -180
        ? "180°"
        : norm === 0
          ? "0°"
          : norm > 0
            ? `${norm}°E`
            : `${-norm}°W`;
    crossings.push({ meridianDeg: norm, label, eastbound: d > 0 });
  }
  return crossings;
}

/**
 * Propulsion of a canvas-down step (work doc #26): nobody motors into
 * a storm, and drift mode idles a genuinely becalmed boat on the
 * current alone; otherwise the engine drives. Shared by the speed
 * decision and the sail-change events, so the event describes the rig
 * it announces with the same rule the rows will live by. The "adrift"
 * here is neutral physics — no propulsion means the water moves the
 * boat — not a tactic: which storm tactic the crew rides out with is
 * work doc #27's decision, not the simulator's.
 *
 * @param {number|null} twsKnots - True wind speed of the step
 * @param {object} cfg - Simulation config (drift_mode_enabled,
 *   motoring_tws_threshold)
 * @returns {"adrift"|"motor"}
 */
function canvasDownPropulsion(twsKnots, cfg) {
  if (twsKnots != null && twsKnots >= SAILS_MAX_AWS_KNOTS) {
    return "adrift";
  }
  if (
    cfg.drift_mode_enabled &&
    (twsKnots == null || twsKnots < cfg.motoring_tws_threshold)
  ) {
    return "adrift";
  }
  return "motor";
}

/**
 * Territorial-waters stints along the route (work doc #19): the
 * plugin's enter/leave transitions folded into distance intervals
 * where territorial rules (and their timezones) apply. Stints opened
 * without a matching leave run to the end of the route.
 *
 * @param {Array<{kind: string, distanceFromStartNm: number,
 *   territory: object}>} transitions - Plugin-detected transitions
 * @returns {Array<{start: number, end: number}>}
 */
function territorialStints(transitions) {
  const stints = [];
  const open = new Map();
  const sorted = (transitions ?? [])
    .filter((transition) => Number.isFinite(transition?.distanceFromStartNm))
    .sort((a, b) => a.distanceFromStartNm - b.distanceFromStartNm);
  for (const transition of sorted) {
    const iso = transition.territory?.iso_ter ?? transition.territory?.name;
    if (transition.kind === "enter") {
      if (!open.has(iso)) {
        open.set(iso, transition.distanceFromStartNm);
      }
    } else if (open.has(iso)) {
      stints.push({
        start: open.get(iso),
        end: transition.distanceFromStartNm,
      });
      open.delete(iso);
    }
  }
  for (const start of open.values()) {
    stints.push({ start, end: Infinity });
  }
  return stints;
}

/**
 * Whether a route distance sits inside any territorial stint.
 *
 * @param {Array<{start: number, end: number}>} stints
 * @param {number} distanceFromStartNm
 * @returns {boolean}
 */
function insideTerritorialWaters(stints, distanceFromStartNm) {
  return stints.some(
    (stint) =>
      distanceFromStartNm >= stint.start && distanceFromStartNm < stint.end,
  );
}

/**
 * Interpolates an hourly forecast series at an arbitrary instant.
 * Angles interpolate along the shortest arc; missing values stay
 * null. Outside the forecast range the nearest step is used (clamped,
 * flagged via `clamped`).
 *
 * @param {Array<object>} forecasts - TimeStepForecast list of one
 *   payload waypoint
 * @param {Date} timestamp
 * @returns {object|null} Interpolated forecast step
 */
export function weatherAt(forecasts, timestamp) {
  if (!Array.isArray(forecasts) || forecasts.length === 0) {
    return null;
  }
  const steps = forecasts
    .map((step) => ({ step, t: new Date(step.timestamp).getTime() }))
    .filter((s) => !Number.isNaN(s.t))
    .sort((a, b) => a.t - b.t);
  if (steps.length === 0) {
    return null;
  }
  const t = timestamp.getTime();
  let a = steps[0];
  let b = steps[steps.length - 1];
  for (let i = 0; i < steps.length - 1; i++) {
    if (t >= steps[i].t && t <= steps[i + 1].t) {
      a = steps[i];
      b = steps[i + 1];
      break;
    }
  }
  if (t <= steps[0].t) {
    a = b = steps[0];
  } else if (t >= steps[steps.length - 1].t) {
    a = b = steps[steps.length - 1];
  }

  const span = b.t - a.t;
  const f = span > 0 ? (t - a.t) / span : 0;
  const mix = (lo, hi, wrap) => {
    if (typeof lo !== "number" || !Number.isFinite(lo)) {
      return typeof hi === "number" ? hi : null;
    }
    if (typeof hi !== "number" || !Number.isFinite(hi)) {
      return lo;
    }
    if (wrap) {
      return (((lo + f * (((hi - lo + 540) % 360) - 180)) % 360) + 360) % 360;
    }
    return lo + f * (hi - lo);
  };

  const sa = a.step?.surface ?? {};
  const sb = b.step?.surface ?? {};
  const ma = a.step?.marine ?? {};
  const mb = b.step?.marine ?? {};
  const ua = a.step?.upperAir ?? {};
  const ub = b.step?.upperAir ?? {};
  const ca = a.step?.current ?? {};
  const cb = b.step?.current ?? {};

  return {
    clamped: t < steps[0].t || t > steps[steps.length - 1].t,
    surface: {
      tws: mix(sa.tws, sb.tws),
      twd: mix(sa.twd, sb.twd, true),
      mslp: mix(sa.mslp, sb.mslp),
      gust: mix(sa.gust, sb.gust),
      // Night-darkness context (work doc #32): the steps carry the
      // Open-Meteo cloud_cover when the source publishes it — the
      // provider payload's null stays null, never invented. A null on
      // either side of the span interpolates to null: unknown is not
      // a value to blend from.
      cloudCover:
        sa.cloudCover == null || sb.cloudCover == null
          ? null
          : mix(sa.cloudCover, sb.cloudCover),
      // Rain fields follow the same honesty rule: unknown on either
      // side of the span interpolates to null, never invented
      precip:
        sa.precip == null || sb.precip == null
          ? null
          : mix(sa.precip, sb.precip),
      precipProbability:
        sa.precipProbability == null || sb.precipProbability == null
          ? null
          : mix(sa.precipProbability, sb.precipProbability),
    },
    marine: {
      hsCombined: mix(ma.hsCombined, mb.hsCombined),
      tpCombined: mix(ma.tpCombined, mb.tpCombined),
      dirCombined: mix(ma.dirCombined, mb.dirCombined, true),
      hsSwell: mix(ma.hsSwell, mb.hsSwell),
      tpSwell: mix(ma.tpSwell, mb.tpSwell),
      dirSwell: mix(ma.dirSwell, mb.dirSwell, true),
      hsWindSea: mix(ma.hsWindSea, mb.hsWindSea),
      tpWindSea: mix(ma.tpWindSea, mb.tpWindSea),
      dirWindSea: mix(ma.dirWindSea, mb.dirWindSea, true),
    },
    upperAir: {
      cape: mix(ua.cape, ub.cape),
      kIndex: mix(ua.kIndex, ub.kIndex),
      rh700: mix(ua.rh700, ub.rh700),
      wind850kts: mix(ua.wind850kts, ub.wind850kts),
    },
    current: {
      drift: mix(ca.drift, cb.drift),
      set: mix(ca.set, cb.set, true),
    },
  };
}

/**
 * Finds the payload waypoint nearest to a position.
 *
 * @param {Array<object>} payloadWaypoints
 * @param {number} lat
 * @param {number} lon
 * @param {number} [hintIndex] - Start searching from this index (the
 *   vessel moves forward, so the previous nearest stays nearest)
 * @returns {{index: number, distanceNm: number}}
 */
export function nearestWaypoint(payloadWaypoints, lat, lon, hintIndex = 0) {
  let best = { index: 0, distanceNm: Infinity };
  for (let i = hintIndex; i < payloadWaypoints.length; i++) {
    const w = payloadWaypoints[i];
    const d = distanceNm(lat, lon, w.lat, w.lon);
    if (d < best.distanceNm) {
      best = { index: i, distanceNm: d };
    }
  }
  return best;
}

/**
 * Ray-casting point-in-polygon test (SPEC §5.3).
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number[][]} ring - [[lon, lat], ...] closed or open ring
 * @returns {boolean}
 */
export function pointInPolygon(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Hazard proximity alerts for the hourly positions (SPEC §5.3):
 * polygon notes alert on containment, point notes on distance below
 * the alert radius.
 *
 * @param {Array<{id: string, description?: string, feature: object>}|
 *   Array<{id: string, description?: string, position: {latitude: number, longitude: number}}>} notes
 * @param {Array<{hoursFromNow: number, timestamp: string, lat: number, lon: number}>} positions
 * @param {number} [radiusNm]
 * @returns {Array<object>} Hazard alerts
 */
/**
 * CAPE at which convection risk turns severe (J/kg) — the bar where
 * weather services start coloring the index. Captured-but-lower
 * values still show, as a warning rather than a red alert.
 */
const CONVECTIVE_CAPE_J_PER_KG = 400;

/**
 * K-index at which convection risk turns severe — the classic
 * "moderate" thunderstorm band starts at 30.
 */
const CONVECTIVE_K_INDEX = 30;

/**
 * K-index above which marginal convection is captured at all: the
 * 28–30 band shows as a plain warning (K over 28 means unstable air),
 * not a red alert.
 */
const CONVECTIVE_K_INDEX_MARGINAL = 28;

/**
 * Hourly precipitation rate at which a rain-shower hour is captured
 * (mm/h). Tropical rain rarely arrives without squalls, so the crew
 * reads a shower band as probable squalls; below the bar an hour is a
 * stray drop, not weather.
 */
const RAIN_MM_PER_H = 0.5;

/**
 * Precipitation probability at which a rain-shower hour is captured
 * (%). The probability field extends detection into the later forecast
 * days, where some models publish it long after they stop being
 * confident about hourly rates.
 */
const RAIN_PROBABILITY_PERCENT = 50;

/**
 * Gust factor (gust / base wind) at which a squall-risk hour is
 * captured (work doc #38 session feedback): gusts more than double
 * the base wind mark unstable, squally air even when the convection
 * indices stay quiet. Steady trades routinely reach 1.3-1.5 at hourly
 * resolution — the crew handles those; a doubling is where the
 * forecast itself says the wind is not one wind.
 */
const SQUALL_GUST_FACTOR = 2;

/**
 * Gust speed (knots) at which a squall-risk hour is captured, beside
 * the factor: a doubling of a 3 kn breeze is 6 kn — real, but not a
 * canvas decision. The absolute bar sits at the top of the moderate
 * breeze, where reefing and rig choices start to matter.
 */
const SQUALL_GUST_KNOTS = 16;

/**
 * Maximum gap in hours between two hourly anomalies that still counts
 * as one continuing episode (covers hourly forecast steps and the
 * partial-hour arrival jitter; 3-hourly steps stay separate).
 */
const EPISODE_GAP_HOURS = 2;

/**
 * Peak of two optional values (null-safe).
 *
 * @param {number|null|undefined} a
 * @param {number|null|undefined} b
 * @returns {number|null}
 */
function maxOf(a, b) {
  if (a == null) {
    return b ?? null;
  }
  if (b == null) {
    return a;
  }
  return Math.max(a, b);
}

/**
 * Merges consecutive hourly anomalies into episodes for the timeline:
 * a warning band that lasts five hours reads as one event with a
 * time range and its peak values, not five lines. Input must be
 * chronological; episodes carry the first hour plus
 * `untilHoursFromNow`/`untilTimestamp` and the peak values chosen by
 * `pickPeak`.
 *
 * @param {Array<{hoursFromNow: number, timestamp: string, [key:
 *   string]: unknown}>} anomalies
 * @param {(episode: object, anomaly: object) => void} pickPeak -
 *   Merges the anomaly's values into the open episode
 * @returns {Array<object>} Episodes, chronological
 */
function mergeEpisodes(anomalies, pickPeak) {
  const episodes = [];
  for (const anomaly of anomalies) {
    const last = episodes.at(-1);
    if (
      last &&
      anomaly.hoursFromNow - last.untilHoursFromNow <= EPISODE_GAP_HOURS
    ) {
      last.untilHoursFromNow = anomaly.hoursFromNow;
      last.untilTimestamp = anomaly.timestamp;
      pickPeak(last, anomaly);
    } else {
      episodes.push({
        ...anomaly,
        untilHoursFromNow: anomaly.hoursFromNow,
        untilTimestamp: anomaly.timestamp,
      });
    }
  }
  return episodes;
}

export function hazardAlerts(notes, positions, radiusNm = HAZARD_RADIUS_NM) {
  const alerts = [];
  if (!Array.isArray(notes)) {
    return alerts;
  }
  for (const note of notes) {
    const ring =
      note?.feature?.geometry?.type === "Polygon"
        ? note.feature.geometry.coordinates[0]
        : null;
    const point =
      note?.position ??
      (note?.feature?.geometry?.type === "Point"
        ? {
            latitude: note.feature.geometry.coordinates[1],
            longitude: note.feature.geometry.coordinates[0],
          }
        : null);
    for (const pos of positions) {
      let hit = false;
      let distance = null;
      if (ring) {
        hit = pointInPolygon(pos.lat, pos.lon, ring);
      } else if (point) {
        distance = distanceNm(
          pos.lat,
          pos.lon,
          point.latitude,
          point.longitude,
        );
        hit = distance < radiusNm;
      }
      if (hit) {
        alerts.push({
          hoursFromNow: pos.hoursFromNow,
          timestamp: pos.timestamp,
          noteId: note.id ?? null,
          description: note.description ?? null,
          // The note's own url is the GDACS event page (work doc
          // #31): rides the alert so the timeline row links the
          // origin instead of just naming the hazard
          url: typeof note.url === "string" ? note.url : null,
          distanceNm: distance != null ? Math.round(distance * 10) / 10 : 0,
        });
        break; // One alert per note
      }
    }
  }
  return alerts.sort((a, b) => a.hoursFromNow - b.hoursFromNow);
}

/**
 * Watch-change boundaries for a time window, from a running watch
 * schedule (signalk-watch-schedule `/api/state`): every published
 * shift start extrapolated by whole rotation cycles in both
 * directions — the rotation repeats, so the horizon needs no server
 * paging — clamped to the window and to the watch's own start.
 *
 * @param {object|null} watch - `{active, startedAt, cycleMs, shifts:
 *   [{startTime, endTime}]}` from the watch plugin's REST state
 * @param {number} fromMs - Window start (epoch ms, inclusive)
 * @param {number} untilMs - Window end (epoch ms, inclusive)
 * @returns {number[]} Sorted boundary instants (epoch ms)
 */
export function watchBoundaries(watch, fromMs, untilMs) {
  if (!watch?.active || !Array.isArray(watch.shifts)) {
    return [];
  }
  const starts = watch.shifts
    .map((shift) => shift?.startTime)
    .filter((start) => Number.isFinite(start))
    .sort((a, b) => a - b);
  if (starts.length === 0) {
    return [];
  }
  const cycle = Number.isFinite(watch.cycleMs) ? watch.cycleMs : 0;
  const startedAt = Number.isFinite(watch.startedAt) ? watch.startedAt : null;
  const out = new Set();
  for (const start of starts) {
    if (cycle > 0) {
      let k = Math.ceil((fromMs - start) / cycle);
      for (; start + k * cycle <= untilMs; k++) {
        const instant = start + k * cycle;
        if (instant >= fromMs && (startedAt == null || instant >= startedAt)) {
          out.add(instant);
        }
      }
    } else if (
      start >= fromMs &&
      start <= untilMs &&
      (startedAt == null || start >= startedAt)
    ) {
      out.add(start);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Anchors recommendation-driven sail changes to the moments the whole
 * crew can act on them (work doc #5 follow-up). Two anchor sources,
 * in order of preference:
 *
 * 1. **Watch changes** (when a watch schedule is running — the
 *    boundary is stronger than sunlight): every change moves to the
 *    *previous* watch change, where both watches are awake at
 *    handover, so canvas comes down slightly early rather than going
 *    late. Boundaries repeat with the rotation cycle, so the whole
 *    forecast horizon is covered.
 * 2. **Sunrise/sunset** (no watch running): the night flags on the
 *    hourly rows are the app's own day/night boundaries, so each
 *    night-flag flip between consecutive rows is a sunrise or sunset
 *    at hourly resolution, and every change moves to the first such
 *    boundary at or after its detection.
 *
 * Several detections before the same boundary collapse into one
 * change carrying the last suggested state, and a change that would
 * re-rig the same canvas is dropped. The hourly rows are rewritten to
 * the anchored schedule (rows before the first boundary show the
 * pre-change rig), so the plan's state column matches what the crew
 * is actually asked to do and when. Tacks and gybes (`.maneuver`
 * events) are navigation-driven and stay at their tactical times —
 * canvas work waits for daylight or a handover, course work does not.
 *
 * Canvas-down events (`NO_SAILS` — motoring, adrift, storm tactics)
 * are propulsion decisions, not canvas work: the engine starts when
 * the wind leaves, daylight or not. They keep their detection time
 * and their honest conditions, and the rows carry the canvas-down
 * rig from that moment — the crew reads no gap between a downwind
 * take-down and the engine, and no "motoring at dusk in 10 kn of
 * wind" stale announcements (work doc #41 session).
 *
 * Detections with no boundary in reach keep their detection time: an
 * unanchored change still beats a dropped one. Each anchored event
 * carries `anchor` (`"watch"`, `"dusk"`, `"dawn"`) so the timeline
 * can say why the change sits where it sits.
 *
 * @param {Array<{hoursFromNow: number, sailState: string|null,
 *   previousSailState?: string|null, maneuver?: string, [key: string]:
 *   unknown}>} events - Recommendation-driven sail events
 * @param {Array<{hoursFromNow: number, timestamp: string, night:
 *   boolean, sailState: string|null}>} rows - Hourly rows (mutated:
 *   `sailState` rewritten to the anchored schedule)
 * @param {object|null} [watch] - Running watch schedule (see
 *   {@link watchBoundaries})
 * @returns {Array<object>} Anchored events, chronological
 */
export function anchorSailChanges(events, rows, watch = null) {
  if (rows.length === 0) {
    return [...events];
  }

  // Anchor candidates: watch changes when a schedule runs, else the
  // sun's own boundaries from the rows' night flags
  let usePrevious = false;
  const boundaries = [];
  if (watch?.active) {
    const refMs =
      new Date(rows[0].timestamp).getTime() - rows[0].hoursFromNow * 3600000;
    const maxHours = rows[rows.length - 1].hoursFromNow;
    const nightAt = (hours) => {
      let best = null;
      let bestDelta = Infinity;
      for (const row of rows) {
        const delta = Math.abs(row.hoursFromNow - hours);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = row;
        }
      }
      return Boolean(best?.night);
    };
    for (const instant of watchBoundaries(
      watch,
      refMs,
      refMs + maxHours * 3600000,
    )) {
      const hoursFromNow = (instant - refMs) / 3600000;
      boundaries.push({
        hoursFromNow,
        timestamp: new Date(instant).toISOString(),
        night: nightAt(hoursFromNow),
        kind: "watch",
      });
    }
    usePrevious = boundaries.length > 0;
  }
  if (boundaries.length === 0) {
    for (let i = 1; i < rows.length; i++) {
      if (Boolean(rows[i].night) !== Boolean(rows[i - 1].night)) {
        boundaries.push({
          hoursFromNow: rows[i].hoursFromNow,
          timestamp: rows[i].timestamp,
          night: Boolean(rows[i].night),
          kind: rows[i].night ? "dusk" : "dawn",
        });
      }
    }
  }

  // Canvas-down events and maneuvers pass through unanchored: the
  // engine (or the drift, or the storm tactic) does not wait for
  // daylight, and course work does not either
  const passthrough = [];
  const downEvents = [];
  const riggingPool = [];
  for (const event of events) {
    if (event.maneuver) {
      passthrough.push(event);
      continue;
    }
    if (event.sailState === "NO_SAILS") {
      passthrough.push(event);
      downEvents.push(event);
      continue;
    }
    riggingPool.push(event);
  }

  // Anchor each detection, keeping the last suggested state per
  // boundary
  const anchoredByBoundary = new Map();
  const unanchored = [];
  for (const event of riggingPool) {
    const boundary = usePrevious
      ? [...boundaries]
          .reverse()
          .find((candidate) => candidate.hoursFromNow <= event.hoursFromNow)
      : boundaries.find(
          (candidate) => candidate.hoursFromNow >= event.hoursFromNow,
        );
    if (!boundary) {
      unanchored.push(event);
      continue;
    }
    const existing = anchoredByBoundary.get(boundary.hoursFromNow);
    anchoredByBoundary.set(boundary.hoursFromNow, {
      ...event,
      hoursFromNow: boundary.hoursFromNow,
      timestamp: boundary.timestamp,
      night: boundary.night,
      anchor: boundary.kind,
      // Collapsed detections keep the earliest prior state: the rows
      // before the boundary rewind to the rig the plan started with
      previousSailState: existing?.previousSailState ?? event.previousSailState,
    });
  }

  const anchored = [...anchoredByBoundary.values()].sort(
    (a, b) => a.hoursFromNow - b.hoursFromNow,
  );

  // Drop re-rigs of the canvas the schedule already carries; the
  // first change is always kept — it differs from the initial rig by
  // construction. The effective rig includes the canvas-down
  // decisions: a rig-up after an unanchored bare-poles stretch is a
  // real change even when the last anchored rig would say otherwise.
  const ordered = [...anchored, ...downEvents].sort(
    (a, b) => a.hoursFromNow - b.hoursFromNow,
  );
  const kept = [];
  let effective = null;
  for (const event of ordered) {
    if (event.sailState === "NO_SAILS") {
      effective = event.sailState;
      continue;
    }
    if (kept.length === 0 || event.sailState !== effective) {
      kept.push(event);
      effective = event.sailState;
    }
  }

  // Rewrite the rows to the merged schedule (anchored rig changes
  // plus the unanchored canvas-down moments): rows at or after an
  // event carry that event's rig, rows before the first one show the
  // rig the passage started with
  const schedule = [...kept, ...downEvents]
    .map((event) => ({
      hoursFromNow: event.hoursFromNow,
      sailState: event.sailState,
      previousSailState: event.previousSailState ?? null,
    }))
    .sort((a, b) => a.hoursFromNow - b.hoursFromNow);
  const preRig = schedule[0]?.previousSailState ?? null;
  for (const row of rows) {
    let applicable = null;
    for (const entry of schedule) {
      if (entry.hoursFromNow <= row.hoursFromNow) {
        applicable = entry;
      }
    }
    if (applicable) {
      row.sailState = applicable.sailState;
    } else if (preRig != null) {
      row.sailState = preRig;
    }
  }

  return [...kept, ...passthrough, ...unanchored].sort(
    (a, b) => a.hoursFromNow - b.hoursFromNow,
  );
}

/**
 * The downwind-sail deployment pass (work doc #41, refined in the
 * work doc #47 session): evaluates the advisor's gates per hour,
 * collects the deployment windows, emits the deploy/take-down
 * timeline entries, stamps the covering rows (`deploymentWindow`) and
 * evaluates the comfort per row with the Parasailor-class windows
 * applied — the recommendation precedes and supersedes the slatting
 * penalty it relieves.
 *
 * Runs twice over the nominal run: once on the RAW rig trajectory
 * inside the run (provisional — twilight anchoring has not rewritten
 * the rows yet), and once on the ANCHORED schedule in
 * {@link simulatePassage}, where the anchored rig is authoritative
 * and the windows break at canvas-down and anchored rig changes.
 *
 * @param {Array<object>} hourly - The rows to evaluate (mutated:
 *   `deploymentWindow` restamped, comfort fields restamped)
 * @param {object} options
 * @param {Array<object>|null} options.advisorSails - The advisor
 *   inventory (from `downwindSails` or the served config)
 * @param {number} options.t0Ms - The passage's start instant (epoch ms)
 * @param {number} options.tEndMs - The horizon end (epoch ms)
 * @param {object|null} options.watch - Running watch schedule
 * @param {Set<number>} options.stormSet - Named-storm hours
 *   (hoursFromNow)
 * @param {Set<number>|null} [options.rigChangedHours] - Hours
 *   (hoursFromNow) where the anchored schedule carried out a rig
 *   change — the post-anchoring pass breaks windows there
 * @param {object} options.cfg - Simulation config (comfort model
 *   constants)
 * @returns {{deploymentEvents: Array<object>, comfortWindows:
 *   Array<object>}}
 */
function runDeploymentPass(
  hourly,
  { advisorSails, t0Ms, tEndMs, watch, stormSet, rigChangedHours = null, cfg },
) {
  const deploymentEvents = [];
  let comfortWindows = [];
  /** Every deployment window (comfort and drive claims alike) — the
   * suppression replay reads it, not just the comfort subset. */
  let deploymentWindows = [];
  if (advisorSails != null && advisorSails.length > 0) {
    const advisorHours = hourly.map((row) => ({
      hourMs: Date.parse(row.timestamp),
      twsKnots: row.twsKnots ?? 0,
      twaDeg:
        row.twaRad == null
          ? NaN
          : Math.abs(((row.twaRad / DEG + 540) % 360) - 180),
      awsKnots: row.awsKnots ?? 0,
      hsMeters: row.hsMeters ?? undefined,
      gustFactor:
        row.gustKnots != null && row.twsKnots > 1
          ? row.gustKnots / row.twsKnots
          : undefined,
      night: row.night === true,
      underCanvas: row.sailState !== "NO_SAILS",
      // The anchored schedule's own rig changes end the deployment
      // whatever the wind says (post-anchoring pass only)
      rigChanged:
        rigChangedHours != null && rigChangedHours.has(row.hoursFromNow),
      // Named forecast events (probable rain squalls, convective air,
      // the squall-risk hours) kill the deployment the same way the
      // gust-factor gate does — the forecast's own "sail comes down"
      // markers
      storm: stormSet.has(row.hoursFromNow),
    }));
    const plan = deploymentPlan(advisorHours, {
      downwindSails: advisorSails,
      watchAnchorsMs: watchBoundaries(watch, t0Ms, tEndMs),
      minWindowHours: DOWNWIND_MIN_WINDOW_HOURS,
      nightPolicy: cfg.downwind_night_policy,
    });
    // The covering comfort window per row: the Parasailor-class
    // (comfort claim) deployment changes what the hours read — the
    // downwind sail is up, drawing, damping the motion. Stamped in
    // the comfort pass below, which always runs.
    comfortWindows = plan.filter((d) => d.claim === "comfort");
    deploymentWindows = plan;
    // Every deployment window stamps its hours: while a downwind sail
    // is up there is no poled-out working canvas to advise about
    for (const row of hourly) {
      row.deploymentWindow = plan.some((d) => {
        const ms = Date.parse(row.timestamp);
        return ms >= d.startMs && ms <= d.untilMs;
      });
    }
    // Timeline entries: deploy (anchored when the watch schedule put
    // a handover inside the window), and the take-down where the
    // forecast broke.
    for (const d of plan) {
      const anchorText =
        d.anchoredMs != null && d.anchoredMs !== d.startMs
          ? "at the watch change"
          : null;
      deploymentEvents.push({
        hoursFromNow: Math.round(((d.startMs - t0Ms) / 3600000) * 10) / 10,
        timestamp: new Date(d.startMs).toISOString(),
        sailName: d.sailName,
        claim: d.claim,
        anchored: anchorText,
        hours: d.hours,
      });
      const breakLabel =
        d.breakReason === "squall gusts"
          ? "squall window"
          : d.breakReason === "squall window"
            ? "squall window"
            : d.breakReason === "bare poles"
              ? "canvas down"
              : d.breakReason === "rig change"
                ? "rig change"
                : d.breakReason === "sea state"
                  ? "sea state"
                  : d.breakReason === "night"
                    ? cfg.downwind_night_policy === "break"
                      ? "nightfall"
                      : "night"
                    : d.breakReason === "wind above envelope"
                      ? "wind building past the envelope"
                      : d.breakReason === "point of sail"
                        ? "wind angle leaving the reach"
                        : d.breakReason === "below fill floor"
                          ? "wind dying"
                          : d.breakReason === "wind below envelope"
                            ? "wind dying"
                            : null;
      if (breakLabel != null) {
        const untilRow = hourly.find(
          (row) => Date.parse(row.timestamp) === d.untilMs,
        );
        deploymentEvents.push({
          hoursFromNow: Math.round(((d.untilMs - t0Ms) / 3600000) * 10) / 10,
          timestamp: new Date(d.untilMs).toISOString(),
          sailName: d.sailName,
          claim: d.claim,
          takeDown: true,
          breakReason: d.breakReason ?? null,
          breakLabel,
          anchored: null,
          hours: d.hours,
          // For the conditions tab: the row the take-down lands on
          untilTimestamp: untilRow?.timestamp ?? null,
        });
      }
    }
  } else {
    // No downwind sail in the inventory: the advisor stays silent and
    // no window stamps the rows
    for (const row of hourly) {
      row.deploymentWindow = false;
    }
    deploymentWindows = [];
  }

  // The comfort evaluation per row (SPEC §5.2): inside a Parasailor
  // deployment window the downwind sail is up, drawing, damping the
  // motion — the recommendation precedes and supersedes the slatting
  // penalty it relieves. Outside, the plan's own rig applies (canvas
  // down reads motoring; unknown stays legacy).
  const covering = (rowMs) =>
    comfortWindows.find((d) => rowMs >= d.startMs && rowMs <= d.untilMs);
  for (const row of hourly) {
    const rowMs = Date.parse(row.timestamp);
    const covered = covering(rowMs);
    const vessel = {
      sogKnots: row.sogKnots ?? 0,
      headingRad: row.headingRad ?? 0,
      waterlineLengthM: cfg.waterline_length_m,
      kHeel: cfg.k_heel,
      kPitch: cfg.k_pitch,
      sailState: covered
        ? "sailing"
        : // null is a meaningful state (unknown rig: legacy slatting
          // behavior) — only an absent field falls back to the row's
          // post-suggestion rig
          (row.sailStateAtComfort !== undefined
              ? row.sailStateAtComfort
              : row.sailState) == null
          ? null
          : (row.sailStateAtComfort !== undefined
                ? row.sailStateAtComfort
                : row.sailState) === "NO_SAILS"
            ? "motoring"
            : "sailing",
      downwindStabilized: covered != null,
    };
    if (row.hsMeters != null && row.tpSeconds != null) {
      const comfort = serenoComfort(
        {
          hsMeters: row.hsMeters,
          tpSeconds: row.tpSeconds,
          waveTravelDirectionRad: row.waveTravelRad ?? null,
        },
        vessel,
        { twsKnots: row.twsKnots ?? 0, twaRad: row.twaRad ?? Math.PI },
      );
      row.azMs2 = comfort.acceleration.value;
      row.comfortLevel = comfort.comfort;
      row.slatting = comfort.slatting;
      row.parasailorRecommended = covered != null;
    }
  }
  return { deploymentEvents, comfortWindows, windows: deploymentWindows };
}

/**
 * Runs the step-forward simulation once.
 *
 * @param {object} params
 * @param {object} params.payload - UnifiedWeatherPayload (its
 *   waypoints double as the track nodes)
 * @param {object} [params.config] - Plugin configuration subset
 * @param {object} [params.matrix] - Learned sail preference matrix
 * @param {object} [params.polar] - Canonical `polars` resource table
 *   (null → built-in default)
 * @param {number} [params.performanceFactor] - Crew derating factor
 *   from `polars.performanceFactor`
 * @param {Array} [params.notes] - Hazard notes
 * @param {Date} [params.startTime] - Simulation start
 * @param {number} [params.twsFactor] - Wind multiplier of this run
 * @param {number} [params.maxHours] - Safety stop
 * @returns {object} One run's result
 */
export function simulateRun({
  payload,
  config = {},
  matrix = null,
  polar = null,
  performanceFactor,
  notes = [],
  startTime = new Date(),
  twsFactor = 1.0,
  maxHours = 14 * 24,
  passageStartedAt = null,
  downwindSails = null,
  watch = null,
  // The hours (rows' hoursFromNow stamps) whose matrix suggestions
  // are suppressed: a deployment window supersedes the working
  // canvas — while a downwind sail flies the plan does not re-rig it
  // (work doc #47 session: one rig at a time — downwind sail, white
  // sails, or no sails and motoring). Only the canvas-down suggestion
  // still fires; the window's own take-down is that rig change.
  suppressedSuggestionHours = null,
}) {
  const cfg = { ...SIMULATION_DEFAULTS, ...config };
  const pf = parsePerformanceFactor(performanceFactor);
  const track = payload?.waypoints ?? [];
  if (track.length < 2) {
    throw new Error("Payload needs at least two waypoints to simulate");
  }

  let pos = { lat: track[0].lat, lon: track[0].lon };
  let targetIndex = 1;
  let nearest = 0;
  let sailState = null;
  /** Suggestion seen but not yet held a full step (bin-edge chatter
   * guard: a state must persist before it enters the queue). */
  let pendingSailState = null;
  let pendingSailSince = 0;
  let t = new Date(startTime.getTime());
  let hours = 0;
  let motoringHours = 0;
  let fuelLiters = 0;
  // Territorial-waters stints (work doc #19): where the plugin's
  // boundary walk has the boat under a local timezone — meridian
  // crossing advisories stay offshore-only
  const territoryStints = territorialStints(payload?.zoneTransitions ?? []);

  const hourly = [];
  const sailEvents = [];
  const positions = [];
  const seaStateAnomalies = [];
  const upperAirAnomalies = [];
  const rainHours = [];
  const squallHours = [];
  // Sea legs (work doc #40): passage day context — the departure
  // time-of-day is the day boundary, so day N begins 24 h after
  // departure. Context only: the comfort model never reads it.
  const dayCheckpoints = [];
  const sunDayTransitions = [];
  const passageStartMs =
    passageStartedAt == null ? null : Date.parse(passageStartedAt);
  let prevDayAtSea = null;
  // Polar day/night tracking (work doc #40 session feedback): the
  // kind is judged per simulated day at the boat's *moved* position,
  // so sailing across the polar circle flips the timeline at the
  // right moment. The first day anchors the baseline without a
  // transition row; later flips emit one.
  let prevSunKind = null;
  let prevSunKindDate = null;
  // Regime awareness (work doc #39): the waters the leg sails
  // through, judged per simulated day at the moved position and
  // annotated per waypoint by the fetch engine
  const regimeTransitions = [];
  let prevRegime = null;
  const timeEvents = [];
  let arrivedHours = null;
  let distanceMadeGoodNm = 0;
  let prevLon = pos.lon;

  while (hours < maxHours && arrivedHours == null) {
    const target = track[targetIndex];
    const heading = bearingRad(pos.lat, pos.lon, target.lat, target.lon);
    const weather = weatherAt(track[nearest].forecasts, t);
    const tws =
      weather?.surface?.tws != null ? weather.surface.tws * twsFactor : null;
    // Forecast gusts never touch the comfort model (the backtest
    // showed gust-peak tier evaluation overcalls the trades); they
    // ride the row and drive the squall-risk advisory instead —
    // gusts far above the base wind are the forecast saying the air
    // is squally: canvas may need to come off for the gusts and the
    // reduced canvas then slats in the lulls (work doc #38)
    const gustKnots = weather?.surface?.gust ?? null;
    const gustFactor =
      gustKnots != null && tws != null && tws > 0 ? gustKnots / tws : null;
    const twaRad =
      weather?.surface?.twd != null
        ? normalizeAngle(weather.surface.twd * DEG - heading)
        : 0;

    // Speed choice (SPEC §5.1 decision tree). The plan's rig gates
    // the drive (work doc #5 session feedback, refined by work doc
    // #26): with canvas down the polars do not apply — the engine
    // pushes (counting motor hours and fuel), except in the two
    // canvas-off regimes: a storm lies ahull, and drift mode idles a
    // genuinely becalmed boat on the current alone.
    const canvasDown = sailState === "NO_SAILS";
    let stw = 0;
    let fuelRate = 0;
    let motoring = false;
    if (canvasDown) {
      // Rig down: apparent wind ≈ true wind, the canvas-off regimes
      // read straight off TWS — one rule drives both the rows and the
      // sail-change events. No drive is modeled in a storm: which
      // tactic the crew rides out with is theirs (work doc #27).
      if (canvasDownPropulsion(tws, cfg) === "adrift") {
        stw = 0; // No propulsion: the current moves the boat, nothing else
      } else {
        stw = MOTOR_SPEED_KNOTS;
        fuelRate = cfg.motor_fuel_l_per_hour ?? MOTOR_FUEL_L_PER_HOUR;
        motoring = true;
      }
    } else if (tws != null && tws >= cfg.motoring_tws_threshold) {
      stw = polarSpeedKnots(polar ?? DEFAULT_POLAR_TABLE, tws, twaRad, {
        performanceFactor: pf,
      });
    } else if (cfg.drift_mode_enabled) {
      stw = 0; // Drift with zero fuel, riding the current
      fuelRate = 0;
    } else {
      stw = MOTOR_SPEED_KNOTS;
      fuelRate = cfg.motor_fuel_l_per_hour ?? MOTOR_FUEL_L_PER_HOUR;
      motoring = true;
    }

    // SOG vector = boat vector + current vector
    const drift = weather?.current?.drift ?? 0;
    const setDeg = weather?.current?.set ?? 0;
    const boatN = stw * Math.cos(heading);
    const boatE = stw * Math.sin(heading);
    const curN = drift * Math.cos(setDeg * DEG);
    const curE = drift * Math.sin(setDeg * DEG);
    const sog = Math.sqrt((boatN + curN) ** 2 + (boatE + curE) ** 2);
    const sogDir = Math.atan2(boatE + curE, boatN + curN);

    // Advance the position by one step
    const remaining = distanceNm(pos.lat, pos.lon, target.lat, target.lon);
    const stepDistance = sog * STEP_HOURS;
    let arrivedNow = false;
    if (sog > 0.05 && stepDistance >= remaining) {
      // Arrive during this step: partial hour
      const hoursNeeded = Math.max(remaining / sog, 0);
      hours += hoursNeeded;
      t = new Date(t.getTime() + hoursNeeded * 3600000);
      pos = { lat: target.lat, lon: target.lon };
      distanceMadeGoodNm += remaining;
      arrivedNow = true;
    } else {
      pos = destinationPoint(pos.lat, pos.lon, sogDir, stepDistance);
      hours += STEP_HOURS;
      t = new Date(t.getTime() + STEP_HOURS * 3600000);
      distanceMadeGoodNm += stepDistance;
    }
    if (motoring) {
      motoringHours += STEP_HOURS;
      fuelLiters += fuelRate * STEP_HOURS;
    }

    // Sea state of the hour (the comfort evaluation itself runs in
    // the post-pass once the downwind-sail windows are known — work
    // doc #41: the recommendation precedes the comfort it relieves)
    const hs = weather?.marine?.hsCombined;
    const tp = weather?.marine?.tpCombined;
    const waveFrom = weather?.marine?.dirCombined;

    // The rig the hour actually sailed with: the suggestion block
    // below may change the rig for the following hours, but this
    // hour's comfort was evaluated on the canvas that was up
    const rigAtEvaluation = sailState;
    // Learned sail preference for these conditions. A suggestion must
    // hold through a full step before it becomes an event (work doc
    // #5): bin-edge chatter must not flap the sail-work queue. The
    // event carries the step's propulsion mode so "no sails" reads as
    // drifting or motoring instead of bare-pole sailing.
    const night = isNight(t, pos.lat, pos.lon);
    // What actually propelled the step (work doc #5 session
    // feedback): the engine when it runs, the current when the mode
    // idles the boat — never "sailing" while the plan's rig is down
    const propulsion = motoring ? "motor" : stw > 0 ? "sailing" : "adrift";
    if (matrix) {
      const suggested = suggestSailState(
        matrix,
        tws ?? 0,
        Math.abs(((twaRad / DEG + 540) % 360) - 180),
        night,
      );
      const suggestedState = suggested?.preferredSailState ?? null;
      // Deployment supersession (work doc #47 session): while a
      // downwind sail flies, the matrix does not re-rig the working
      // canvas — one rig at a time. Only the canvas-down suggestion
      // still fires (the wind leaving the sail), so the window's own
      // take-down is the rig change that ends it. The hour stamp
      // matches the rows' hoursFromNow the suppression set carries.
      const suppressWorkingCanvas =
        suppressedSuggestionHours?.has(Math.round(hours * 10) / 10) === true &&
        suggestedState !== "NO_SAILS";
      // Canvas-off guard (work doc #26): a NO_SAILS suggestion is a
      // two-regime decision — apparent wind below the fill floor
      // (slatting) or at the survival top. The boat still carries
      // canvas here, so the apparent wind is the real one. A learned
      // cell saying NO_SAILS mid-scale is a propulsion decision the
      // plan must not hold; the rig persists.
      const noSailsJustified =
        suggestedState !== "NO_SAILS" ||
        (tws != null &&
          noSailsRegime({
            awsKnots: apparentWindSpeedKnots({
              twsKnots: tws,
              stwKnots: stw,
              twaRad,
            }),
          }) != null);
      if (
        suggestedState != null &&
        suggestedState !== sailState &&
        noSailsJustified &&
        !suppressWorkingCanvas
      ) {
        if (
          sailState == null ||
          (suggestedState === pendingSailState &&
            hours - pendingSailSince >= STEP_HOURS)
        ) {
          // First rig of the passage, or the suggestion held through a
          // full step: a real change. The prior state rides along so
          // twilight anchoring can restore the plan's pre-change rig.
          // The event's propulsion describes the rig it announces
          // (same rule the rows will live by), and a canvas-off
          // regime rides along so the timeline can name the decision
          // it calls for: storm tactics are the crew's call, not the
          // simulator's (work doc #27).
          const previousSailState = sailState;
          sailState = suggestedState;
          sailEvents.push({
            hoursFromNow: Math.round(hours * 10) / 10,
            timestamp: t.toISOString(),
            sailState,
            previousSailState: previousSailState ?? null,
            night,
            propulsion:
              sailState === "NO_SAILS"
                ? canvasDownPropulsion(tws, cfg)
                : propulsion,
            canvasOffRegime:
              sailState === "NO_SAILS" && tws != null
                ? noSailsRegime({ awsKnots: tws })
                : null,
          });
          pendingSailState = null;
        } else if (suggestedState !== pendingSailState) {
          pendingSailState = suggestedState;
          pendingSailSince = hours;
        }
      }
    }

    // Sea legs (work doc #40): passage day context — the departure
    // time-of-day is the day boundary, so day N begins 24 h after
    // departure. Context only: the comfort model never reads it.
    const dayAtSea =
      passageStartMs != null
        ? Math.floor((t.getTime() - passageStartMs) / (24 * 3600000)) + 1
        : null;
    // Distance to land for this position, inverse-distance weighted
    // across the bracketing waypoints' annotations (work doc #39)
    const legA = track[Math.max(0, targetIndex - 1)];
    const legB = track[Math.min(track.length - 1, targetIndex)];
    const landA = legA?.distanceToLandNm ?? null;
    const landB = legB?.distanceToLandNm ?? null;
    let distanceToLandNm = null;
    if (landA != null || landB != null) {
      if (landA == null) {
        distanceToLandNm = landB;
      } else if (landB == null) {
        distanceToLandNm = landA;
      } else {
        const toA = distanceNm(pos.lat, pos.lon, legA.lat, legA.lon);
        const toB = distanceNm(pos.lat, pos.lon, legB.lat, legB.lon);
        distanceToLandNm =
          toA + toB > 0 ? (landB * toA + landA * toB) / (toA + toB) : landA;
      }
    }
    const regime = regimeBandOf({
      distanceToLandNm,
      depthAvailable: false,
    });
    hourly.push({
      hoursFromNow: Math.round(hours * 10) / 10,
      timestamp: t.toISOString(),
      lat: pos.lat,
      lon: pos.lon,
      distanceFromStartNm: Math.round(distanceMadeGoodNm * 10) / 10,
      headingDeg: Math.round(((heading / DEG) % 360) * 10) / 10,
      twdDeg: weather?.surface?.twd ?? null,
      twaRad,
      awsKnots: apparentWindSpeedKnots({
        twsKnots: tws ?? 0,
        stwKnots: stw,
        twaRad,
      }),
      azMs2: null,
      comfortLevel: null,
      slatting: null,
      twsKnots: tws,
      gustKnots,
      dayAtSea,
      regime,
      distanceToLandNm:
        distanceToLandNm != null
          ? Math.round(distanceToLandNm * 10) / 10
          : null,
      hsMeters: hs ?? null,
      tpSeconds: tp ?? null,
      waveTravelRad: travelDirection((waveFrom ?? 0) * DEG),
      stwKnots: stw,
      sogKnots: sog,
      sailState,
      sailStateAtComfort: rigAtEvaluation,
      motoring,
      night,
      // Cloud cover at the boat's position (work doc #32): rides the
      // row so the timeline night glyphs can say how dark the night
      // actually is
      cloudCover: weather?.surface?.cloudCover ?? null,
    });

    // Polar day/night: judge the 24 h ending at this row at the
    // boat's position, once per simulated day
    const sunKindDate = t.toISOString().slice(0, 10);
    const firstDayOfRun = prevSunKindDate == null;
    let sunKind = null;
    if (sunKindDate !== prevSunKindDate) {
      sunKind = sunDayKind(
        t.getTime() - 24 * 3600000,
        t.getTime(),
        pos.lat,
        pos.lon,
      );
      if (prevSunKindDate != null && sunKind !== prevSunKind) {
        sunDayTransitions.push({
          hoursFromNow: Math.round(hours * 10) / 10,
          timestamp: t.toISOString(),
          from: prevSunKind,
          to: sunKind,
        });
      }
      prevSunKind = sunKind;
      prevSunKindDate = sunKindDate;
      if (!firstDayOfRun && regime !== prevRegime) {
        regimeTransitions.push({
          hoursFromNow: Math.round(hours * 10) / 10,
          timestamp: t.toISOString(),
          from: prevRegime,
          to: regime,
        });
      }
      prevRegime = regime;
    }

    // Day-at-sea checkpoint: the first row of each new passage day
    // announces the count. Neutral marker — the easing thresholds the
    // original idea imagined did not survive the backtest. The polar
    // kind rides along so the row can name the sun regime.
    if (dayAtSea != null && dayAtSea !== prevDayAtSea) {
      dayCheckpoints.push({
        hoursFromNow: Math.round(hours * 10) / 10,
        timestamp: t.toISOString(),
        dayAtSea,
        sunDayKind: prevSunKind,
        regime,
      });
      prevDayAtSea = dayAtSea;
    }

    // Anomalies
    if (hs != null && tp != null) {
      const ratio = steepnessRatio(tp, hs);
      if (ratio < 3.28) {
        seaStateAnomalies.push({
          hoursFromNow: Math.round(hours * 10) / 10,
          timestamp: t.toISOString(),
          steepnessRatio: Math.round(ratio * 100) / 100,
          hsMeters: hs,
          tpSeconds: tp,
        });
      }
    }
    const cape = weather?.upperAir?.cape;
    const kIndexValue = weather?.upperAir?.kIndex;
    if (
      (cape != null && cape >= CONVECTIVE_CAPE_J_PER_KG) ||
      (kIndexValue != null && kIndexValue >= CONVECTIVE_K_INDEX_MARGINAL)
    ) {
      upperAirAnomalies.push({
        hoursFromNow: Math.round(hours * 10) / 10,
        timestamp: t.toISOString(),
        cape,
        kIndex: kIndexValue,
      });
    }

    // Rain-shower hours (probable squalls): either the model's hourly
    // rate crosses the shower bar or its probability does — the two
    // fields have independent availability across the horizon
    const precip = weather?.surface?.precip;
    const precipProbability = weather?.surface?.precipProbability;
    if (
      (precip != null && precip >= RAIN_MM_PER_H) ||
      (precipProbability != null &&
        precipProbability >= RAIN_PROBABILITY_PERCENT)
    ) {
      rainHours.push({
        hoursFromNow: Math.round(hours * 10) / 10,
        timestamp: t.toISOString(),
        precip,
        precipProbability,
      });
    }

    // Squall-risk hours (work doc #38 session feedback): the
    // forecasted gusts dwarf the base wind — unstable air where the
    // crew should expect sail changes on gust cycles, advise care,
    // and not plan light canvas
    if (
      gustKnots != null &&
      tws != null &&
      gustKnots >= SQUALL_GUST_KNOTS &&
      gustFactor >= SQUALL_GUST_FACTOR
    ) {
      squallHours.push({
        hoursFromNow: Math.round(hours * 10) / 10,
        timestamp: t.toISOString(),
        twsKnots: tws,
        gustKnots,
        gustFactor: Math.round(gustFactor * 100) / 100,
      });
    }

    // Waypoint progress
    if (arrivedNow) {
      if (targetIndex === track.length - 1) {
        arrivedHours = hours;
        break;
      }
      targetIndex = Math.min(targetIndex + 1, track.length - 1);
    }
    nearest = nearestWaypoint(track, pos.lat, pos.lon, nearest).index;
    const nextRemaining = distanceNm(
      pos.lat,
      pos.lon,
      track[targetIndex].lat,
      track[targetIndex].lon,
    );
    if (nextRemaining < 1 && targetIndex === track.length - 1) {
      // Within a mile of the destination: close enough to call it
      arrivedHours = hours;
      break;
    }
    if (nextRemaining < 1) {
      targetIndex = Math.min(targetIndex + 1, track.length - 1);
    }
    // Zone meridian crossings (work doc #19): offshore the solar clock
    // drifts 1 h per 15° of longitude. Each crossing becomes an
    // advisory — what the crew does with the clock is the master's
    // discretion. Inside territorial waters the local zone governs
    // instead, so no advisory fires there.
    const crossings = insideTerritorialWaters(
      territoryStints,
      distanceMadeGoodNm,
    )
      ? []
      : meridianCrossings(prevLon, pos.lon);
    for (const crossing of crossings) {
      timeEvents.push({
        hoursFromNow: Math.round(hours * 10) / 10,
        timestamp: t.toISOString(),
        meridian: crossing.label,
        eastbound: crossing.eastbound,
      });
    }
    prevLon = pos.lon;
    positions.push({
      hoursFromNow: Math.round(hours * 10) / 10,
      timestamp: t.toISOString(),
      lat: pos.lat,
      lon: pos.lon,
    });
  }

  const arrived = arrivedHours != null;
  if (arrivedHours == null) {
    arrivedHours = hours; // Never arrived: report the max horizon
  }

  // ── Downwind-sail deployment pass (work doc #41) ─────────────
  // The advisor runs BEFORE the comfort evaluation: its forward
  // horizons need the whole simulated timeline, and an established
  // window changes the comfort the hours read — the recommendation
  // precedes and supersedes the slatting penalty it relieves.
  // simulatePassage re-runs this pass on the ANCHORED schedule after
  // twilight anchoring, so the windows this raw pass produced are
  // provisional.
  const { deploymentEvents } = runDeploymentPass(hourly, {
    advisorSails: Array.isArray(downwindSails)
      ? downwindSails
      : Array.isArray(cfg.downwindSails)
        ? cfg.downwindSails
        : null,
    t0Ms: Date.parse(startTime.toISOString()),
    tEndMs: Date.parse(startTime.toISOString()) + maxHours * 3600000,
    watch,
    stormSet: new Set(
      [...rainHours, ...squallHours, ...upperAirAnomalies].map(
        (e) => e.hoursFromNow,
      ),
    ),
    cfg,
  });

  return {
    arrived,
    etaHours: arrivedHours,
    eta: new Date(startTime.getTime() + arrivedHours * 3600000).toISOString(),
    motoringHours,
    fuelLiters: Math.round(fuelLiters * 100) / 100,
    hourly,
    sailEvents,
    positions,
    seaStateAnomalies,
    upperAirAnomalies,
    rainHours,
    squallHours,
    dayCheckpoints,
    sunDayTransitions,
    regimeTransitions,
    deploymentEvents,
    timeEvents,
    hazardAlerts: hazardAlerts(notes, positions),
  };
}

/**
 * Poled-out drive advisories (bergie: the pole keeps the sails
 * pulling past 150 deg TWA — below that it sails poorly): a deep run
 * under canvas worth rigging the pole for, one entry per stretch.
 * When the plan's TWA oscillates across the pole floor, the note
 * names the oscillation instead — the crew would be in and out of
 * the pole (bergie: the pole-toggle regime signal).
 *
 * Runs on the anchored schedule (the same rig the timeline
 * announces), and skips the hours where the plan is motoring or a
 * downwind sail is deployed: the engine needs no pole, and a flying
 * Parasailor is not a deep run the pole would improve.
 *
 * @param {Array<{hoursFromNow: number, timestamp: string,
 *   twaRad: ?number, twsKnots: ?number, sailState: ?string,
 *   motoring: ?boolean, deploymentWindow: ?boolean}>} hourly - The
 *   anchored hourly rows (post {@link anchorSailChanges} rewrite)
 * @returns {Array<object>} Pole notes, chronological
 */
export function poleAdvisories(hourly) {
  const notes = [];
  const POLE_FLOOR_DEG = 150;
  const MIN_POLE_HOURS = 3;
  let run = null;
  let crossings = 0;
  const flush = () => {
    if (run && run.rows.length >= MIN_POLE_HOURS) {
      const first = run.rows[0];
      const last = run.rows.at(-1);
      notes.push({
        hoursFromNow: first.hoursFromNow,
        timestamp: first.timestamp,
        untilTimestamp: last.timestamp,
        hours: run.rows.length,
        oscillating: crossings >= 2,
      });
    }
    run = null;
    crossings = 0;
  };
  for (const row of hourly) {
    const folded =
      row.twaRad == null
        ? null
        : Math.abs(((row.twaRad / DEG + 540) % 360) - 180);
    if (
      row.sailState !== "NO_SAILS" &&
      row.sailState != null &&
      row.motoring !== true &&
      row.deploymentWindow !== true &&
      folded != null &&
      folded > POLE_FLOOR_DEG &&
      (row.twsKnots ?? 0) >= 6
    ) {
      if (run) {
        run.rows.push(row);
      } else {
        run = { rows: [row] };
      }
    } else {
      if (run && folded != null && folded > POLE_FLOOR_DEG - 25) {
        crossings++;
      }
      flush();
    }
  }
  flush();
  return notes;
}

/**
 * Aggregates the optional energy forecast into the 24-hour net
 * figures the tactical dashboard needs (SPEC §6.2).
 *
 * @param {Array<{timestamp: string, solarWh?: number, loadWh?: number}>|
 *   null} energyHourly
 * @param {Date} startTime
 * @returns {{netSolar24h: number|null, netBalance24h: number|null}}
 */
function energySummary(energyHourly, startTime) {
  if (!Array.isArray(energyHourly) || energyHourly.length === 0) {
    return { netSolar24h: null, netBalance24h: null };
  }
  const end = startTime.getTime() + 24 * 3600000;
  let solar = 0;
  let balance = 0;
  let seen = 0;
  for (const hour of energyHourly) {
    const t = new Date(hour.timestamp).getTime();
    // Half-open 24h window: [start, start + 24h)
    if (Number.isNaN(t) || t < startTime.getTime() || t >= end) {
      continue;
    }
    const solarWh = typeof hour.solarWh === "number" ? hour.solarWh : 0;
    const loadWh = typeof hour.loadWh === "number" ? hour.loadWh : 0;
    solar += solarWh;
    balance += solarWh - loadWh;
    seen++;
  }
  if (seen === 0) {
    return { netSolar24h: null, netBalance24h: null };
  }
  return {
    netSolar24h: Math.round(solar) / 1000, // kWh
    netBalance24h: Math.round(balance) / 1000, // kWh
  };
}

/**
 * Places territorial-waters transitions on the passage schedule (work
 * doc #17): each crossing's `distanceFromStartNm` interpolates
 * against the simulated hourly rows' distance made good, giving the
 * transition its `hoursFromNow` and timestamp — the same schedule the
 * ETA percentiles come from. Crossings beyond the simulated horizon
 * (or a payload without the enrichment) stay undated.
 *
 * @param {Array<{distanceFromStartNm: number, kind: string,
 *   territory: object}>} transitions - Plugin-detected transitions
 * @param {Array<{hoursFromNow: number, timestamp: string,
 *   distanceFromStartNm: number}>} rows - Simulated hourly rows
 * @returns {Array<object>} Transitions with `hoursFromNow` and
 *   `timestamp` (nulls when undatable), chronological where dated
 */
function timestampZoneTransitions(transitions, rows) {
  // The simulated rows start at hour 1 (~7 nm made good at passage
  // speed): prepend the departure itself so crossings inside the
  // first hour interpolate instead of going undated
  const track =
    rows.length > 0
      ? [
          {
            hoursFromNow: 0,
            timestamp: new Date(
              new Date(rows[0].timestamp).getTime() -
                rows[0].hoursFromNow * 3600000,
            ).toISOString(),
            distanceFromStartNm: 0,
          },
          ...rows,
        ]
      : rows;
  const timed = (transitions ?? []).map((transition) => {
    if (!Number.isFinite(transition?.distanceFromStartNm) || track.length < 2) {
      return { ...transition, hoursFromNow: null, timestamp: null };
    }
    let before = null;
    let after = null;
    for (const row of track) {
      if (row.distanceFromStartNm <= transition.distanceFromStartNm) {
        before = row;
      } else if (after == null) {
        after = row;
        break;
      }
    }
    if (!before || !after) {
      // Beyond the horizon in either direction
      return { ...transition, hoursFromNow: null, timestamp: null };
    }
    const span = after.distanceFromStartNm - before.distanceFromStartNm;
    if (span <= 0) {
      return {
        ...transition,
        hoursFromNow: before.hoursFromNow,
        timestamp: before.timestamp,
      };
    }
    const f =
      (transition.distanceFromStartNm - before.distanceFromStartNm) / span;
    return {
      ...transition,
      hoursFromNow:
        Math.round(
          (before.hoursFromNow +
            f * (after.hoursFromNow - before.hoursFromNow)) *
            10,
        ) / 10,
      timestamp: new Date(
        new Date(before.timestamp).getTime() +
          f *
            (new Date(after.timestamp).getTime() -
              new Date(before.timestamp).getTime()),
      ).toISOString(),
    };
  });
  return timed.sort((a, b) => {
    if (a.hoursFromNow == null || b.hoursFromNow == null) {
      return a.hoursFromNow == null ? 1 : -1;
    }
    return a.hoursFromNow - b.hoursFromNow;
  });
}

/**
 * Attaches the IANA timezone at a transition's crossing point plus
 * its UTC offset at the crossing instant (work doc #19): the timeline
 * compares that offset with the vessel's current zone to decide
 * whether the event says "time zone UTC+13". The lookup runs once per
 * transition, not per position; undated crossings carry the zone but
 * no offset. Lookup failures degrade to no annotation — never a
 * failed briefing.
 *
 * @param {object} transition - Dated zone transition with `lat`, `lon`
 * @returns {object} Same transition with `zoneIana` and
 *   `zoneOffsetMinutes` (either null when unknown)
 */
function annotateZoneTimezone(transition) {
  if (!Number.isFinite(transition?.lat) || !Number.isFinite(transition?.lon)) {
    return transition;
  }
  let zoneIana = null;
  try {
    zoneIana = tzLookup(transition.lat, transition.lon);
  } catch {
    return transition;
  }
  const zoneOffsetMinutes = transition.timestamp
    ? ianaOffsetMinutes(zoneIana, new Date(transition.timestamp))
    : null;
  return { ...transition, zoneIana, zoneOffsetMinutes };
}

/**
 * Full passage simulation: the nominal run plus wind-perturbed runs
 * for the ETA percentiles, assembled into the shape the webapp's
 * `filterExceptions` consumes (SPEC §6.2).
 *
 * @param {object} params
 * @param {object} params.payload - UnifiedWeatherPayload
 * @param {object} [params.config] - Plugin configuration subset
 * @param {object} [params.matrix] - Learned sail preference matrix
 * @param {object} [params.polar] - Polar table
 * @param {Array} [params.notes] - Hazard notes
 * @param {Array<{timestamp: string, solarWh?: number, loadWh?: number}>} [params.energyHourly]
 *   Energy forecast series; falls back to the payload's own
 *   `energyHourly` (work doc #10: the series rides the payload)
 * @param {{assumed: boolean, time: Date|string, reason: string}|
 *   null} [params.departure] - The assumed departure the startTime
 *   anchors to (work doc #15): passed through to the result so the UI
 *   can state what was assumed
 * @param {object} [params.watch] - Running watch schedule
 *   (signalk-watch-schedule): sail changes anchor to watch changes
 *   while it runs
 * @param {Date} [params.startTime]
 * @returns {object} simulationResult
 */
export function simulatePassage({
  payload,
  config,
  matrix,
  polar,
  performanceFactor,
  notes,
  energyHourly,
  watch = null,
  startTime = new Date(),
  departure = null,
  passageStartedAt = null,
}) {
  // Accept an ISO string (the payload stores fetchedAt as text) or a
  // Date — callers on the wire pass strings
  startTime = new Date(startTime);
  if (Number.isNaN(startTime.getTime())) {
    startTime = new Date();
  }
  // The energy series rides the briefing payload (work doc #10); the
  // explicit param wins when a caller feeds a different series
  energyHourly = energyHourly ?? payload?.energyHourly ?? null;
  const simCfg = { ...SIMULATION_DEFAULTS, ...config };
  const runs = ETA_FACTORS.map((twsFactor) =>
    simulateRun({
      payload,
      config,
      matrix,
      polar,
      performanceFactor,
      notes,
      startTime,
      twsFactor,
      passageStartedAt,
      watch,
    }),
  );
  const base = runs.find((r) => r !== null);
  const nominalIndex = ETA_FACTORS.indexOf(1.0);
  let nominal = runs[nominalIndex] ?? base;

  // Deployment supersession (work doc #47 session): the deployment
  // windows need the whole timeline, so the nominal run replays — the
  // advisor probes the raw trajectory, the run replays with the
  // covered hours' working-canvas suggestions suppressed, and the
  // Parasailor stays up through the dusk the matrix would otherwise
  // have re-rigged. One rig at a time: downwind sail, white sails, or
  // no sails and motoring. The trajectory is rig-independent (the
  // polar does not take the rig, and canvas-down hours still fire),
  // so one probe and one replay are exact.
  const replaySails = Array.isArray(simCfg.downwindSails)
    ? simCfg.downwindSails
    : null;
  if (nominal != null && replaySails != null && replaySails.length > 0) {
    const probe = runDeploymentPass(nominal.hourly, {
      advisorSails: replaySails,
      t0Ms: Date.parse(startTime.toISOString()),
      tEndMs:
        (nominal.hourly ?? []).length > 0
          ? Date.parse(nominal.hourly.at(-1).timestamp) + 3600000
          : Date.parse(startTime.toISOString()),
      watch,
      stormSet: new Set(
        [
          ...(nominal.squallHours ?? []),
          ...(nominal.rainHours ?? []),
          ...(nominal.upperAirAnomalies ?? []),
        ].map((e) => e.hoursFromNow),
      ),
      cfg: simCfg,
    });
    const suppressedSuggestionHours = new Set();
    for (const window of probe.windows ?? []) {
      for (const row of nominal.hourly ?? []) {
        const ms = Date.parse(row.timestamp);
        if (ms >= window.startMs && ms <= window.untilMs) {
          suppressedSuggestionHours.add(row.hoursFromNow);
        }
      }
    }
    if (suppressedSuggestionHours.size > 0) {
      const replay = simulateRun({
        payload,
        config,
        matrix,
        polar,
        performanceFactor,
        notes,
        startTime,
        twsFactor: 1.0,
        passageStartedAt,
        watch,
        suppressedSuggestionHours,
      });
      if (replay != null) {
        nominal = replay;
        if (nominalIndex >= 0) {
          runs[nominalIndex] = replay;
        }
      }
    }
  }

  // Lines of interest (work doc #1): wind-independent, so computed
  // once for the passage rather than per perturbed run — along the
  // simulated track, whose timestamps are the boat's schedule (the
  // payload waypoints' forecasts all start at the fetch window, which
  // would put every crossing at "now")
  const linesOfInterest = simCfg.lines_of_interest_enabled
    ? detectLineCrossings(nominal.hourly ?? [])
    : [];

  // Territorial waters transitions (work doc #17): the plugin walks
  // the 1 nm-resampled route for boundary crossings; the simulation
  // gives them their place in the passage schedule by interpolating
  // each crossing's distance from start against the hourly rows —
  // the same schedule the ETA percentiles come from
  const zoneTransitions = timestampZoneTransitions(
    payload?.zoneTransitions ?? [],
    nominal.hourly ?? [],
  ).map(annotateZoneTimezone);

  // Zone meridian advisories from the nominal track (work doc #19)
  const timeZoneChanges = nominal.timeEvents ?? [];

  const etas = runs.map((run) => run.etaHours).sort((a, b) => a - b);
  const pctHours = (p) =>
    etas[Math.min(etas.length - 1, Math.round(p * (etas.length - 1)))];
  const pct = (p) =>
    new Date(startTime.getTime() + pctHours(p) * 3600000).toISOString();
  // Day/night at the destination per arrival percentile: a night
  // landfall is worth flagging (dark anchorage, tired crew)
  const destination =
    payload?.waypoints?.[payload.waypoints.length - 1] ?? null;
  const etaNight = (p) => {
    if (!destination) {
      return null;
    }
    return isNight(
      new Date(startTime.getTime() + pctHours(p) * 3600000),
      destination.lat,
      destination.lon,
    );
  };

  // Canvas changes anchored to the moments the whole crew can act on
  // (work doc #5): recommendation-driven changes move to
  // sunrise/sunset or a watch handover with conditions at the change
  // point, so the timeline can say what the crew is rigging into
  const sailPlan = anchorSailChanges(
    nominal.sailEvents ?? [],
    nominal.hourly ?? [],
    watch,
  );
  // The deployment advisor re-runs on the ANCHORED schedule (work
  // doc #47 session): the pre-anchoring windows were computed on the
  // raw rig trajectory — a Parasailor window sailed straight through
  // a stretch the anchored schedule announced as motoring, its
  // take-down 32 hours after the engine started. The anchored rows
  // carry the announced rig, so the advisor's gates break each window
  // where the plan actually changes it: canvas down at the engine,
  // and the Parasailor down at every anchored rig change — one rig
  // state per hour (downwind sail, white sails, or no sails).
  // Real rig changes only: announcements of a rig already carried
  // (the passage's initial rig, previousSailState null) are not
  // changes — the sail was up since its raw hour, and its twilight
  // announcement must not strike a flying Parasailor
  const rigChangedHours = new Set(
    (sailPlan ?? [])
      .filter((event) => !event.maneuver && event.previousSailState != null)
      .map(
        (event) =>
          (nominal.hourly ?? []).find(
            (row) => row.hoursFromNow >= event.hoursFromNow,
          )?.hoursFromNow,
      )
      .filter((hour) => hour != null),
  );
  const anchoredDeployment = runDeploymentPass(nominal.hourly ?? [], {
    advisorSails: simCfg.downwindSails,
    t0Ms: Date.parse(startTime.toISOString()),
    tEndMs:
      (nominal.hourly ?? []).length > 0
        ? Date.parse(nominal.hourly.at(-1).timestamp) + 3600000
        : Date.parse(startTime.toISOString()),
    watch,
    stormSet: new Set(
      [
        ...(nominal.squallHours ?? []),
        ...(nominal.rainHours ?? []),
        ...(nominal.upperAirAnomalies ?? []),
      ].map((e) => e.hoursFromNow),
    ),
    rigChangedHours,
    cfg: simCfg,
  });
  const deploymentEvents = anchoredDeployment.deploymentEvents;
  // Tacks and gybes the plan implies (work doc #5): detected on the
  // anchored schedule — the same rig the timeline announces — so a
  // maneuver never contradicts the canvas the crew was told to carry
  // (with canvas down there is nothing to tack or gybe)
  const maneuvers = detectManeuvers(nominal.hourly);
  // Pole advisories read the anchored schedule too: no pole note in
  // a stretch the plan announces as motoring or a downwind-sail
  // deployment (work doc #41 session)
  const poleNotes = poleAdvisories(nominal.hourly ?? []);

  return {
    arrived: nominal.arrived === true,
    eta: {
      p10: pct(0),
      p50: pct(0.5),
      p90: pct(1),
      night: {
        p10: etaNight(0),
        p50: etaNight(0.5),
        p90: etaNight(1),
      },
    },
    motoringHours: nominal.motoringHours,
    fuelConsumptionLiters: nominal.fuelLiters,
    hourlyComfort: nominal.hourly,
    // Ceremonial line crossings (work doc #1): wind-independent,
    // computed once for the passage
    linesOfInterest,
    // Merged sail-work queue: twilight-anchored canvas changes plus
    // the tactical tacks/gybes, every event carrying the forecast
    // conditions at the change point (nearest hourly step)
    sailEvents: [...sailPlan, ...maneuvers]
      .map((event) => {
        let row = null;
        let bestDelta = Infinity;
        for (const hour of nominal.hourly ?? []) {
          const delta = Math.abs(hour.hoursFromNow - event.hoursFromNow);
          if (delta < bestDelta) {
            bestDelta = delta;
            row = hour;
          }
        }
        return row
          ? {
              ...event,
              conditions: {
                twsKnots: row.twsKnots ?? null,
                awsKnots: row.awsKnots ?? null,
                // Signed TWA at the change point (positive = wind
                // from starboard, same convention as the maneuvers):
                // the timeline names the point of sail, tiles and
                // widgets read the precise angle
                twaDeg:
                  typeof row.headingDeg === "number" &&
                  typeof row.twdDeg === "number"
                    ? Math.round(wrap180(row.twdDeg - row.headingDeg) * 10) / 10
                    : null,
                hsMeters: row.hsMeters ?? null,
                tpSeconds: row.tpSeconds ?? null,
                comfortLevel: row.comfortLevel ?? null,
                slatting: Boolean(row.slatting),
                // Night-darkness context (work doc #32)
                cloudCover: row.cloudCover ?? null,
              },
            }
          : event;
      })
      .sort((x, y) => x.hoursFromNow - y.hoursFromNow),
    // Proactive downwind sail deployments (work doc #41): the
    // post-anchoring pass, so the windows break where the announced
    // rig changes
    deploymentEvents,
    // Territorial waters transitions with their place in the passage
    // schedule (work doc #17); undated when the crossing lies beyond
    // the simulated horizon. Each carries the IANA zone at the
    // crossing point and its offset at the crossing instant (work
    // doc #19) so the timeline can flag a clock change.
    zoneTransitions,
    // Offshore zone meridian crossings, solar-clock advisories
    // (work doc #19)
    timeZoneChanges,
    // The assumed departure the schedule anchors to (work doc #15)
    departure,
    hazardAlerts: nominal.hazardAlerts,
    seaStateAnomalies: nominal.seaStateAnomalies,
    upperAirAnomalies: nominal.upperAirAnomalies,
    rainHours: nominal.rainHours,
    squallHours: nominal.squallHours,
    dayCheckpoints: nominal.dayCheckpoints,
    sunDayTransitions: nominal.sunDayTransitions,
    regimeTransitions: nominal.regimeTransitions,
    // Pole advisories computed on the anchored schedule
    poleNotes,
    energy: energySummary(energyHourly, startTime),
    runs: runs.map((run, i) => ({
      twsFactor: ETA_FACTORS[i],
      etaHours: run.etaHours,
      motoringHours: run.motoringHours,
      fuelLiters: run.fuelLiters,
    })),
  };
}

/**
 * Meteor-shower nights along the simulated track (work doc #37).
 *
 * The radiant-altitude gate is position-sensitive, so the evaluation
 * runs here, where the track lives — the same pipeline that produces
 * the sail changes. Per-night sky context (nautical-dusk anchors and
 * moonlight) comes from the payload's `celestialNights`, computed at
 * the departure position: anchors shift only minutes across a route,
 * and the position-sensitive part travels with the track. Positions
 * and cloud cover interpolate between the hourly rows; a night
 * without context (beyond the payload's forecast window) is skipped,
 * never invented.
 *
 * @param {object} simulationResult - From {@link simulatePassage}
 * @param {object} [simParams] - Worker params; `payload` carries
 *   `celestialNights`
 * @returns {Array<object>} spaceEvent-shaped meteor events
 */
function trackMeteorEvents(simulationResult, simParams) {
  const rows = simulationResult?.hourlyComfort ?? [];
  const nights = simParams?.payload?.celestialNights ?? [];
  if (rows.length < 2 || !Array.isArray(nights) || nights.length === 0) {
    return [];
  }
  const from = Date.parse(rows[0].timestamp);
  const last = Date.parse(rows.at(-1).timestamp);
  if (!Number.isFinite(from) || !Number.isFinite(last)) {
    return [];
  }
  const hours = Math.max(1, Math.ceil((last - from) / 3600000));
  const bracket = (iso, pick) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t) || t < from || t > last) {
      return null;
    }
    let lo = 0;
    let hi = rows.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (Date.parse(rows[mid].timestamp) <= t) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const a = rows[lo];
    const b = rows[hi];
    const span = Date.parse(b.timestamp) - Date.parse(a.timestamp);
    const f = span > 0 ? (t - Date.parse(a.timestamp)) / span : 0;
    const value = pick(a, b, f);
    return value == null ? null : value;
  };
  return meteorNightEvents({
    from: new Date(from),
    hours,
    nights,
    lat: rows[0].lat,
    lon: rows[0].lon,
    positionAt: (iso) =>
      bracket(iso, (a, b, f) => ({
        lat: a.lat + f * (b.lat - a.lat),
        lon: a.lon + f * (b.lon - a.lon),
      })),
    cloudCoverAt: (iso) =>
      bracket(iso, (a, b, f) => {
        if (a.cloudCover == null || b.cloudCover == null) {
          return null;
        }
        return a.cloudCover + f * (b.cloudCover - a.cloudCover);
      }),
  });
}

/**
 * Exception-based display filtering (SPEC §6.2): passes raw
 * simulation output through to the exception views the UI renders.
 *
 * @param {object} simulationResult - From {@link simulatePassage}
 * @param {object} [simParams] - The worker's simulation params; the
 *   payload carries the per-night sky context (`celestialNights`)
 *   the track-positioned meteor evaluation reads (work doc #37)
 * @returns {object}
 */
export function filterExceptions(simulationResult, simParams = {}) {
  const meteorEvents = trackMeteorEvents(simulationResult, simParams);
  // Regime summary (work doc #39): the majority regime per simulated
  // day, run-length encoded for the strategic headline — "offshore
  // ×3 · coastal ×2". Absent when the payload carries no
  // distance-to-land annotations (regime rows all unknown).
  const dayRegimes = new Map();
  for (const row of simulationResult.hourlyComfort ?? []) {
    if (row.regime == null || row.regime === "unknown") {
      continue;
    }
    const date = row.timestamp?.slice(0, 10);
    if (date == null) {
      continue;
    }
    const counts = dayRegimes.get(date) ?? new Map();
    counts.set(row.regime, (counts.get(row.regime) ?? 0) + 1);
    dayRegimes.set(date, counts);
  }
  let regimeSummary = null;
  {
    const runs = [];
    for (const [, counts] of [...dayRegimes.entries()].sort()) {
      let best = null;
      let bestCount = 0;
      for (const [regime, count] of counts) {
        if (count > bestCount) {
          best = regime;
          bestCount = count;
        }
      }
      const last = runs.at(-1);
      if (last && last.regime === best) {
        last.days += 1;
      } else {
        runs.push({ regime: best, days: 1 });
      }
    }
    if (runs.length > 0) {
      regimeSummary = runs
        .map((run) => `${run.regime} ×${run.days}`)
        .join(" · ");
    }
  }
  return {
    next24h: {
      comfortBlocks: (simulationResult.hourlyComfort ?? []).slice(0, 24),
      solarYieldKwh: simulationResult.energy?.netSolar24h ?? null,
      energyDeficitAlert:
        simulationResult.energy?.netBalance24h != null &&
        simulationResult.energy.netBalance24h < 0,
    },
    passageSummary: {
      etaP10: simulationResult.eta?.p10 ?? null,
      etaP50: simulationResult.eta?.p50 ?? null,
      etaP90: simulationResult.eta?.p90 ?? null,
      etaNight: simulationResult.eta?.night ?? null,
      totalMotorHours: simulationResult.motoringHours ?? 0,
      totalFuelLiters: simulationResult.fuelConsumptionLiters ?? 0,
      // Whole-route sail-work queue: recommendations plus the
      // tacks/gybes the plan implies (work doc #5)
      sailChanges: simulationResult.sailEvents ?? [],
      // Whole-route hazard alerts (work doc #18): the unified
      // timeline slices per screen, so the summary carries them all
      hazards: simulationResult.hazardAlerts ?? [],
      // Ceremonial line crossings (work doc #1)
      linesOfInterest: simulationResult.linesOfInterest ?? [],
      // Territorial waters transitions with their simulated schedule
      // (work doc #17), timezone-annotated (work doc #19)
      zoneTransitions: simulationResult.zoneTransitions ?? [],
      // Offshore zone meridian crossing advisories (work doc #19)
      timeZoneChanges: simulationResult.timeZoneChanges ?? [],
      // Landfall sightings along the simulated course (work doc #6):
      // every gated episode, the arrival coast flagged `final`
      landfalls: simulationResult.landfalls ?? [],
      // Meteor-shower nights evaluated along the simulated track
      // (work doc #37): the radiant gate is position-sensitive, so it
      // runs where the track lives — the payload's own `meteor`
      // entries would double-report against a fixed position
      meteorEvents,
      // Whether the plan reached its destination inside the horizon:
      // an "Arrival" that is really the horizon cap would be a lie
      arrived: simulationResult.arrived === true,
      // The destination's gazetteer name for the arrival row (work
      // doc #34 session); null without the vector base layer
      destinationName: simulationResult.destinationName ?? null,
      // The assumed departure the schedule anchors to (work doc #15)
      departure: simulationResult.departure ?? null,
      // The simulated track, compact: the timeline's night indicators
      // interpolate the crew's position at each event's hour so every
      // item — not only sail changes — can say whether it happens at
      // night (work doc #17 session feedback); the comfort tier rides
      // along so every item's conditions tab (work doc #18) picks the
      // same colors the tactical sparkline paints
      track: (simulationResult.hourlyComfort ?? []).map((row) => ({
        hoursFromNow: row.hoursFromNow,
        timestamp: row.timestamp ?? null,
        lat: row.lat,
        lon: row.lon,
        // Distance made good at the row: the route ribbon maps the
        // plan's encoding onto the real route geometry by it
        distanceFromStartNm: row.distanceFromStartNm ?? null,
        comfortLevel: row.comfortLevel ?? null,
        slatting: Boolean(row.slatting),
        // Ribbon regime fields (work doc #47): the map colors the
        // route by how the plan is sailed — slatting stretches, the
        // motoring dashes, night shading — not just the tier
        motoring: Boolean(row.motoring),
        night: Boolean(row.night),
        // Night-darkness context (work doc #32)
        cloudCover: row.cloudCover ?? null,
      })),
      // Anomalies merge into episodes (start hour, time range, peak
      // values) — a five-hour warning band reads as one timeline
      // event, not five lines
      macroSeaAnomalies: mergeEpisodes(
        (simulationResult.seaStateAnomalies ?? []).filter(
          (a) => a.steepnessRatio < 3.28,
        ),
        (episode, a) => {
          // Most severe = lowest steepness ratio, biggest seas
          episode.steepnessRatio = Math.min(
            episode.steepnessRatio,
            a.steepnessRatio,
          );
          episode.hsMeters = maxOf(episode.hsMeters, a.hsMeters);
          episode.tpSeconds = maxOf(episode.tpSeconds, a.tpSeconds);
        },
      ),
      convectiveWarnings: mergeEpisodes(
        simulationResult.upperAirAnomalies ?? [],
        (episode, u) => {
          episode.cape = maxOf(episode.cape, u.cape);
          episode.kIndex = maxOf(episode.kIndex, u.kIndex);
        },
      ).map((episode) => ({
        ...episode,
        // Severity lives with the peak: an episode whose CAPE or
        // K-index crosses the severe bars is a red alert, the rest
        // (the unstable-air band below it) shows as a plain warning
        marginal: !(
          (episode.cape != null && episode.cape >= CONVECTIVE_CAPE_J_PER_KG) ||
          (episode.kIndex != null && episode.kIndex >= CONVECTIVE_K_INDEX)
        ),
      })),
      // Rain-shower episodes (probable squalls): contiguous wet hours
      // merge into one entry carrying the episode's peak rate and
      // probability; always info-level — rain informs, CAPE warns
      rainEpisodes: mergeEpisodes(
        simulationResult.rainHours ?? [],
        (episode, r) => {
          episode.precip = maxOf(episode.precip, r.precip);
          episode.precipProbability = maxOf(
            episode.precipProbability,
            r.precipProbability,
          );
        },
      ),
      // Sea-legs day checkpoints (work doc #40): one per passage day,
      // already deduplicated by the simulator — no merging needed
      dayCheckpoints: simulationResult.dayCheckpoints ?? [],
      regimeSummary,
      sunDayTransitions: simulationResult.sunDayTransitions ?? [],
      regimeTransitions: simulationResult.regimeTransitions ?? [],
      deploymentEvents: simulationResult.deploymentEvents ?? [],
      poleNotes: simulationResult.poleNotes ?? [],
      // Squall-risk episodes (work doc #38 session feedback): hours
      // where the forecasted gusts dwarf the base wind merge into one
      // entry carrying the peak gust factor — the timeline's "advise
      // care" marker for squally air that the convection indices may
      // not see
      squallEpisodes: mergeEpisodes(
        simulationResult.squallHours ?? [],
        (episode, s) => {
          episode.gustFactor = Math.max(episode.gustFactor, s.gustFactor);
          episode.gustKnots = maxOf(episode.gustKnots, s.gustKnots);
          // Peak gust pairs with the calmest base wind of the episode
          episode.twsKnots = Math.min(episode.twsKnots, s.twsKnots);
        },
      ),
    },
  };
}
