/**
 * Meteor-shower night evaluation (work doc #37), shared by the
 * plugin's server compile and the webapp's simulation worker — one
 * implementation, two consumers, like the rest of `components/`.
 *
 * The shower calendar is the static annual table work doc #3 chose:
 * shower maxima drift by hours year to year, and the ±1-night
 * bracketing around the catalog peak absorbs that drift, so no fetch
 * source is needed. Everything variable is supplied by the caller:
 *
 * - `nights` — the per-night context (anchor instant, whether
 *   nautical night exists, moon illumination at the anchor): on the
 *   server this is `celestialNights` computed at the vessel position;
 *   in the worker it is the payload's `celestialNights`, already
 *   riding the briefing.
 * - `positionAt` — the forecasted position at an instant: the
 *   interpolated simulated track in the worker (the radiant altitude
 *   is the position-sensitive gate, and this is why the evaluation
 *   runs where the track lives, like the sail changes), the vessel
 *   position on the server, or nothing for a fixed position.
 * - `cloudCoverAt` — forecast cloud cover at an instant.
 *
 * A shower whose nominal peak hour falls in local daytime still
 * watches fine on the bracketing nights — the activity profile is
 * broad, not an instant — so each qualifying night fires its own
 * event, worded honestly: the peak night claims the ZHR, the
 * neighbors say climbing toward / just past. Sharp-maximum showers
 * (the Quadrantids) lose more on the bracket nights than broad ones;
 * the hedge in the wording covers them without a per-shower profile
 * table.
 *
 * Kept free of DOM and dependencies so Node requires it and the
 * worker imports it.
 *
 * @module meteors
 */

/**
 * Major annual meteor showers with well-behaved peaks. `peakHourUtc`
 * is the typical shower maximum expressed in UTC hours on the peak
 * date (approximate — the bracketing nights are the screen, not an
 * ephemeris of the maximum itself); `dec` is the radiant declination;
 * `zhr` the nominal zenith hourly rate.
 */
