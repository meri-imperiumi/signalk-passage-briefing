/**
 * Landfall estimator (work doc #6): where and when topography first
 * breaks the visual horizon along the planned course, and what it is
 * called.
 *
 * Pure and DOM-free, the same pattern as `sereno-physics.mjs`: the
 * worker imports it in the browser, the server can dynamic-import it
 * for the backtest CLI. The DEM and the gazetteer are injectable —
 * `elevation(lat, lon)` and `placeName(lat, lon)` async lookups — so
 * the visibility math, the episode gating and the advisory strings
 * are all testable against synthetic terrain without tiles; the
 * browser readers in `landfall-tiles.mjs` are one implementation of
 * each interface (lossless-WebP Mapterhorn DEM, Shortbread
 * `place_labels`).
 *
 * Geometry: the horizon is the plain 2.08·(√h_eye + √H) nautical-mile
 * formula, no refraction correction (work doc #6). The raycast walks
 * the simulated track resampled at 0.5 nm, scanning the course line
 * out to `landfall_max_range_nm`; land "breaks the horizon" when its
 * own height puts it inside the eye-height horizon. Terrain occlusion
 * (a headland hiding the bay behind it) is not modeled — each land
 * sample is judged independently, per the original proposal.
 *
 * Episodes: a passage may sight land more than once — island chains
 * to pass, then the destination coast. Every gated sighting (land
 * newly within the horizon after `landfall_min_offshore_hours` with
 * nothing visible) is one episode; while land stays in sight the
 * episode stays open and its gate timer runs, so flicker cannot
 * duplicate events. The last episode is the arrival landfall and is
 * flagged `final` — the primary interest; intermediate islands are
 * interesting too and ride the same list.
 *
 * No-data handling: a DEM miss is `null` — neither land nor proof of
 * open water. Missing tiles yield no land samples; a coverage hole
 * can therefore suppress a sighting rather than invent one.
 *
 * @file landfall-estimator.mjs
 */

/** Simulation defaults, mirroring the plugin configuration. */
export const LANDFALL_DEFAULTS = {
  landfall_enabled: true,
  height_of_eye_m: 3,
  landfall_max_range_nm: 120,
  landfall_min_offshore_hours: 12,
};

/** Track resampling step (work doc #6). */
export const LANDFALL_SAMPLE_NM = 0.5;

/**
 * Nautical miles per radian of latitude arc (mean Earth radius).
 */
const NM_PER_RADIAN = 3440.065;
const DEG = Math.PI / 180;

/**
 * Great-circle distance between two points, nautical miles.
 *
 * @param {number} lat1 - Degrees
 * @param {number} lon1 - Degrees
 * @param {number} lat2 - Degrees
 * @param {number} lon2 - Degrees
 * @returns {number} Nautical miles
 */
export function distanceNm(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * DEG;
  const φ2 = lat2 * DEG;
  const dφ = φ2 - φ1;
  const dλ = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * NM_PER_RADIAN * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Initial great-course bearing from point 1 to point 2, degrees true.
 *
 * @param {number} lat1 - Degrees
 * @param {number} lon1 - Degrees
 * @param {number} lat2 - Degrees
 * @param {number} lon2 - Degrees
 * @returns {number} Degrees true, 0..360
 */
export function initialBearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * DEG;
  const φ2 = lat2 * DEG;
  const dλ = (lon2 - lon1) * DEG;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (((Math.atan2(y, x) / DEG) % 360) + 360) % 360;
}

/**
 * Destination point given a start, a bearing and a distance.
 *
 * @param {number} lat - Degrees
 * @param {number} lon - Degrees
 * @param {number} bearingDeg - Degrees true
 * @param {number} distNm - Nautical miles
 * @returns {{lat: number, lon: number}}
 */
export function destinationPoint(lat, lon, bearingDeg, distNm) {
  const δ = distNm / NM_PER_RADIAN;
  const θ = bearingDeg * DEG;
  const φ1 = lat * DEG;
  const λ1 = lon * DEG;
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );
  return { lat: φ2 / DEG, lon: ((((λ2 / DEG) % 360) + 540) % 360) - 180 };
}

/**
 * Interpolated position a fraction along the segment between two
 * points. Linear in lat/lon — the segments are sub-mile, where the
 * great-circle sagitta is far below positional noise.
 *
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @param {number} fraction - 0..1
 * @returns {{lat: number, lon: number}}
 */
export function interpolatePosition(lat1, lon1, lat2, lon2, fraction) {
  return {
    lat: lat1 + (lat2 - lat1) * fraction,
    lon: lon1 + (lon2 - lon1) * fraction,
  };
}

