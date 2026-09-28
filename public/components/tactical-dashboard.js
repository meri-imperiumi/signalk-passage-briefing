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

import { sailActionCards, splitSevere, tacticalNow } from "./models.mjs";
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
      </style>
      <section class="sk-card theme-teal">
        <h2>Next 24 Hours</h2>
        <div class="now">
          <span class="label">AWS</span>
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
    this._actionsEl = this.shadowRoot.getElementById("actions");
    this._energyEl = this.shadowRoot.getElementById("energy");
    this._hazardsEl = this.shadowRoot.getElementById("hazards");
    this._spaceEl = this.shadowRoot.getElementById("space");
    this._blocksCard = this.shadowRoot.getElementById("blocks-card");
    this._blocksEl = this.shadowRoot.getElementById("blocks");
    if (this._exceptions) {
      this.setExceptions(this._exceptions);
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
          : c.label;
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
