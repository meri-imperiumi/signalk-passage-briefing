/**
 * The ℹ️ next to the comfort tier: an expanding explainer for the
 * project's modified Sereno comfort scale (champagne → miserable),
 * highlighting the current tier via the `tier` attribute. Used by the tactical dashboard and
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
          max-height: calc(100vh - 16px); overflow-y: auto;
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
    this._summary = this.shadowRoot.querySelector("summary");
    this._pop = this.shadowRoot.getElementById("pop");
    // Mobile-safe popover (viewport-clamped): anchored absolute it
    // runs off the right edge of a phone screen and drags the page
    // into a sideways scroll. While open it is pinned to the
    // viewport instead, repositioning on scroll and resize.
    this._details.addEventListener("toggle", () => {
      if (this._details.open) {
        requestAnimationFrame(() => this._positionPop());
        window.addEventListener("scroll", this, true);
        window.addEventListener("resize", this);
      } else {
        window.removeEventListener("scroll", this, true);
        window.removeEventListener("resize", this);
      }
    });
    this.renderPop();
  }

  /**
   * Repositions the open popover as a viewport-fixed overlay clamped
   * inside the window (handleEvent target for scroll/resize).
   */
  handleEvent() {
    this._positionPop();
  }

  disconnectedCallback() {
    window.removeEventListener("scroll", this, true);
    window.removeEventListener("resize", this);
  }

  /** Pins the open popover inside the viewport, flipping above the
   *  summary when the space below runs out. */
  _positionPop() {
    if (!this._details?.open || !this._pop) {
      return;
    }
    const rect = this._summary.getBoundingClientRect();
    const margin = 8;
    const gap = 6;
    const width = this._pop.offsetWidth;
    const height = this._pop.offsetHeight;
    const left = Math.min(
      Math.max(rect.left, margin),
      Math.max(window.innerWidth - width - margin, margin),
    );
    let top = rect.bottom + gap;
    if (top + height > window.innerHeight - margin) {
      top = rect.top - height - gap;
    }
    top = Math.min(
      Math.max(top, margin),
      Math.max(window.innerHeight - height - margin, margin),
    );
    this._pop.style.position = "fixed";
    this._pop.style.left = `${left}px`;
    this._pop.style.top = `${top}px`;
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
    const slatting = document.createElement("div");
    slatting.className = "row";
    const slattingName = document.createElement("span");
    slattingName.className = "name";
    slattingName.textContent = "SLATTING";
    const slattingText = document.createElement("span");
    slattingText.textContent =
      " — Light air over a residual swell: the sails slat and bang, " +
      "snap-rolling the boat.";
    slatting.appendChild(slattingName);
    slatting.appendChild(slattingText);
    const slattingBand = document.createElement("span");
    slattingBand.className = "band";
    slattingBand.textContent =
      "wind < 7–12 kn by point of sail · swell ≥ 0.6 m";
    slatting.appendChild(slattingBand);
    this._pop.appendChild(slatting);
    // Content changes (tier highlight) can resize the open popover
    this._positionPop();
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("comfort-info", ComfortInfo);
}

export { ComfortInfo };
