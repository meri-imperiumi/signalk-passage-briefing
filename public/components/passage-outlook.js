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

import {
  briefingAgeHours,
  effectiveDeparture,
  fmtHours,
  fmtShip,
  parseTimezoneOffset,
  setShipTime,
  shipTimeLabel,
  trimWaypointsToPosition,
} from "./models.mjs";

import {
  createStream,
  fetchJson,
  fetchNavigationState,
  fetchNotes,
  fetchShipTime,
} from "./sk-api.js";
import { SK_BASE_CSS } from "./sk-base-css.js";

/**
 * Plugin API base. SK v2 serves the webapp itself under
 * /@<scope>/<name>/, but registerWithRouter routes stay mounted at
 * /plugins/<name>/ (unscoped) — same as the energy-predictor
 * webapp's API_BASE on this server.
 */
const PLUGIN_API = "/plugins/signalk-passage-briefing/api";

/**
 * Briefings are compiled daily (SPEC §2.2): past a day old the
 * timeline's `+Xh` labels point at the past, so the cached compile
 * gets an explicit age banner (work doc #18 follow-up) — the data
 * still renders, better than nothing underway.
 */
const STALE_AFTER_HOURS = 24;

/**
 * Friendly text for fetch failures: the 8 s/120 s abort timeouts
 * surface with cryptic engine-specific messages ("Fetch is aborted",
 * "The operation was aborted") — say what actually happened instead.
 *
 * @param {Error} error
 * @param {string} fallback - Prefix for non-abort failures
 * @returns {string}
 */
function fetchErrorMessage(error, fallback) {
  if (error?.name === "AbortError" || /abort/i.test(error?.message ?? "")) {
    return "The server took too long to answer — it may be busy compiling a briefing. Try again.";
  }
  return `${fallback}: ${error.message}`;
}

/**
 * The custom element (browser only).
 */
