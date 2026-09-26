/**
 * Connection & navigation state machine (SPEC §2.2).
 *
 * Tracks `network.internet.state`, `navigation.state` and the house bank
 * state of charge, and decides when weather fetches may run:
 *
 * - `OFFLINE`: internet down. No fetching; spool directory is the only
 *   data source (watched by the spool engine, not this module).
 * - `TRIGGER_ONESHOT`: transient pass-through state realized whenever the
 *   internet state *changes* into `online` or `metered`. The transition
 *   itself fires a single explicit fetch. Because the resolution
 *   conditions (metered/sailing vs online/moored) are known immediately,
 *   the machine lands directly in the target stable state and reports the
 *   trigger via the returned `fetch: "oneshot"` action.
 * - `STANDBY_OFFSHORE`: internet up but the vessel is sailing, or the
 *   link is metered, or the house bank is not full. Cron timers are
 *   disabled — fetches are strictly tied to explicit internet-state
 *   transitions (and later, spool files).
 * - `PERSISTENT_CRON`: online, moored/anchored, state of charge above the
 *   full threshold. Weather fetches run at the fixed UTC publication
 *   windows (02:15, 08:15, 14:15, 20:15 — 15 minutes after major global
 *   ensemble publication times).
 *
 * The machine contains no timers of its own: every method takes an `at`
 * instant so callers (and tests) drive the clock. `update()` processes
 * observations from the Signal K stream, `tick()` is called periodically
 * by the plugin to check whether a cron window has come due.
 *
 * @file state-machine.js
 */

/**
 * Machine states.
 */
const STATES = {
  OFFLINE: "OFFLINE",
  TRIGGER_ONESHOT: "TRIGGER_ONESHOT",
  STANDBY_OFFSHORE: "STANDBY_OFFSHORE",
  PERSISTENT_CRON: "PERSISTENT_CRON",
};

/**
 * `network.internet.state` values published by signalk-internet that
 * allow fetching.
 */
const ONLINE_STATES = new Set(["online", "metered"]);

/**
 * Navigation states in which scheduled cron fetching is allowed.
 */
const MOORED_STATES = new Set(["moored", "anchored"]);

/**
 * House bank state of charge (0..1) above which persistent cron
 * operation is allowed.
 */
const SOC_FULL_THRESHOLD = 0.95;

/**
 * Cron window hours (UTC). Minutes are always {@link CRON_MINUTE_UTC}.
 */
const CRON_HOURS_UTC = [2, 8, 14, 20];

/**
 * Cron window minute (UTC).
 */
const CRON_MINUTE_UTC = 15;

/**
 * Next cron publication window strictly after the given instant.
 *
 * @param {Date} after - Instant to search from (exclusive)
 * @returns {Date} Next 02:15/08:15/14:15/20:15 UTC occurrence
 */
function nextCronRun(after) {
  const day = new Date(after.getTime());
  day.setUTCHours(0, CRON_MINUTE_UTC, 0, 0);
  for (let i = 0; i < 3; i++) {
    for (const hour of CRON_HOURS_UTC) {
      const candidate = new Date(day.getTime());
      candidate.setUTCHours(hour);
      if (candidate.getTime() > after.getTime()) {
        return candidate;
      }
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  // Unreachable: the 3-day scan always finds a window.
  return null;
}

/**
 * Result of a state machine update.
 *
 * @typedef {object} MachineResult
 * @property {string} previousState - State before the update
 * @property {string} state - State after the update
 * @property {"oneshot"|"cron"|null} fetch - Fetch action the caller
 *   should run now, if any
 * @property {boolean} transitioned - Whether the durable state changed
 */

/**
 * Connection & navigation state machine.
 */
class PassageStateMachine {
  constructor() {
    /** @type {string} */
    this._state = STATES.OFFLINE;
    /** @type {string|null} Last seen network.internet.state */
    this._internetState = null;
    /** @type {Date|null} Next scheduled cron window (PERSISTENT_CRON only) */
    this._nextCronRun = null;
  }

  /**
   * Current durable state. `TRIGGER_ONESHOT` never appears here — it is
   * an edge-triggered action, not a durable state (see module docs).
   *
   * @returns {string}
   */
  get state() {
    return this._state;
  }

  /**
   * Next scheduled cron window while in PERSISTENT_CRON, else null.
   *
   * @returns {Date|null}
   */
  get scheduledCronRun() {
    return this._nextCronRun;
  }

  /**
   * Processes a new set of observations from the Signal K stream.
   *
   * @param {object} [observations]
   * @param {string|null} [observations.internetState] -
   *   `network.internet.state` (online, metered, offline, captive)
   * @param {string|null} [observations.navigationState] -
   *   `navigation.state` (sailing, moored, anchored, …)
   * @param {number|null} [observations.soc] - House bank state of
   *   charge, fraction 0..1
   * @param {Date} [at] - Observation instant (injectable for tests)
   * @returns {MachineResult}
   */
  update(observations = {}, at = new Date()) {
    const { internetState, navigationState, soc } = observations;
    const previousState = this._state;

    const internetUp =
      typeof internetState === "string" && ONLINE_STATES.has(internetState);

    // Edge detection: any change *into* online/metered — including the
    // first observation after startup and online↔metered flips — fires a
    // single explicit oneshot fetch.
    let fetch = null;
    if (internetUp && internetState !== this._internetState) {
      fetch = "oneshot";
    }
    this._internetState =
      typeof internetState === "string" ? internetState : null;

    if (!internetUp) {
      this._state = STATES.OFFLINE;
      this._nextCronRun = null;
      return {
        previousState,
        state: this._state,
        fetch,
        transitioned: this._state !== previousState,
      };
    }

    // Stable-state resolution for a working internet link.
    const moored =
      typeof navigationState === "string" && MOORED_STATES.has(navigationState);
    const charged = typeof soc === "number" && soc >= SOC_FULL_THRESHOLD;
    const target =
      moored && charged ? STATES.PERSISTENT_CRON : STATES.STANDBY_OFFSHORE;

    if (target === STATES.PERSISTENT_CRON) {
      if (this._state !== STATES.PERSISTENT_CRON) {
        this._nextCronRun = nextCronRun(at);
      }
    } else {
      this._nextCronRun = null;
    }
    this._state = target;

    return {
      previousState,
      state: this._state,
      fetch,
      transitioned: this._state !== previousState,
    };
  }

  /**
   * Checks whether a cron window has come due. Only fires in
   * PERSISTENT_CRON — this is the execution guard that disables cron
   * fetching while sailing or offshore. Call periodically (the plugin
   * uses a one-minute interval).
   *
   * @param {Date} [at] - Current instant (injectable for tests)
   * @returns {MachineResult}
   */
  tick(at = new Date()) {
    const previousState = this._state;
    if (this._state !== STATES.PERSISTENT_CRON || !this._nextCronRun) {
      return {
        previousState,
        state: this._state,
        fetch: null,
        transitioned: false,
      };
    }
    if (at.getTime() < this._nextCronRun.getTime()) {
      return {
        previousState,
        state: this._state,
        fetch: null,
        transitioned: false,
      };
    }
    const missed = this._nextCronRun;
    this._nextCronRun = nextCronRun(at);
    return {
      previousState,
      state: this._state,
      fetch: "cron",
      transitioned: false,
      /** Window that came due (informational, for logging). */
      cronWindow: missed,
    };
  }
}

module.exports = {
  STATES,
  ONLINE_STATES,
  MOORED_STATES,
  SOC_FULL_THRESHOLD,
  CRON_HOURS_UTC,
  CRON_MINUTE_UTC,
  nextCronRun,
  PassageStateMachine,
};
