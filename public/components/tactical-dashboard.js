/**
 * `<tactical-dashboard>` — Screen 1: the next 24 hours (SPEC §6.3).
 *
 * Exception-driven: the unified passage timeline (work doc #18)
 * renders the 24 h slice of every event source, the energy warning
 * only on deficit. Data arrives via `setExceptions()` plus
 * `setPayload()` from the root component; updates touch cached DOM
 * nodes only.
 *
 * @file components/tactical-dashboard.js
 */

import { blockShapes, eventPins, trackLine } from "./map-model.mjs";
import {
  fmtShip,
  fmtUtc,
  mergeTimeline,
  skySegments,
  splitSevere,
  tacticalNow,
} from "./models.mjs";
import "./map-view.js";
import "./passage-timeline.js";
import { SK_BASE_CSS } from "./sk-base-css.js";

/**
 * The custom element (browser only).
 */
class TacticalDashboard extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    this.shadowRoot.innerHTML = `
      <style>
        ${SK_BASE_CSS}
        :host { display: block; }
        .now { display: flex; align-items: baseline; gap: 12px; }
        .tier {
          font-family: var(--font-data, ui-monospace, monospace);
          font-size: 1rem; font-weight: 700;
          letter-spacing: 0.1em; text-transform: uppercase;
        }
        .banner {
          border: 1px solid var(--color-red);
          color: var(--color-red);
          font-family: var(--font-data, ui-monospace, monospace);
          padding: 8px 12px; margin-top: 8px;
          text-transform: uppercase; letter-spacing: 0.1em;
          font-size: 0.85rem; font-weight: 700;
        }
                .cap-alert { margin: 6px 0 0; }
        .cap-severe {
          color: var(--color-orange);
          font-family: var(--font-data, ui-monospace, monospace);
          font-weight: 700;
          letter-spacing: 0.08em;
          margin-right: 8px;
        }
        .cap-extreme {
          color: var(--color-red);
          font-family: var(--font-data, ui-monospace, monospace);
          font-weight: 700;
          letter-spacing: 0.08em;
          margin-right: 8px;
        }
        .cap-instruction {
          margin: 4px 0 0;
          font-size: 0.9em;
          opacity: 0.85;
        }
        .cap-prov, .block-prov {
          color: inherit;
          opacity: 0.7;
          text-decoration: none;
          font-family: var(--font-data, ui-monospace, monospace);
        }
        .cap-prov:hover, .cap-prov:focus,
        .block-prov:hover, .block-prov:focus { opacity: 1; }
strong.sev {
          color: var(--color-orange);
          text-transform: uppercase;
        }
        .departure-chip {
          font-family: var(--font-data, ui-monospace, monospace);
          font-size: 0.8rem; font-weight: 700;
          letter-spacing: 0.08em; text-transform: uppercase;
          color: var(--color-grey);
          margin: 8px 0 0;
        }
        /* Sky line (work doc #33): tonight's sun/moon times and the
         * now cloud cover, one dense monospace line — watch planning
         * reads off one row */
        .sky {
          font-family: var(--font-data, ui-monospace, monospace);
          font-size: 0.8rem;
          color: var(--text-muted);
          margin: 6px 0 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .sky span { margin-right: 10px; }
        .card-head {
          display: flex; align-items: center; justify-content: space-between;
          gap: 8px;
        }
        .card-head h2 { margin: 0; }
        .refresh {
          min-height: 36px; padding: 6px 12px; flex: none;
        }
        .refresh:disabled { opacity: 0.5; }
      </style>
      <section class="sk-card theme-teal">
        <div class="card-head">
          <h2>Next 24 Hours</h2>
          <button id="refresh" class="refresh">Update now</button>
        </div>
        <div class="now">
          <span class="label">AWS</span>
          <span class="value" id="aws">—</span>
          <span class="tier" id="tier">no data</span>
          <comfort-info id="cinfo"></comfort-info>
        </div>
        <div class="departure-chip" id="departure-chip" hidden></div>
        <div class="sky" id="sky"></div>
        <horizon-sparkline id="spark"></horizon-sparkline>
        <departure-control id="departure-control"></departure-control>
        <div id="energy"></div>
        <passage-timeline id="timeline"></passage-timeline>
      </section>
      <section class="sk-card theme-red" id="blocks-card" hidden>
        <h2>Warnings On Your Waters</h2>
        <div class="console" id="blocks"></div>
      </section>
      <section class="sk-card theme-red" id="cap-card" hidden>
        <h2>Official Alerts</h2>
        <div id="cap-alerts"></div>
      </section>
      <section class="sk-card theme-teal" id="map-card" hidden>
        <h2>Warnings Map</h2>
        <!-- The warnings map (work doc #47), same as the strategic
             screen's: the track, its warnings and every placeable
             timeline event — the whole passage, not just the 24 h
             slice — drawn where they happen; above the synoptic
             chart like the strategic card -->
        <pb-map-view id="warnings-map"></pb-map-view>
      </section>
      <synoptic-chart hidden></synoptic-chart>
    `;
    this._awsEl = this.shadowRoot.getElementById("aws");
    this._tierEl = this.shadowRoot.getElementById("tier");
    this._cinfo = this.shadowRoot.getElementById("cinfo");
    this._refreshEl = this.shadowRoot.getElementById("refresh");
    this._refreshEl.disabled = !this._online;
    this._refreshEl.addEventListener("click", () => this.onRefresh?.());
    this._spark = this.shadowRoot.getElementById("spark");
    this._departureControl =
      this.shadowRoot.getElementById("departure-control");
    this._departureControl?.addEventListener("departurechange", (event) =>
      this.onDepartureChange?.(event.detail),
    );
    this._energyEl = this.shadowRoot.getElementById("energy");
    this._timeline = this.shadowRoot.getElementById("timeline");
    this._blocksCard = this.shadowRoot.getElementById("blocks-card");
    this._blocksEl = this.shadowRoot.getElementById("blocks");
    // The warnings map (work doc #47): shapes click through to the
    // console text card, pins to the timeline rows, rows back to pins
    this._map = this.shadowRoot.getElementById("warnings-map");
    if (this._map) {
      this._map.onBlockSelect = (index) => this._highlightBlock(index);
      // Map pin → timeline row (work doc #47): the map carries the
      // whole passage's pins while the list holds the tactical 24 h
      // slice, so the pin's full-list index translates to a row
      // index through the shared event objects; off-slice pins have
      // no row and no-op
      this._map.onEventSelect = (index) => {
        const sliceIndex = this._sliceIndexOf?.get(this._mapEvents?.[index]);
        if (sliceIndex != null) {
          this._timeline?.reveal(sliceIndex);
        }
      };
    }
    if (this._timeline) {
      // Timeline row → map pin: the row's slice index translates to
      // the full-list index the map's pins are keyed by
      this._timeline.onEventSelect = (index) => {
        const fullIndex = this._fullIndexOf?.get(this._sliceEvents?.[index]);
        if (fullIndex != null) {
          this._map?.focusEvent(fullIndex);
        }
      };
    }
    if (this._exceptions) {
      this.setExceptions(this._exceptions);
    }
    if (this._payload !== undefined) {
      this.setPayload(this._payload);
    }
    if (this._bulletin !== undefined) {
      this.setBulletin(this._bulletin);
    }
  }

  /**
   * Renders from the worker's exception view.
   *
   * @param {object|null} exceptions
   */
  setExceptions(exceptions) {
    this._exceptions = exceptions;
    if (!this._awsEl) {
      return; // Not yet connected
    }

    // Now readout
    const now = tacticalNow(exceptions);
    this._awsEl.textContent =
      now.awsKnots != null ? `${now.awsKnots.toFixed(1)} kn` : "—";
    this._tierEl.textContent = now.comfortLevel ?? "no data";
    this._tierEl.style.color = now.color;
    this._cinfo?.setAttribute("tier", now.comfortLevel ?? "");

    // Departure chip (work doc #15): states the anchor when the
    // schedule shifts — "First light 10-05 06:00 +13" — hidden when
    // the schedule runs from now
    const departure = exceptions?.passageSummary?.departure ?? null;
    const chip = this.shadowRoot.getElementById("departure-chip");
    if (chip) {
      const shifted =
        departure?.time != null && departure.reason !== "underway";
      chip.hidden = !shifted;
      if (shifted) {
        const reasonText =
          departure.reason === "next_dawn"
            ? "First light"
            : departure.reason === "daylight_prep"
              ? "After prep"
              : "Departure";
        chip.textContent = `${reasonText} ${fmtShip(departure.time)}`;
      }
    }

    this._spark.setColumns(exceptions?.next24h?.comfortBlocks ?? [], {
      anchorMs: this._departureAnchorMs ?? null,
    });

    // Energy deficit — only when true
    const deficit = exceptions?.next24h?.energyDeficitAlert === true;
    this._energyEl.innerHTML = "";
    if (deficit) {
      const el = document.createElement("div");
      el.className = "banner";
      el.textContent = "Energy deficit next 24h";
      this._energyEl.appendChild(el);
    }

    this._renderTimeline();
  }

  /**
   * Departure state (work doc #15): renders the shared control and
   * re-paints the chip/sparkline labels against the anchor.
   *
   * @param {{mode: string, customTime: string|null, departure: object|
   *   null}} state
   */
  setDeparture(state) {
    this._departureState = state;
    this._departureAnchorMs = state?.departure?.time
      ? new Date(state.departure.time).getTime()
      : null;
    if (this._departureControl) {
      this._departureControl.render(state);
    }
    if (this._exceptions) {
      this.setExceptions(this._exceptions);
    }
  }

  /**
   * The root owns the departure state; the control reports changes.
   */
  onDepartureChange = null;

  /**
   * Online state: the refresh button only fires while the link is up
   * (the server refuses offline refreshes).
   *
   * @param {boolean} online
   */
  setOnline(online) {
    this._online = online === true;
    if (this._refreshEl) {
      this._refreshEl.disabled = !this._online;
    }
  }

  /**
   * Refresh callback (set by the root component): posts the route
   * refresh and reloads — the tactical view otherwise has no way to
   * recompile between scheduled windows, and a cached payload
   * predating a new payload field would render stale forever.
   */
  onRefresh = null;

  /**
   * Briefing payload (work docs #3, #17): carries the space events
   * and zone transitions the timeline merges in alongside the
   * exception view's own sources.
   *
   * @param {object|null} payload
   */
  setPayload(payload) {
    this._payload = payload;
    if (!this._timeline) {
      return; // Not yet connected
    }
    this._renderTimeline();
    this.renderCapAlerts();
    this.renderSky();
    this._map?.setPayload(payload);
    this._hasTrack = trackLine(payload?.waypoints).length > 0;
    this._updateMapCard();
  }

  /**
   * The sky line (work doc #33): tonight's sunset, nautical dusk and
   * moon brackets plus the now cloud cover — watch planning reads
   * off one line instead of guesswork around dusk. Empty when the
   * payload predates the sky data.
   */
  renderSky() {
    const el = this.shadowRoot.getElementById("sky");
    if (!el) {
      return;
    }
    el.innerHTML = "";
    const nowSurface =
      this._payload?.waypoints?.[0]?.forecasts?.[0]?.surface ?? null;
    const segments = skySegments(this._payload ?? null, {
      cloudCover: nowSurface?.cloudCover ?? null,
      precip: nowSurface?.precip ?? null,
      precipProbability: nowSurface?.precipProbability ?? null,
    });
    for (const segment of segments) {
      const span = document.createElement("span");
      span.textContent = segment.text;
      span.title = segment.title;
      el.appendChild(span);
    }
  }

  /**
   * Official Alerts (work doc #24): structured CAP warnings near the
   * vessel or route — visually separate from the filtered METAREA
   * text so the crew can tell authoritative machine-readable warnings
   * from broadcast prose. Severity colours the event line; the
   * instruction text is the crew's action.
   *
   * @param {object|null} payload
   */
  renderCapAlerts() {
    const card = this.shadowRoot.getElementById("cap-card");
    const list = this.shadowRoot.getElementById("cap-alerts");
    if (!card || !list) {
      return;
    }
    const alerts = this._payload?.capAlerts ?? [];
    // The field rides every fresh payload when CAP is enabled; an old
    // payload without it keeps the card hidden (channel not configured)
    card.hidden = !Array.isArray(this._payload?.capAlerts);
    list.innerHTML = "";
    if (alerts.length === 0) {
      // The channel is enabled and green: silence should be explicit
      // — "checked, nothing active" — not an absent card the crew
      // cannot tell from a dead feed
      const none = document.createElement("div");
      none.className = "none";
      none.textContent = "No official alerts in effect for these waters";
      list.appendChild(none);
      return;
    }
    for (const alert of alerts) {
      const el = document.createElement("div");
      el.className = "cap-alert";
      const severity = document.createElement("span");
      severity.className =
        alert.severity === "extreme" ? "cap-extreme" : "cap-severe";
      severity.textContent = (alert.severity ?? "alert").toUpperCase();
      const body = document.createElement("span");
      body.textContent = [
        alert.headline || alert.event || "Official alert",
        alert.expires ? `expires ${fmtUtc(alert.expires)}` : null,
      ]
        .filter(Boolean)
        .join(" — ");
      el.append(severity, body);
      // Provenance (work doc #31): the sender's page or the feed
      const provUrl = alert.provenance?.url ?? alert.web ?? alert.sourceUrl;
      if (provUrl) {
        const prov = document.createElement("a");
        prov.className = "cap-prov";
        prov.href = provUrl;
        prov.target = "_blank";
        prov.rel = "noopener";
        prov.textContent = "↗";
        prov.title = alert.provenance?.label ?? "source";
        el.append(" ", prov);
      }
      list.appendChild(el);
      if (alert.instruction) {
        const instruction = document.createElement("div");
        instruction.className = "cap-instruction";
        instruction.textContent = alert.instruction;
        list.appendChild(instruction);
      }
    }
  }

  /**
   * The unified timeline (work doc #18): the 24 h slice of the
   * merged view model — sail work, maneuvers, convective risk, sea
   * state, zones, sky and hazards in one chronological list. The
   * list keeps the slice, but the map paints the whole passage's
   * placeable events (the strategic map already did): pins that
   * stopped at 24 h read as events simply ceasing to happen. The
   * two projections index differently, so the click-through keys
   * translate through the shared event objects.
   */
  _renderTimeline() {
    if (!this._timeline) {
      return;
    }
    const items = mergeTimeline(
      this._exceptions ?? null,
      this._payload ?? null,
    );
    const slice = items.filter(
      (item) => item.hoursFromNow != null && item.hoursFromNow <= 24,
    );
    this._timeline.setTimeline(slice);
    this._sliceEvents = slice;
    // Whole passage on the map, with the index translations both
    // ways (slice items are the full list's own objects)
    this._map?.setTimeline(items);
    this._mapEvents = items;
    this._sliceIndexOf = new Map(slice.map((item, i) => [item, i]));
    this._fullIndexOf = new Map(items.map((item, i) => [item, i]));
    const track = this._exceptions?.passageSummary?.track ?? [];
    this._map?.setRibbon(track);
    this._hasRibbon = track.length > 0;
    this._hasPins = eventPins(items).length > 0;
    this._updateMapCard();
  }

  /**
   * Map card visibility (work doc #47): geographic data only — same
   * rule as the strategic screen.
   */
  _updateMapCard() {
    const card = this.shadowRoot.getElementById("map-card");
    if (card) {
      card.hidden = !(
        this._hasTrack ||
        this._hasShapes ||
        this._hasRibbon ||
        this._hasPins
      );
    }
  }

  /**
   * Click-through target (work doc #47): scroll to and flash the
   * warning block's text card.
   *
   * @param {number} index - Block index in the console
   */
  _highlightBlock(index) {
    const el = this.shadowRoot.querySelector(`[data-block-index="${index}"]`);
    if (!el) {
      return;
    }
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.style.background = "rgba(78, 201, 176, 0.15)";
    setTimeout(() => {
      el.style.background = "";
    }, 1600);
  }

  /**
   * METAREA warning blocks for the route (work doc #4 §5): the
   * geographically filtered paragraphs, severe keywords lit. Shares
   * the strategic outlook's rendering; the raw bulletin console
   * stays on the strategic screen only. Also mirrors the synoptic
   * surface-analysis chart here.
   *
   * @param {{blocks?: Array<{text: string}>}|null} bulletin
   */
  setBulletin(bulletin) {
    this._bulletin = bulletin;
    if (!this._blocksEl) {
      return; // Not yet connected
    }
    const blocks = bulletin?.blocks ?? [];
    this._blocksCard.hidden = blocks.length === 0;
    this._blocksEl.innerHTML = "";
    for (const [index, block] of blocks.entries()) {
      const pre = document.createElement("div");
      pre.style.marginBottom = "8px";
      // The map's click-through key (work doc #47)
      pre.dataset.blockIndex = String(index);
      if (block.storm) {
        // Advisory family (work doc #21): the structured storm summary
        // replaces the raw radii tables — what the crew needs is the
        // storm, its force and where it is going
        const storm = block.storm;
        const strong = document.createElement("strong");
        strong.className = "sev";
        strong.textContent = [
          storm.severityLabel ?? "TROPICAL CYCLONE",
          storm.stormName ?? "Tropical cyclone",
        ].join(" — ");
        pre.appendChild(strong);
        pre.appendChild(document.createElement("br"));
        pre.appendChild(
          document.createTextNode(
            [
              storm.center
                ? `center ${storm.center.lat.toFixed(1)}° ${storm.center.lon.toFixed(1)}°`
                : null,
              storm.movementText
                ? `moving ${storm.movementText.toLowerCase()} at ${storm.movementSpeedKt ?? "?"} kt`
                : null,
              storm.maxWindKt != null
                ? `max ${storm.maxWindKt} kt, gusts ${storm.gustKt ?? "?"} kt`
                : null,
              storm.forecastPoints?.length
                ? `forecast ${storm.forecastPoints.length} positions to ${storm.forecastPoints.at(-1).lat.toFixed(1)}° ${storm.forecastPoints.at(-1).lon.toFixed(1)}°`
                : null,
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        );
        this._blocksEl.appendChild(pre);
        continue;
      }
      for (const token of splitSevere(block.text)) {
        if (token.severe) {
          const strong = document.createElement("strong");
          strong.className = "sev";
          strong.textContent = token.text;
          pre.appendChild(strong);
        } else {
          pre.appendChild(document.createTextNode(token.text));
        }
      }
      this._blocksEl.appendChild(pre);
      // Provenance (work doc #31): the feed the text arrived from
      if (block.sourceUrl) {
        const prov = document.createElement("a");
        prov.className = "block-prov";
        prov.href = block.sourceUrl;
        prov.target = "_blank";
        prov.rel = "noopener";
        prov.textContent = "↗ source";
        prov.title = "bulletin feed";
        this._blocksEl.appendChild(prov);
      }
    }
    this._map?.setBulletin(bulletin);
    this._hasShapes = blockShapes(blocks).length > 0;
    this._updateMapCard();
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("tactical-dashboard", TacticalDashboard);
}

export { TacticalDashboard };
