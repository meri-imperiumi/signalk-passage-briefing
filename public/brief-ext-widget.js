/**
 * `<brief-ext-widget>` — the passage-brief plotter tile (work doc
 * #8). Runs inside a chart plotter's sandboxed iframe (Plotter
 * Extensions API v1 hosts): connects over the vendored bus client,
 * subscribes to the plugin's three published paths through the
 * host's multiplexed Signal K relay, and renders brief freshness.
 * The pure state machine lives in `brief-ext-model.js`.
 *
 * Short tap → the full briefing over the chart: a floating window on
 * hosts with the `windows` capability (work doc #52 — the host's
 * sandbox blocks pop-ups and all top-frame navigation, so the old
 * "open the webapp in a new context" fallback was never reachable),
 * falling back to a host panel under `panels.iframe`; a host with
 * neither keeps the tile as the glanceable mini summary it is.
 * Long-press → host config/remove dialog (pointer events inside the
 * iframe are invisible to the host, so the widget detects the
 * gesture itself). Night mode (optional capability) shifts the
 * palette amber/red.
 *
 * @file brief-ext-widget.js
 */

import { tileModel } from "./brief-ext-model.js";
import { connectExtension } from "./vendor/plotterext-bus/extension.js";

/** Flat paths the tile consumes (scalars over the host relay). */
const STREAM_PATHS = [
  "navigation.briefing.generatedAt",
  "navigation.briefing.route",
  "navigation.briefing.hasNew",
  "navigation.briefing.comfort",
  "navigation.briefing.stale",
  "navigation.briefing.ageHours",
];

// The meta endpoint runs on the same server, so the freshness
// summary fetches directly. The full briefing is the host's to show
// (short tap → ui.openWindow / ui.openPanel): the sandbox blocks
// pop-ups and all top-frame navigation, so this iframe could never
// navigate to the webapp itself.
const BRIEF_META_URL = "/plugins/signalk-passage-briefing/api/brief-meta";

const template = document.createElement("template");
template.innerHTML = /* html */ `
  <style>
    :host {
      display: block;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      padding: 6px 8px;
      background: var(--bg-panel, #111414);
      font-family: ui-monospace, "Fira Code", monospace;
      color: var(--text-main, #ffffff);
      cursor: default;
      user-select: none;
      --tile-accent: var(--color-teal, #4f9ea8);
    }
    :host(.ok) { --tile-accent: var(--color-teal, #4f9ea8); }
    :host(.new) {
      --tile-accent: var(--color-red, #c94b4b);
    }
    :host(.muted) { --tile-accent: var(--color-grey, #666677); }

    /* Night mode (host nightMode capability): amber/red palette. */
    :host(.night) {
      --color-teal: #c97b4f;
      --color-red: #e06a5a;
      --color-grey: #6a4a3f;
      --text-main: #e8c9a0;
      --bg-panel: rgba(22, 11, 6, 0.88);
    }

    .tile {
      display: grid;
      grid-template-rows: auto 1fr auto;
      height: 100%;
      gap: 2px;
    }
    .head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }
    .head .label {
      font-size: 0.55rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--tile-accent);
      white-space: nowrap;
    }
    .badge {
      display: none;
      padding: 1px 5px;
      border: 1px solid var(--color-red, #c94b4b);
      color: var(--color-red, #c94b4b);
      font-size: 0.55rem;
      font-weight: 700;
      letter-spacing: 0.1em;
    }
    .badge.on { display: inline-block; }
    .route {
      align-self: center;
      font-size: clamp(0.8rem, 3vh, 1.05rem);
      font-weight: 700;
      line-height: 1.15;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .age {
      font-size: 0.6rem;
      letter-spacing: 0.06em;
      color: var(--text-muted, #9aa3ad);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .age.stale { color: #fca847; }
    .comfort {
      align-self: center;
      font-family: var(--font-data, ui-monospace, monospace);
      font-size: clamp(0.9rem, 4vh, 1.4rem);
      font-weight: 700;
      letter-spacing: 0.1em;
      line-height: 1.1;
    }
  </style>
  <div class="tile">
    <div class="head">
      <span class="label">Brief</span>
      <span class="badge" id="badge">NEW</span>
    </div>
    <div class="route" id="route">No brief</div>
    <div class="comfort" id="comfort"></div>
    <div class="age" id="age">not compiled yet</div>
  </div>
`;

