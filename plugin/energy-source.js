/**
 * Energy forecast consumer (work doc #10): the briefing stays a
 * consumer — signalk-energy-predictor owns the energy model, including
 * the surplus and deficit *terms*.
 *
 * The predictor publishes its hourly forecast (45 entries, 48 h, no
 * windowing needed) as one delta value on
 * `electrical.energy.prediction.forecast.hourly`, and its outlook
 * terms as scalar paths:
 *
 * - `.status` — overall 24 h outlook: "surplus" (battery fills to 100%
 *   and production is curtailed), "rising", "stable", "deficit" (SoC
 *   ends >5 points below now), "critical" (dips below the chemistry
 *   threshold);
 * - `.surplus` / `.surplus.from` / `.surplus.to` — the curtailment
 *   surplus in Wh with its window: energy the charge controller would
 *   throw away, available for opportunistic loads;
 * - `.net` — the 24 h bank trajectory in Wh (positive = rising,
 *   negative = falling);
 * - `.timeToEmpty` — predicted depletion timestamp, or null.
 *
 * The plugin subscribes to all of these like any other Signal K path
 * and keeps the latest values in memory. At briefing compile the
 * forecast adapts into the frozen `energyHourly` consumer contract —
 * `[{timestamp, solarWh, loadWh}]` — riding the briefing payload, so
 * the offline hours re-derive from the payload cache without a cache
 * of their own.
 *
 * Field mapping: the contract's `solarWh` carries the predictor's
 * *total ideal generation* (solar + wind + hydro + alternator), since
 * the balance on board cares about every source; `loadWh` is the
 * house load. `netWh` and `soc` ride along enriched.
 *
 * The energy events the timeline surfaces are the predictor's own:
 * a surplus event when curtailment is forecast, a deficit event when
 * the outlook status says deficit or critical — not an independent
 * re-derivation with invented thresholds.
 *
 * @file energy-source.js
 */

/** The predictor's hourly forecast path (one array value). */
const ENERGY_FORECAST_PATH = "electrical.energy.prediction.forecast.hourly";

/**
 * Scalar outlook paths (work doc #10 update): the predictor's own
 * surplus/deficit terms.
 */
const ENERGY_OUTLOOK_PATHS = {
  status: "electrical.energy.prediction.status",
  net: "electrical.energy.prediction.net",
  surplus: "electrical.energy.prediction.surplus",
  surplusFrom: "electrical.energy.prediction.surplus.from",
  surplusTo: "electrical.energy.prediction.surplus.to",
  timeToEmpty: "electrical.energy.prediction.timeToEmpty",
};

/**
 * Adapts the predictor's hourly forecast into the briefing's
 * `energyHourly` contract shape. Entries without a parseable time are
 * skipped; generation sums the four ideal sources plus the alternator
 * and rounds to whole Wh.
 *
 * @param {Array<object>|null} forecast - Raw
 *   `electrical.energy.prediction.forecast.hourly` value
 * @returns {Array<{timestamp: string, solarWh: number, loadWh: number,
 *   netWh: number, soc: number|null}>}
 */
function adaptEnergyForecast(forecast) {
  if (!Array.isArray(forecast)) {
    return [];
  }
  const rows = [];
  for (const entry of forecast) {
    const timestamp = entry?.time != null ? new Date(entry.time) : null;
    if (!timestamp || Number.isNaN(timestamp.getTime())) {
      continue;
    }
    const solarWh = Math.round(
      (entry.idealSolarYieldWh ?? 0) +
        (entry.idealWindYieldWh ?? 0) +
        (entry.idealHydroYieldWh ?? 0) +
        (entry.alternatorWh ?? 0),
    );
    const loadWh = Math.round(entry.houseLoadWh ?? 0);
    rows.push({
      timestamp: timestamp.toISOString(),
      solarWh,
      loadWh,
      netWh: solarWh - loadWh,
      soc:
        typeof entry.idealSoC === "number" && Number.isFinite(entry.idealSoC)
          ? entry.idealSoC
          : null,
    });
  }
  return rows;
}

/**
 * Derives the briefing's energy events from the predictor's own
 * outlook state — its terms, its windows, no independent thresholds:
 *
 * - **Surplus** when the forecast curtailment is positive: the battery
 *   fills to 100% while yield continues, so energy would be thrown
 *   away — the window is when it happens and the crew can run
 *   opportunistic loads through it.
 * - **Deficit** when the outlook status is `deficit` (SoC ends more
 *   than 5 points below now) or `critical` (dips below the chemistry
 *   threshold) — renewables cannot cover the daily usage and the
 *   battery keeps going down. `timeToEmpty` rides along when the
 *   trajectory names a date.
 *
 * @param {object} state - Latest outlook values from the subscribed
 *   paths
 * @param {string|null} state.status
 * @param {number|null} state.net - 24 h net balance (Wh)
 * @param {number|null} state.surplus - Curtailment surplus (Wh)
 * @param {string|null} state.surplusFrom - Window start (ISO)
 * @param {string|null} state.surplusTo - Window end (ISO)
 * @param {string|null} state.timeToEmpty - Depletion timestamp (ISO)
 * @returns {Array<{type: "surplus"|"deficit", status: string|null,
 *   netWh: number|null, timestamp: string|null, endTimestamp: string|
 *   null, timeToEmpty: string|null}>}
 */
function energyEventsFromState({
  status,
  net,
  surplus,
  surplusFrom,
  surplusTo,
  timeToEmpty,
}) {
  const events = [];
  if (typeof surplus === "number" && surplus > 0) {
    events.push({
      type: "surplus",
      status: status ?? null,
      netWh: Math.round(surplus),
      timestamp: surplusFrom ?? null,
      endTimestamp: surplusTo ?? null,
      timeToEmpty: null,
    });
  }
  const normalized = String(status ?? "").toLowerCase();
  if (normalized === "deficit" || normalized === "critical") {
    events.push({
      type: "deficit",
      status: normalized,
      netWh:
        typeof net === "number" && Number.isFinite(net)
          ? Math.round(net)
          : null,
      timestamp: null,
      endTimestamp: null,
      timeToEmpty: timeToEmpty ?? null,
    });
  }
  return events;
}

module.exports = {
  ENERGY_FORECAST_PATH,
  ENERGY_OUTLOOK_PATHS,
  adaptEnergyForecast,
  energyEventsFromState,
};