/**
 * Distance to the visual horizon of a target of the given height, as
 * seen from an eye of the given height — the plain 2.08·(√h + √H)
 * nautical-mile constant, no refraction (work doc #6).
 *
 * @param {number} eyeHeightM - Height of eye, meters
 * @param {number} targetHeightM - Target elevation, meters
 * @returns {number} Nautical miles
 */
export function visualHorizonNm(eyeHeightM, targetHeightM) {
  return (
    2.08 *
    (Math.sqrt(Math.max(0, eyeHeightM)) + Math.sqrt(Math.max(0, targetHeightM)))
  );
}

/**
 * Web-Mercator tile holding a point at the given zoom. Shared with
 * the tile readers, so the estimator's tests pin the coordinate math
 * the gazetteer depends on.
 *
 * @param {number} lat - Degrees
 * @param {number} lon - Degrees
 * @param {number} zoom - Tile zoom
 * @returns {{x: number, y: number}} XYZ tile coordinates
 */
export function tileFor(lat, lon, zoom) {
  const n = 2 ** zoom;
  // Normalize first: an unwrapped route frame (Tonga at 185°E) must
  // not produce out-of-range tile x on the antimeridian's far side
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = Math.max(-85.05112878, Math.min(85.05112878, lat)) * DEG;
  const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

/**
 * Resamples the simulated track into fixed-step boat samples with
 * interpolated timestamps and the leg's course. The track is the
 * hourly comfort rows (`simulationResult.hourlyComfort`: lat, lon,
 * hoursFromNow, timestamp, distanceFromStartNm) — the same geometry
 * every other simulated view reads.
 *
 * @param {Array<{lat: number, lon: number, hoursFromNow: number,
 *   timestamp: string, distanceFromStartNm?: number|null}>} track
 * @param {number} stepNm - Resample step
 * @returns {Array<{lat: number, lon: number, hoursFromNow: number,
 *   timestamp: string|null, bearingDeg: number,
 *   distanceFromStartNm: number}>}
 */
export function resampleTrack(track, stepNm = LANDFALL_SAMPLE_NM) {
  const samples = [];
  let cumulativeNm = 0;
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    const legNm = distanceNm(a.lat, a.lon, b.lat, b.lon);
    const bearing = initialBearingDeg(a.lat, a.lon, b.lat, b.lon);
    const steps = Math.max(1, Math.round(legNm / stepNm));
    for (let s = 0; s < steps; s++) {
      const fraction = s / steps;
      const pos = interpolatePosition(a.lat, a.lon, b.lat, b.lon, fraction);
      samples.push({
        lat: pos.lat,
        lon: pos.lon,
        hoursFromNow:
          a.hoursFromNow + (b.hoursFromNow - a.hoursFromNow) * fraction,
        timestamp:
          a.timestamp != null && b.timestamp != null
            ? new Date(
                new Date(a.timestamp).getTime() +
                  (new Date(b.timestamp).getTime() -
                    new Date(a.timestamp).getTime()) *
                    fraction,
              ).toISOString()
            : (a.timestamp ?? null),
        bearingDeg: bearing,
        distanceFromStartNm:
          a.distanceFromStartNm != null && b.distanceFromStartNm != null
            ? a.distanceFromStartNm +
              (b.distanceFromStartNm - a.distanceFromStartNm) * fraction
            : cumulativeNm + legNm * fraction,
      });
    }
    cumulativeNm += legNm;
  }
  const last = track[track.length - 1];
  if (last != null) {
    samples.push({
      lat: last.lat,
      lon: last.lon,
      hoursFromNow: last.hoursFromNow,
      timestamp: last.timestamp ?? null,
      bearingDeg:
        samples.length > 0 ? samples[samples.length - 1].bearingDeg : 0,
      distanceFromStartNm:
        last.distanceFromStartNm ??
        (samples.length > 0
          ? samples[samples.length - 1].distanceFromStartNm
          : 0),
    });
  }
  return samples;
}

/**
 * Walks the simulated track and reports every gated landfall
 * sighting.
 *
 * @param {object} params
 * @param {Array<{lat: number, lon: number, hoursFromNow: number,
 *   timestamp: string, distanceFromStartNm?: number|null}>} params.track
 *   - The simulated track (hourly rows)
 * @param {(lat: number, lon: number) => Promise<number|null>}
 *   params.elevation - DEM lookup, meters above sea level; `null` on
 *   a miss (a miss is neither land nor open water)
 * @param {(lat: number, lon: number) => Promise<{name: string,
 *   kind?: string}|null>} [params.placeName] - Gazetteer lookup
 * @param {object} [params.config] - Landfall configuration subset
 *   (`landfall_enabled`, `height_of_eye_m`, `landfall_max_range_nm`,
 *   `landfall_min_offshore_hours`)
 * @param {(iso: string) => string} [params.formatTime] - Vessel-local
 *   time formatter for the advisory string (defaults to HH:MM of the
 *   ISO stamp)
 * @returns {Promise<Array<{lat: number, lon: number, name: string,
 *   kind: string|null, bearingTrue: number, distNm: number,
 *   elevationM: number|null, hoursFromNow: number, timestamp: string,
 *   distanceFromStartNm: number, final: boolean, advisory: string}>>}
 *   Episodes, chronological; `final` marks the arrival landfall
 */
