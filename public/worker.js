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

/**
 * Landfall pass (work doc #6): where and when topography first breaks
 * the visual horizon along the simulated course. Best-effort — without
 * the corridor DEM or when disabled, the briefing simply carries no
 * landfall rows. Runs after the simulation because the sightings read
 * the simulated track the timeline renders.
 *
 * @param {object} result - Simulation result
 * @param {object} params - Worker params (config subset)
 * @returns {Promise<object>} The result with `landfalls` attached
 */
async function withLandfalls(result, params) {
  const { estimateLandfalls, destinationName } = await import(
    "./landfall-estimator.mjs"
  );
  const { createLandfallReaders } = await import("./landfall-tiles.mjs");
  const readers = await createLandfallReaders();
  result.landfalls = await estimateLandfalls({
    track: result.hourlyComfort ?? [],
    elevation: readers?.elevation ?? (async () => null),
    placeName: readers?.placeName ?? null,
    config: params.config ?? {},
  });
  // The arrival row greets by name when the gazetteer knows the place
  result.destinationName = await destinationName({
    track: result.hourlyComfort ?? [],
    placeName: readers?.placeName ?? null,
  });
  return result;
}

self.onmessage = (event) => {
  const message = event.data ?? {};
  if (message.type !== "simulate") {
    return;
  }
  const run = async () => {
    const params = message.params ?? {};
    const result = simulatePassage(params);
    try {
      await withLandfalls(result, params);
    } catch (error) {
      // Tile problems must not sink the briefing
      console.warn("pb-worker: landfall pass failed", error);
    }
    self.postMessage({
      type: "result",
      id: message.id,
      result,
      exceptions: filterExceptions(result, params),
    });
  };
  run().catch((error) => {
    self.postMessage({ type: "error", id: message.id, error: error.message });
  });
};
