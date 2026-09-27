/**
 * `<horizon-sparkline>` — 24-column SVG comfort/AWS bar chart
 * (SPEC §6.3). Bar fill maps the Sereno comfort tier, bar height the
 * apparent wind within the window.
 *
 * Granular updates: the SVG skeleton is built once in
 * `connectedCallback`; data updates touch only existing `<rect>`
 * attributes and `<title>` text.
 *
 * DOM-free import safe: the element registers only in the browser.
 *
 * @file components/horizon-sparkline.js
 */

import { sparklineColumns } from "./models.mjs";

const NS = "http://www.w3.org/2000/svg";

/**
 * The custom element (browser only).
 */
class HorizonSparkline extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        svg { width: 100%; height: 96px; display: block; }
        rect { shape-rendering: crispEdges; }
      </style>
      <svg viewBox="0 0 240 96" preserveAspectRatio="none" role="img"
        aria-label="24 hour comfort and wind outlook"></svg>
    `;
    this._svg = this.shadowRoot.querySelector("svg");
    this._rects = [];
    this.setColumns(this._columns ?? []);
  }

  /**
   * Re-renders the bars from comfort blocks.
   *
   * @param {Array<{hoursFromNow: number, comfortLevel: string, awsKnots: number}>|
   *   null} hourlyComfort
   */
  setColumns(hourlyComfort) {
    this._columns = hourlyComfort;
    if (!this._svg) {
      return; // Not yet connected: cached, rendered on connect
    }
    const columns = sparklineColumns(hourlyComfort);
    const width = 240 / 24;
    while (this._rects.length < columns.length) {
      const rect = document.createElementNS(NS, "rect");
      const title = document.createElementNS(NS, "title");
      rect.appendChild(title);
      rect.setAttribute("y", "0");
      rect.setAttribute("width", String(width - 1));
      this._svg.appendChild(rect);
      this._rects.push(rect);
    }
    columns.forEach((col, i) => {
      const rect = this._rects[i];
      rect.setAttribute("x", String(i * width));
      rect.setAttribute("height", String((col.heightPct / 100) * 96));
      rect.setAttribute("fill", col.color);
      rect.querySelector("title").textContent = col.title;
    });
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("horizon-sparkline", HorizonSparkline);
}

export { HorizonSparkline };