export async function estimateLandfalls({
  track,
  elevation,
  placeName = null,
  config = {},
  formatTime = null,
}) {
  const cfg = { ...LANDFALL_DEFAULTS, ...config };
  if (!cfg.landfall_enabled || track.length < 2 || elevation == null) {
    return [];
  }
  const samples = resampleTrack(track);
  if (samples.length < 2) {
    return [];
  }
  /** Land seen along the course so far: absolute points, elevation
   * cached. Distances are recomputed per sample, so course changes
   * need no ray rebuild. */
  const land = [];
  /** Quantized lookups already made — the ray is rescan-safe without
   * repeating DEM calls on course changes. */
  const visited = new Set();
  /** Passage time of the most recent sample with land within the
   * horizon; `null` while nothing has been in sight yet. */
  let lastVisibleHours = null;
  const episodes = [];
  const rangeSteps = Math.ceil(cfg.landfall_max_range_nm / LANDFALL_SAMPLE_NM);

  const scan = async (sample) => {
    for (let s = 1; s <= rangeSteps; s++) {
      const point = destinationPoint(
        sample.lat,
        sample.lon,
        sample.bearingDeg,
        s * LANDFALL_SAMPLE_NM,
      );
      // Quantize to ~0.001° so revisited rays skip their lookups
      const key = `${point.lat.toFixed(3)},${point.lon.toFixed(3)}`;
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      const elev = await elevation(point.lat, point.lon);
      if (elev != null && elev > 0) {
        land.push({ lat: point.lat, lon: point.lon, elevM: elev });
      }
    }
  };

  const nearestVisible = (sample) => {
    let best = null;
    for (const point of land) {
      const dist = distanceNm(sample.lat, sample.lon, point.lat, point.lon);
      if (dist > cfg.landfall_max_range_nm) {
        continue;
      }
      if (dist <= visualHorizonNm(cfg.height_of_eye_m, point.elevM)) {
        if (best == null || dist < best.distNm) {
          best = { ...point, distNm: dist };
        }
      }
    }
    return best;
  };

  // Index-driven: after an episode's sighting the walk resumes past
  // that moment, so the open episode's own visibility cannot re-trigger
  // the gate behind it (work doc #6 update #2: island chains ride the
  // same list, the gate separates the episodes).
  let i = 0;
  /** Whether the boat starts with land in its corridor at all (the
   * "initial land", work doc #6 update #3): a departure next to the
   * home islands. Until that land has disappeared — nothing within
   * the horizon for the offshore stretch — no sighting is reported;
   * a boat starting genuinely mid-ocean has no initial land to
   * disappear, and may report from the first horizon break. */
  let initialLandPresent = null;
  while (i < samples.length) {
    const sample = samples[i];
    await scan(sample);
    if (initialLandPresent == null) {
      initialLandPresent = land.length > 0;
    }
    const visible = nearestVisible(sample);
    if (visible != null) {
      lastVisibleHours = sample.hoursFromNow;
      i += 1;
      continue;
    }
    // Out of sight of land: how long for? While nothing has been seen
    // yet, the offshore stretch runs from the passage start — but only
    // when there was initial land to leave; a mid-ocean start has no
    // initial land to disappear, so the gate is already satisfied.
    const offshoreFor =
      lastVisibleHours == null
        ? initialLandPresent
          ? sample.hoursFromNow - samples[0].hoursFromNow
          : Infinity
        : sample.hoursFromNow - lastVisibleHours;
    if (offshoreFor < cfg.landfall_min_offshore_hours) {
      i += 1;
      continue;
    }
    // The gate has run with nothing visible — the next sighting is a
    // new episode. The walk jumps to the sighting, whose visibility
    // restarts the gate timer.
    const landfall = await firstSightingAfter(
      samples,
      i,
      elevation,
      cfg,
      visited,
      land,
    );
    if (landfall == null) {
      break; // No land within reach before the track ends
    }
    episodes.push(landfall);
    lastVisibleHours = landfall.hoursFromNow;
    i = landfall.sampleIndex + 1;
  }
  const named = [];
  for (const [index, episode] of episodes.entries()) {
    const gazetteer =
      placeName != null ? await placeName(episode.lat, episode.lon) : null;
    named.push({
      ...episode,
      name: gazetteer?.name ?? "land",
      kind: gazetteer?.kind ?? null,
      final: index === episodes.length - 1,
    });
  }
  for (const episode of named) {
    episode.advisory = landfallAdvisory(episode, formatTime);
  }
  return named;
}

