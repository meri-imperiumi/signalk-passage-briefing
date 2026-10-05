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

import {
  fmtKn,
  fmtUtc,
  hereEnergySummary,
  hereHourly,
  hereNow,
  splitSevere,
} from "./models.mjs";
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
        .card-head {
          display: flex; align-items: center; justify-content: space-between;
          gap: 8px;
        }
        .card-head h2 { margin: 0; }
        .refresh {
          min-height: 36px; padding: 6px 12px; flex: none;
        }
        .refresh:disabled { opacity: 0.5; }
        .note { color: var(--color-grey); font-size: 0.85rem; margin: 4px 0 0; }
        .noteworthy {
          color: var(--color-orange);
          font-family: var(--font-data, ui-monospace, monospace);
          font-weight: 700;
          letter-spacing: 0.08em;
          margin-right: 8px;
        }
      </style>
      <section class="sk-card theme-teal">
        <div class="card-head">
          <h2>Conditions Here</h2>
          <button id="refresh" class="refresh">Update now</button>
        </div>
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
          <dt>Energy 24h</dt><dd id="energy">—</dd>
        </dl>
        <horizon-sparkline id="spark"></horizon-sparkline>
      </section>
      <section class="sk-card theme-red" id="warnings-card" hidden>
        <h3>Warnings for these waters</h3>
        <div class="console" id="warnings"></div>
      </section>
      <synoptic-chart hidden></synoptic-chart>
      <section class="sk-card" id="events-card" hidden>
        <h3>Celestial &amp; space events</h3>
        <div id="events"></div>
      </section>
      <section class="sk-card" id="hazards-card" hidden>
        <h3>Hazard events</h3>
        <div id="hazards"></div>
      </section>
      <section class="sk-card" id="cap-card" hidden>
        <h3>Official Alerts</h3>
        <div id="cap-alerts"></div>
      </section>
      <section class="sk-card" id="zones-card" hidden>
        <h3>Waters you are in</h3>
        <div id="zones"></div>
      </section>
    `;
    this._posEl = this.shadowRoot.getElementById("pos");
    this._tierEl = this.shadowRoot.getElementById("tier");
    this._cinfo = this.shadowRoot.getElementById("cinfo");
    this._windEl = this.shadowRoot.getElementById("wind");
    this._seaEl = this.shadowRoot.getElementById("sea");
    this._currentEl = this.shadowRoot.getElementById("current");
    this._pressureEl = this.shadowRoot.getElementById("pressure");
    this._energyEl = this.shadowRoot.getElementById("energy");
    this._spark = this.shadowRoot.getElementById("spark");
    this._warningsCard = this.shadowRoot.getElementById("warnings-card");
    this._warningsEl = this.shadowRoot.getElementById("warnings");
    this._eventsCard = this.shadowRoot.getElementById("events-card");
    this._eventsEl = this.shadowRoot.getElementById("events");
    this._hazardsCard = this.shadowRoot.getElementById("hazards-card");
    this._hazardsEl = this.shadowRoot.getElementById("hazards");
    this._capCard = this.shadowRoot.getElementById("cap-card");
    this._capEl = this.shadowRoot.getElementById("cap-alerts");
    this._zonesCard = this.shadowRoot.getElementById("zones-card");
    this._zonesEl = this.shadowRoot.getElementById("zones");
    this._refreshEl = this.shadowRoot.getElementById("refresh");
    this._refreshEl.disabled = !this._online;
    this._refreshEl.addEventListener("click", () => this.onRefresh?.());
    if (this._payload) {
      this.setHere(this._payload, this._config);
    }
  }

  /**
   * Online state: the fetch button only fires while the link is up
   * (the server refuses offline refreshes).
   *
   * @param {boolean} online
   */
  setOnline(online) {
    this._online = online === true;
    if (this._refreshEl) {
      this._refreshEl.disabled = !this._online;
    }
  }

  /**
   * Refresh callback (set by the root component): posts the here
   * refresh and reloads — the conditions view otherwise has no way to
   * recompile, and a cached payload predating a new payload field
   * would render stale forever.
   */
  onRefresh = null;

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
    // The tier is computed server-side with this same model at
    // compile time and rides the payload — identical to what the
    // plotter tile publishes
    const tier = payload.comfortTier ?? now.comfortLevel ?? null;
    this._tierEl.textContent = tier ?? "no data";
    this._tierEl.style.color = now.color;
    this._cinfo?.setAttribute("tier", tier ?? "");

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

    // Energy strip (work doc #10): the predictor's forecast summed
    // over the forward 24 h at SOG 0 — generation and net balance.
    // A payload with no energy field at all predates the feature (or
    // the predictor's delta had not arrived at compile time): say so
    // instead of the generic dash, so the crew knows to refresh
    const energy = hereEnergySummary(payload);
    this._energyEl.textContent =
      energy.netSolar24h != null
        ? `+${energy.netSolar24h.toFixed(1)} kWh solar, net ${
            energy.netBalance24h >= 0 ? "+" : "−"
          }${Math.abs(energy.netBalance24h).toFixed(1)} kWh`
        : payload?.energyHourly
          ? "no forward hours in forecast"
          : "no energy forecast";

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

    // GDACS hazard events (work doc #22): earthquakes, cyclones,
    // floods near the vessel — critical while stationary too, so the
    // here view carries them alongside the passage timeline
    const hazards = payload?.hazardEvents ?? [];
    this._hazardsCard.hidden = hazards.length === 0;
    this._hazardsEl.innerHTML = "";
    for (const hazard of hazards) {
      const el = document.createElement("div");
      const level = String(hazard.alertLevel ?? "").toLowerCase();
      if (level === "red") {
        el.className = "severe";
      }
      const where =
        hazard.distanceNm != null
          ? `${hazard.distanceNm} nm @ ${hazard.bearingDeg ?? "?"}°`
          : null;
      el.textContent = [
        level === "red" ? "RED" : level === "orange" ? "ORANGE" : null,
        hazard.title ?? hazard.type ?? "Hazard event",
        where,
      ]
        .filter(Boolean)
        .join(" — ");
      this._hazardsEl.appendChild(el);
    }

    // CAP official alerts (work doc #24): authoritative structured
    // warnings near the vessel — critical while stationary too, kept
    // visually separate from the GDACS situational events above
    const capAlerts = payload?.capAlerts ?? [];
    this._capCard.hidden = !Array.isArray(payload?.capAlerts);
    this._capEl.innerHTML = "";
    if (capAlerts.length === 0) {
      const none = document.createElement("div");
      none.className = "none";
      none.textContent = "No official alerts in effect for these waters";
      this._capEl.appendChild(none);
      return;
    }
    for (const alert of capAlerts) {
      const el = document.createElement("div");
      const severity = document.createElement("span");
      severity.className =
        alert.severity === "extreme" ? "severe" : "noteworthy";
      severity.textContent = (alert.severity ?? "alert").toUpperCase();
      const body = document.createElement("span");
      body.textContent = [
        alert.headline || alert.event || "Official alert",
        alert.expires ? `expires ${fmtUtc(alert.expires)}` : null,
      ]
        .filter(Boolean)
        .join(" — ");
      el.append(severity, body);
      this._capEl.appendChild(el);
      if (alert.instruction) {
        const instruction = document.createElement("div");
        instruction.className = "note";
        instruction.textContent = alert.instruction;
        this._capEl.appendChild(instruction);
      }
    }

    // Waters the vessel sits in (work doc #17): here mode reports the
    // current zones instead of transitions; the Marine Regions
    // attribution renders app-wide in the root's footer
    const zones = payload?.zonesHere ?? [];
    this._zonesCard.hidden = zones.length === 0;
    this._zonesEl.innerHTML = "";
    if (zones.length > 0) {
      const el = document.createElement("div");
      el.textContent = zones.map((z) => z.name).join(", ");
      this._zonesEl.appendChild(el);
    }
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("conditions-here", ConditionsHere);
}

export { ConditionsHere, compass, fmtPosition };
