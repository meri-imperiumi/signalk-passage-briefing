/**
 * The synoptic surface-analysis figure (work doc #11): loads the
 * cached chart for the vessel's position zone from the plugin API
 * and shows it inverted under the night palette. Stays hidden until
 * the image actually loads, so zones without a chart render nothing
 * — same graceful handling as the bulletin console. Shared by the
 * strategic screen and the conditions-here view.
 *
 * @file components/synoptic-chart.js
 */

const PLUGIN_API = "/plugins/signalk-passage-briefing/api";

class SynopticChart extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        :host([hidden]) { display: none; }
        figure { margin: 0; }
        img { width: 100%; height: auto; display: block; }
        :host([data-mode="night"]) img {
          filter: invert(0.93) hue-rotate(180deg);
        }
      </style>
      <figure>
        <img id="img" alt="Synoptic surface analysis for the current zone">
      </figure>
    `;
    const img = this.shadowRoot.getElementById("img");
    img.addEventListener("load", () => {
      this.hidden = false;
    });
    img.addEventListener("error", () => {
      this.hidden = true;
    });
    img.src = `${PLUGIN_API}/synoptic`;
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("synoptic-chart", SynopticChart);
}

export { SynopticChart };
