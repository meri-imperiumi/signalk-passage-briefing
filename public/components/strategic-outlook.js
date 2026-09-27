/**
 * `<strategic-outlook>` — Screen 2: whole-passage summary (SPEC
 * §6.3). ETA percentile table, macro sea-state warnings, convective
 * warnings and the raw METAREA bulletin console.
 *
 * @file components/strategic-outlook.js
 */

import { etaTable, sailWorkTimeline, splitSevere } from "./models.mjs";

/**
 * The custom element (browser only).
 */
class StrategicOutlook extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .sk-card { margin-bottom: 12px; }
        pre.console { margin: 0; }
        .warn {
          color: var(--color-orange);
          font-family: var(--font-data, ui-monospace, monospace);
          font-size: 0.85rem;
          padding: 4px 0;
        }
        .warn.severe { color: var(--color-red); }
        .none { color: var(--text-muted); font-size: 0.85rem; }
        strong.sev {
          color: var(--color-orange);
          text-transform: uppercase;
        }
      </style>
      <section class="sk-card theme-teal">
        <h2>ETA &amp; Motor Plan</h2>
        <table class="data">
          <thead>
            <tr><th>Percentile</th><th>Arrival (UTC)</th></tr>
          </thead>
          <tbody id="eta-body"></tbody>
        </table>
        <div class="grid-auto" style="margin-top: 8px">
          <div><div class="label">Motor hours</div><div class="value-small" id="motor">—</div></div>
          <div><div class="label">Fuel</div><div class="value-small" id="fuel">—</div></div>
        </div>
      </section>
      <section class="sk-card theme-orange">
        <h2>Macro Sea State</h2>
        <div id="sea"><span class="none">No anomalies</span></div>
      </section>
      <section class="sk-card theme-red">
        <h2>Convective Risk</h2>
        <div id="conv"><span class="none">No warnings</span></div>
      </section>
      <section class="sk-card theme-orange">
        <h2>Sail Work</h2>
        <div id="sailwork"><span class="none">No sail changes planned</span></div>
      </section>
      <section class="sk-card" id="sky-card" hidden>
        <h2>Sky Notes</h2>
        <div id="sky"></div>
      </section>
      <section class="sk-card theme-teal">
        <h2>METAREA Bulletin</h2>
        <pre class="console" id="bulletin">No bulletin cached</pre>
      </section>
      <section class="sk-card theme-red" id="blocks-card" hidden>
        <h2>Warnings On Your Waters</h2>
        <div class="console" id="blocks"></div>
      </section>
      <backfill-controls></backfill-controls>
    `;
    this._etaBody = this.shadowRoot.getElementById("eta-body");
    this._motorEl = this.shadowRoot.getElementById("motor");
    this._fuelEl = this.shadowRoot.getElementById("fuel");
    this._seaEl = this.shadowRoot.getElementById("sea");
    this._convEl = this.shadowRoot.getElementById("conv");
    this._sailWorkEl = this.shadowRoot.getElementById("sailwork");
    this._skyCard = this.shadowRoot.getElementById("sky-card");
    this._skyEl = this.shadowRoot.getElementById("sky");
    this._bulletinEl = this.shadowRoot.getElementById("bulletin");
    if (this._exceptions) {
      this.setExceptions(this._exceptions);
    }
    if (this._bulletin !== undefined) {
      this.setBulletin(this._bulletin);
    }
    if (this._spaceEvents !== undefined) {
      this.setSpaceEvents(this._spaceEvents);
    }
  }

  /**
   * Sky notes (work doc #3): comets and any other non-urgent space
   * events for the passage summary. Hidden when there are none.
   *
   * @param {Array<{description: string, tactical: boolean}>|null} events
   */
  setSpaceEvents(events) {
    this._spaceEvents = events;
    if (!this._skyEl) {
      return; // Not yet connected
    }
    const list = (events ?? []).filter((e) => !e.tactical);
    this._skyCard.hidden = list.length === 0;
    this._skyEl.innerHTML = "";
    for (const e of list) {
      const el = document.createElement("div");
      el.textContent = `✦ ${e.description}`;
      this._skyEl.appendChild(el);
    }
  }

  /**
   * Renders from the worker's exception view.
   *
   * @param {object|null} exceptions
   */
  setExceptions(exceptions) {
    this._exceptions = exceptions;
    if (!this._etaBody) {
      return; // Not yet connected
    }
    const table = etaTable(exceptions);
    this._etaBody.innerHTML = "";
    for (const row of table.rows) {
      const tr = document.createElement("tr");
      const tdLabel = document.createElement("td");
      tdLabel.className = "muted";
      tdLabel.textContent = row.label;
      const tdStamp = document.createElement("td");
      tdStamp.textContent = row.stamp || "—";
      tr.append(tdLabel, tdStamp);
      this._etaBody.appendChild(tr);
    }
    this._motorEl.textContent = table.motorHours || "—";
    this._fuelEl.textContent = table.fuel || "—";

    // Macro sea-state anomalies
    this._seaEl.innerHTML = "";
    const sea = exceptions?.passageSummary?.macroSeaAnomalies ?? [];
    for (const a of sea) {
      const el = document.createElement("div");
      el.className = "warn";
      el.textContent = `+${a.hoursFromNow}h steep sea (ratio ${a.steepnessRatio})`;
      this._seaEl.appendChild(el);
    }
    if (sea.length === 0) {
      const el = document.createElement("span");
      el.className = "none";
      el.textContent = "No anomalies";
      this._seaEl.appendChild(el);
    }

    // Sail work: recommendations plus the planned tacks/gybes (doc #5)
    this._sailWorkEl.innerHTML = "";
    const sailWork = sailWorkTimeline(exceptions);
    for (const item of sailWork) {
      const el = document.createElement("div");
      el.className =
        item.label.startsWith("Tack") || item.label.startsWith("Gybe")
          ? "warn"
          : "";
      el.textContent = `+${item.hoursFromNow}h ${item.stamp} · ${item.label}${item.detail ? ` · ${item.detail}` : ""}`;
      this._sailWorkEl.appendChild(el);
    }
    if (sailWork.length === 0) {
      const el = document.createElement("span");
      el.className = "none";
      el.textContent = "No sail changes planned";
      this._sailWorkEl.appendChild(el);
    }

    // Convective warnings
    this._convEl.innerHTML = "";
    const conv = exceptions?.passageSummary?.convectiveWarnings ?? [];
    for (const a of conv) {
      const el = document.createElement("div");
      el.className = "warn severe";
      const parts = [];
      if (a.cape != null) {
        parts.push(`CAPE ${a.cape}`);
      }
      if (a.kIndex != null) {
        parts.push(`K ${a.kIndex}`);
      }
      el.textContent = `+${a.hoursFromNow}h convection (${parts.join(", ")})`;
      this._convEl.appendChild(el);
    }
    if (conv.length === 0) {
      const el = document.createElement("span");
      el.className = "none";
      el.textContent = "No warnings";
      this._convEl.appendChild(el);
    }
  }

  /**
   * Raw METAREA bulletin (spool-sourced when available).
   *
   * @param {string|{bulletinText: string, blocks: Array<{text: string}>}|null}
   *   bulletin - The payload's metareaBulletin, or raw text
   */
  setBulletin(bulletin) {
    this._bulletin = bulletin;
    if (!this._bulletinEl) {
      return; // Not yet connected
    }
    const normalized =
      typeof bulletin === "string" ? { bulletinText: bulletin } : bulletin;
    this._bulletinEl.textContent =
      normalized?.bulletinText || "No bulletin cached";

    // Filtered blocks replace the raw wall of text (work doc #4 §5):
    // only geographically relevant paragraphs, severe keywords lit
    const blocksCard = this.shadowRoot.getElementById("blocks-card");
    const blocksEl = this.shadowRoot.getElementById("blocks");
    const blocks = normalized?.blocks ?? [];
    blocksCard.hidden = blocks.length === 0;
    blocksEl.innerHTML = "";
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
      blocksEl.appendChild(pre);
    }
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("strategic-outlook", StrategicOutlook);
}

export { StrategicOutlook };
