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
 * landfall rows. Runs *after* the result is posted (work doc #6
 * session): the raycast walks a corridor of tiles and takes seconds,
 * and the crew reads the timeline while it works — the landfalls
 * arrive as their own message and inject into the painted briefing.
 *
 * @param {object} result - Simulation result
 * @param {object} params - Worker params (config subset)
 * @returns {Promise<{landfalls: object[], destinationName: string|null}>}
 */
async function computeLandfalls(result, params) {
  const { estimateLandfalls, destinationName } = await import(
    "./landfall-estimator.mjs"
  );
  const { createLandfallReaders } = await import("./landfall-tiles.mjs");
  const readers = await createLandfallReaders();
  const landfalls = await estimateLandfalls({
    track: result.hourlyComfort ?? [],
    elevation: readers?.elevation ?? (async () => null),
    placeName: readers?.placeName ?? null,
    config: params.config ?? {},
  });
  // The arrival row greets by name when the gazetteer knows the place
  const name = await destinationName({
    track: result.hourlyComfort ?? [],
    placeName: readers?.placeName ?? null,
  });
  return { landfalls, destinationName: name };
}

self.onmessage = (event) => {
  const message = event.data ?? {};
  if (message.type !== "simulate") {
    return;
  }
  const run = async () => {
    const params = message.params ?? {};
    const result = simulatePassage(params);
    // The briefing paints now; the landfall raycast is seconds of tile
    // walking and injects when it lands
    result.landfalls = [];
    result.destinationName = null;
    self.postMessage({
      type: "result",
      id: message.id,
      result,
      exceptions: filterExceptions(result, params),
    });
    try {
      const { landfalls, destinationName } = await computeLandfalls(
        result,
        params,
      );
      self.postMessage({
        type: "landfalls",
        id: message.id,
        landfalls,
        destinationName,
      });
    } catch (error) {
      // Tile problems must not sink the briefing
      console.warn("pb-worker: landfall pass failed", error);
    }
  };
  run().catch((error) => {
    self.postMessage({ type: "error", id: message.id, error: error.message });
  });
};