/**
 * Finds the first moment land actually breaks the horizon at or after
 * the gate clearing: the gate sample itself sits in open water, the
 * sighting happens somewhere ahead of it. The corridor is rescanned
 * sample by sample (the visited set keeps the DEM cost of already
 * covered ground at zero) until any land is within the horizon; the
 * land cache is shared with the walk, so the sighting's own land
 * feeds the visibility checks that follow it.
 *
 * @param {Array<object>} samples - Resampled track
 * @param {number} startIndex - Index of the sample where the gate
 *   cleared
 * @param {(lat: number, lon: number) => Promise<number|null>} elevation
 * @param {object} cfg - Landfall configuration
 * @param {Set<string>} visited - Quantized lookup keys (mutated)
 * @param {Array<object>} land - Shared land cache (mutated)
 * @returns {Promise<object|null>} The sighting (with `sampleIndex`),
 *   or `null` when the track ends before land comes within the
 *   horizon
 */
async function firstSightingAfter(
  samples,
  startIndex,
  elevation,
  cfg,
  visited,
  land,
) {
  const rangeSteps = Math.ceil(cfg.landfall_max_range_nm / LANDFALL_SAMPLE_NM);
  for (let i = startIndex; i < samples.length; i++) {
    const sample = samples[i];
    for (let s = 1; s <= rangeSteps; s++) {
      const point = destinationPoint(
        sample.lat,
        sample.lon,
        sample.bearingDeg,
        s * LANDFALL_SAMPLE_NM,
      );
      const key = `${point.lat.toFixed(3)},${point.lon.toFixed(3)}`;
      if (!visited.has(key)) {
        visited.add(key);
        const elev = await elevation(point.lat, point.lon);
        if (elev != null && elev > 0) {
          land.push({ lat: point.lat, lon: point.lon, elevM: elev });
        }
      }
    }
    let best = null;
    for (const point of land) {
      const dist = distanceNm(sample.lat, sample.lon, point.lat, point.lon);
      if (dist > cfg.landfall_max_range_nm) {
        continue;
      }
      if (dist <= visualHorizonNm(cfg.height_of_eye_m, point.elevM)) {
        if (best == null || dist < best.distNm) {
          best = { ...point, distNm: dist };
        }
      }
    }
    if (best != null) {
      return {
        lat: best.lat,
        lon: best.lon,
        elevationM: best.elevM,
        distNm: Math.round(best.distNm * 10) / 10,
        bearingTrue: Math.round(sample.bearingDeg),
        hoursFromNow: Math.round(sample.hoursFromNow * 10) / 10,
        timestamp: sample.timestamp,
        distanceFromStartNm: Math.round(sample.distanceFromStartNm),
        sampleIndex: i,
      };
    }
  }
  return null;
}

/**
 * The destination's name from the gazetteer — the arrival row greets
 * by the place it lands at, the same nearest-match the sightings use
 * (work doc #34 session). `null` without a gazetteer; the timeline
 * then says plain "Arrival".
 *
 * @param {object} params
 * @param {Array<{lat: number, lon: number}>} params.track - The
 *   simulated track; its last row is the destination
 * @param {(lat: number, lon: number) => Promise<{name: string,
 *   kind?: string}|null>} [params.placeName] - Gazetteer lookup
 * @returns {Promise<string|null>}
 */
export async function destinationName({ track, placeName = null }) {
  const last = track?.[track.length - 1] ?? null;
  if (last == null || placeName == null) {
    return null;
  }
  const place = await placeName(last.lat, last.lon);
  return place?.name ?? null;
}

/**
 * The synthesized advisory string: "At 14:00 assumed landfall,
 * Neiafu visible at 230° True." (work doc #6). The name falls back to
 * bare "land" — the gazetteer is nearest-match and may not know the
 * point.
 *
 * @param {{timestamp: string, name: string, bearingTrue: number}}
 *   episode
 * @param {(iso: string) => string|null} [formatTime] - Vessel-local
 *   time formatter; defaults to the UTC HH:MM of the stamp
 * @returns {string}
 */
export function landfallAdvisory(episode, formatTime = null) {
  const stamp =
    formatTime != null && episode.timestamp != null
      ? formatTime(episode.timestamp)
      : (episode.timestamp ?? "").slice(11, 16);
  return `At ${stamp} assumed landfall, ${episode.name} visible at ${episode.bearingTrue}° True.`;
}
