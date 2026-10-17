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
 * elements — the same shapes the console renders as text. Clicking a
 * shape calls `onBlockSelect(blockIndex)` so the console can
 * highlight its text card; the text stays authoritative, the map
 * shows where.
 *
 * @file components/map-view.js
 */

/* global L */

import {
  blockShapes,
  capShape,
  eventPins,
  frameBounds,
  hazardPin,
  ribbonSegments,
  routeRibbon,
  stormGraphic,
  stormMarker,
  stormRingColor,
} from "./map-model.mjs";
import { comfortColor } from "./models.mjs";
import { SK_BASE_CSS } from "./sk-base-css.js";

/** The default fallback basemap (online only): OSM tiles. */
const OSM_LAYER = {
  name: "OpenStreetMap (online)",
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: "© OpenStreetMap contributors",
  maxZoom: 19,
};

/**
 * Parses the server's configured chart resources into raster tile
 * layers (offline MBTiles and tile proxies serve the standard
 * `{z}/{x}/{y}` scheme). Field names follow the Signal K chart
 * resource convention — `minzoom`/`maxzoom`, lowercase — with
 * numeric guards so a malformed value degrades to Leaflet's
 * defaults, never into the tile layer's zoom arithmetic. Entries
 * without a tile URL are skipped — vector charts would need
 * MapLibre and are phase-3 material.
 *
 * @param {object|null} resource - `/signalk/v1/api/resources/charts`
 * @returns {Array<{name: string, url: string, attribution?: string,
 *   minZoom?: number, maxZoom?: number}>}
 */
