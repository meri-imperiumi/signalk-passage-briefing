/**
 * Tests for the warnings map's chart parsing and the MapLibre chart
 * path: vector charts (the corridor downloader's Open Waters mirror
 * is all `pbf`) parse like raster ones and mount through
 * `L.maplibreGL` with a client-built style, the offline mirror rides
 * the manifest (work doc #47 session; the chart path mirrors
 * signalk-dead-reckoning's).
 *
 * @file map-view.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

test("parseChartLayers keeps raster and vector charts, skips GL styles", async () => {
  const { parseChartLayers } = await import(
    "../public/components/map-model.mjs"
  );
  const resource = {
    // The corridor downloader's own provider entry: a GL style — the
    // mirror mounts via the manifest, so the entry is redundant
    corridor: {
      name: "Open Waters corridor",
      type: "mapstyleJSON",
      url: "/plugins/signalk-corridor-tile-downloader/assets/style-ol.json",
      bounds: [170, -35, 178, -18],
    },
    // The mirrored seamap: XYZ-servable vector pbf
    seamap: {
      name: "Signal K Corridor Cache",
      format: "pbf",
      tilemapUrl: "/signalk/v1/api/resources/charts/passage_cache/{z}/{x}/{y}",
      chartLayers: ["land", "light", "sea_area", "seamark", "water"],
    },
    // A raster chart renders through Leaflet's own engine
    osmMbtiles: {
      name: "OSM raster",
      format: "png",
      tilemapUrl: "/signalk/v1/api/resources/charts/osm/{z}/{x}/{y}",
    },
  };
  const layers = parseChartLayers(resource);
  // Name-sorted: OSM raster before the corridor cache
  assert.deepEqual(
    layers.map((layer) => layer.identifier),
    ["osmMbtiles", "seamap"],
    "vector and raster parse, the GL style entry skips",
  );
  assert.equal(layers[1].format, "pbf");
  assert.deepEqual(layers[1].chartLayers, [
    "land",
    "light",
    "sea_area",
    "seamark",
    "water",
  ]);
  assert.equal(layers[0].format, "png");
  // Concrete zoom bounds: the raster path's maxNativeZoom needs them
  assert.equal(layers[1].minZoom, 0);
  assert.equal(layers[1].maxZoom, 19);
  // Degradation: no resource, or entries with nothing identifiable
  assert.deepEqual(parseChartLayers(null), []);
  assert.deepEqual(parseChartLayers({ empty: {} }), []);
});

test("isVectorChart keys on the pbf format", async () => {
  const { isVectorChart } = await import("../public/components/map-model.mjs");
  assert.equal(isVectorChart({ format: "pbf" }), true);
  assert.equal(isVectorChart({ format: "png" }), false);
  assert.equal(isVectorChart({ format: "webp" }), false);
  assert.equal(isVectorChart(null), false);
});

test("absoluteTileUrl resolves root-relative URLs against the page origin", async () => {
  const { absoluteTileUrl } = await import(
    "../public/components/map-model.mjs"
  );
  assert.equal(
    absoluteTileUrl("https://tiles.example.com/{z}/{x}/{y}"),
    "https://tiles.example.com/{z}/{x}/{y}",
  );
  // No page origin outside a browser: unchanged rather than garbage
  assert.equal(
    absoluteTileUrl("/signalk/v1/api/resources/charts/x/{z}/{x}/{y}"),
    "/signalk/v1/api/resources/charts/x/{z}/{x}/{y}",
  );
});

test("chartAssetsFromManifest accepts only an absolute mirror style", async () => {
  const { chartAssetsFromManifest } = await import(
    "../public/components/map-model.mjs"
  );
  assert.deepEqual(
    chartAssetsFromManifest({
      style: "http://10.10.10.1:3000/plugins/x/assets/style.json",
      glyphs: "http://10.10.10.1:3000/plugins/x/assets/fonts/{f}/{r}.pbf",
    }),
    { style: "http://10.10.10.1:3000/plugins/x/assets/style.json" },
  );
  // Root-relative or missing style: no mirror to mount
  assert.equal(
    chartAssetsFromManifest({ style: "/plugins/x/assets/style.json" }),
    null,
  );
  assert.equal(chartAssetsFromManifest({ sprites: {} }), null);
  assert.equal(chartAssetsFromManifest(null), null);
});

test("maplibreStyleFor builds a source-and-trio style for a vector chart", async () => {
  const { maplibreStyleFor } = await import(
    "../public/components/map-model.mjs"
  );
  const style = maplibreStyleFor({
    identifier: "passage_cache",
    name: "Signal K Corridor Cache",
    url: "/signalk/v1/api/resources/charts/passage_cache/{z}/{x}/{y}",
    minZoom: 0,
    maxZoom: 14,
    chartLayers: ["land", "sea_area", "seamark", "depcnt", "lights"],
  });
  assert.equal(style.version, 8);
  assert.equal(style.name, "Signal K Corridor Cache");
  const source = style.sources.passage_cache;
  assert.equal(source.type, "vector");
  assert.match(source.tiles[0], /passage_cache\/\{z\}\/\{x\}\/\{y\}$/);
  assert.equal(source.maxzoom, 14);
  // Dark sea background first, then the family paint order: land
  // fills before water fills before lines before points
  assert.equal(style.layers[0].type, "background");
  const kinds = style.layers.slice(1).map((layer) => layer.type);
  const firstFill = kinds.indexOf("fill");
  const firstLine = kinds.indexOf("line");
  const firstCircle = kinds.indexOf("circle");
  assert.ok(firstFill < firstLine, "fills under lines");
  assert.ok(firstLine < firstCircle, "lines under points");
  // Land paints before water so islands don't drown
  const landIdx = style.layers.findIndex((l) => l["source-layer"] === "land");
  const waterIdx = style.layers.findIndex(
    (l) => l["source-layer"] === "sea_area",
  );
  assert.ok(landIdx < waterIdx, "land before water");
  // Per-family paint: lights draw as circles, contours as lines
  assert.ok(
    style.layers.some(
      (l) => l["source-layer"] === "lights" && l.type === "circle",
    ),
  );
  assert.ok(
    style.layers.some(
      (l) => l["source-layer"] === "depcnt" && l.type === "line",
    ),
  );
  // The seamark family paints its fills above the natural families
  const seamarkIdx = style.layers.findIndex(
    (l) => l["source-layer"] === "seamark",
  );
  assert.ok(seamarkIdx > waterIdx, "seamarks above water fills");
});

test("the map view mounts Leaflet without view-copy teleporting", async () => {
  // Leaflet only mounts in a browser, so the component itself has no
  // node-test harness — these two mount/render regressions are pinned
  // at the source level instead.
  //
  // worldCopyJump silently wraps a drag across the antimeridian back
  // into the primary world copy: tiles repeat every world so the
  // basemap looks unchanged, but the overlays are unwrapped into the
  // boat's own copy (work doc #47) and do not repeat — on a
  // Tonga→New Zealand passage (route astride ±180°) one pan across
  // the seam left every route, pin and warning shape 360° off-screen
  // until the next data-driven fit. The option must stay off.
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const source = readFileSync(
    join(__dirname, "../public/components/map-view.js"),
    "utf8",
  );
  assert.ok(
    !/worldCopyJump\s*:\s*true/.test(source),
    "worldCopyJump must not be enabled — it teleports the view off the boat's overlay frame mid-drag",
  );
});

test("the view renders the ribbon through the model's one-line selector", async () => {
  // The 2026-10 discard regression: the view computed the route-geometry
  // ribbon (routeRibbon) and then overwrote it with the sim-row ribbon
  // (ribbonSegments) — the map drew the simplified sim track that drifts
  // off the route instead of the route itself. The selection now lives in
  // map-model's ribbonSpec; the view must call it once and never assign
  // _ribbon again. The only allowed assignments are the pre-mount []
  // initializer and the render's ribbonSpec call.
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const source = readFileSync(
    join(__dirname, "../public/components/map-view.js"),
    "utf8",
  );
  const initializers = [...source.matchAll(/this\._ribbon\s*=\s*(\S)/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    initializers,
    ["[", "r"],
    `the only _ribbon assignments must be the [] initializer and the render's ribbonSpec call (found: ${JSON.stringify(initializers)})`,
  );
  assert.match(source, /ribbonSpec\(/, "the selector comes from the model");
});
