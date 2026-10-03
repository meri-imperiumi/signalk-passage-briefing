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

import { fmtShip, mergeTimeline, splitSevere, tacticalNow } from "./models.mjs";
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
        <horizon-sparkline id="spark"></horizon-sparkline>
        <departure-control id="departure-control"></departure-control>
        <div id="energy"></div>
        <passage-timeline id="timeline"></passage-timeline>
      </section>
      <section class="sk-card theme-red" id="blocks-card" hidden>
        <h2>Warnings On Your Waters</h2>
        <div class="console" id="blocks"></div>
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
    }
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("tactical-dashboard", TacticalDashboard);
}

export { TacticalDashboard };
