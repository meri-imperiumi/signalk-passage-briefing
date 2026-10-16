/**
 * Downwind-sail deployment advisor (work doc #41): the pure gate
 * evaluator the sail-change planner and the backtest runner share.
 *
 * The premise is the #38 finding the crew themselves framed: their
 * downwind light-air days — Parasailor set, sails drawing, following
 * long swell — read champagne, while the working-canvas hours in the
 * same forecast would slat and cost sail work. The advisor decides,
 * hour by hour, whether the forecast sits in the envelope where a
 * downwind sail is worth deploying, with the honest gates that keep
 * the recommendation trustworthy.
 *
 * Behavioral asymmetries (bergie session): the learned envelope is a
 * floor, not an endorsement ceiling — crews under-report deployment,
 * so the gates may recommend beyond logged usage; and deployment is
 * real work, so only windows of qualifying hours recommend at all.
 * The window run-length logic lives here too
 * (`collectDownwindWindows`).
 *
 * @file spinnaker-advisor.mjs
 */

/**
 * TWA (deg, folded 0-180) from which a downwind sail is the reaching
 * canvas: the trigger is the slatting regime on a reach or run, not a
 * beat. The crew's own deployments fold down to ~60° (a Parasailor
 * broad-reaches happily), so the gate sits there, not at 90.
 */
export const DOWNWIND_MIN_TWA_DEG = 60;

/**
 * Apparent wind (kn) below which a downwind sail will not fill even
 * with the boat pushing it (work doc #41 envelope floor).
 */
export const DOWNWIND_FILL_MIN_AWS_KNOTS = 2;

/**
 * Gust factor (gust / base wind) at which the hour is squally air —
 * the same bar the squall-risk advisory uses (work doc #38): gust
 * cycling forces canvas off and then slats the reduced canvas.
 */
export const DOWNWIND_SQUALL_GUST_FACTOR = 2;

/**
 * Minimum length (hours) of a qualifying stretch for a deployment
 * recommendation — the hassle threshold (work doc #41): rigging the
 * sail is real work, a two-hour blip gets a note at most.
 */
export const DOWNWIND_MIN_WINDOW_HOURS = 3;

/**
 * Significant wave height (m) above which the downwind sail comes
 * down regardless of the wind: the sea-state ceiling. The crew's own
 * deployments top out at 3.3 m (p95 3.1) — the take-down threshold
 * sits just above their demonstrated practice.
 */
export const DOWNWIND_HS_CEILING_M = 3.5;

/**
 * Why an hour fails the gates, for the timeline's honest take-down
 * wording. One reason per hour, checked in gate order.
 *
 * The night gate has two strengths (the backtest's own crew flew
 * 23-40 % of their downwind hours after dark — a blanket night ban
 * contradicts practice): a night hour *continues* an already-open
 * deployment window (the sail is up; leaving it is normal), but it
 * never *starts* one (rigging in the dark is the reluctance). The
 * window collector implements the split; this evaluator only
 * reports `night`.
 *
 * @param {object} params
 * @param {number} params.twsKnots - True wind speed (kn)
 * @param {number} params.twaDeg - True wind angle (deg, folded 0-180)
 * @param {number} params.awsKnots - Apparent wind speed (kn)
 * @param {number} [params.hsMeters] - Significant wave height (m)
 * @param {number} [params.gustFactor] - Gust / base wind ratio
 * @param {boolean} [params.night] - Sun below the horizon at the hour
 * @param {boolean} [params.nightOk] - Whether night deployment is
 *   acceptable (default false: most crews are reluctant)
 * @param {{minTwsKnots?: number|null, maxTwsKnots?: number|null}} params.envelope
 *   The sail's wind window — learned from the crew's own deployments
 *   or configured; the floor may stretch beyond logged usage only in
 *   the maxTws direction when the payoff says so (bergie session)
 * @returns {string|null} null = the hour qualifies
 */
export function evaluateDownwindSail({
  twsKnots,
  twaDeg,
  awsKnots,
  hsMeters,
  gustFactor,
  night = false,
  nightOk = false,
  envelope = {},
}) {
  if (!Number.isFinite(twsKnots) || !Number.isFinite(twaDeg)) {
    return "unknown";
  }
  if (Math.abs(twaDeg) < DOWNWIND_MIN_TWA_DEG) {
    return "point of sail";
  }
  const minTws = envelope.minTwsKnots;
  const maxTws = envelope.maxTwsKnots;
  if (minTws != null && twsKnots < minTws) {
    return "wind below envelope";
  }
  // Gusts kill it before the envelope max: the sail comes off for
  // the squalls anyway, and the reef-then-slat cycle follows
  if (gustFactor != null && gustFactor >= DOWNWIND_SQUALL_GUST_FACTOR) {
    return "squall gusts";
  }
  if (maxTws != null && twsKnots > maxTws) {
    return "wind above envelope";
  }
  if (!Number.isFinite(awsKnots) || awsKnots < DOWNWIND_FILL_MIN_AWS_KNOTS) {
    return "below fill floor";
  }
  if (
    Number.isFinite(hsMeters) &&
    hsMeters > DOWNWIND_HS_CEILING_M
  ) {
    return "sea state";
  }
  if (night && !nightOk) {
    return "night";
  }
  return null;
}

/**
 * Collects the qualifying windows from a chronological run of
 * per-hour evaluations: consecutive qualifying hours merge, and only
 * windows at or over the minimum length recommend (the hassle
 * threshold). Short stretches stay quiet — a note at most.
 *
 * @param {Array<{hourMs: number, qualifies: boolean, reason: string|null,
 *   night?: boolean, [key: string]: unknown}>} hours - Chronological
 *   per-hour results
 * @param {{minWindowHours?: number, nightContinuation?: boolean}} [options]
 *   `nightContinuation` (default true): hours whose only failing gate
 *   is `night` continue an open window but cannot open one — leaving
 *   a sail up overnight is normal, rigging in the dark is the
 *   reluctance the gate models
 * @returns {Array<{startMs: number, endMs: number, hours: number,
 *   hours_: Array<object>}>} Windows, chronological
 */
export function collectDownwindWindows(hours, options = {}) {
  const minWindowHours = options.minWindowHours ?? DOWNWIND_MIN_WINDOW_HOURS;
  const nightContinuation = options.nightContinuation ?? true;
  const windows = [];
  let open = null;
  const close = () => {
    if (open && open.hours.length >= minWindowHours) {
      windows.push({
        startMs: open.hours[0].hourMs,
        endMs: open.hours.at(-1).hourMs,
        hours: open.hours.length,
        hours_: open.hours,
      });
    }
    open = null;
  };
  for (const hour of hours) {
    const joins =
      hour.qualifies ||
      (nightContinuation && open != null && hour.reason === "night");
    if (joins) {
      if (open) {
        open.hours.push(hour);
      } else {
        open = { hours: [hour] };
      }
    } else {
      close();
    }
  }
  close();
  return windows;
}
