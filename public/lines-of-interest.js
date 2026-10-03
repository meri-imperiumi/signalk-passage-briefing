/**
 * Lines of interest (work doc #1): the traditional ceremonial lines a
 * passage may cross — equator, tropics, polar circles, prime
 * meridian, antimeridian/Date Line — detected along the planned
 * route, with the crossing position, distance from start and the
 * nominal ETA interpolated from the track schedule.
 *
 * A pure, zero-dependency module: the web worker imports it in the
 * browser, the tests run it in Node.
 *
 * Ceremony names attach only where the tradition is well established;
 * the other lines stay plain. The antimeridian is used for detection —
 * the real geopolitical Date Line deviates from 180°, but for a
 * briefing the 180th meridian is the right approximation.
 *
 * @module lines-of-interest
 */

/**
 * The fixed line set, parallels first. Latitudes/longitudes in
 * degrees; the tropics and circles use the obliquity-derived values
 * rounded to four decimals.
 */
export const LINES_OF_INTEREST = [
  {
    id: "equator",
    name: "Equator",
    latitude: 0,
    ceremony: "Shellback ceremony",
    tradition: "Order of the Deep",
  },
  { id: "tropic-cancer", name: "Tropic of Cancer", latitude: 23.4366 },
  { id: "tropic-capricorn", name: "Tropic of Capricorn", latitude: -23.4366 },
  {
    id: "arctic-circle",
    name: "Arctic Circle",
    latitude: 66.5633,
    ceremony: "Blue Nose",
  },
  {
    id: "antarctic-circle",
    name: "Antarctic Circle",
    latitude: -66.5633,
    ceremony: "Red Nose",
  },
  { id: "prime-meridian", name: "Prime Meridian", longitude: 0 },
  {
    id: "antimeridian",
    name: "Antimeridian / Date Line",
    longitude: 180,
    ceremony: "Domain of the Golden Dragon",
    note: "the calendar skips or repeats by 24 h",
  },
];

/**
 * Minimum excursion (degrees) on either side of a line before the
 * track counts as being on that side: a track hugging the line —
 * sailing its length, or interpolation noise — must not read as
 * crossing it every hour. About 0.6 nm of latitude.
 */
const SIDE_EPSILON_DEG = 0.01;

/**
 * Normalizes a longitude difference to [−180, 180): the shortest arc
 * between two meridians, antimeridian wrap included.
 *
 * @param {number} delta - Raw longitude difference in degrees
 * @returns {number} Wrapped difference
 */
function wrapLonDelta(delta) {
  return ((((delta + 180) % 360) + 360) % 360) - 180;
}

/**
 * Normalizes a longitude to [−180, 180).
 *
 * @param {number} lon - Longitude in degrees
 * @returns {number} Wrapped longitude
 */
function wrapLon(lon) {
  return wrapLonDelta(lon);
}

/**
 * The nominal timestamp of a track point: simulated hourly rows carry
 * `timestamp` directly; raw payload waypoints only carry forecast
 * lists, whose first entry is the forecast window start — not the
 * time the boat is there (the simulation supplies the schedule).
 *
 * @param {object} point
 * @returns {number|null} Epoch ms, null when the point carries no
 *   parseable timestamp
 */