class PassageOutlook extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    // Embed mode (work doc #8): compact chrome for a plotter dialog —
    // no app header, just the tactical/strategic switch and content
    this.embedded = new URLSearchParams(location.search).get("embed") === "1";
    this.shadowRoot.innerHTML = `
      <style>
        ${SK_BASE_CSS}
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
        .outdated {
          border: 1px solid var(--color-orange);
          color: var(--color-orange);
          font-family: var(--font-data, ui-monospace, monospace);
          padding: 8px 12px; margin-bottom: 12px;
          display: flex; justify-content: space-between; gap: 8px;
          align-items: center; flex-wrap: wrap;
        }
        .outdated button { min-height: 40px; padding: 8px 12px; }
        .loading {
          border: 1px solid var(--color-grey);
          color: var(--text-muted);
          font-family: var(--font-data, ui-monospace, monospace);
          letter-spacing: 0.1em; text-transform: uppercase;
          padding: 8px 12px; margin-bottom: 12px;
        }
        footer {
          margin-top: 12px;
          font-size: 0.75em;
          opacity: 0.7;
        }
      </style>
      <header>
        <h1>Passage Briefing</h1>
        <select id="route" aria-label="Route" style="max-width: 16rem"></select>
        <span class="pill" id="online">OFFLINE</span>
        <span class="pill" id="shiptime" hidden></span>
      </header>
      <div class="tab-bar" role="tablist" id="tab-bar">
        <button id="tab-tactical" role="tab" aria-selected="true">Tactical</button>
        <button id="tab-strategic" role="tab" aria-selected="false">Strategic</button>
      </div>
      <main id="view"></main>
      ${this.embedded ? "" : "<backfill-controls></backfill-controls>"}
      <footer id="disclaimer" hidden></footer>
    `;

    this._routeSelect = this.shadowRoot.getElementById("route");
    this._onlinePill = this.shadowRoot.getElementById("online");
    this._shiptimePill = this.shadowRoot.getElementById("shiptime");
    this._tabBar = this.shadowRoot.getElementById("tab-bar");
    this._tabTactical = this.shadowRoot.getElementById("tab-tactical");
    this._tabStrategic = this.shadowRoot.getElementById("tab-strategic");
    this._view = this.shadowRoot.getElementById("view");
    this._disclaimerEl = this.shadowRoot.getElementById("disclaimer");

    // Embed mode (work doc #8): compact chrome for a plotter dialog
    if (this.embedded) {
      this.shadowRoot.querySelector("header").hidden = true;
    }

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
    this._briefingKey = null;
    this._exceptions = null;
    // Departure anchoring (work doc #15): mode + custom instant are
    // the crew's choice, shared by both views; navigation state drives
    // the auto anchor; the re-check catches the dawn crossing without
    // flapping (re-simulates only when the anchor moves > 10 min)
    this._departureMode = "auto";
    this._customDepartureTime = null;
    this._navigationState = null;
    this._simulatedDepartureMs = null;
    this._departureTimer = setInterval(
      () => this.recheckDeparture(),
      10 * 60000,
    );
    // Live trim progress: the plan re-anchors when the boat advanced
    // this far along the compiled track since the last simulation
    // (work doc #28) — one re-anchor per leg, not per position update
    this._liveTrimAdvanceNm = 15;

    this.renderRoute();
    this.connectStream();
    this.bootstrap();
  }

  disconnectedCallback() {
    this._stream?.close();
    this._worker?.terminate();
    clearInterval(this._departureTimer);
  }

  /**
   * The departure state the views render and the simulation anchors
   * to (work doc #15): effective departure from the chosen mode, with
   * the start position from the route's first waypoint (the payload
   * is the route's). Here mode has no departure to anchor.
   *
   * @returns {{mode: string, customTime: string|null, departure:
   *   {time: Date, reason: string, assumed: boolean}|null}|null}
   */
  departureState() {
    const payload = this._briefing?.payload;
    const waypoint = payload?.waypoints?.[0];
    if (!waypoint) {
      return null;
    }
    const departure = effectiveDeparture({
      mode: this._departureMode,
      customTime: this._customDepartureTime,
      now: new Date(payload.metadata?.fetchedAt ?? Date.now()),
      lat: waypoint.lat,
      lon: waypoint.lon,
      underway:
        typeof this._navigationState === "string" &&
        !["moored", "anchored"].includes(this._navigationState),
      prepHours: this._config?.departure_prep_hours ?? 1.5,
      dawnAltitudeDeg: this._config?.departure_dawn_altitude_deg ?? -6,
    });
    return {
      mode: this._departureMode,
      customTime: this._customDepartureTime,
      departure,
    };
  }

  /**
   * Live re-anchor (work doc #28): when the boat advanced far enough
   * along the compiled track since the last simulation, the simulated
   * plan re-trims to the boat — sailed waypoints drop out, the boat
   * position joins the track. Hysteresis: one re-anchor per
   * {@link this._liveTrimAdvanceNm} of progress, not per position fix.
   */
  maybeReliveTrim() {
    const payload = this._briefing?.payload;
    if (!payload?.waypoints) {
      return;
    }
    const trimmed = trimWaypointsToPosition(
      payload.waypoints,
      this._vesselPosition ?? null,
    );
    if (!trimmed) {
      return;
    }
    const last = this._simulatedTrimProgressNm;
    if (last != null && trimmed.progressNm - last < this._liveTrimAdvanceNm) {
      return; // Not enough advance: keep the running plan
    }
    this.simulate();
  }

  /**
   * The 10-minute re-check (work doc #15): refresh the navigation
   * state (stream fallback — the cast-off may predate the page or the
   * stream may have missed it) and re-simulate when the anchor moved
   * more than 10 minutes, so the plan keeps advancing while sailing.
   */
  async recheckDeparture() {
    if (!this._briefing?.payload || !this._exceptions) {
      return;
    }
    try {
      const navState = await fetchNavigationState();
      if (navState != null) {
        this._navigationState = navState;
      }
    } catch {
      // Best effort: the stream carries the live value
    }
    const next = this.departureState();
    if (!next?.departure) {
      return;
    }
    const timeMs = next.departure.time.getTime();
    if (
      this._simulatedDepartureMs == null ||
      Math.abs(timeMs - this._simulatedDepartureMs) > 10 * 60000
    ) {
      this.simulate();
    } else {
      // Same anchor: repaint the chip so the stamps stay current
      this.renderDeparture(next);
    }
  }

  /**
   * The crew moved the control (work doc #15): manual modes override
   * auto until it is put back; the simulation re-runs immediately.
   *
   * @param {{mode: string, customTime: string|null}} detail
   */
  onDepartureChange(detail) {
    this._departureMode = detail.mode;
    this._customDepartureTime = detail.customTime ?? null;
    this.simulate();
  }

  /**
   * Pushes the departure state into whichever view is showing (work
   * doc #15: the control and its chip render in both, sharing the
   * root's state).
   *
   * @param {object} [state]
   */
  renderDeparture(state = this.departureState()) {
    const target = this._view?.querySelector(
      "tactical-dashboard, strategic-outlook",
    );
    target?.setDeparture?.(state);
  }

  /** Signal K stream: environment mode + connectivity + ship's time. */
  connectStream() {
    this._stream = createStream({
      onMode: (mode) => {
        document.documentElement.dataset.mode =
          mode === "day" ? "day" : "night";
        this._view?.firstElementChild?.setAttribute("data-mode", mode);
      },
      onTime: (path, value) => {
        // Offset and region arrive as separate updates; keep the
        // latest of each
        this._timeRaw ??= {};
        this._timeRaw[path] = value;
        this.applyShipTime({
          offset: this._timeRaw["environment.time.timezoneOffset"],
          region: this._timeRaw["environment.time.timezoneRegion"],
        });
      },
      onConnection: (connected) => {
        this._onlinePill.classList.toggle("online", connected);
        this._onlinePill.textContent = connected ? "ONLINE" : "OFFLINE";
      },
      // Navigation state drives the departure anchor (work doc #15):
      // when the crew starts sailing — or drops the hook — the plan
      // re-anchors right away instead of at the next re-check
      onNavigationState: (value) => {
        if (value === this._navigationState) {
          return;
        }
        const was = this._navigationState;
        this._navigationState = value;
        if (this._briefing?.payload && this._exceptions) {
          const next = this.departureState();
          const nextMs = next?.departure?.time?.getTime() ?? null;
          // Anchor moved (moored → underway flips it to now): re-simulate
          if (
            nextMs != null &&
            Math.abs((nextMs ?? 0) - (this._simulatedDepartureMs ?? 0)) > 60000
          ) {
            this.simulate();
          } else if (was == null) {
            // First value: just repaint the chip/control
            this.renderDeparture(next);
          }
        }
      },
      // Vessel position (work doc #28): the plan re-anchors to actual
      // progress between compiles — the handler is cheap (nearest-
      // waypoint lookup) and the hysteresis gate does the throttling
      onPosition: (position) => {
        this._vesselPosition = position;
        if (this._briefing?.payload && this._exceptions) {
          this.maybeReliveTrim();
        }
      },
    });
  }

  /** Loads everything the simulation needs, then simulates. */
  async bootstrap() {
    try {
      const [status, routes, config, matrix, polar, notes, time, navState] =
        await Promise.all([
          fetchJson(`${PLUGIN_API}/status`),
          fetchJson(`${PLUGIN_API}/routes`),
          fetchJson(`${PLUGIN_API}/config`).catch(() => ({})),
          fetchJson(`${PLUGIN_API}/matrix`).catch(() => null),
          fetchJson(`${PLUGIN_API}/polar`).catch(() => null),
          fetchNotes(),
          fetchShipTime(),
          fetchNavigationState(),
        ]);
      this._status = status;
      this._config = config;
      this._matrix = matrix;
      this._polar = polar;
      this._notes = notes;
      this._navigationState = navState;
      if (time) {
        this.applyShipTime(time);
      }

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
    // Always send ?route=: the empty string is an explicit request
    // for conditions-here, not an omission (the server otherwise
    // serves the route being sailed)
    const query = `?route=${encodeURIComponent(routeId)}`;
    // Sequence token: only the newest selection may paint, so rapid
    // switching cannot apply a stale response
    this._loadSeq = (this._loadSeq ?? 0) + 1;
    const seq = this._loadSeq;
    this.renderLoading();
    try {
      this._briefing = await fetchJson(`${PLUGIN_API}/briefing${query}`, 20000);
      if (seq !== this._loadSeq) {
        return;
      }
      if (!this._briefing.payload) {
        // A never-briefed route: fetch it once automatically (online)
        // instead of requiring the button — but only once per route,
        // so an unreachable route can't loop
        const key = this._briefing.routeId ?? "here";
        this._autoFetched ??= new Set();
        if (this._briefing.mode === "route" && !this._autoFetched.has(key)) {
          this._autoFetched.add(key);
          await this.refreshBriefing();
          return;
        }
        const mode = this._briefing.mode;
        this._briefing = null;
        this.renderRoute();
        this.renderStale(true, mode);
        return;
      }
      if (seq !== this._loadSeq) {
        return;
      }
      // Route change: drop cached exceptions from the previous mode,
      // they belong to another track (or none at all)
      const key = this._briefing.routeId ?? "here";
      if (key !== this._briefingKey) {
        this._briefingKey = key;
        this._exceptions = null;
      }
      this.renderStale(false);
      const ageHours = briefingAgeHours(this._briefing.payload);
      this.renderOutdated(
        ageHours != null && ageHours > STALE_AFTER_HOURS
          ? {
              stamp: fmtShip(this._briefing.payload.metadata?.fetchedAt),
              age: fmtHours(ageHours),
            }
          : null,
      );
      // Rebuild the view shell for the served mode: leaving "Conditions
      // here" must bring the tactical/strategic tabs back, and the
      // worker's results render into the elements this creates
      this.renderRoute();
      if (this._briefing.mode !== "here") {
        this.simulate();
      }
    } catch (error) {
      if (seq !== this._loadSeq) {
        return;
      }
      this.showError(fetchErrorMessage(error, "Briefing unavailable"));
    }
  }

  /**
   * Applies the vessel's published timezone (signalk-ships-time):
   * stamps across the app switch to ship's time, the header pill
   * names the zone. The offset alone is required; the region label
   * is optional and may arrive separately from the stream.
   *
   * @param {{offset: number|string|null, region: string|null}} time
   */
  applyShipTime({ offset, region }) {
    const offsetMinutes = parseTimezoneOffset(offset);
    if (offsetMinutes == null) {
      return; // No usable offset (yet): keep UTC stamps
    }
    this._shipRegion = region ?? null;
    setShipTime({ offsetMinutes, region: this._shipRegion });
    if (this._shiptimePill) {
      this._shiptimePill.textContent = shipTimeLabel();
      this._shiptimePill.hidden = false;
    }
    this.renderData();
    // Here mode stamps live outside renderData; restamp in place
    if (this._briefing?.mode === "here" && this._briefing?.payload) {
      this._view
        ?.querySelector("conditions-here")
        ?.setHere(this._briefing.payload, this._config ?? {});
    }
  }

  /** Refreshes the selected route's briefing while online. */
  async refreshBriefing() {
    const routeId = this._routeSelect.value;
    const query = routeId ? `?route=${encodeURIComponent(routeId)}` : "";
    this.renderLoading(
      routeId
        ? "Fetching briefing — can take a minute over a slow link…"
        : "Fetching conditions…",
    );
    try {
      await fetchJson(`${PLUGIN_API}/briefing/refresh${query}`, 120000, {
        method: "POST",
      });
      await this.loadBriefing(routeId);
    } catch (error) {
      this.showError(fetchErrorMessage(error, "Refresh failed"));
    }
  }

  /**
   * Loading strip replacing the view while a fetch or refresh runs:
   * briefing compiles can take tens of seconds on a slow link, and
   * silence reads as a broken app.
   *
   * @param {string} [message]
   */
  renderLoading(message = "Loading briefing…") {
    this.shadowRoot.getElementById("stale")?.remove();
    this.shadowRoot.getElementById("outdated")?.remove();
    this._view.innerHTML = "";
    const strip = document.createElement("div");
    strip.className = "loading";
    strip.textContent = message;
    this._view.appendChild(strip);
  }

  /**
   * "No cached briefing yet" strip with the refresh affordance.
   *
   * @param {boolean} show
   * @param {string} [mode] - Served mode the strip refers to
   */
  renderStale(show, mode = "route") {
    this.shadowRoot.getElementById("stale")?.remove();
    if (!show) {
      return;
    }
    const strip = document.createElement("div");
    strip.className = "stale";
    strip.id = "stale";
    const text = document.createElement("span");
    text.textContent =
      mode === "here"
        ? "No cached conditions yet"
        : "No cached briefing for this route";
    const button = document.createElement("button");
    button.textContent = "Fetch now";
    button.disabled = this._status?.online !== true;
    // Here mode refreshes the conditions payload; the route-select
    // flow would target the selected route instead
    button.addEventListener("click", () =>
      mode === "here" ? this.refreshHereBriefing() : this.refreshBriefing(),
    );
    strip.append(text, button);
    this._view.before(strip);
  }

  /**
   * "Compiled N days ago" banner above the rendered briefing: the
   * cache is served as-is (offline-first), but a multi-day-old
   * timeline reads as upcoming when it is already past — say so, and
   * keep the refresh affordance at hand. Null hides the banner.
   *
   * @param {{stamp: string, age: string}|null} info - Compile stamp
   *   and formatted age, or null to clear
   */
  renderOutdated(info) {
    this.shadowRoot.getElementById("outdated")?.remove();
    if (!info) {
      return;
    }
    const strip = document.createElement("div");
    strip.className = "outdated";
    strip.id = "outdated";
    const text = document.createElement("span");
    text.textContent = `Briefing compiled ${info.stamp} — ${info.age} old`;
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
    // Live re-anchor (work doc #28): between compiles the simulated
    // plan starts at the boat — sailed waypoints drop out, the boat
    // position carries the nearest waypoint's forecasts. The compile
    // payload itself stays untouched (it is the served truth).
    const trim = trimWaypointsToPosition(
      payload.waypoints,
      this._vesselPosition ?? null,
    );
    this._simulatedTrimProgressNm = trim?.progressNm ?? null;
    const simPayload = trim
      ? { ...payload, waypoints: trim.waypoints }
      : payload;
    // The effective departure anchors the whole schedule (work doc
    // #15): auto daylight anchor or the crew's override. The simulated
    // anchor is remembered so the 10-minute re-check can tell drift
    // from a real change.
    const state = this.departureState();
    const departure = state?.departure ?? null;
    this._simulatedDepartureMs = departure ? departure.time.getTime() : null;
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
        payload: simPayload,
        config: this._config ?? {},
        matrix: this._matrix,
        polar: this._polar?.table ?? null,
        performanceFactor: this._polar?.performanceFactor,
        notes: this._notes ?? [],
        // Running watch schedule (signalk-watch-schedule): sail
        // changes anchor to watch changes while it runs
        watch: this._watch ?? null,
        // The payload covers the fetch window forward; hours are read
        // from its own timestamps — anchored to the effective
        // departure when one is assumed (work doc #15)
        startTime:
          departure?.time?.toISOString() ??
          payload.metadata?.fetchedAt ??
          new Date().toISOString(),
        departure: departure
          ? {
              assumed: departure.assumed,
              time: departure.time.toISOString(),
              reason: departure.reason,
            }
          : null,
        // Energy forecast (work doc #10): the predictor's hourly
        // series rides the payload
        energyHourly: payload.energyHourly ?? null,
      },
    });
  }

  /** Routes to the current hash tab and paints cached data. */
  _applyModeToView() {
    this._view?.firstElementChild?.setAttribute(
      "data-mode",
      document.documentElement.dataset.mode ?? "night",
    );
  }

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
    this._applyModeToView();
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
    this._applyModeToView();
    const here = this._view.querySelector("conditions-here");
    if (here && this._briefing?.payload) {
      here.setHere(this._briefing.payload, this._config ?? {});
    }
    here?.setOnline(this._status?.online === true);
    here.onRefresh = () => this.refreshHereBriefing();
    this.renderDisclaimer();
  }

  /**
   * Refreshes the conditions-here briefing specifically: the header's
   * route-select flow would target the selected route, and the here
   * payload is what the crew is looking at (work doc #7; the energy
   * and other payload fields only arrive on a recompile).
   */
  async refreshHereBriefing() {
    this.renderLoading("Fetching conditions…");
    try {
      await fetchJson(`${PLUGIN_API}/briefing/refresh`, 120000, {
        method: "POST",
      });
      await this.loadBriefing("");
    } catch (error) {
      this.showError(fetchErrorMessage(error, "Refresh failed"));
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
      if (this._briefing?.payload) {
        // Both screens carry the warning blocks; the raw bulletin
        // console stays strategic-only
        target.setBulletin?.(this._briefing.payload.metareaBulletin ?? null);
        // The unified timeline (work doc #18) merges payload-borne
        // events (space, zone transitions) alongside the exceptions
        target.setPayload?.(this._briefing.payload);
      }
      // Departure control + chip (work doc #15): shared state, both
      // views
      this.renderDeparture();
    }
    this.renderDisclaimer();
  }

  /**
   * Data-source attribution footer (work doc #17): the Marine Regions
   * CC-BY notice rides the payload and renders app-wide — wherever
   * zones show, the license and no-navigation notice say so. The app
   * footer carries it once, not per card.
   */
  renderDisclaimer() {
    if (!this._disclaimerEl) {
      return; // Not yet connected
    }
    const text = this._briefing?.payload?.zoneDisclaimer ?? "";
    this._disclaimerEl.textContent = text;
    this._disclaimerEl.hidden = !text;
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
