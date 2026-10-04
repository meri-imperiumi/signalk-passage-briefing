/**
 * Critical hazard notifications (work doc #30): an escalation layer
 * over the already-ingested warning stream — bulletin blocks (#4/#21),
 * GDACS events (#22), CAP alerts (#24). Almost all warnings correctly
 * stay as passive timeline entries and chart notes; a small class
 * should interrupt dinner.
 *
 * The escalation matrix requires BOTH a hazard condition and an
 * exposure condition:
 *
 * - **Tropical cyclone** (GDACS TC Red/Orange, CAP HURRICANE/TYPHOON,
 *   advisory storms from #21): impact area near the vessel — the
 *   compile-time filters established that; the escalation adds the
 *   max-severity requirement.
 * - **Tsunami** (CAP TSUNAMI events, GDACS EQ): vessel anchored or
 *   moored — a roadstead is shallow by definition — or a live depth
 *   sounding present (a common transducer reads only to ~100 m, so a
 *   reading means the bottom is within range, i.e. shallow). A tsunami
 *   observed in deep open water with no sounding stays a passive
 *   event: in hundreds of metres it is a non-event for the hull.
 * - **Direct-hit gale/storm**: a bulletin warning block whose
 *   extracted geometry contains the vessel position NOW (not
 *   along-track — those stay passive).
 *
 * Everything else remains timeline/notes content. The matrix is
 * deliberately small: escalations must be rare enough to always be
 * taken seriously.
 *
 * @file hazard-alerts.js
 */

/** Notification states per the escalation matrix. */
const STATE = { emergency: "emergency", error: "error" };

/**
 * The navigation states that count as "in port or at anchor" for the
 * tsunami exposure condition (same set as the state machine's
 * MOORED_STATES — duplicated because this module is pure).
 */
const MOORED_STATES = new Set(["moored", "anchored"]);

/**
 * Classifies one refresh's warning stream into notifications.
 *
 * @param {object} params
 * @param {Array<object>} [params.gdacsEvents] - Filtered GDACS events
 *   (payload.hazardEvents: {id, type, alertLevel, ...})
 * @param {Array<object>} [params.capAlerts] - Filtered CAP alerts
 *   (payload.capAlerts: {id, event, severity, ...})
 * @param {Array<object>} [params.bulletinBlocks] - Serve-time
 *   filtered bulletin blocks ({storm?, geometry?, text, ...})
 * @param {{lat: number, lon: number}|null} params.vessel - Vessel
 *   position
 * @param {string|null} [params.navigationState] - navigation.state
 * @param {boolean} [params.hasDepthReading] - A live depth sounding
 *   exists (transducer in range = shallow)
 * @returns {Array<{id: string, state: string, message: string,
 *   eventId: string}>} Notifications to raise
 */
function escalateHazards({
  gdacsEvents = [],
  capAlerts = [],
  bulletinBlocks = [],
  vessel,
  navigationState = null,
  hasDepthReading = false,
}) {
  const notifications = [];
  const moored =
    typeof navigationState === "string" && MOORED_STATES.has(navigationState);

  // Tropical cyclone: GDACS TC at Red or Orange — the compile filters
  // established impact (near vessel or route)
  for (const event of gdacsEvents ?? []) {
    if (
      event?.type === "TC" &&
      (event.alertLevel === "red" || event.alertLevel === "orange")
    ) {
      notifications.push({
        id: `gdacs-${event.id}`,
        eventId: event.id,
        state: STATE.emergency,
        message: `Tropical cyclone: ${event.title ?? event.type} — ${event.distanceNm ?? "?"} nm from the vessel`,
      });
    }
  }

  // CAP alerts: tsunami events and hurricane/typhoon events
  for (const alert of capAlerts ?? []) {
    const event = String(alert.event ?? "").toLowerCase();
    const id = `cap-${alert.identifier ?? alert.id}`;
    if (event.includes("tsunami")) {
      // Exposure decides: at anchor/in port → emergency (a roadstead
      // is shallow by definition); in transit with a live sounding →
      // error (transducer in range = shallow); deep water, no
      // sounding → not an escalation at all
      if (moored) {
        notifications.push({
          id,
          eventId: alert.identifier ?? alert.id,
          state: STATE.emergency,
          message: `Tsunami ${alert.severity ?? "warning"} while at anchor: ${alert.headline ?? alert.event}`,
        });
      } else if (hasDepthReading) {
        notifications.push({
          id,
          eventId: alert.identifier ?? alert.id,
          state: STATE.error,
          message: `Tsunami ${alert.severity ?? "warning"} — shallow water (sounding in range): ${alert.headline ?? alert.event}`,
        });
      }
      // Deep water, underway: passive timeline event only
    } else if (event.includes("hurricane") || event.includes("typhoon")) {
      notifications.push({
        id,
        eventId: alert.identifier ?? alert.id,
        state: STATE.emergency,
        message: `${alert.event}: ${alert.headline ?? "impact area near the vessel"}`,
      });
    }
  }

  // Direct-hit gale/storm: a bulletin block whose geometry contains
  // the vessel position now. The block carries the serve-time filtered
  // geometry; the point-in-ring test comes from the caller-supplied
  // containment check (the bulletin-engine's ringContains).
  for (const block of bulletinBlocks ?? []) {
    if (block?.geometry?.type !== "polygon" || block.isSevere?.() !== true) {
      continue;
    }
    if (vessel && block.containsPoint?.(vessel.lon, vessel.lat) === true) {
      notifications.push({
        id: `bulletin-${block.id ?? "direct"}`,
        eventId: block.id ?? "direct-hit",
        state: STATE.error,
        message: `Direct hit: ${block.storm?.stormName ?? block.title ?? block.text?.slice(0, 80) ?? "severe warning"} — vessel inside the warning area`,
      });
    }
  }

  return notifications;
}

/**
 * Suppression hysteresis (work doc #30): a notification that dips out
 * of the matrix for one refresh cycle does not flap the alarm — it
 * clears only after `missesToClear` consecutive cycles without
 * qualifying. Pure function over the previous active set.
 *
 * @param {object} params
 * @param {Map<string, object>} params.previous - Previously active
 *   notifications by id
 * @param {Array<object>} params.current - This cycle's escalations
 * @param {Map<string, number>} [params.missCounts] - Per-id
 *   consecutive miss counters (mutated)
 * @param {number} [params.missesToClear=2]
 * @returns {{active: Map<string, object>, cleared: string[]}} The new
 *   active set and the ids that cleared this cycle
 */
function applyHysteresis({ previous, current, missCounts, missesToClear = 2 }) {
  const misses = missCounts ?? new Map();
  const active = new Map();
  const cleared = [];
  const currentIds = new Set((current ?? []).map((n) => n.id));
  // This cycle's escalations are always active
  for (const notification of current ?? []) {
    active.set(notification.id, notification);
  }
  // Previously active ids that dipped out: carry them through the
  // miss grace period (borderline geometry must not flap the alarm)
  for (const [id, notification] of previous ?? []) {
    if (currentIds.has(id)) {
      continue;
    }
    const count = (misses.get(id) ?? 0) + 1;
    misses.set(id, count);
    if (count >= missesToClear) {
      cleared.push(id);
      misses.delete(id);
    } else {
      active.set(id, notification); // Still within the grace period
    }
  }
  // Present ids reset their miss counter
  for (const id of currentIds) {
    misses.delete(id);
  }
  return { active, cleared, missCounts: misses };
}

module.exports = {
  STATE,
  MOORED_STATES,
  escalateHazards,
  applyHysteresis,
};
