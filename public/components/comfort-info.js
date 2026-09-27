/**
 * The ℹ️ next to the comfort tier: an expanding explainer for the
 * Sereno comfort scale (champagne → sick), highlighting the current
 * tier via the `tier` attribute. Used by the tactical dashboard and
 * the conditions-here view.
 *
 * @file components/comfort-info.js
 */

import { COMFORT_SCALE_INFO } from "../sereno-physics.mjs";

class ComfortInfo extends HTMLElement {
  static get observedAttributes() {
    return ["tier"];
  }

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: inline-block; position: relative; }
        summary {
          list-style: none; cursor: pointer; user-select: none;
        }
        summary::-webkit-details-marker { display: none; }
        .pop {
          position: absolute; z-index: 20; left: 0; top: calc(100% + 6px);
          min-width: 16rem; max-width: 18rem; padding: 8px 10px;
          background: var(--bg-panel);
          border: 1px solid var(--color-grey);
          font-family: var(--font-data, ui-monospace, monospace);
          font-size: 0.75rem; text-transform: none; letter-spacing: normal;
        }
        .note { color: var(--color-grey); margin: 0 0 6px; }
        .row { margin: 4px 0; }
        .row.current { font-weight: 700; }
        .row.current .name { text-decoration: underline; }
        .band { color: var(--color-grey); display: block; }
      </style>
      <details class="info">
        <summary aria-label="Comfort scale explained" title="Comfort scale explained">ℹ️</summary>
        <div class="pop" id="pop"></div>
      </details>
    `;
    this._details = this.shadowRoot.querySelector("details");
    this._pop = this.shadowRoot.getElementById("pop");
    this.renderPop();
  }

  attributeChangedCallback() {
    this.renderPop();
  }

  renderPop() {
    if (!this._pop) {
      return;
    }
    const current = this.getAttribute("tier")?.toLowerCase() ?? "";
    this._pop.textContent = "";
    const note = document.createElement("p");
    note.className = "note";
    note.textContent =
      "Comfort tiers are lost when apparent wind or vertical motion crosses their line — the worse factor wins.";
    this._pop.appendChild(note);
    for (const level of COMFORT_SCALE_INFO) {
      const row = document.createElement("div");
      row.className =
        level.tier.toLowerCase() === current ? "row current" : "row";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = level.tier.toUpperCase();
      const text = document.createElement("span");
      text.textContent = ` — ${level.text}`;
      row.appendChild(name);
      row.appendChild(text);
      const band = document.createElement("span");
      band.className = "band";
      band.textContent =
        level.maxAws == null
          ? "wind ≥ 33 kn or motion ≥ 1.25 m/s²"
          : `wind < ${level.maxAws} kn · motion < ${level.maxAz} m/s²`;
      row.appendChild(band);
      this._pop.appendChild(row);
    }
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("comfort-info", ComfortInfo);
}

export { ComfortInfo };
