/**
 * `<brief-ext-widget>` — the passage-brief plotter tile (work doc
 * #8). Runs inside a chart plotter's sandboxed iframe (Plotter
 * Extensions API v1 hosts): connects over the vendored bus client,
 * subscribes to the plugin's three published paths through the
 * host's multiplexed Signal K relay, and renders brief freshness.
 * The pure state machine lives in `brief-ext-model.js`.
 *
 * Tap → open the full brief. The v1 widget→host open-panel request
 * is not settled, so the documented fallback applies: open the brief
 * webapp URL in a new browser context (the webapp renders from the
 * cached payload, so it shows the same brief offline).
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
];

/** The webapp served by the webapp keyword (fallback brief surface). */
const BRIEF_URL = "/plugins/signalk-passage-briefing/";

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
      border: 1px solid rgba(255, 255, 255, 0.1);
      font-family: ui-monospace, "Fira Code", monospace;
      color: var(--text-main, #ffffff);
      cursor: default;
      user-select: none;
      --tile-accent: var(--color-teal, #4f9ea8);
    }
    :host(.ok) { --tile-accent: var(--color-teal, #4f9ea8); }
    :host(.new) {
      --tile-accent: var(--color-red, #c94b4b);
      border-color: var(--color-red, #c94b4b);
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
  </style>
  <div class="tile">
    <div class="head">
      <span class="label">Brief</span>
      <span class="badge" id="badge">NEW</span>
    </div>
    <div class="route" id="route">No brief</div>
    <div class="age" id="age">not compiled yet</div>
  </div>
`;

class BriefExtWidget extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.append(template.content.cloneNode(true));

    /** @type {Record<string, unknown>} latest per-path bus values */
    this.values = {};
    this.connected = false;

    // Long-press → host config/remove dialog; short tap → open the
    // brief webapp (fallback until the v1 open-panel request lands).
    /** @type {number|null} */
    this.pressTimer = null;
    /** @type {boolean} */
    this.longPressed = false;
    this.addEventListener("click", this.onTap);
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
    }
  }

  /**
   * Short tap: open the brief webapp in a new browser context.
   *
   * @returns {void}
   */
  onTap() {
    if (!this.connected || this.longPressed) {
      return;
    }
    window.open(BRIEF_URL, "_blank");
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
    root.querySelector("#age").textContent = model.detail;
    root.querySelector("#badge").classList.toggle("on", model.badge);
  }
}

customElements.define("brief-ext-widget", BriefExtWidget);
