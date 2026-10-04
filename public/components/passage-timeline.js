/**
 * `<passage-timeline>` — the unified passage timeline (work doc
 * #18): one merged, chronological list of everything the briefing
 * expects to happen, replacing the per-type blocks. Rows carry a
 * time gutter (relative hours + UTC stamp), a kind glyph and a
 * severity colour, then label and detail.
 *
 * Data arrives via `setTimeline()` from the screen elements, which
 * build it with `mergeTimeline()` from `models.mjs` — the tactical
 * dashboard renders the 24 h slice, the strategic outlook the whole
 * passage.
 *
 * @file components/passage-timeline.js
 */

import { SK_BASE_CSS } from "./sk-base-css.js";

/**
 * Glyph per timeline kind. Monochrome marks that inherit the
 * severity colour; unknown kinds fall back to a plain bullet so new
 * sources render before their glyph is picked.
 */
const GLYPHS = {
  sail: "⛵",
  maneuver: "⇄",
  convective: "⚡",
  sea: "🌊",
  zone: "⚑",
  space: "✦",
  hazard: "⚠",
  line: "⌀",
  energy: "🔋",
  departure: "⚓",
};

/**
 * The custom element (browser only).
 */
class PassageTimeline extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    this.shadowRoot.innerHTML = `
      <style>
        ${SK_BASE_CSS}
        :host { display: block; }
        .entry {
          display: grid;
          grid-template-columns: auto auto 1fr;
          gap: 4px 10px;
          align-items: baseline;
          padding: 6px 0;
          border-bottom: 1px solid rgba(102, 198, 219, 0.15);
        }
        .entry:last-child { border-bottom: none; }
        .when {
          font-family: var(--font-data, ui-monospace, monospace);
          font-variant-numeric: tabular-nums;
          font-size: 0.8rem;
          color: var(--text-muted);
          white-space: nowrap;
        }
        .glyph { text-align: center; }
        .label { color: var(--text-main); }
        .detail {
          color: var(--text-muted);
          font-size: 0.8rem;
        }
        .sev-warn .glyph, .sev-warn .label { color: var(--color-orange); }
        .sev-severe .glyph, .sev-severe .label { color: var(--color-red); }
        .sev-info .glyph { color: var(--color-teal); }
        .none { color: var(--text-muted); font-size: 0.85rem; }
        /* Phone: the when gutter is too wide and squeezes the event
         * text, so the date line goes on top at full width and the
         * event data flows beneath it. Matches the 700px layout
         * breakpoint used across the app. */
        @media (max-width: 699px) {
          .entry { grid-template-columns: auto 1fr; }
          .when { grid-area: 1 / 1 / 2 / 3; }
          .glyph { grid-area: 2 / 1 / 3 / 2; }
          .body { grid-area: 2 / 2 / 3 / 3; }
        }
      </style>
      <div id="list"></div>
    `;
    this._listEl = this.shadowRoot.getElementById("list");
    if (this._timeline) {
      this.setTimeline(this._timeline);
    }
  }

  /**
   * Renders the merged timeline, oldest first.
   *
   * @param {Array<{hoursFromNow: number|null, stamp: string, kind:
   *   string, severity: string, label: string, detail: string,
   *   night: boolean}>|null} timeline - From `mergeTimeline()`
   */
  setTimeline(timeline) {
    this._timeline = timeline;
    if (!this._listEl) {
      return; // Not yet connected
    }
    this._listEl.innerHTML = "";
    const items = timeline ?? [];
    if (items.length === 0) {
      const el = document.createElement("span");
      el.className = "none";
      el.textContent = "No events expected";
      this._listEl.appendChild(el);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = `entry sev-${item.severity ?? "info"}`;

      const when = document.createElement("span");
      when.className = "when";
      const hours = item.hoursFromNow != null ? `+${item.hoursFromNow}h` : "—";
      when.textContent =
        `${hours} ${item.stamp || ""}${item.night ? ` ${item.moon || "☾"}` : ""}`.trim();

      const glyph = document.createElement("span");
      glyph.className = "glyph";
      glyph.textContent = GLYPHS[item.kind] ?? "•";
      glyph.title = item.kind ?? "";

      const body = document.createElement("span");
      body.className = "body";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = item.label ?? "?";
      body.appendChild(label);
      if (item.detail) {
        const detail = document.createElement("span");
        detail.className = "detail";
        detail.textContent = ` — ${item.detail}`;
        body.appendChild(detail);
      }

      row.append(when, glyph, body);
      this._listEl.appendChild(row);
    }
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("passage-timeline", PassageTimeline);
}

export { PassageTimeline };
