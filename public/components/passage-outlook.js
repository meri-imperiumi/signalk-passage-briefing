/**
 * `<passage-outlook>` — app root (SPEC §6.3).
 *
 * Component shell: owns the plugin REST calls (status, routes,
 * config, matrix, polar, briefing), the Signal K stream (mode +
 * connectivity), the hazard notes, and the simulation web worker.
 * Renders `<tactical-dashboard>` or `<strategic-outlook>` per the
 * `#/tactical` / `#/strategic` hash route.
 *
 * @file components/passage-outlook.js
 */

import { createStream, fetchJson, fetchNotes } from "./sk-api.js";

const PLUGIN_API = "api";

/**
 * The custom element (browser only).
 */
class PassageOutlook extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        header {
          display: flex; flex-wrap: wrap; gap: 8px;
          align-items: center; margin-bottom: 12px;
        }
        h1 { flex: 1; margin: 0; }
        .pill {
          font-family: var(--font-data, ui-monospace, monospace);
          font-size: 0.75rem; font-weight: 700;
          letter-spacing: 0.1em; text-transform: uppercase;
          border: 1px solid var(--color-grey);
          color: var(--color-grey);
          padding: 6px 10px;
        }
        .pill.online { border-color: var(--color-green); color: var(--color-green); }
        .stale {
          border: 1px solid var(--color-orange);
          color: var(--color-orange);
          font-family: var(--font-data, ui-monospace, monospace);
          padding: 8px 12px; margin-bottom: 12px;
          display: flex; justify-content: space-between; gap: 8px;
          align-items: center; flex-wrap: wrap;
        }
        .stale button { min-height: 40px; padding: 8px 12px; }
      </style>
      <header>
        <h1>Passage Briefing</h1>
        <select id="route" aria-label="Route" style="max-width: 16rem"></select>
        <span class="pill" id="online">OFFLINE</span>
      </header>
      <div class="tab-bar" role="tablist" id="tab-bar">
        <button id="tab-tactical" role="tab" aria-selected="true">Tactical</button>
        <button id="tab-strategic" role="tab" aria-selected="false">Strategic</button>
      </div>
      <main id="view"></main>
    `;

    this._routeSelect = this.shadowRoot.getElementById("route");
    this._onlinePill = this.shadowRoot.getElementById("online");
    this._tabBar = this.shadowRoot.getElementById("tab-bar");
    this._tabTactical = this.shadowRoot.getElementById("tab-tactical");
    this._tabStrategic = this.shadowRoot.getElementById("tab-strategic");
    this._view = this.shadowRoot.getElementById("view");

    this._tabTactical.addEventListener("click", () => {
      location.hash = "#/tactical";
    });
    this._tabStrategic.addEventListener("click", () => {
      location.hash = "#/strategic";
    });
    this._routeSelect.addEventListener("change", () => {
      this.loadBriefing(this._routeSelect.value);
    });
    window.addEventListener("hashchange", () => this.renderRoute());

    this._worker = null;
    this._briefing = null;
    this._exceptions = null;

    this.renderRoute();
    this.connectStream();
    this.bootstrap();
  }

  disconnectedCallback() {
    this._stream?.close();
    this._worker?.terminate();
  }

  /** Signal K stream: environment mode + connectivity pill. */
  connectStream() {
    this._stream = createStream({
      onMode: (mode) => {
        document.documentElement.dataset.mode =
          mode === "day" ? "day" : "night";
      },
      onConnection: (connected) => {
        this._onlinePill.classList.toggle("online", connected);
        this._onlinePill.textContent = connected ? "ONLINE" : "OFFLINE";
      },
    });
  }

  /** Loads everything the simulation needs, then simulates. */
  async bootstrap() {
    try {
      const [status, routes, config, matrix, polar, notes] = await Promise.all([
        fetchJson(`${PLUGIN_API}/status`),
        fetchJson(`${PLUGIN_API}/routes`),
        fetchJson(`${PLUGIN_API}/config`).catch(() => ({})),
        fetchJson(`${PLUGIN_API}/matrix`).catch(() => null),
        fetchJson(`${PLUGIN_API}/polar`).catch(() => null),
        fetchNotes(),
      ]);
      this._status = status;
      this._config = config;
      this._matrix = matrix;
      this._polar = polar;
      this._notes = notes;

      this._onlinePill.classList.toggle("online", status.online === true);
      this._onlinePill.textContent = status.online ? "ONLINE" : "OFFLINE";

      const select = this._routeSelect;
      select.innerHTML = "";
      const routesList = routes ?? [];
      // The empty-state option always leads the picker (work doc #7)
      const hereOption = document.createElement("option");
      hereOption.value = "";
      hereOption.textContent = "Conditions here";
      select.appendChild(hereOption);
      for (const route of routesList) {
        const option = document.createElement("option");
        option.value = route.id;
        option.textContent = `${route.active ? "▶ " : ""}${route.name} (${route.distanceNm ?? "?"} nm)`;
        select.appendChild(option);
      }
      // Preselect the route being sailed; everything else is here mode
      const preferred = routesList.find(
        (r) => r.active && r.id === status.activeRouteId,
      );
      if (preferred) {
        select.value = preferred.id;
        this.loadBriefing(preferred.id);
      } else {
        select.value = "";
        this.loadBriefing("");
      }
    } catch (error) {
      this.showError(`Server unreachable: ${error.message}`);
    }
  }

  /**
   * Fetches the briefing for a route, or conditions-here when the
   * route id is empty (work doc #7): the served mode drives the
   * view. When nothing is cached offers a refresh (online only).
   *
   * @param {string} routeId - Route resource id, or "" for here mode
   */
  async loadBriefing(routeId) {
    const query = routeId ? `?route=${encodeURIComponent(routeId)}` : "";
    try {
      this._briefing = await fetchJson(`${PLUGIN_API}/briefing${query}`);
      this.renderStale(false);
      if (this._briefing.mode === "here") {
        this.renderHere();
      } else {
        this.simulate();
      }
    } catch (error) {
      if (String(error.message).startsWith("404")) {
        this._briefing = null;
        this.renderStale(true);
      } else {
        this.showError(`Briefing unavailable: ${error.message}`);
      }
    }
  }

  /** Refreshes the selected route's briefing while online. */
  async refreshBriefing() {
    const routeId = this._routeSelect.value;
    const query = routeId ? `?route=${encodeURIComponent(routeId)}` : "";
    try {
      await fetchJson(`${PLUGIN_API}/briefing/refresh${query}`, 120000);
      await this.loadBriefing(routeId);
    } catch (error) {
      this.showError(`Refresh failed: ${error.message}`);
    }
  }

  /**
   * "No cached briefing yet" strip with the refresh affordance.
   *
   * @param {boolean} show
   */
  renderStale(show) {
    this.shadowRoot.getElementById("stale")?.remove();
    if (!show) {
      return;
    }
    const strip = document.createElement("div");
    strip.className = "stale";
    strip.id = "stale";
    const text = document.createElement("span");
    text.textContent = "No cached briefing for this route";
    const button = document.createElement("button");
    button.textContent = "Fetch now";
    button.disabled = this._status?.online !== true;
    button.addEventListener("click", () => this.refreshBriefing());
    strip.append(text, button);
    this._view.before(strip);
  }

  /** Sends the cached payload to the worker for simulation. */
  simulate() {
    const payload = this._briefing?.payload;
    if (!payload) {
      return;
    }
    this._worker?.terminate();
    this._worker = new Worker(new URL("../worker.js", import.meta.url), {
      type: "module",
    });
    this._worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === "result") {
        this._exceptions = message.exceptions;
        this.renderData();
      } else if (message.type === "error") {
        this.showError(`Simulation failed: ${message.error}`);
      }
    };
    this._worker.postMessage({
      type: "simulate",
      params: {
        payload,
        config: this._config ?? {},
        matrix: this._matrix,
        polar: this._polar?.table ?? null,
        performanceFactor: this._polar?.performanceFactor,
        notes: this._notes ?? [],
        // The payload covers the fetch window forward; hours are read
        // from its own timestamps
        startTime: payload.metadata?.fetchedAt ?? new Date().toISOString(),
      },
    });
  }

  /** Routes to the current hash tab and paints cached data. */
  renderRoute() {
    if (this._briefing?.mode === "here") {
      this.renderHere();
      return;
    }
    this._tabBar.hidden = false;
    const strategic = location.hash === "#/strategic";
    this._tabTactical.setAttribute("aria-selected", String(!strategic));
    this._tabStrategic.setAttribute("aria-selected", String(strategic));
    this._view.innerHTML = strategic
      ? "<strategic-outlook></strategic-outlook>"
      : "<tactical-dashboard></tactical-dashboard>";
    if (this._exceptions) {
      this.renderData();
    }
  }

  /**
   * Here mode (work doc #7): single view, no tabs — the empty state
   * reads as intentional. No passage simulation runs; the view
   * computes its rows client-side at SOG 0.
   */
  renderHere() {
    this._tabBar.hidden = true;
    this._view.innerHTML = "<conditions-here></conditions-here>";
    const here = this._view.querySelector("conditions-here");
    if (here && this._briefing?.payload) {
      here.setHere(this._briefing.payload, this._config ?? {});
    }
  }

  /** Pushes the latest exceptions into the active screen. */
  renderData() {
    if (!this._exceptions) {
      return;
    }
    const strategicView = location.hash === "#/strategic";
    const target = this._view.querySelector(
      strategicView ? "strategic-outlook" : "tactical-dashboard",
    );
    if (target) {
      target.setExceptions(this._exceptions);
      if (strategicView && this._briefing?.payload) {
        target.setBulletin(this._briefing.payload.metareaBulletin ?? null);
      }
      this.pushSpaceEvents(target);
    }
  }

  /**
   * Space events (work doc #3): aurora-class alerts to whichever
   * screen is active, comet items ride the strategic Sky Notes.
   *
   * @param {HTMLElement} target - Active screen element
   */
  pushSpaceEvents(target) {
    const events = this._briefing?.payload?.spaceEvents ?? [];
    if (typeof target.setSpaceEvents === "function") {
      target.setSpaceEvents(events);
    }
  }

  /**
   * Error strip replacing the view content.
   *
   * @param {string} message
   */
  showError(message) {
    this._view.innerHTML = "";
    const strip = document.createElement("div");
    strip.className = "stale";
    strip.textContent = message;
    this._view.appendChild(strip);
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("passage-outlook", PassageOutlook);
}

export { PassageOutlook };
