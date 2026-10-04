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

import { detectLineCrossings } from "./lines-of-interest.js";
import {
  bearingRad,
  DEFAULT_POLAR_TABLE,
  parsePerformanceFactor,
  polarSpeedKnots,
} from "./polar.mjs";
import {
  isNight,
  serenoComfort,
  steepnessRatio,
  suggestSailState,
  travelDirection,
} from "./sereno-physics.mjs";
import { detectManeuvers } from "./tack-gybe.js";
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

  // Anchor each detection, keeping the last suggested state per
  // boundary
  const anchoredByBoundary = new Map();
  const unanchored = [];
  for (const event of events) {
    if (event.maneuver) {
      unanchored.push(event);
      continue;
    }
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
  // construction
  const kept = [];
  for (const event of anchored) {
    const previous = kept.at(-1)?.sailState ?? event.previousSailState;
    if (kept.length > 0 && event.sailState === previous) {
      continue;
    }
    kept.push(event);
  }

  // Rewrite the rows to the anchored schedule: rows at or after a
  // boundary carry that boundary's rig, rows before the first one
  // show the pre-change rig
  for (const row of rows) {
    let applicable = null;
    for (const event of kept) {
      if (event.hoursFromNow <= row.hoursFromNow) {
        applicable = event;
      }
    }
    if (applicable) {
      row.sailState = applicable.sailState;
    } else if (kept.length > 0) {
      const first = kept[0];
      if (first.previousSailState != null) {
        row.sailState = first.previousSailState;
      }
    }
  }

  return [...kept, ...unanchored].sort(
    (a, b) => a.hoursFromNow - b.hoursFromNow,
  );
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
    const twaRad =
      weather?.surface?.twd != null
        ? normalizeAngle(weather.surface.twd * DEG - heading)
        : 0;

    // Speed choice (SPEC §5.1 decision tree)
    let stw = 0;
    let fuelRate = 0;
    let motoring = false;
    if (tws != null && tws >= cfg.motoring_tws_threshold) {
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

    // Comfort of the hour (SPEC §5.2)
    const hs = weather?.marine?.hsCombined;
    const tp = weather?.marine?.tpCombined;
    const waveFrom = weather?.marine?.dirCombined;
    const comfort = serenoComfort(
      {
        hsMeters: hs ?? 0,
        tpSeconds: tp ?? 0,
        waveTravelDirectionRad: travelDirection((waveFrom ?? 0) * DEG),
      },
      {
        sogKnots: sog,
        headingRad: heading,
        waterlineLengthM: cfg.waterline_length_m,
        kHeel: cfg.k_heel,
        kPitch: cfg.k_pitch,
      },
      { twsKnots: tws ?? 0, twaRad },
    );

    // Learned sail preference for these conditions. A suggestion must
    // hold through a full step before it becomes an event (work doc
    // #5): bin-edge chatter must not flap the sail-work queue. The
    // event carries the step's propulsion mode so "no sails" reads as
    // drifting or motoring instead of bare-pole sailing.
    const night = isNight(t, pos.lat, pos.lon);
    const propulsion =
      tws != null && tws >= cfg.motoring_tws_threshold
        ? "sailing"
        : cfg.drift_mode_enabled
          ? "adrift"
          : "motor";
    if (matrix) {
      const suggested = suggestSailState(
        matrix,
        tws ?? 0,
        Math.abs(((twaRad / DEG + 540) % 360) - 180),
        night,
      );
      const suggestedState = suggested?.preferredSailState ?? null;
      if (suggestedState != null && suggestedState !== sailState) {
        if (
          sailState == null ||
          (suggestedState === pendingSailState &&
            hours - pendingSailSince >= STEP_HOURS)
        ) {
          // First rig of the passage, or the suggestion held through a
          // full step: a real change. The prior state rides along so
          // twilight anchoring can restore the plan's pre-change rig.
          const previousSailState = sailState;
          sailState = suggestedState;
          sailEvents.push({
            hoursFromNow: Math.round(hours * 10) / 10,
            timestamp: t.toISOString(),
            sailState,
            previousSailState: previousSailState ?? null,
            night,
            propulsion,
          });
          pendingSailState = null;
        } else if (suggestedState !== pendingSailState) {
          pendingSailState = suggestedState;
          pendingSailSince = hours;
        }
      }
    }

    hourly.push({
      hoursFromNow: Math.round(hours * 10) / 10,
      timestamp: t.toISOString(),
      lat: pos.lat,
      lon: pos.lon,
      distanceFromStartNm: Math.round(distanceMadeGoodNm * 10) / 10,
      headingDeg: Math.round(((heading / DEG) % 360) * 10) / 10,
      twdDeg: weather?.surface?.twd ?? null,
      awsKnots: comfort.awsKnots,
      azMs2: comfort.acceleration.value,
      comfortLevel: comfort.comfort,
      slatting: comfort.slatting,
      twsKnots: tws,
      hsMeters: hs ?? null,
      tpSeconds: tp ?? null,
      stwKnots: stw,
      sogKnots: sog,
      sailState,
      motoring,
      night,
    });

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

  if (arrivedHours == null) {
    arrivedHours = hours; // Never arrived: report the max horizon
  }

  return {
    etaHours: arrivedHours,
    eta: new Date(startTime.getTime() + arrivedHours * 3600000).toISOString(),
    motoringHours,
    fuelLiters: Math.round(fuelLiters * 100) / 100,
    hourly,
    sailEvents,
    positions,
    seaStateAnomalies,
    upperAirAnomalies,
    timeEvents,
    hazardAlerts: hazardAlerts(notes, positions),
  };
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
    }),
  );
  const base = runs.find((r) => r !== null);
  const nominal = runs[ETA_FACTORS.indexOf(1.0)] ?? base;

  // Lines of interest (work doc #1): wind-independent, so computed
  // once for the passage rather than per perturbed run — along the
  // simulated track, whose timestamps are the boat's schedule (the
  // payload waypoints' forecasts all start at the fetch window, which
  // would put every crossing at "now")
  const simCfg = { ...SIMULATION_DEFAULTS, ...config };
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

  // Tacks and gybes the plan implies (work doc #5): read off the
  // raw hourly plan before twilight anchoring rewrites the rows.
  // Recommendation-driven changes are then anchored to sunrise/sunset
  // with conditions at the change point (nearest hourly step) so the
  // timeline can say what the crew is rigging into
  const maneuvers = detectManeuvers(nominal.hourly);
  const sailPlan = anchorSailChanges(
    nominal.sailEvents ?? [],
    nominal.hourly ?? [],
    watch,
  );

  return {
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
                hsMeters: row.hsMeters ?? null,
                tpSeconds: row.tpSeconds ?? null,
                comfortLevel: row.comfortLevel ?? null,
              },
            }
          : event;
      })
      .sort((x, y) => x.hoursFromNow - y.hoursFromNow),
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
 * Exception-based display filtering (SPEC §6.2): passes raw
 * simulation output through to the exception views the UI renders.
 *
 * @param {object} simulationResult - From {@link simulatePassage}
 * @returns {object}
 */
export function filterExceptions(simulationResult) {
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
      // The assumed departure the schedule anchors to (work doc #15)
      departure: simulationResult.departure ?? null,
      // The simulated track, compact: the timeline's night indicators
      // interpolate the crew's position at each event's hour so every
      // item — not only sail changes — can say whether it happens at
      // night (work doc #17 session feedback)
      track: (simulationResult.hourlyComfort ?? []).map((row) => ({
        hoursFromNow: row.hoursFromNow,
        lat: row.lat,
        lon: row.lon,
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
    },
  };
}
