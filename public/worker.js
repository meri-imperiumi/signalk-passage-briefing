/**
 * Passage simulation web worker (SPEC §5.1).
 *
 * Runs the step-forward isochrone simulation off the main thread so
 * the tactical dashboard keeps its frame budget while the boat
 * advances hour by hour. Receives the cached briefing payload, the
 * plugin configuration subset, the learned sail preference matrix,
 * the polar table and hazard notes; replies with the simulation
 * result plus its pre-filtered exception views.
 *
 * Loaded as a module worker (`new Worker(..., { type: "module" })`)
 * so it can import the shared physics and polar modules directly.
 *
 * @file worker.js
 */

import { filterExceptions, simulatePassage } from "./route-sim.mjs";

self.onmessage = (event) => {
  const message = event.data ?? {};
  if (message.type !== "simulate") {
    return;
  }
  try {
    const result = simulatePassage(message.params ?? {});
    self.postMessage({
      type: "result",
      id: message.id,
      result,
      exceptions: filterExceptions(result),
    });
  } catch (error) {
    self.postMessage({ type: "error", id: message.id, error: error.message });
  }
};