class BriefExtWidget extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.append(template.content.cloneNode(true));
    // target="_top" lets the anchor escape this iframe when the host
    // sandbox allows top navigation at all

    /** @type {Record<string, unknown>} latest per-path bus values */
    this.values = {};
    this.connected = false;

    // Long-press → host config/remove dialog; short tap → the full
    // brief in a floating window (or a host panel where the host has
    // no windows).
    /** @type {number|null} */
    this.pressTimer = null;
    /** @type {boolean} */
    this.longPressed = false;
    this.addEventListener("pointerdown", this.onPointerDown);
    this.addEventListener("pointerup", this.onPointerUp);
    this.addEventListener("pointercancel", this.onPointerUp);
    this.addEventListener("pointerleave", this.onPointerUp);
    this.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /**
   * @param {PointerEvent} e
   * @returns {void}
   */
  onPointerDown(e) {
    if (!this.connected || e.button !== 0) return;
    this.longPressed = false;
    this.pressTimer = setTimeout(() => {
      this.longPressed = true;
      this.client?.call("ui.toggleConfigPanel").catch(() => {});
    }, 1200);
  }

  /**
   * @returns {void}
   */
  onPointerUp() {
    if (this.pressTimer) {
      clearTimeout(this.pressTimer);
      this.pressTimer = null;
      // A short tap (the gesture the long-press did not claim) opens
      // the full briefing; the long-press keeps its config dialog.
      if (!this.longPressed) this.openBrief();
    }
  }

  /**
   * Opens the full briefing over the chart: a floating window on a
   * `windows` host (single — one briefing at a time — with the
   * host-side remembered geometry under the "brief" restore key), a
   * host panel where only `panels.iframe` is offered, and nothing on
   * a host with neither. Plain `call`s: the wire format is the
   * contract — the vendored 0.11.0 client predates the `windows`
   * sugar, which adds nothing over the method call.
   *
   * @returns {void}
   */
  openBrief() {
    const client = this.client;
    if (!client) return;
    if (client.hasCapability("windows")) {
      client
        .call("ui.openWindow", {
          panel: "brief-panel",
          single: true,
          restoreKey: "brief",
        })
        .catch(() => {});
      return;
    }
    if (client.hasCapability("panels.iframe")) {
      client.call("ui.openPanel", { panel: "brief-panel" }).catch(() => {});
    }
  }

  /**
   * @returns {void}
   */
  async connectedCallback() {
    if (this.connected) return;
    let client;
    try {
      client = await connectExtension();
    } catch {
      // No host handshake (opened standalone while developing, or the
      // host vanished): render the placeholder and give up.
      this.render();
      return;
    }
    this.connected = true;
    this.client = client;

    // Current values right away: deltas only travel on change, so
    // without this the tile would wait for the next ticker emission
    try {
      const meta = await fetch(BRIEF_META_URL).then((r) => r.json());
      Object.assign(this.values, {
        "navigation.briefing.generatedAt": meta.generatedAt,
        "navigation.briefing.route": meta.route,
        "navigation.briefing.hasNew": meta.hasNew,
        "navigation.briefing.comfort": meta.comfort,
        "navigation.briefing.stale": meta.stale,
        "navigation.briefing.ageHours": meta.ageHours,
      });
      this.render();
    } catch (_error) {
      // Meta unavailable: the subscription still fills values in
    }

    try {
      await client.signalk.subscribe(STREAM_PATHS, (ev) => {
        // Event name is `sk.<path>`; the path is the dict key.
        const path = ev?.path;
        if (typeof path === "string") this.values[path] = ev.value;
        this.render();
      });
    } catch {
      // Host without signalk.stream (or relay failure): placeholders.
    }

    if (client.hasCapability("nightMode")) {
      try {
        const { enabled } = await client.nightMode.get();
        this.classList.toggle("night", Boolean(enabled));
      } catch {
        /* best-effort seed */
      }
      await client
        .subscribe(["nightMode.changed"], (_name, params) => {
          this.classList.toggle("night", Boolean(params?.enabled));
        })
        .catch(() => {});
    }

    this.render();
  }

  disconnectedCallback() {
    this.onPointerUp();
    this.client?.close();
    this.client = null;
    this.connected = false;
  }

  /**
   * Applies the latest bus values to the DOM.
   *
   * @returns {void}
   */
  render() {
    const model = tileModel({
      generatedAt: this.values["navigation.briefing.generatedAt"] ?? null,
      route: this.values["navigation.briefing.route"] ?? null,
      hasNew: this.values["navigation.briefing.hasNew"] ?? null,
    });
    const root = this.shadowRoot;
    this.classList.remove("ok", "new", "muted");
    this.classList.add(model.severity);
    root.querySelector("#route").textContent = model.title;
    const comfort = this.values["navigation.briefing.comfort"];
    const comfortEl = root.querySelector("#comfort");
    comfortEl.textContent = comfort ? String(comfort).toUpperCase() : "";
    comfortEl.style.color =
      {
        champagne: "#8dfcbb",
        easy: "#8dfcbb",
        sporty: "#fca847",
        rough: "#fca847",
        miserable: "#ff5e5e",
      }[String(comfort).toLowerCase()] ?? "var(--text-main, #c4c4c4)";
    const stale = this.values["navigation.briefing.stale"] === true;
    const ageEl = root.querySelector("#age");
    ageEl.textContent = model.detail + (stale ? " · STALE" : "");
    ageEl.classList.toggle("stale", stale);
    root.querySelector("#badge").classList.toggle("on", model.badge);
  }
}

customElements.define("brief-ext-widget", BriefExtWidget);