export function parseChartLayers(resource) {
  const layers = [];
  for (const [id, chart] of Object.entries(resource ?? {})) {
    const url =
      typeof chart?.tilemapUrl === "string" && chart.tilemapUrl.includes("{z}")
        ? chart.tilemapUrl
        : null;
    if (!url) {
      continue;
    }
    layers.push({
      name: chart.name ?? chart.identifier ?? id,
      url,
      attribution: chart.attribution ?? "",
      minZoom: typeof chart.minzoom === "number" ? chart.minzoom : undefined,
      maxZoom: typeof chart.maxzoom === "number" ? chart.maxzoom : undefined,
    });
  }
  return layers.sort((a, b) => a.name.localeCompare(b.name));
}

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
    this._ribbonRows = [];
    this._events = [];
    this._shapes = [];
    this._pins = [];
    this._caps = [];
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
    this._basemaps = L.control.layers(null, null, { position: "bottomleft" });
    fetch("/signalk/v1/api/resources/charts")
      .then((r) => (r.ok ? r.json() : null))
      .then((resource) => {
        const charts = parseChartLayers(resource);
        console.info(`pb-map-view: ${charts.length} configured chart layer(s)`);
        const bases = charts.length > 0 ? charts : [OSM_LAYER];
        let first = null;
        for (const chart of bases) {
          const layer = L.tileLayer(chart.url, {
            attribution: chart.attribution ?? "",
            minZoom: chart.minZoom,
            maxZoom: chart.maxZoom,
          });
          this._watchTileLayer(layer, chart.name);
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
            this._basemaps.addBaseLayer(layer, chart.name);
          }
        }
        // The online fallback stays switchable even when configured
        // charts exist — a dead chart tile URL is one tap away from
        // a working map (dead-reckoning's "blank chart reads as
        // broken" feedback, 2026-09)
        if (charts.length > 0) {
          this._basemaps.addBaseLayer(
            L.tileLayer(OSM_LAYER.url, {
              attribution: OSM_LAYER.attribution,
              maxZoom: OSM_LAYER.maxZoom,
            }),
            OSM_LAYER.name,
          );
        }
        // Auto-recovery: a configured chart whose tiles all fail
        // (dead tile server, stale MBTiles) leaves a grey canvas
        // beneath the overlays — slip the OSM fallback underneath
        // so the crew sees a chart regardless
        if (first) {
          setTimeout(() => {
            if (
              first._pbTileErrors > 0 &&
              first._pbTileLoads === 0 &&
              this.map
            ) {
              console.warn(
                "pb-map-view: configured chart yields no tiles — OSM fallback slipped underneath",
              );
              const fallback = L.tileLayer(OSM_LAYER.url, {
                attribution: OSM_LAYER.attribution,
                maxZoom: OSM_LAYER.maxZoom,
              });
              fallback.addTo(this.map).bringToBack();
            }
          }, 6000);
        }
        if (bases.length > 1) {
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
   * Bulletin console data (same object the console text renders):
   * block geometry draws as shapes, block indices key the
   * click-through.
   *
   * @param {{blocks?: Array<object>}|null} bulletin
   */
  setBulletin(bulletin) {
    this._blocks = bulletin?.blocks ?? [];
    this._render();
    this._fit();
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
    this._shapes = blockShapes(this._blocks, referenceLon);
    this._caps = (this._payload?.capAlerts ?? [])
      .map((alert) => capShape(alert, referenceLon))
      .filter(Boolean);
    this._pins = (this._payload?.hazardEvents ?? [])
      .map((event) => hazardPin(event, referenceLon))
      .filter(Boolean);
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
      layer
        .bindTooltip(`Off your waters — ${shape.label ?? ""}`)
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
    for (const shape of this._shapes) {
      if (
        shape.kind === "point" &&
        this._storms?.some((storm) => storm.index === shape.index)
      ) {
        continue; // Advisory storm: the graphic below covers it
      }
      if (shape.kind === "point") {
        const marker = stormMarker({
          text: this._blocks[shape.index]?.text ?? "",
          geometry: { type: "point", coordinates: shape.points[0] },
        });
        L.circleMarker([shape.points[0][1], shape.points[0][0]], {
          radius: 7,
          color: shape.severe ? "#ff5c5c" : "#ffb45c",
          fillColor: shape.severe ? "#ff5c5c" : "#ffb45c",
          fillOpacity: 0.9,
          weight: 2,
        })
          .bindTooltip(marker?.label ?? "storm")
          .on("click", () => this._select(shape.index))
          .addTo(this._overlayGroup);
        continue;
      }
      const style = {
        color: shape.severe ? "#ff5c5c" : "#ffb45c",
        weight: shape.severe ? 2 : 1.5,
        dashArray: shape.dashed ? "4 6" : undefined,
        fillOpacity: 0.12,
      };
      const layer =
        shape.kind === "line"
          ? L.polyline(
              shape.points.map(([lon, lat]) => [lat, lon]),
              style,
            )
          : L.polygon(
              shape.points.map(([lon, lat]) => [lat, lon]),
              style,
            );
      if (shape.label) {
        layer.bindTooltip(shape.label);
      }
      layer
        .on("click", () => this._select(shape.index))
        .addTo(this._overlayGroup);
    }
    for (const cap of this._caps) {
      const style = {
        color: cap.severity === "extreme" ? "#ff5c5c" : "#ffb45c",
        weight: 2,
        dashArray: cap.kind === "bbox" ? "4 6" : undefined,
        fillOpacity: 0.08,
      };
      const layer =
        cap.kind === "bbox"
          ? L.polygon(
              cap.points.map(([lon, lat]) => [lat, lon]),
              style,
            )
          : L.polygon(
              cap.points.map(([lon, lat]) => [lat, lon]),
              style,
            );
      layer.bindTooltip(cap.label).addTo(this._overlayGroup);
    }
    for (const pin of this._pins) {
      L.circleMarker([pin.lat, pin.lon], {
        radius: 6,
        color: pin.level === "red" ? "#ff5c5c" : "#ffb45c",
        fillColor: pin.level === "red" ? "#ff5c5c" : "#ffb45c",
        fillOpacity: 0.9,
        weight: 2,
      })
        .bindTooltip(pin.label)
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

  /** Every coordinate the overlays would draw (fit bounds). */
  _drawablePoints() {
    return [
      ...(this._storms ?? []).flatMap((storm) => [
        storm.center,
        ...storm.rings.flatMap((ring) => ring.points),
        ...storm.track,
        ...storm.forecastPoints.map((point) => [point.lon, point.lat]),
      ]),
      ...(this._ribbon ?? []).flatMap((segment) => segment.points),
      ...(this._eventPins ?? []).map((pin) => [pin.lon, pin.lat]),
      ...this._shapes.flatMap((shape) =>
        shape.kind === "point" ? [shape.points[0]] : shape.points,
      ),
      ...this._caps.flatMap((cap) => cap.points),
      ...this._pins.map((pin) => [pin.lon, pin.lat]),
    ].filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  }

  /** Fits the view to every drawn coordinate (track wins the centre). */
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
    const bounds = frameBounds(all);
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
