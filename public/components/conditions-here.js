/**
 * `<conditions-here>` — empty-state view (work doc #7): conditions at
 * the vessel when no route is active or briefed. Single view, no
 * tactical/strategic tabs: a conditions-now summary, the 24 h comfort
 * sparkline at the anchored position, and geographically filtered
 * NAVAREA/NAVTEX warnings. Exception-based: absent blocks (warnings,
 * space events) simply don't render.
 *
 * Data arrives via `setHere()` from the root component; updates touch
 * cached DOM nodes only.
 *
 * @file components/conditions-here.js
 */

import { fmtKn, hereHourly, hereNow, splitSevere } from "./models.mjs";
import { SK_BASE_CSS } from "./sk-base-css.js";

/**
 * Formats a position as `21°06.0'S 175°12.0'W`.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {string}
 */
function fmtPosition(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return "—";
  }
  const fmt = (value, pos, neg) => {
    const hemi = value >= 0 ? pos : neg;
    const abs = Math.abs(value);
    const deg = Math.floor(abs);
    const min = ((abs - deg) * 60).toFixed(1).padStart(4, "0");
    return `${deg}°${min}'${hemi}`;
  };
  return `${fmt(lat, "N", "S")} ${fmt(lon, "E", "W")}`;
}

/**
 * Compass label for a direction in degrees.
 *
 * @param {number|null} deg
 * @returns {string}
 */
function compass(deg) {
  if (!Number.isFinite(deg)) {
    return "";
  }
  const points = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
  ];
  return points[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/**
 * The custom element (browser only).
 */
class ConditionsHere extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    this.shadowRoot.innerHTML = `
      <style>
        ${SK_BASE_CSS}
        :host { display: block; }
        .now { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
        .tier {
          font-family: var(--font-data, ui-monospace, monospace);
          font-size: 1rem; font-weight: 700;
          letter-spacing: 0.1em; text-transform: uppercase;
        }
        dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 8px 0 0; }
        dt { color: var(--color-grey); }
        dd { margin: 0; font-family: var(--font-data, ui-monospace, monospace); }
        .console { margin: 0; white-space: pre-wrap; font-family: var(--font-data, ui-monospace, monospace); font-size: 0.85rem; }
        .severe { color: var(--color-red); font-weight: 700; }
        .note { color: var(--color-grey); font-size: 0.85rem; margin: 4px 0 0; }
      </style>
      <section class="sk-card theme-teal">
        <h2>Conditions Here</h2>
        <p class="note">No active route — conditions at the vessel</p>
        <div class="now">
          <span class="value" id="pos">—</span>
          <span class="tier" id="tier">no data</span>
          <comfort-info id="cinfo"></comfort-info>
        </div>
        <dl>
          <dt>Wind</dt><dd id="wind">—</dd>
          <dt>Sea</dt><dd id="sea">—</dd>
          <dt>Current</dt><dd id="current">—</dd>
          <dt>Pressure</dt><dd id="pressure">—</dd>
        </dl>
        <horizon-sparkline id="spark"></horizon-sparkline>
        <section class="sk-card theme-red" id="warnings-card" hidden>
          <h3>Warnings for these waters</h3>
          <div class="console" id="warnings"></div>
        </section>
        <synoptic-chart hidden></synoptic-chart>
        <section class="sk-card" id="events-card" hidden>
          <h3>Celestial &amp; space events</h3>
          <div id="events"></div>
        </section>
      </section>
    `;
    this._posEl = this.shadowRoot.getElementById("pos");
    this._tierEl = this.shadowRoot.getElementById("tier");
    this._cinfo = this.shadowRoot.getElementById("cinfo");
    this._windEl = this.shadowRoot.getElementById("wind");
    this._seaEl = this.shadowRoot.getElementById("sea");
    this._currentEl = this.shadowRoot.getElementById("current");
    this._pressureEl = this.shadowRoot.getElementById("pressure");
    this._spark = this.shadowRoot.getElementById("spark");
    this._warningsCard = this.shadowRoot.getElementById("warnings-card");
    this._warningsEl = this.shadowRoot.getElementById("warnings");
    this._eventsCard = this.shadowRoot.getElementById("events-card");
    this._eventsEl = this.shadowRoot.getElementById("events");
    if (this._payload) {
      this.setHere(this._payload, this._config);
    }
  }

  /**
   * Renders from the here payload and simulation config.
   *
   * @param {object|null} payload - Here payload (single waypoint,
   *   optional `metareaBulletin`, optional `spaceEvents`)
   * @param {object} [config] - Simulation config subset
   */
  setHere(payload, config = {}) {
    this._payload = payload;
    this._config = config;
    if (!this._posEl) {
      return; // Not yet connected
    }
    const waypoint = payload?.waypoints?.[0];
    this._posEl.textContent = waypoint
      ? fmtPosition(waypoint.lat, waypoint.lon)
      : "—";

    const rows = hereHourly(payload, config);
    const now = hereNow(payload, rows);
    this._tierEl.textContent = now.comfortLevel ?? "no data";
    this._tierEl.style.color = now.color;
    this._cinfo?.setAttribute("tier", now.comfortLevel ?? "");

    const wind = [
      now.twsKnots != null
        ? `${fmtKn(now.twsKnots)} ${compass(now.twdDeg)}`
        : null,
      now.gustKnots != null ? `gust ${fmtKn(now.gustKnots)}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    this._windEl.textContent = wind || "—";

    this._seaEl.textContent =
      now.hsMeters != null
        ? `${now.hsMeters.toFixed(1)} m @ ${now.tpSeconds?.toFixed(0) ?? "?"}s`
        : "—";

    this._currentEl.textContent =
      now.currentDriftKnots != null
        ? `${fmtKn(now.currentDriftKnots)} ${compass(now.currentSetDeg)}`
        : "—";

    this._pressureEl.textContent =
      now.mslpHpa != null
        ? `${now.mslpHpa.toFixed(0)} hPa${
            now.mslpTrend != null
              ? ` (${now.mslpTrend >= 0 ? "+" : ""}${now.mslpTrend.toFixed(1)}/3h)`
              : ""
          }`
        : "—";

    this._spark.setColumns(rows);

    // Warnings: filtered NAVAREA/NAVTEX blocks for these waters
    const blocks = payload?.metareaBulletin?.blocks ?? [];
    this._warningsCard.hidden = blocks.length === 0;
    this._warningsEl.innerHTML = "";
    for (const block of blocks) {
      const pre = document.createElement("pre");
      pre.className = "console";
      for (const token of splitSevere(block.text)) {
        if (token.severe) {
          const span = document.createElement("span");
          span.className = "severe";
          span.textContent = token.text;
          pre.appendChild(span);
        } else {
          pre.appendChild(document.createTextNode(token.text));
        }
      }
      this._warningsEl.appendChild(pre);
    }

    // Celestial/space events (work doc #3): render only when present
    const events = payload?.spaceEvents ?? [];
    this._eventsCard.hidden = events.length === 0;
    this._eventsEl.innerHTML = "";
    for (const event of events) {
      const el = document.createElement("div");
      el.textContent =
        `${event.stamp ?? event.timestamp ?? ""} ${event.description ?? event.kind ?? ""}`.trim();
      this._eventsEl.appendChild(el);
    }
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("conditions-here", ConditionsHere);
}

export { ConditionsHere, compass, fmtPosition };
