/**
 * `<strategic-outlook>` — Screen 2: whole-passage summary (SPEC
 * §6.3). ETA percentile table, the unified passage timeline (work
 * doc #18) and the raw METAREA bulletin console.
 *
 * @file components/strategic-outlook.js
 */

import { etaTable, fmtShip, mergeTimeline, splitSevere } from "./models.mjs";
import "./passage-timeline.js";
import { SK_BASE_CSS } from "./sk-base-css.js";

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
        ${SK_BASE_CSS}
        :host { display: block; }
        .sk-card { margin-bottom: 12px; }
        pre.console { margin: 0; }
        strong.sev {
          color: var(--color-orange);
          text-transform: uppercase;
        }
        .departure-line {
          font-family: var(--font-data, ui-monospace, monospace);
          font-size: 0.8rem; font-weight: 700;
          letter-spacing: 0.08em; text-transform: uppercase;
          color: var(--color-grey);
          margin: 0 0 8px;
        }
      </style>
      <section class="sk-card theme-teal">
        <h2>ETA &amp; Motor Plan</h2>
        <div class="departure-line" id="departure-line" hidden></div>
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
        <departure-control id="departure-control"></departure-control>
      </section>
      <section class="sk-card theme-teal">
        <h2>Passage Timeline</h2>
        <passage-timeline id="timeline"></passage-timeline>
      </section>
      <section class="sk-card theme-teal">
        <h2>METAREA Bulletin</h2>
        <pre class="console" id="bulletin">No bulletin cached</pre>
      </section>
      <section class="sk-card theme-red" id="blocks-card" hidden>
        <h2>Warnings On Your Waters</h2>
        <div class="console" id="blocks"></div>
      </section>
      <synoptic-chart hidden></synoptic-chart>
    `;
    this._etaBody = this.shadowRoot.getElementById("eta-body");
    this._motorEl = this.shadowRoot.getElementById("motor");
    this._fuelEl = this.shadowRoot.getElementById("fuel");
    this._departureLine = this.shadowRoot.getElementById("departure-line");
    this._departureControl =
      this.shadowRoot.getElementById("departure-control");
    this._departureControl?.addEventListener("departurechange", (event) =>
      this.onDepartureChange?.(event.detail),
    );
    this._timeline = this.shadowRoot.getElementById("timeline");
    this._bulletinEl = this.shadowRoot.getElementById("bulletin");
    if (this._exceptions) {
      this.setExceptions(this._exceptions);
    }
    if (this._payload !== undefined) {
      this.setPayload(this._payload);
    }
    if (this._bulletin !== undefined) {
      this.setBulletin(this._bulletin);
    }
  }

  /**
   * Briefing payload (work docs #3, #17): carries the space events
   * and zone transitions the timeline merges in alongside the
   * exception view's own sources.
   *
   * @param {object|null} payload
   */
  setPayload(payload) {
    this._payload = payload;
    if (!this._timeline) {
      return; // Not yet connected
    }
    this._renderTimeline();
  }

  /**
   * The unified timeline (work doc #18): the whole passage — sail
   * work, maneuvers, convective risk, sea state, zones, sky and
   * hazards in one chronological list.
   */
  _renderTimeline() {
    if (!this._timeline) {
      return;
    }
    this._timeline.setTimeline(
      mergeTimeline(this._exceptions ?? null, this._payload ?? null),
    );
  }

  /**
   * Departure state (work doc #15): the ETA header states the
   * assumption, and the shared control renders the mode.
   *
   * @param {{mode: string, customTime: string|null, departure: object|
   *   null}} state
   */
  setDeparture(state) {
    this._departureState = state;
    if (this._departureControl) {
      this._departureControl.render(state);
    }
    const departure = state?.departure ?? null;
    if (this._departureLine) {
      if (departure?.time != null && departure.reason !== "underway") {
        const reasonText =
          departure.reason === "next_dawn"
            ? "Assumed departure first light"
            : departure.reason === "daylight_prep"
              ? "Assumed departure after prep"
              : "Assumed departure";
        this._departureLine.textContent = `${reasonText} ${fmtShip(departure.time)}`;
        this._departureLine.hidden = false;
      } else if (departure?.reason === "underway") {
        this._departureLine.textContent = "Underway — from now";
        this._departureLine.hidden = false;
      } else {
        this._departureLine.hidden = true;
      }
    }
  }

  /**
   * The root owns the departure state; the control reports changes.
   */
  onDepartureChange = null;

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
    const table = etaTable(exceptions, this._payload ?? null);
    this._etaBody.innerHTML = "";
    for (const row of table.rows) {
      const tr = document.createElement("tr");
      const tdLabel = document.createElement("td");
      tdLabel.className = "muted";
      tdLabel.textContent = row.label;
      const tdStamp = document.createElement("td");
      tdStamp.textContent = row.night
        ? `${row.stamp || "—"} ${row.moon || "☾"}`
        : row.stamp || "—";
      if (row.night) {
        tdStamp.title = "Night arrival at destination";
      }
      tr.append(tdLabel, tdStamp);
      this._etaBody.appendChild(tr);
    }
    this._motorEl.textContent = table.motorHours || "—";
    this._fuelEl.textContent = table.fuel || "—";

    this._renderTimeline();
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
