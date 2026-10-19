/**
 * `<departure-control>` — the departure chip shared by the tactical
 * and strategic views (work doc #15, SPEC §6.3 element conventions).
 *
 * Displays the effective departure instead of silently shifting
 * numbers: "First light 05:48 (+7 h)" or "Underway — from now". The
 * timing itself is decided in two places: the daylight anchor (auto,
 * work doc #15) and the route switcher's departure-day variants
 * (work doc #34) — the old mode pulldown went away once the variants
 * made the manual presets redundant.
 *
 * DOM-free import safe: the element registers only in the browser.
 *
 * @file components/departure-control.js
 */

import { fmtShip } from "./models.mjs";

/**
 * Reason → chip text, the part the departure anchor explains.
 *
 * @param {string|null} reason
 * @returns {string}
 */
function reasonText(reason) {
  switch (reason) {
    case "underway":
      return "Underway — from now";
    case "next_dawn":
      return "First light";
    case "daylight_prep":
      return "After prep";
    case "no_dawn":
      return "No dawn in sight — from now";
    case "manual":
      return "Manual";
    default:
      return "";
  }
}

/**
 * The custom element (browser only).
 */
class DepartureControl extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    if (!this._rendered) {
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; }
          .chip {
            font-family: var(--font-data, ui-monospace, monospace);
            font-size: 0.8rem; font-weight: 700;
            letter-spacing: 0.08em; text-transform: uppercase;
            color: var(--color-grey);
            margin: 8px 0 0;
          }
        </style>
        <span class="chip" id="chip"></span>
      `;
      this._chip = this.shadowRoot.getElementById("chip");
      this._rendered = true;
    }
    this.render(this._state ?? {});
  }

  /**
   * Renders the current departure state.
   *
   * @param {object} state
   * @param {{time: string|Date, reason: string, assumed: boolean}|
   *   null} state.departure - Effective departure
   */
  render(state) {
    this._state = state ?? {};
    if (!this._chip) {
      return; // Not yet connected: rendered on connect
    }
    const departure = this._state.departure;
    if (!departure?.time) {
      this._chip.textContent = "";
      return;
    }
    const stamp = fmtShip(departure.time);
    const reason = reasonText(departure.reason);
    this._chip.textContent = reason
      ? `${reason} ${stamp}`
      : `Departure ${stamp}`;
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("departure-control", DepartureControl);
}

export { DepartureControl };
