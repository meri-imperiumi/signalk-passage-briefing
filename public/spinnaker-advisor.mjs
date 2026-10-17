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
 * TWA (deg, folded 0-180) default floor for a downwind sail, when
 * the class carries none of its own. Downwind sails are deep: the
 * crew's Parasailor deployments fold at p10 142°, poled-out 133°,
 * and bergie states 130° as the Parasailor floor — a reaching sail
 * (code zero / asymmetric) would cover the 60-130° band and carries
 * its own floor when the inventory grows one.
 */
export const DOWNWIND_MIN_TWA_DEG = 90;

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
 * @param {boolean} [params.storm] - Named forecast event at the hour
 *   (probable rain squalls, convective air, squall-risk advisory)
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
  storm = false,
  nightOk = false,
  envelope = {},
}) {
  if (!Number.isFinite(twsKnots) || !Number.isFinite(twaDeg)) {
    return "unknown";
  }
  if (Math.abs(twaDeg) < (envelope.minTwaDeg ?? DOWNWIND_MIN_TWA_DEG)) {
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
  // Named forecast events take precedence as retract reasons: they
  // are the forecast's explicit "sail comes down now" markers
  if (storm) {
    return "squall window";
  }
  if (maxTws != null && twsKnots > maxTws) {
    return "wind above envelope";
  }
  if (!Number.isFinite(awsKnots) || awsKnots < DOWNWIND_FILL_MIN_AWS_KNOTS) {
    return "below fill floor";
  }
  if (Number.isFinite(hsMeters) && hsMeters > DOWNWIND_HS_CEILING_M) {
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

/**
 * The forward-looking deployment plan (work doc #41): for each hour
 * of a simulated passage, how long the forecast would let the sail
 * stay up — the horizon — and which stretches justify the rigging
 * work. A recommendation needs:
 *
 * - a horizon of qualifying hours at or over the minimum window
 *   (the hassle threshold), starting in daylight (the night gate:
 *   night hours continue a horizon, never start one),
 * - a watch-anchored deploy moment that still leaves the minimum
 *   window of payoff (the anchoring composes with the night rule:
 *   a horizon opening at night waits for the dawn anchor),
 * - and it ends where the forecast breaks — the squall window, the
 *   envelope exit, the sea-state ceiling — which supplies the
 *   take-down stamp for free.
 *
 * Pure: the caller feeds per-hour forecast facts and the downwind
 * sail inventory; the return is the timeline's deploy/take-down
 * entries.
 *
 * @param {Array<{hourMs: number, twsKnots: number, twaDeg: number,
 *   awsKnots: number, hsMeters?: number, gustFactor?: number,
 *   night?: boolean, underCanvas?: boolean}>} hours - Chronological
 *   forecast hours
 * @param {object} [options]
 * @param {Array<{name: string, claim: "comfort"|"drive",
 *   minTwsKnots?: number|null, maxTwsKnots?: number|null,
 *   minTwaDeg?: number|null}>} [options.downwindSails] - The
 *   inventory's downwind sails (Parasailor-class claims comfort,
 *   poled-out claims drive)
 * @param {number[]} [options.watchAnchorsMs] - Watch-change instants
 *   (chronological); deployments anchor to the next one inside the
 *   window when it still leaves the minimum payoff. Empty = day-sail
 *   mode: deployments are immediate.
 * @param {number} [options.minWindowHours] - Hassle threshold
 * @param {boolean} [options.nightOk] - Whether night hours may start
 *   a horizon (default false)
 * @returns {Array<{startMs: number, untilMs: number, sailName: string,
 *   claim: string, anchoredMs: number|null, breakReason: string|null,
 *   hours: number}>} Deployments, chronological
 */
export function deploymentPlan(hours, options = {}) {
  const sails = Array.isArray(options.downwindSails)
    ? options.downwindSails
    : [];
  if (sails.length === 0) {
    return [];
  }
  const minWindowHours = options.minWindowHours ?? DOWNWIND_MIN_WINDOW_HOURS;
  const nightOk = options.nightOk ?? false;
  const anchors = (options.watchAnchorsMs ?? [])
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  // Per-hour, per-sail hard-gate failures (night handled separately
  // in the horizon scan — it continues, never starts)
  const perSail = hours.map((hour) =>
    sails.map((sail) => ({
      sail,
      reason: evaluateDownwindSail({
        twsKnots: hour.twsKnots,
        twaDeg: hour.twaDeg,
        awsKnots: hour.awsKnots,
        hsMeters: hour.hsMeters,
        gustFactor: hour.gustFactor,
        envelope: sail,
      }),
    })),
  );

  const deployments = [];
  /** First hour index not consumed by a returned deployment. */
  let cursor = 0;
  for (let start = cursor; start < hours.length; start++) {
    if (start < cursor) {
      continue;
    }
    const hour = hours[start];
    const night = hour.night === true;
    // Night hours cannot start a horizon unless explicitly allowed
    const startable = !night || nightOk;
    if (!startable) {
      continue;
    }
    // The best sail for this start: one whose horizon reaches the
    // minimum window, comfort claim preferred over drive
    let chosen = null;
    for (const { sail, reason } of perSail[start]) {
      if (reason != null) {
        continue;
      }
      // Forward horizon: consecutive hours the hard gates hold;
      // night hours continue (they cannot start, but they do not
      // break an already-started horizon)
      let horizon = 0;
      let breakReason = null;
      for (let i = start; i < hours.length; i++) {
        const entry = perSail[i].find((p) => p.sail === sail);
        const hourNight = hours[i].night === true;
        if (entry.reason == null || (hourNight && entry.reason === "night")) {
          horizon++;
        } else {
          breakReason = entry.reason;
          break;
        }
      }
      if (horizon >= minWindowHours) {
        const candidate = {
          sail,
          horizon,
          breakReason,
          // Comfort claims outrank drive claims on the same conditions
          preferred: sail.claim === "comfort",
        };
        if (
          chosen == null ||
          (candidate.preferred && !chosen.preferred) ||
          (candidate.preferred === chosen.preferred &&
            candidate.horizon > chosen.horizon)
        ) {
          chosen = candidate;
        }
      }
    }
    if (chosen == null) {
      continue;
    }
    const endMs = hours[start + chosen.horizon - 1].hourMs;
    // The deploy moment anchors to the next watch change inside the
    // window — but only while the anchored remainder still pays the
    // minimum window. Day sails (no anchors) deploy immediately.
    let anchoredMs = null;
    for (const anchor of anchors) {
      if (anchor >= hour.hourMs && anchor <= endMs) {
        const anchoredHours =
          Math.round(((endMs - anchor) / 3600000 + 1) * 10) / 10;
        if (anchoredHours >= minWindowHours) {
          anchoredMs = anchor;
        }
        break;
      }
    }
    const startMs = anchoredMs ?? hour.hourMs;
    deployments.push({
      startMs,
      untilMs: endMs,
      sailName: chosen.sail.name,
      claim: chosen.sail.claim,
      anchoredMs,
      breakReason: chosen.breakReason,
      hours: chosen.horizon,
    });
    // The cursor skips the consumed hours: hours inside a deployment
    // window do not start overlapping ones
    cursor = start + chosen.horizon;
    start = cursor - 1;
  }
  return deployments;
}
