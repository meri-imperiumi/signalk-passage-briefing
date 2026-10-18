/**
 * `<pb-map-view>` — the warnings map (work doc #47): the briefing's
 * route and warning geometry drawn on the boat's own charts. The
 * pure layer specs come from `map-model.mjs`; this file is the
 * Leaflet adapter, following the dead-reckoning map's proven
 * patterns:
 *
 * - Leaflet is vendored (`./vendor/leaflet/`, BSD-2) — no CDN, no
 *   build tooling; loaded as a classic script from index.html that
 *   sets `window.L`.
 * - Leaflet's CSS lives INSIDE the shadow root — a document-level
 *   link cannot reach the `.leaflet-*` classes Leaflet creates here.
 * - Basemap: the server's configured charts
 *   (`/signalk/v1/api/resources/charts` — offline MBTiles, tile
 *   proxies) when available, the OSM online fallback otherwise. Only
 *   a failed charts request leaves the canvas tile-less (plain dark
 *   background). No hardcoded OSM-only default: it referer-403s on
 *   self-hosted setups.
 *
 * Data arrives via `setBulletin()` / `setPayload()` from the screen
 * elements. The warning shapes themselves are the published resources
 * (work doc #48): the map consumes `/signalk/v2/api/resources/notes`
 * and `/resources/regions` — our own warnings ride the same notes and
 * regions other plotters see, and any third-party resource provider's
 * notes and regions draw here for free. Clicking our own shape calls
 * `onBlockSelect(blockIndex)` so the console can highlight its text
 * card (matched by the note/region description, which is the block's
 * text); the text stays authoritative, the map shows where.
 *
 * @file components/map-view.js
 */

/* global L */

import {
  blockShapes,
  chartAssetsFromManifest,
  eventPins,
  fitPoints,
  frameBounds,
  isVectorChart,
  maplibreStyleFor,
  notePins,
  OSM_LAYER,
  parseChartLayers,
  regionShapes,
  ribbonSegments,
  routeRibbon,
  stormGraphic,
  stormRingColor,
  vesselFitBounds,
} from "./map-model.mjs";
import { comfortColor } from "./models.mjs";
import { SK_BASE_CSS } from "./sk-base-css.js";

/**
 * The custom element (browser only).
 */
