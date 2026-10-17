MapLibre GL JS 5.24.0 + @maplibre/maplibre-gl-leaflet 0.1.4,
vendored as static browser assets (no npm dependency, no build
tooling — same policy as vendor/leaflet). Fetched via
`npm pack maplibre-gl@5.24.0 @maplibre/maplibre-gl-leaflet@0.1.4`,
dist files only:

- maplibre-gl.js, maplibre-gl.css (BSD-3-Clause, see
  LICENSE-maplibre-gl.txt) — the WebGL vector-tile renderer.
  5.x is the last line shipping the UMD browser build the
  classic-script index.html loads (6.x is ESM-only).
- leaflet-maplibre-gl.js (ISC, see LICENSE-leaflet-maplibre-gl.txt)
  — binds `L.maplibreGL(...)`: renders a MapLibre map as one
  Leaflet layer, so DR overlays stay plain Leaflet.

Only the libraries are vendored. Vector styles are built
client-side from the configured charts resource
(dr-viewmodel.js `maplibreStyleFor`) — no CDN, no remote style
host, no glyphs/sprite endpoints (geometry-only, no symbol
layers).
