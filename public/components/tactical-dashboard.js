/**
 * `<tactical-dashboard>` — Screen 1: the next 24 hours (SPEC §6.3).
 *
 * Exception-driven: sail action cards render only when there are
 * changes, the energy warning only on deficit, hazard banners only
 * on proximity alerts. Data arrives via `setExceptions()` from the
 * root component; updates touch cached DOM nodes only.
 *
 * @file components/tactical-dashboard.js
 */

import { sailActionCards, tacticalNow } from "./models.mjs";

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
        :host { display: block; }
        .now { display: flex; align-items: baseline; gap: 12px; }
        .tier {
          font-family: var(--font-data, ui-monospace, monospace);
          font-size: 1rem; font-weight: 700;
          letter-spacing: 0.1em; text-transform: uppercase;
        }
        .cards { display: grid; gap: 8px; }
        .card {
          border: 1px solid var(--theme-color, var(--color-teal));
          padding: 8px 12px; display: flex; justify-content: space-between;
          gap: 8px; align-items: baseline;
        }
        .banner {
          border: 1px solid var(--color-red);
          color: var(--color-red);
          font-family: var(--font-data, ui-monospace, monospace);
          padding: 8px 12px; margin-top: 8px;
          text-transform: uppercase; letter-spacing: 0.1em;
          font-size: 0.85rem; font-weight: 700;
        }
      </style>
      <section class="sk-card theme-teal">
        <h2>Next 24 Hours</h2>
        <div class="now">
          <span class="value" id="aws">—</span>
          <span class="tier" id="tier">no data</span>
          <comfort-info id="cinfo"></comfort-info>
        </div>
        <horizon-sparkline id="spark"></horizon-sparkline>
        <div id="actions"></div>
        <div id="energy"></div>
        <div id="hazards"></div>
        <div id="space"></div>
      </section>
    `;
    this._awsEl = this.shadowRoot.getElementById("aws");
    this._tierEl = this.shadowRoot.getElementById("tier");
    this._cinfo = this.shadowRoot.getElementById("cinfo");
    this._spark = this.shadowRoot.getElementById("spark");
    this._actionsEl = this.shadowRoot.getElementById("actions");
    this._energyEl = this.shadowRoot.getElementById("energy");
    this._hazardsEl = this.shadowRoot.getElementById("hazards");
    this._spaceEl = this.shadowRoot.getElementById("space");
    if (this._exceptions) {
      this.setExceptions(this._exceptions);
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
      now.awsKnots != null ? `${now.awsKnots.toFixed(1)}` : "—";
    this._tierEl.textContent = now.comfortLevel ?? "no data";
    this._tierEl.style.color = now.color;
    this._cinfo?.setAttribute("tier", now.comfortLevel ?? "");

    this._spark.setColumns(exceptions?.next24h?.comfortBlocks ?? []);

    // Sail action cards — only when there are changes; maneuver
    // events read as the sail work they demand (work doc #5)
    const cards = sailActionCards(exceptions);
    this._actionsEl.innerHTML = "";
    if (cards.length > 0) {
      const wrap = document.createElement("div");
      wrap.className = "cards";
      for (const c of cards) {
        const el = document.createElement("div");
        el.className = "card";
        el.style.setProperty("--theme-color", "var(--color-orange)");
        const name = document.createElement("span");
        name.className = "value-small";
        name.textContent = c.maneuver
          ? `${c.maneuver === "tack" ? "Tack" : "Gybe"} to ${c.toTack ?? "?"}`
          : c.sailState;
        const when = document.createElement("span");
        when.className = "muted";
        when.textContent = c.maneuver
          ? `~${c.stamp}${c.twsKnots != null ? `, ${c.twsKnots.toFixed(0)} kt` : ""}`
          : `${c.night ? "☾ " : ""}+${c.hoursFromNow}h ${c.stamp}`;
        el.append(name, when);
        wrap.appendChild(el);
      }
      this._actionsEl.appendChild(wrap);
    }

    // Energy deficit — only when true
    const deficit = exceptions?.next24h?.energyDeficitAlert === true;
    this._energyEl.innerHTML = "";
    if (deficit) {
      const el = document.createElement("div");
      el.className = "banner";
      el.textContent = "Energy deficit next 24h";
      this._energyEl.appendChild(el);
    }

    // Hazard banners — only when present
    const hazards = exceptions?.next24h?.hazards ?? [];
    this._hazardsEl.innerHTML = "";
    for (const h of hazards) {
      const el = document.createElement("div");
      el.className = "banner";
      el.textContent = `⚠ ${h.description ?? h.noteId ?? "hazard"} +${h.hoursFromNow}h`;
      this._hazardsEl.appendChild(el);
    }
    if (this._spaceEvents) {
      this.setSpaceEvents(this._spaceEvents);
    }
  }

  /**
   * Tactical space-weather banners (work doc #3): aurora-class
   * alerts only; comet items belong to the strategic outlook.
   *
   * @param {Array<{description: string}>|null} events
   */
  setSpaceEvents(events) {
    this._spaceEvents = events;
    if (!this._spaceEl) {
      return; // Not yet connected
    }
    this._spaceEl.innerHTML = "";
    for (const e of events ?? []) {
      const el = document.createElement("div");
      el.className = "banner";
      el.textContent = `✦ ${e.description}`;
      this._spaceEl.appendChild(el);
    }
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("tactical-dashboard", TacticalDashboard);
}

export { TacticalDashboard };