class PbMapView extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    this._blocks = [];
    this._wider = [];
    this._payload = null;
    this._vessel = null;
    this._ribbonRows = [];
    this._events = [];
    this._resourceRegions = {};
    this._resourceNotes = {};
    this._regions = [];
    this._noteMarkers = [];
    this._ribbon = [];
    this._eventPins = [];
    this._eventMarkers = new Map();
    this._onBlockSelect = null;
    this._onEventSelect = null;
    this._needsFit = false;
    this.shadowRoot.innerHTML = `
      <style>
        ${SK_BASE_CSS}
        :host {
          display: block;
          height: 320px;
        }
        /* The hidden attribute must win over :host display:block —
           conditions-here toggles the element itself */
        :host([hidden]) { display: none; }
        .map-wrap {
          width: 100%;
          height: 100%;
          background: var(--bg-base, #080a0c);
          border-radius: 6px;
        }
        /* Selected-shape pulse: the click-through target highlight
           (console-side flash styles land on the text card) */
        /* Timeline event pins (work doc #47): the same emoji glyph
           the timeline row paints, severity-colored via filter */
        .pb-pin {
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
          line-height: 1;
          background: transparent;
          border: none;
          text-shadow:
            0 0 3px var(--bg-base, #080a0c),
            0 0 3px var(--bg-base, #080a0c);
        }
        .pb-pin.sev-warn { filter: sepia(1) saturate(4) hue-rotate(-25deg); }
        .pb-pin.sev-severe { filter: sepia(1) saturate(6) hue-rotate(-40deg); }
        .pb-pin:focus { outline: none; }
      </style>
      <link rel="stylesheet" href="vendor/leaflet/leaflet.css">
      <link rel="stylesheet" href="vendor/maplibre-gl/maplibre-gl.css">
      <div class="map-wrap" part="map"></div>
    `;
    this.mapEl = this.shadowRoot.querySelector(".map-wrap");
    if (typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver(() => this._invalidate());
      this._resizeObserver.observe(this.mapEl);
    }
    // Shadow DOM layout settles asynchronously after
    // connectedCallback: force Leaflet to recompute the container
    // size a couple of frames in, like dead-reckoning does — the
    // skipped fits then run against real dimensions
    requestAnimationFrame(() =>
      requestAnimationFrame(() => this._invalidate()),
    );
    if (typeof L === "undefined") {
      // index.html loads the vendored script; a missing script (webapp
      // served through an older cache) degrades to the empty state
      console.warn("pb-map-view: Leaflet not loaded");
      return;
    }
    this._mount();
  }

  disconnectedCallback() {
    this._resizeObserver?.disconnect();
    this.map?.remove();
    this.map = null;
  }

  /** Boots Leaflet and the basemap once (dead-reckoning's lifecycle:
   * the map is BORN with a concrete view — there is no unset state
   * to degenerate from — and the mount is idempotent). */
  _mount() {
    if (this.map || typeof L === "undefined") {
      return;
    }
    this.map = L.map(this.mapEl, {
      center: [0, 0],
      zoom: 3,
      // World-span views at zoom 0–1 are where a dateline-centered
      // viewport exceeds the primary world's tile grid; zoom 2 keeps
      // every view inside it, and the fit never needs to zoom out
      // that far anyway
      minZoom: 2,
      attributionControl: false,
      worldCopyJump: true,
    });
    L.control.zoom({ position: "bottomleft" }).addTo(this.map);
    // On touch the collapsed gear is one more tap between the crew and
    // their charts — render the layer list expanded on coarse pointers
    const coarse =
      typeof matchMedia === "function" &&
      matchMedia("(pointer: coarse)").matches;
    this._basemaps = L.control.layers(null, null, {
      position: "bottomleft",
      collapsed: !coarse,
    });
    let osmFallbackLayer = null;
    // The corridor tile downloader's offline mirror (work doc #47
    // session): the manifest advertises the mirrored Open Waters GL
    // style — absolute URLs, sprite and glyph endpoints rewritten —
    // once the mirror is complete enough to render. Fetched alongside
    // the charts; the mirror mounts as the first base layer.
    const manifestReady = fetch(
      "/plugins/signalk-corridor-tile-downloader/assets/manifest.json",
    )
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    Promise.all([
      fetch("/signalk/v1/api/resources/charts")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      manifestReady,
    ])
      .then(([resource, manifest]) => {
        const charts = parseChartLayers(resource);
        console.info(`pb-map-view: ${charts.length} configured chart layer(s)`);
        const assets = chartAssetsFromManifest(manifest);
        const vectorCharts = charts.filter((c) => isVectorChart(c));
        // Raster-dem mirrors (webp elevation) are terrain data, not a
        // visual basemap — excluded like dead-reckoning's chart path
        const rasterCharts = charts.filter(
          (c) => !isVectorChart(c) && c.format !== "webp",
        );
        // Basemap hierarchy (work doc #47 session): the offline
        // corridor mirror leads when it mounts; then the configured
        // charts; OSM online is the universal base and the
        // always-switchable fallback
        const bases = [];
        const mounted = [];
        let first = null;
        const addBase = (label, layer) => {
          let name = label;
          // The control is keyed by display name — dedupe so two
          // charts sharing a name don't clobber each other's radio
          for (let n = 2; bases.includes(name); n++) name = `${label} (${n})`;
          bases.push(name);
          mounted.push(layer);
          return name;
        };
        const tryAdd = (layer, name) => {
          if (!first) {
            first = layer;
            try {
              layer.addTo(this.map);
            } catch (error) {
              // A degenerate map state must not take the basemap
              // (and the promise chain) down: retry once the next
              // fit has run
              console.warn("pb-map-view: basemap add failed", error);
              this._pendingBasemap = layer;
            }
          } else {
            this._basemaps.addBaseLayer(layer, name);
          }
        };
        let vectorMounted = false;
        if (assets) {
          if (typeof L.maplibreGL === "function") {
            const mirror = L.maplibreGL({ style: assets.style });
            const name = addBase("Open Waters chart", mirror);
            tryAdd(mirror, name);
            vectorMounted = true;
          } else {
            console.warn(
              "pb-map-view: mirrored chart style skipped — MapLibre bridge not loaded",
            );
          }
        }
        if (!vectorMounted) {
          for (const chart of vectorCharts) {
            if (typeof L.maplibreGL !== "function") {
              console.warn(
                `pb-map-view: vector chart "${chart.name}" skipped — MapLibre bridge not loaded`,
              );
              continue;
            }
            const layer = L.maplibreGL({
              style: maplibreStyleFor(chart),
            });
            const name = addBase(chart.name, layer);
            tryAdd(layer, name);
          }
        }
        for (const chart of rasterCharts) {
          const layer = L.tileLayer(chart.url, {
            attribution: chart.attribution ?? "",
            minZoom: chart.minZoom,
            maxZoom: chart.maxZoom,
            maxNativeZoom: chart.maxZoom,
          });
          this._watchTileLayer(layer, chart.name);
          const name = addBase(chart.name, layer);
          tryAdd(layer, name);
        }
        // The online fallback stays switchable even when configured
        // charts exist — a dead chart tile URL is one tap away from
        // a working map (dead-reckoning's "blank chart reads as
        // broken" feedback, 2026-09). The same layer instance is
        // registered here and reused by the auto-recovery below, so
        // switching back to a chart actually removes the fallback —
        // an unregistered slip-underneath layer would be
        // unswitchable, which is how a phone ends up parked on
        // OpenStreetMap
        if (mounted.length > 0) {
          osmFallbackLayer = L.tileLayer(OSM_LAYER.url, {
            attribution: OSM_LAYER.attribution,
            maxZoom: OSM_LAYER.maxZoom,
          });
          this._basemaps.addBaseLayer(osmFallbackLayer, OSM_LAYER.name);
        }
        // Auto-recovery: a configured raster chart whose tiles all
        // fail (dead tile server, stale MBTiles) leaves a grey canvas
        // beneath the overlays — slip the OSM fallback underneath
        // so the crew sees a chart regardless. The fallback is the
        // registered layer above: selecting a chart in the layer
        // list removes it again. Only for raster charts — the
        // offline mirror needs no recovery, and without any chart
        // OSM already is the base (a second copy would be an
        // unregistered, unswitchable duplicate)
        if (first && first._pbTileErrors !== undefined && mounted.length > 0) {
          setTimeout(() => {
            if (
              first._pbTileErrors > 0 &&
              first._pbTileLoads === 0 &&
              this.map
            ) {
              console.warn(
                "pb-map-view: configured chart yields no tiles — OSM fallback slipped underneath",
              );
              (osmFallbackLayer ?? L.tileLayer(OSM_LAYER.url))
                .addTo(this.map)
                .bringToBack();
            }
          }, 6000);
        }
        // Layer switching needs the control whenever more than the
        // fallback exists
        if (mounted.length > 0) {
          try {
            this._basemaps.addTo(this.map);
          } catch (_error) {
            // Layer switching is a convenience, not a requirement
          }
        }
        this._fit();
        this._retryBasemap();
      })
      .catch(() => {
        // Charts request failed entirely: no basemap, shapes still draw
        this._fit();
      });
    this._render();
    this._loadResources();
  }

  /**
   * Tile-failure telemetry for one base layer (work doc #47 test
   * rounds): errors and loads counted on the layer so the
   * auto-fallback can tell a dead chart from a slow one, and the
   * first few failures log the tile URL — a misconfigured chart
   * tilemapUrl should be findable from the console alone.
   *
   * @param {object} layer - L.tileLayer
   * @param {string} name - Chart name for the log line
   */
  _watchTileLayer(layer, name) {
    layer._pbTileErrors = 0;
    layer._pbTileLoads = 0;
    layer.on("tileerror", (event) => {
      layer._pbTileErrors += 1;
      if (layer._pbTileErrors <= 3) {
        const src =
          typeof event?.error === "string"
            ? event.error
            : (event?.error?.message ?? event?.tile?.src ?? "unknown");
        console.warn(
          `pb-map-view: tile error on "${name}" (${layer._pbTileErrors}): ${src}`,
        );
      }
    });
    layer.on("tileload", () => {
      layer._pbTileLoads += 1;
    });
  }

  /** Adds a basemap whose first add hit a degenerate map state. */
  _retryBasemap() {
    if (!this._pendingBasemap) {
      return;
    }
    try {
      this._pendingBasemap.addTo(this.map);
      this._pendingBasemap = null;
    } catch (_error) {
      // Still degenerate: the next fit's resize tick retries
    }
  }

  /**
   * Whether the current bulletin carries drawable shapes (view-level
   * gating: conditions-here hides the map entirely without them).
   *
   * @returns {boolean}
   */
  hasShapes() {
    return (
      blockShapes(this._blocks ?? [], this._frameLon?.() ?? null).length > 0
    );
  }

  /**
   * Bulletin console data: block geometry keys the storm graphics and
   * the console click-through. The shapes themselves draw from the
   * published resources (work doc #48), so a bulletin change also
   * re-fetches them — the publish pass that produced this bulletin
   * may have refreshed the notes and regions.
   *
   * @param {{blocks?: Array<object>}|null} bulletin
   */
  setBulletin(bulletin) {
    this._blocks = bulletin?.blocks ?? [];
    this._render();
    this._fit();
    this._loadResources();
  }

  /**
   * Fetches the published resources once per bulletin: the notes and
   * regions the plugin (and any other provider) publishes. A failed
   * request keeps whatever was drawn before — a stale warning shape
   * beats no warning shape.
   */
  async _loadResources() {
    try {
      const [regions, notes] = await Promise.all([
        fetch("/signalk/v2/api/resources/regions")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch("/signalk/v2/api/resources/notes")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      if (regions) {
        this._resourceRegions = regions;
      }
      if (notes) {
        this._resourceNotes = notes;
      }
      this._render();
      this._fit();
    } catch (error) {
      console.warn("pb-map-view: resource fetch failed", error);
    }
  }

  /**
   * Wider-area severe warnings (work doc #47): severe geometric
   * blocks from the same bulletins that the track filter discarded —
   * drawn muted, zoomable context the console never shows. They sit
   * outside the fit on purpose: the map stays anchored on the
   * vessel's waters, the crew pans to the rest.
   *
   * @param {Array<object>} blocks - wider blocks from the payload
   */
  setWider(blocks) {
    this._wider = blocks ?? [];
    this._render();
  }

  /**
   * Briefing payload: the compiled track plus the CAP alerts and
   * GDACS events that ride it.
   *
   * @param {{waypoints?: Array<{lat: number, lon: number}>,
   *   capAlerts?: Array<object>, hazardEvents?: Array<object>}|null}
   *   payload
   */
  setPayload(payload) {
    this._payload = payload ?? null;
    // The vessel anchors the map when no route does (here mode: the
    // payload carries the vessel's position as its single waypoint)
    const waypoints = this._payload?.waypoints ?? [];
    this._vessel =
      waypoints.length === 1 &&
      Number.isFinite(waypoints[0]?.lat) &&
      Number.isFinite(waypoints[0]?.lon)
        ? waypoints[0]
        : null;
    this._render();
    this._fit();
  }

  /**
   * The simulated passage rows (work doc #47): they colorize the real
   * route geometry — comfort tier colors, motoring stretches dashed,
   * night legs dimmed, mapped onto the route by distance made good.
   * The map draws one line: the route itself, colored as the plan
   * reads.
   *
   * @param {Array<{hoursFromNow: number, lat: number, lon: number,
   *   distanceFromStartNm: number, comfortLevel: string|null,
   *   slatting: boolean, motoring: boolean, night: boolean}>} track -
   *   summary.track rows
   */
  setRibbon(track) {
    this._ribbonRows = track ?? [];
    this._render();
    this._fit();
  }

  /**
   * Timeline event pins (work doc #47): the mergeTimeline output —
   * the same array the timeline component renders as rows, so the
   * map and the timeline are two projections of one list. Pin click
   * → `onEventSelect(eventIndex)`.
   *
   * @param {Array<object>} events - mergeTimeline output
   */
  setTimeline(events) {
    this._events = events ?? [];
    this._render();
    this._fit();
  }

  /**
   * Callback when a timeline pin is clicked: receives the event's
   * index in the mergeTimeline array (the timeline scrolls to its
   * row).
   *
   * @param {function(number)|null} callback
   */
  set onEventSelect(callback) {
    this._onEventSelect = callback;
  }

  /**
   * Timeline → map direction: pan to and pulse the pin for one
   * timeline event index.
   *
   * @param {number} index - Event index in the mergeTimeline array
   */
  focusEvent(index) {
    const pin = this._eventPins.find((p) => p.index === index);
    if (!pin || !this.map) {
      return;
    }
    this.map.panTo([pin.lat, pin.lon]);
    const marker = this._eventMarkers?.get(index);
    if (marker) {
      const icon = marker.getElement();
      if (icon) {
        icon.style.transform += " scale(1.6)";
        setTimeout(() => {
          icon.style.transform = icon.style.transform.replace(
            " scale(1.6)",
            "",
          );
        }, 800);
      }
    }
  }

  /**
   * Callback when a shape is clicked: receives the block's console
   * index (the screen element highlights its text card).
   *
   * @param {function(number)|null} callback
   */
  set onBlockSelect(callback) {
    this._onBlockSelect = callback;
  }

  /**
   * One longitude frame for everything (work doc #47 test round): the
   * whole map unwraps against the boat's longitude — the first
   * compiled waypoint — so the track, the warning shapes and the
   * pins all draw on the same world copy. Mixing frames (a ribbon at
   * -182, a gale polygon at 178E) made the combined bounds span more
   * than one world and Leaflet tried to load an infinite number of
   * tiles.
   *
   * @returns {number|null}
   */
  _frameLon() {
    const firstWaypoint = (this._payload?.waypoints ?? []).find(
      (w) => Number.isFinite(w?.lat) && Number.isFinite(w?.lon),
    );
    if (firstWaypoint) {
      return firstWaypoint.lon;
    }
    const firstRibbon = (this._ribbonRows ?? []).find(
      (row) => Number.isFinite(row?.lat) && Number.isFinite(row?.lon),
    );
    if (firstRibbon) {
      return firstRibbon.lon;
    }
    const firstBlock = (this._blocks ?? []).find(
      (block) => block?.geometry?.type === "point",
    );
    if (firstBlock) {
      return firstBlock.geometry.coordinates[0];
    }
    return null;
  }

  /** Clears and redraws every overlay layer from the current specs. */
  _render() {
    if (!this.map) {
      return; // Not yet mounted: specs are set, rendering waits
    }
    // Compute every spec in the boat's frame before drawing
    const referenceLon = this._frameLon();
    // One route line (work doc #47 session): the real route geometry
    // carrying the plan's color encoding — not a plain route line
    // plus a second sim-track ribbon that drifts off it. The row
    // ribbon survives only where no route geometry exists
    this._ribbon =
      (this._payload?.waypoints ?? []).filter(
        (w) => Number.isFinite(w?.lat) && Number.isFinite(w?.lon),
      ).length >= 2
        ? routeRibbon(
            this._payload.waypoints,
            this._ribbonRows ?? [],
            referenceLon,
          )
        : ribbonSegments(this._ribbonRows ?? [], referenceLon);
    this._regions = regionShapes(this._resourceRegions, referenceLon);
    this._noteMarkers = notePins(
      this._resourceNotes,
      new Set(this._regions.map((region) => region.id)),
      referenceLon,
    );
    // The console click-through matches on the block's text — the
    // note/region description IS that text (they are published from
    // the same filtered blocks)
    this._consoleIndex = new Map(
      (this._blocks ?? []).map((block, index) => [block.text, index]),
    );
    this._ribbon = ribbonSegments(this._ribbonRows ?? [], referenceLon);
    this._eventPins = eventPins(this._events ?? [], referenceLon);
    this._storms = (this._blocks ?? [])
      .map((block, index) => stormGraphic(block, index, referenceLon))
      .filter(Boolean);
    if (this._overlayGroup) {
      this._overlayGroup.remove();
    }
    this._overlayGroup = L.layerGroup().addTo(this.map);
    this._eventMarkers = new Map();
    // Wider-area severe warnings first (work doc #47): muted and
    // beneath everything — context to pan to, not the headline
    for (const shape of blockShapes(this._wider ?? [], referenceLon)) {
      const layer =
        shape.kind === "line"
          ? L.polyline(
              shape.points.map(([lon, lat]) => [lat, lon]),
              {
                color: "#7f95a1",
                weight: 1.5,
                dashArray: "2 6",
                fillOpacity: 0.04,
              },
            )
          : L.polygon(
              shape.points.map(([lon, lat]) => [lat, lon]),
              {
                color: "#7f95a1",
                weight: 1.5,
                dashArray: "2 6",
                fillOpacity: 0.04,
              },
            );
      // The grey mute styling already says these are elsewhere — the
      // tooltip just names the warning (work doc #47 session: the
      // spatial relationship is visible on the map, the prefix read
      // as noise)
      layer
        .bindTooltip(shape.label ?? "", {
          sticky: true,
        })
        .addTo(this._overlayGroup);
    }
    // The colorized route first (work doc #47): underlies the warning
    // shapes — comfort tier colors, motoring dashed, night dimmed,
    // drawn along the real route geometry
    for (const segment of this._ribbon ?? []) {
      const color = segment.comfortLevel
        ? comfortColor(segment.comfortLevel)
        : "#4ec9b0";
      L.polyline(
        segment.points.map(([lon, lat]) => [lat, lon]),
        {
          color,
          weight: 4,
          opacity: segment.night ? 0.45 : 0.85,
          dashArray: segment.motoring ? "2 8" : undefined,
          lineCap: "round",
        },
      ).addTo(this._overlayGroup);
    }
    // The published warning shapes (work doc #48): regions first —
    // gale areas, corridor bands, CAP polygons, storm quadrant rings —
    // colored by the severity the console's own highlighter derives
    // from the warning text; ours and third-party ones share the
    // visual language. The dashed bbox honesty cue and the console
    // click-through stay ours-only (properties they carry).
    for (const region of this._regions) {
      for (const ring of region.rings) {
        L.polygon(
          ring.map(([lon, lat]) => [lat, lon]),
          {
            color: region.severe ? "#ff5c5c" : "#ffb45c",
            weight: region.severe ? 2 : 1.5,
            dashArray: region.dashed ? "4 6" : undefined,
            fillOpacity: 0.12,
          },
        )
          .bindTooltip(region.label, { sticky: true })
          .on("click", () => this._selectResource(region))
          .addTo(this._overlayGroup);
      }
    }
    // The point-anchored notes on top: GDACS hazards, storm
    // declarations, region-less warnings. A note whose region draws
    // stays hidden (the href pairing — no double render); an advisory
    // storm's note yields to the graphic below, which covers it
    const stormTexts = new Set(
      (this._storms ?? []).map((storm) => this._blocks[storm.index]?.text),
    );
    for (const pin of this._noteMarkers) {
      if (pin.ours && stormTexts.has(pin.description)) {
        continue; // The cyclone graphic below covers this block
      }
      L.circleMarker([pin.lat, pin.lon], {
        radius: 6,
        color: pin.severe ? "#ff5c5c" : "#ffb45c",
        fillColor: pin.severe ? "#ff5c5c" : "#ffb45c",
        fillOpacity: 0.9,
        weight: 2,
      })
        .bindTooltip(pin.label, { sticky: true })
        .on("click", () => this._selectResource(pin))
        .addTo(this._overlayGroup);
    }
    // Cyclone graphics (work doc #47 phase 3): quadrant wind/seas
    // rings, the forecast track, and the centre marker — the classic
    // advisory chart drawn from the parsed storm
    for (const storm of this._storms ?? []) {
      const name = [storm.severityLabel, storm.name]
        .filter(Boolean)
        .join(" — ");
      const ringStyle = (ring) => ({
        color: stormRingColor(ring),
        weight: 1.5,
        fillOpacity: 0.12,
      });
      for (const ring of storm.rings) {
        L.polygon(
          ring.points.map(([lon, lat]) => [lat, lon]),
          ringStyle(ring),
        )
          .bindTooltip(`${name}: ${ring.label}`)
          .on("click", () => this._select(storm.index))
          .addTo(this._overlayGroup);
      }
      if (storm.track.length > 1) {
        L.polyline(
          storm.track.map(([lon, lat]) => [lat, lon]),
          { color: "#c8c8c8", weight: 2, dashArray: "6 6", opacity: 0.8 },
        )
          .bindTooltip(`${name} — forecast track`)
          .on("click", () => this._select(storm.index))
          .addTo(this._overlayGroup);
      }
      for (const point of storm.forecastPoints) {
        L.circleMarker([point.lat, point.lon], {
          radius: 4,
          color: "#c8c8c8",
          fillColor: "#c8c8c8",
          fillOpacity: 0.9,
          weight: 1,
        })
          .bindTooltip(
            `${point.label ?? "forecast"}${point.maxWindKt != null ? ` · ${point.maxWindKt} kt` : ""}`,
          )
          .addTo(this._overlayGroup);
      }
      L.marker([storm.center[1], storm.center[0]], {
        icon: L.divIcon({
          html: '<span class="pb-pin">🌀</span>',
          className: "pb-pin-host",
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        }),
        keyboard: true,
        title: name || "Tropical cyclone",
      })
        .bindTooltip(name || "Tropical cyclone")
        .on("click", () => this._select(storm.index))
        .addTo(this._overlayGroup);
    }

    // Timeline event pins last (work doc #47): on top of everything,
    // the same emoji the timeline row paints; click-through to the
    // timeline row via onEventSelect
    for (const pin of this._eventPins ?? []) {
      const marker = L.marker([pin.lat, pin.lon], {
        icon: L.divIcon({
          html: `<span class="pb-pin sev-${pin.severity}">${pin.glyph}</span>`,
          className: "pb-pin-host",
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        }),
        keyboard: true,
        title: pin.label,
      });
      marker
        .bindTooltip(`${pin.label}${pin.detail ? ` — ${pin.detail}` : ""}`)
        .on("click", () => this._onEventSelect?.(pin.index))
        .addTo(this._overlayGroup);
      this._eventMarkers.set(pin.index, marker);
    }
  }

  /** Click-through: hand the console the block index. */
  _select(index) {
    this.onBlockSelect?.(index);
  }

  /**
   * Click-through for a published resource (work doc #48): only our
   * own notes and regions name console cards, and the match is the
   * block's text — the description the resource carries verbatim.
   * Third-party resources have no console to scroll to; their tooltip
   * is the whole interaction.
   *
   * @param {{ours: boolean, description: string}} resource
   */
  _selectResource(resource) {
    if (!resource?.ours) {
      return;
    }
    const index = this._consoleIndex?.get(resource.description);
    if (index != null) {
      this._select(index);
    }
  }

  /**
   * One resize tick (dead-reckoning's pattern): recompute the
   * container size, then run the fit that was skipped while the
   * layout was unsettled.
   */
  _invalidate() {
    try {
      this.map?.invalidateSize();
    } catch (_error) {
      // A transient degenerate view (tiny container mid-layout)
      // must not break the observer loop
    }
    if (this._needsFit) {
      this._needsFit = false;
      this._fit();
      this._retryBasemap();
    }
  }

  /**
   * Coordinates the initial fit frames (work doc #47 session: the fit
   * is the route's, not the warnings'; without a route the vessel
   * anchors it). Delegates to {@link fitPoints} — the map view itself
   * only filters non-finite points.
   *
   * @returns {Array<[number, number]>} [lon, lat] points
   */
  _drawablePoints() {
    return fitPoints({
      ribbon: this._ribbon ?? [],
      eventPins: this._eventPins ?? [],
      vessel: this._vessel,
      storms: this._storms ?? [],
      // Only our own resources drive the fit — third-party ones can
      // sit in another ocean, and the fit stays anchored on the
      // vessel's waters the way the wider set already does
      resourcePoints: [
        ...(this._regions ?? [])
          .filter((region) => region.ours)
          .flatMap((region) => region.rings.flat()),
        ...(this._noteMarkers ?? [])
          .filter((pin) => pin.ours)
          .map((pin) => [pin.lon, pin.lat]),
      ],
    }).filter(
      (point) => Number.isFinite(point[0]) && Number.isFinite(point[1]),
    );
  }

  /** Fits the view: the route when one exists, the vessel's waters
   * when not, the warnings only without either. */
  _fit() {
    if (!this.map) {
      return;
    }
    // A hidden or mid-layout container cannot be fitted: fitBounds'
    // padding arithmetic produces a NaN view (zoom log of a negative
    // scale) on tiny containers, not just zero-sized ones. Anything
    // under 50 px is unmeasured — the resize tick refits once the
    // card reveals.
    if (this.mapEl.clientWidth < 50 || this.mapEl.clientHeight < 50) {
      this._needsFit = true;
      return;
    }
    const all = this._drawablePoints();
    // No route: the vessel anchors the view — a couple hundred miles
    // of water around her, a fabricated square so the span holds
    // across screen sizes instead of leaning on a zoom level
    const vesselBounds =
      all.length === 1 && this._vessel ? vesselFitBounds(this._vessel) : null;
    const bounds = vesselBounds ?? frameBounds(all);
    if (!bounds) {
      return;
    }
    const [minLon, minLat, maxLon, maxLat] = bounds;
    // Guard the tiles: a frame bug that spans more than one world —
    // or any non-finite coordinate — must not reach Leaflet. A failed
    // fit must never break the render chain either: the dashboard
    // renders the map mid-flow, and a throw here would leave every
    // setter after it unrun
    if (
      maxLon - minLon >= 360 ||
      ![minLon, minLat, maxLon, maxLat].every(Number.isFinite)
    ) {
      return;
    }
    try {
      this.map.fitBounds(
        [
          [minLat, minLon],
          [maxLat, maxLon],
        ],
        { padding: [24, 24], maxZoom: 10 },
      );
    } catch (_error) {
      this._needsFit = true;
      return;
    }
    // Validate the view Leaflet actually landed on: a NaN center or
    // zoom (padding arithmetic on a small container) would make every
    // subsequent tile update throw. Reset to the provisional view and
    // let the next resize refit.
    const center = this.map.getCenter();
    const zoom = this.map.getZoom();
    if (
      !center ||
      !Number.isFinite(center.lat) ||
      !Number.isFinite(center.lng) ||
      !Number.isFinite(zoom)
    ) {
      // Reset to the constructor's known-good view; the next resize
      // tick refits
      this.map.setView([0, 0], 3);
      this._needsFit = true;
    }
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("pb-map-view", PbMapView);
}

export { PbMapView };