function pointTimeMs(point) {
  const raw = point?.timestamp ?? point?.forecasts?.[0]?.timestamp ?? null;
  const t = raw != null ? new Date(raw).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * Detects where the track crosses each line of interest.
 *
 * The caller supplies the *simulated* track (route-sim's hourly rows:
 * position, distance made good, timestamp), so ETAs come from the
 * passage schedule rather than the forecast window start — a payload
 * waypoint's first forecast is ~fetch time for every waypoint alike.
 *
 * Crossing detection runs per line with hysteresis: the track must
 * sit clearly beyond {@link SIDE_EPSILON_DEG} on one side and then
 * clearly beyond it on the other before a crossing is counted, and
 * the crossing point interpolates inside the raw sign-change segment
 * between those confirmed-side points. This keeps a route grazing the
 * line (or drifting within noise of it) from reading as dozens of
 * crossings, while a genuine crossing is still placed precisely even
 * when a sample sits almost exactly on the line. Longitudes run
 * unwrapped along the track, so meridian crossings survive an
 * antimeridian hop (175°E → 175°W is a 10° hop over the Date Line,
 * not a 350° swing across the prime meridian).
 *
 * Segments missing coordinates or distances are skipped; a missing
 * time degrades only that crossing's ETA.
 *
 * @param {Array<{lat: number, lon: number, distanceFromStartNm:
 *   number, timestamp?: string, forecasts?: Array<{timestamp:
 *   string}>}>} track - Simulated track points
 * @returns {Array<{lineId: string, lineName: string, ceremony:
 *   string|null, tradition: string|null, note: string|null, lat:
 *   number, lon: number, distanceFromStartNm: number|null, eta:
 *   string|null}>} Crossings sorted by distance from start
 */
export function detectLineCrossings(track) {
  if (!Array.isArray(track)) {
    return [];
  }
  const points = track.filter(
    (p) =>
      Number.isFinite(p?.lat) &&
      Number.isFinite(p?.lon) &&
      Number.isFinite(p.distanceFromStartNm),
  );
  if (points.length < 2) {
    return [];
  }
  // Longitudes unwrapped along the track: each point continues from
  // the previous one by the shortest arc, so a track walking east
  // over 180° keeps counting past it instead of snapping to −180
  const unwrapped = [points[0].lon];
  for (let i = 1; i < points.length; i++) {
    unwrapped.push(
      unwrapped[i - 1] + wrapLonDelta(points[i].lon - unwrapped[i - 1]),
    );
  }
  const times = points.map(pointTimeMs);

  const crossings = [];
  for (const line of LINES_OF_INTEREST) {
    const isParallel = line.latitude != null;
    const linePos = isParallel
      ? line.latitude
      : line.longitude +
        360 * Math.round((line.longitude - unwrapped[0]) / 360);
    const sideOf = (i) => {
      const d = isParallel ? points[i].lat - linePos : unwrapped[i] - linePos;
      return d > SIDE_EPSILON_DEG ? 1 : d < -SIDE_EPSILON_DEG ? -1 : 0;
    };
    let state = sideOf(0);
    let lastConfirmed = 0;
    for (let i = 1; i < points.length; i++) {
      const side = sideOf(i);
      if (side === 0 || side === state) {
        continue;
      }
      if (state === 0) {
        // First confirmed side along this track: no crossing behind it
        state = side;
        lastConfirmed = i;
        continue;
      }
      // The track moved from one confirmed side to the other: the
      // crossing interpolates on the raw sign-change segment between
      // the two confirmed-side points
      for (let j = lastConfirmed; j < i; j++) {
        const dA = isParallel
          ? points[j].lat - linePos
          : unwrapped[j] - linePos;
        const dB = isParallel
          ? points[j + 1].lat - linePos
          : unwrapped[j + 1] - linePos;
        if (dA !== 0 && dB !== 0 && dA * dB < 0) {
          const f = dA / (dA - dB);
          const a = points[j];
          const b = points[j + 1];
          const span = b.distanceFromStartNm - a.distanceFromStartNm;
          const tA = times[j];
          const tB = times[j + 1];
          crossings.push({
            lineId: line.id,
            lineName: line.name,
            ceremony: line.ceremony ?? null,
            tradition: line.tradition ?? null,
            note: line.note ?? null,
            lat: isParallel ? linePos : a.lat + f * (b.lat - a.lat),
            lon: wrapLon(unwrapped[j] + f * (unwrapped[j + 1] - unwrapped[j])),
            distanceFromStartNm:
              span === 0
                ? a.distanceFromStartNm
                : a.distanceFromStartNm + f * span,
            eta:
              tA != null && tB != null
                ? new Date(tA + f * (tB - tA)).toISOString()
                : null,
          });
          break;
        }
      }
      state = side;
      lastConfirmed = i;
    }
  }
  return crossings.sort((x, y) => {
    if (x.distanceFromStartNm == null || y.distanceFromStartNm == null) {
      return x.distanceFromStartNm == null ? 1 : -1;
    }
    return x.distanceFromStartNm - y.distanceFromStartNm;
  });
}
