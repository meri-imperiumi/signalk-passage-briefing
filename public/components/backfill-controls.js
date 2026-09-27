/**
 * Logbook backfill controls: a card on the strategic screen that
 * triggers the plugin's POST /api/backfill from the browser session.
 * The route is auth-gated server-side, so it cannot be curl-ed from
 * the host without a login — the webapp's session is the interface.
 *
 * @file components/backfill-controls.js
 */

import { fetchJson } from "./sk-api.js";
import { SK_BASE_CSS } from "./sk-base-css.js";

const PLUGIN_API = "/plugins/signalk-passage-briefing/api";

class BackfillControls extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    this.shadowRoot.innerHTML = `
      <style>
        ${SK_BASE_CSS}
        :host { display: block; }
        details.sk-card { margin-bottom: 12px; }
        summary { cursor: pointer; font-weight: 700; }
        .body { margin-top: 8px; }
        .row {
          display: flex; gap: 8px; flex-wrap: wrap;
          align-items: center; margin-top: 8px;
        }
        input { font: inherit; }
        .note { color: var(--color-grey); font-size: 0.85rem; margin: 4px 0 0; }
        .out {
          font-family: var(--font-data, ui-monospace, monospace);
          font-size: 0.85rem; margin-top: 8px; white-space: pre-wrap;
        }
        .out.err { color: var(--color-red); }
      </style>
      <details class="sk-card">
        <summary>Logbook Backfill</summary>
        <div class="body">
          <p class="note">
            Learn sail preferences from signalk-logbook history into the
            day/night matrix (optional date range).
          </p>
          <div class="row">
            <label>From <input type="date" id="from"></label>
            <label>To <input type="date" id="to"></label>
            <button id="run">Backfill</button>
          </div>
          <div class="out" id="out"></div>
        </div>
      </details>
    `;
    this._run = this.shadowRoot.getElementById("run");
    this._out = this.shadowRoot.getElementById("out");
    this._run.addEventListener("click", () => this.backfill());
  }

  disconnectedCallback() {
    this._run?.replaceWith(this._run.cloneNode(true));
  }

  async backfill() {
    const from = this.shadowRoot.getElementById("from").value;
    const to = this.shadowRoot.getElementById("to").value;
    const query = new URLSearchParams();
    if (from) {
      query.set("from", from);
    }
    if (to) {
      query.set("to", to);
    }
    const qs = query.size > 0 ? `?${query}` : "";
    this._run.disabled = true;
    this._out.classList.remove("err");
    this._out.textContent = "Backfill running…";
    try {
      const summary = await fetchJson(`${PLUGIN_API}/backfill${qs}`, 600000, {
        method: "POST",
      });
      const skipped = summary.skippedCached + summary.skippedNoData;
      this._out.textContent =
        `Learned ${summary.learned} of ${summary.total} sail changes` +
        (skipped > 0 ? ` (skipped ${skipped})` : "") +
        `, ${summary.cells.length} matrix cells`;
    } catch (error) {
      this._out.classList.add("err");
      this._out.textContent = `Backfill failed: ${error.message}`;
    } finally {
      this._run.disabled = false;
    }
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("backfill-controls", BackfillControls);
}

export { BackfillControls };
