/**
 * Landfall map source availability (work doc #50 session): the
 * landfall sightings raycast the planned course against the
 * corridor DEM (Mapterhorn elevation tiles) and name the land from
 * the Shortbread gazetteer — both served as chart resources the
 * corridor tile downloader publishes. When the layers are missing
 * the estimator is silently best-effort and the briefing simply
 * carries no landfall rows; the checklist should say so instead.
 *
 * The availability check mirrors the client's own layer selection
 * (`pickLandfallCharts` in public/landfall-tiles.mjs): an
 * elevation layer in WebP and a Shortbread vector layer in PBF.
 *
 * @file landfall-source.js
 */

/**
 * Checklist metadata for the landfall map source (work doc #23).
 */
const LANDFALL_SOURCE = {
  id: "landfall",
  label: "Landfall map (corridor DEM)",
  kind: "charts",
  expectedRefreshMs: 86400000,
};

/**
 * Picks the landfall chart layers out of the server's charts
 * resources, the same match the webapp's tile readers make.
 *
 * @param {object|null} charts - `listResources("charts", {})` output
 * @returns {{elevation: boolean, base: boolean}}
 */
function pickLandfallCharts(charts) {
  let elevation = false;
  let base = false;
  for (const chart of Object.values(charts ?? {})) {
    const format =
      typeof chart?.format === "string" ? chart.format.toLowerCase() : null;
    const name =
      typeof chart?.name === "string" ? chart.name : (chart?.identifier ?? "");
    if (/elevation/i.test(name) && format === "webp") {
      elevation = true;
    } else if (/shortbread/i.test(name) && format === "pbf") {
      base = true;
    }
  }
  return { elevation, base };
}

/**
 * Checks whether the landfall map sources are on board. Any error
 * reading the resources degrades to both-missing — the checklist
 * records absent, never a failure.
 *
 * @param {object} app - Signal K server API
 * @returns {Promise<{elevation: boolean, base: boolean}>}
 */
async function checkLandfallCharts(app) {
  try {
    const charts = await app.resourcesApi.listResources("charts", {});
    return pickLandfallCharts(charts);
  } catch {
    return { elevation: false, base: false };
  }
}

/**
 * Records the landfall map source's availability on the checklist.
 *
 * @param {object} app - Signal K server API
 * @param {Function} [recordSource] - Checklist recorder
 * @returns {Promise<{elevation: boolean, base: boolean}>}
 */
async function recordLandfallSource(app, recordSource) {
  const availability = await checkLandfallCharts(app);
  if (availability.elevation && availability.base) {
    recordSource?.({
      ...LANDFALL_SOURCE,
      note: "corridor DEM and gazetteer on board",
    });
  } else {
    const missing = [
      !availability.elevation ? "elevation tiles" : null,
      !availability.base ? "Shortbread gazetteer" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    recordSource?.({
      ...LANDFALL_SOURCE,
      absent: true,
      note: `No landfall map: ${missing} not in the chart resources`,
    });
  }
  return availability;
}

module.exports = {
  LANDFALL_SOURCE,
  pickLandfallCharts,
  checkLandfallCharts,
  recordLandfallSource,
};