export const METEOR_SHOWERS = [
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

/** Altitude (degrees) a meteor radiant must reach from the night's
 * position to be worth reporting: marine boundary-layer haze eats
 * anything lower. */
export const MIN_RADIANT_ALTITUDE_DEG = 20;

/** Moon illumination fraction at or below which the night counts as
 * dark enough (the gate compares against a crescent threshold). */
export const MAX_MOON_ILLUMINATION = 0.3;

/** How far a night's anchor may sit from the nominal peak and still
 * belong to the shower's watch: the night whose dark hours hold the
 * peak, plus its neighbors. Anchors are ~24 h apart, so this window
 * admits at most three nights per peak regardless of longitude. */
const CANDIDATE_BEFORE_MS = 46 * 3600000;
const CANDIDATE_AFTER_MS = 32 * 3600000;

/** Fallback dark-span length when the night context carries no
 * dawn stamp: peaks falling inside it make that night the peak
 * night. Generous enough for the long darkness at high latitudes;
 * the context's own `nauticalDawn` wins when present. */
const NIGHT_SPAN_MS = 14 * 3600000;

/**
 * Maximum altitude a meteor radiant reaches from a latitude:
 * 90° − |lat − dec|.
 *
 * @param {number} lat - Latitude in degrees
 * @param {number} dec - Radiant declination in degrees
 * @returns {number} Highest radiant altitude in degrees
 */
export function radiantMaxAltitudeDeg(lat, dec) {
  return 90 - Math.abs(lat - dec);
}

const DAY_MS = 86400000;

/**
 * Evaluates the shower calendar against the timeline's nights.
 *
 * @param {object} params
 * @param {Date} params.from - Window start
 * @param {number} params.hours - Window length
 * @param {Array<{timestamp: string, nauticalDusk: string|null,
 *   nauticalDawn: string|null, moonIllumination: number}>} params.nights - Per-night context,
 *   one entry per night the caller can vouch for (server:
 *   `celestialNights` at the vessel position; worker: the payload's
 *   `celestialNights`). Nights outside this context are skipped —
 *   no invented anchors.
 * @param {number} params.lat - Fallback latitude (degrees; the
 *   radiant gate is latitude-only)
 * @param {((timestamp: string) => {lat: number, lon: number}|null)|null}
 *   [params.positionAt] - Forecasted position at an instant (the
 *   simulated track in the worker); null evaluates every night at the
 *   fallback position
 * @param {((timestamp: string) => number|null)|undefined}
 *   [params.cloudCoverAt] - Forecast cloud cover (percent) at an
 *   instant; null answers pass
 * @returns {Array<{kind: string, timestamp: string, tactical: boolean,
 *   name: string, description: string}>} One event per qualifying
 *   (shower, night) pair, sorted by instant
 */
export function meteorNightEvents({
  from,
  hours,
  nights,
  lat,
  positionAt = null,
  cloudCoverAt,
}) {
  const events = [];
  const end = from.getTime() + hours * DAY_MS;
  // Candidate nights keyed by anchor instant — longitude-proof: a
  // night's dusk anchor may fall on either side of its UTC calendar
  // date, so calendar-date keying would misfile nights
  const candidates = (nights ?? [])
    .filter((night) => night?.timestamp && night.nauticalDusk)
    .map((night) => ({
      anchor: Date.parse(night.timestamp),
      night,
    }))
    .filter((entry) => Number.isFinite(entry.anchor))
    .sort((a, b) => a.anchor - b.anchor);

  for (const shower of METEOR_SHOWERS) {
    for (const year of [from.getUTCFullYear(), from.getUTCFullYear() + 1]) {
      const peak = Date.UTC(
        year,
        shower.month - 1,
        shower.day,
        shower.peakHourUtc,
      );
      if (peak < from.getTime() || peak >= end) {
        continue;
      }
      // The nights worth evaluating: the one whose dark hours hold
      // the peak ("peak tonight"), and its neighbors on either side
      // (rates climbing toward it, or easing past it)
      const nearby = candidates.filter(
        (entry) =>
          entry.anchor >= peak - CANDIDATE_BEFORE_MS &&
          entry.anchor <= peak + CANDIDATE_AFTER_MS,
      );
      for (const { anchor, night } of nearby) {
        const anchorIso = new Date(anchor).toISOString();
        // The peak night is the one whose dark hours hold the peak:
        // nautical dusk → nautical dawn when the context carries the
        // dawn, the fallback span otherwise
        const dusk = Date.parse(night.nauticalDusk ?? "");
        const dawn = Date.parse(night.nauticalDawn ?? "");
        const holdsPeak =
          Number.isFinite(dusk) && Number.isFinite(dawn)
            ? peak >= dusk && peak < dawn
            : peak >= anchor && peak < anchor + NIGHT_SPAN_MS;
        const wording = holdsPeak
          ? "peak"
          : anchor < peak
            ? "climbing"
            : "past";
        const position = positionAt ? positionAt(anchorIso) : null;
        const nightLat = position?.lat ?? lat;
        if (
          radiantMaxAltitudeDeg(nightLat, shower.dec) < MIN_RADIANT_ALTITUDE_DEG
        ) {
          continue;
        }
        const illumination = night.moonIllumination;
        if (
          !Number.isFinite(illumination) ||
          illumination >= MAX_MOON_ILLUMINATION
        ) {
          continue;
        }
        if (
          typeof cloudCoverAt === "function" &&
          (() => {
            const cover = cloudCoverAt(anchorIso);
            return cover != null && cover > 30;
          })()
        ) {
          continue;
        }
        const peakLabel = `${shower.name} peak ${new Date(peak).toISOString().slice(0, 10)}`;
        const moonText = `(Moon ${Math.round(illumination * 100)}% lit)`;
        const description =
          wording === "peak"
            ? `${shower.name} peak tonight: up to ~${shower.zhr} meteors/h ${moonText}`
            : wording === "climbing"
              ? `${shower.name} — climbing toward the ${peakLabel}: up to ~${shower.zhr} meteors/h on the peak itself ${moonText}`
              : `${shower.name} — just past the ${peakLabel}: rates easing, still worth a look ${moonText}`;
        events.push({
          kind: "meteor",
          timestamp: anchorIso,
          tactical: true,
          name: shower.name,
          description,
        });
      }
    }
  }
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
