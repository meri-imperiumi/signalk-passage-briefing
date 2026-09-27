/**
 * Status Tiles example-set provider (work doc #13).
 *
 * Ships a ready-made Status Tiles set so the boat owner can copy the
 * briefing comfort tile into their panel with one tap. The set is
 * pure config; it is discovered by the Status Tiles webapp through
 * the standard resources API as a read-only `statusTileExamples`
 * provider (signalk-status-tiles/doc/sharing-example-tile-sets.md).
 *
 * Idempotency contract: the server calls stop()/start() on config
 * saves and has no unregister, so the registration is held at module
 * scope keyed by the app — the first start() registers one provider
 * whose methods close over a shared running flag, a later start()
 * flips it back on, and stop() flips it off (a disabled plugin
 * contributes no stale sets). Mirrors the dead-reckoning plugin.
 *
 * @file statustilesexamples.js
 */

const { readFileSync } = require("node:fs");
const { join } = require("node:path");

/** The example sets, loaded once at require time (pure config). */
const EXAMPLES = JSON.parse(
  readFileSync(join(__dirname, "..", "status-tiles-examples.json"), "utf8"),
);

/**
 * Per-app registration state, so a re-start reuses the one provider
 * instead of stacking a second.
 * @type {WeakMap<object, Map<string, {running: boolean, registered: boolean, declined: boolean}>>}
 */
const states = new WeakMap();

/**
 * Registers the read-only `statusTileExamples` resource provider,
 * idempotently per plugin instance. Returns a teardown that flips
 * `running` off.
 *
 * @param {object} app - Signal K server API
 * @param {{id: string}} opts - plugin id (the resource key under which
 *   the webapp labels this set's source)
 * @returns {() => void} teardown — empties the provider's listing
 */
function registerStatusTileExamples(app, opts) {
  const { id } = opts;

  if (!states.has(app)) {
    states.set(app, new Map());
  }
  const perApp = states.get(app);
  let state = perApp.get(id);
  if (!state) {
    state = { running: true, registered: false, declined: false };
    perApp.set(id, state);
  } else {
    state.running = true;
  }

  if (!state.registered) {
    if (typeof app.registerResourceProvider !== "function") {
      if (!state.declined) {
        app.error?.(
          `${id}: server has no resource provider registry; status-tiles examples disabled`,
        );
        state.declined = true;
      }
    } else {
      app.registerResourceProvider({
        type: "statusTileExamples",
        methods: {
          listResources: async () => (state.running ? { [id]: EXAMPLES } : {}),
          getResource: async (resourceId) => {
            if (!state.running || resourceId !== id) {
              throw new Error(
                `No such statusTileExamples resource: ${resourceId}`,
              );
            }
            return EXAMPLES;
          },
          setResource: async () => {
            throw new Error(`${id} is a read-only provider`);
          },
          deleteResource: async () => {
            throw new Error(`${id} is a read-only provider`);
          },
        },
      });
      state.registered = true;
    }
  }

  return () => {
    state.running = false;
  };
}

module.exports = {
  registerStatusTileExamples,
  EXAMPLES,
};
