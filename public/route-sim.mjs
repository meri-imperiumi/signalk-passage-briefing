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
  waterline_length_m: 9.4,
  k_heel: 0.35,
  k_pitch: 0.4,
};

/**
 * Fuel burn of the auxiliary at its passage speed (gal/h), used when
 * drift mode is off and the wind is below the motoring threshold.
 */
export const MOTOR_FUEL_GAL_PER_HOUR = 0.8;

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
  let t = new Date(startTime.getTime());
  let hours = 0;
  let motoringHours = 0;
  let fuelGal = 0;

  const hourly = [];
  const sailEvents = [];
  const positions = [];
  const seaStateAnomalies = [];
  const upperAirAnomalies = [];
  let arrivedHours = null;
  let distanceMadeGoodNm = 0;

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
      fuelRate = MOTOR_FUEL_GAL_PER_HOUR;
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
      fuelGal += fuelRate * STEP_HOURS;
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

    // Learned sail preference for these conditions
    const night = isNight(t, pos.lat, pos.lon);
    if (matrix) {
      const suggested = suggestSailState(
        matrix,
        tws ?? 0,
        Math.abs(((twaRad / DEG + 540) % 360) - 180),
        night,
      );
      if (suggested && suggested.preferredSailState !== sailState) {
        sailState = suggested.preferredSailState;
        sailEvents.push({
          hoursFromNow: Math.round(hours * 10) / 10,
          timestamp: t.toISOString(),
          sailState,
          night,
        });
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
      twsKnots: tws,
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
      (cape != null && cape > 1000) ||
      (kIndexValue != null && kIndexValue > 28)
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
    fuelGal: Math.round(fuelGal * 100) / 100,
    hourly,
    sailEvents,
    positions,
    seaStateAnomalies,
    upperAirAnomalies,
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
  startTime = new Date(),
}) {
  // Accept an ISO string (the payload stores fetchedAt as text) or a
  // Date — callers on the wire pass strings
  startTime = new Date(startTime);
  if (Number.isNaN(startTime.getTime())) {
    startTime = new Date();
  }
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

  const etas = runs.map((run) => run.etaHours).sort((a, b) => a - b);
  const pct = (p) =>
    new Date(
      startTime.getTime() +
        etas[Math.min(etas.length - 1, Math.round(p * (etas.length - 1)))] *
          3600000,
    ).toISOString();

  return {
    eta: {
      p10: pct(0),
      p50: pct(0.5),
      p90: pct(1),
    },
    motoringHours: nominal.motoringHours,
    fuelConsumptionGal: nominal.fuelGal,
    hourlyComfort: nominal.hourly,
    // Tacks and gybes the plan implies, merged into the sail-change
    // queue alongside the recommendation-driven changes (work doc #5)
    sailEvents: [
      ...(nominal.sailEvents ?? []),
      ...detectManeuvers(nominal.hourly),
    ].sort((x, y) => x.hoursFromNow - y.hoursFromNow),
    hazardAlerts: nominal.hazardAlerts,
    seaStateAnomalies: nominal.seaStateAnomalies,
    upperAirAnomalies: nominal.upperAirAnomalies,
    energy: energySummary(energyHourly, startTime),
    runs: runs.map((run, i) => ({
      twsFactor: ETA_FACTORS[i],
      etaHours: run.etaHours,
      motoringHours: run.motoringHours,
      fuelGal: run.fuelGal,
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
      sailChanges: (simulationResult.sailEvents ?? []).filter(
        (e) => e.hoursFromNow <= 24,
      ),
      hazards: (simulationResult.hazardAlerts ?? []).filter(
        (h) => h.hoursFromNow <= 24,
      ),
      solarYieldKwh: simulationResult.energy?.netSolar24h ?? null,
      energyDeficitAlert:
        simulationResult.energy?.netBalance24h != null &&
        simulationResult.energy.netBalance24h < 0,
    },
    passageSummary: {
      etaP10: simulationResult.eta?.p10 ?? null,
      etaP50: simulationResult.eta?.p50 ?? null,
      etaP90: simulationResult.eta?.p90 ?? null,
      totalMotorHours: simulationResult.motoringHours ?? 0,
      totalFuelGal: simulationResult.fuelConsumptionGal ?? 0,
      // Whole-route sail-work queue: recommendations plus the
      // tacks/gybes the plan implies (work doc #5)
      sailChanges: simulationResult.sailEvents ?? [],
      macroSeaAnomalies: (simulationResult.seaStateAnomalies ?? []).filter(
        (a) => a.steepnessRatio < 3.28,
      ),
      convectiveWarnings: (simulationResult.upperAirAnomalies ?? []).filter(
        (u) => u.cape > 1000 || u.kIndex > 28,
      ),
    },
  };
}
