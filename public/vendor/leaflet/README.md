Leaflet 1.9.4, vendored as static browser assets (no npm dependency,
no build tooling — SPEC §14). Fetched via `npm pack leaflet@1.9.4`,
dist files only:

- leaflet.js, leaflet.css (BSD-2-Clause, see LICENSE)
- images/*.png (default marker/layers assets referenced by the CSS)

Only the library is vendored; map tiles remain optional/network-gated
(the DR map renders tile-less by default — offline-first).
