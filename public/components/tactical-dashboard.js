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

import {
  fmtShip,
  fmtUtc,
  mergeTimeline,
  skySegments,
  splitSevere,
  tacticalNow,
} from "./models.mjs";
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
      </style>
      <section class="sk-card theme-teal">
        <h2>Next 24 Hours</h2>
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
      <synoptic-chart hidden></synoptic-chart>
    `;
    this._awsEl = this.shadowRoot.getElementById("aws");
    this._tierEl = this.shadowRoot.getElementById("tier");
    this._cinfo = this.shadowRoot.getElementById("cinfo");
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
    const nowCloud =
      this._payload?.waypoints?.[0]?.forecasts?.[0]?.surface?.cloudCover ??
      null;
    const segments = skySegments(this._payload ?? null, {
      cloudCover: nowCloud,
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
   * state, zones, sky and hazards in one chronological list.
   */
  _renderTimeline() {
    if (!this._timeline) {
      return;
    }
    const items = mergeTimeline(
      this._exceptions ?? null,
      this._payload ?? null,
    );
    this._timeline.setTimeline(
      items.filter(
        (item) => item.hoursFromNow != null && item.hoursFromNow <= 24,
      ),
    );
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
    for (const block of blocks) {
      const pre = document.createElement("div");
      pre.style.marginBottom = "8px";
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
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("tactical-dashboard", TacticalDashboard);
}

export { TacticalDashboard };
