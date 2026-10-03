/**
 * `<departure-control>` — the departure-time control shared by the
 * tactical and strategic views (work doc #15, SPEC §6.3 element
 * conventions).
 *
 * Auto mode anchors to daylight (next civil dawn at night, prep delay
 * during the day, next dawn when the sun would set within the prep
 * window); the manual presets — Now, First light, +1 h, +2 h, and a
 * custom instant — are the crew's word and override auto until it is
 * put back to Auto. The root component owns the state; this element
 * renders it and reports changes, so both views always agree.
 *
 * The chip line states the assumption instead of silently shifting
 * numbers: "First light 05:48 (+7 h)" or "Underway — from now".
 *
 * DOM-free import safe: the element registers only in the browser.
 *
 * @file components/departure-control.js
 */

import { fmtShip } from "./models.mjs";

const MODES = [
  ["auto", "Auto (daylight)"],
  ["now", "Now"],
  ["dawn", "First light"],
  ["+1h", "In 1 hour"],
  ["+2h", "In 2 hours"],
  ["custom", "Custom…"],
];

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
          .row {
            display: flex; flex-wrap: wrap; gap: 8px;
            align-items: center; margin: 8px 0 0;
          }
          .chip {
            font-family: var(--font-data, ui-monospace, monospace);
            font-size: 0.8rem; font-weight: 700;
            letter-spacing: 0.08em; text-transform: uppercase;
            color: var(--color-grey);
          }
          select, input {
            min-height: 36px; padding: 4px 8px;
          }
          input[hidden] { display: none; }
        </style>
        <div class="row">
          <span class="chip" id="chip"></span>
          <select id="mode" aria-label="Departure time"></select>
          <input type="datetime-local" id="custom" hidden
            aria-label="Custom departure time"></input>
        </div>
      `;
      this._chip = this.shadowRoot.getElementById("chip");
      this._select = this.shadowRoot.getElementById("mode");
      this._custom = this.shadowRoot.getElementById("custom");
      for (const [value, label] of MODES) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        this._select.appendChild(option);
      }
      this._select.addEventListener("change", () => {
        const mode = this._select.value;
        this._custom.hidden = mode !== "custom";
        if (mode !== "custom") {
          this._customTime = null;
        }
        this.emit({ mode, customTime: this._customTime });
      });
      this._custom.addEventListener("change", () => {
        if (this._custom.value) {
          // datetime-local is naive local time; convert to epoch
          this._customTime = new Date(this._custom.value).toISOString();
          this.emit({ mode: "custom", customTime: this._customTime });
        }
      });
      this._rendered = true;
    }
    this.render(this._state ?? {});
  }

  /**
   * Renders the current departure state.
   *
   * @param {object} state
   * @param {string} state.mode - Selected mode
   * @param {{time: string|Date, reason: string, assumed: boolean}|
   *   null} state.departure - Effective departure
   * @param {string|null} state.customTime - Custom instant (ISO)
   */
  render(state) {
    this._state = state ?? {};
    if (!this._select) {
      return; // Not yet connected: rendered on connect
    }
    if (this._select.value !== this._state.mode) {
      this._select.value = this._state.mode ?? "auto";
      this._custom.hidden = this._select.value !== "custom";
    }
    if (this._state.customTime && this._state.mode === "custom") {
      const custom = this._state.customTime;
      if (this._custom.value !== custom) {
        // datetime-local wants local wall time; offset from ISO
        const date = new Date(custom);
        const pad = (n) => String(n).padStart(2, "0");
        this._custom.value =
          `${date.getFullYear()}-${pad(date.getMonth() + 1)}-` +
          `${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
      }
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

  emit(detail) {
    this.dispatchEvent(
      new CustomEvent("departurechange", { detail, bubbles: true }),
    );
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("departure-control", DepartureControl);
}

export { DepartureControl };
