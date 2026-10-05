/**
 * `<passage-timeline>` — the unified passage timeline (work doc
 * #18): one merged, chronological list of everything the briefing
 * expects to happen, replacing the per-type blocks. Rows carry a
 * conditions tab (comfort tier color, the tactical sparkline's
 * palette), a time gutter (relative hours + UTC stamp), a kind glyph
 * and a severity colour, then label and detail.
 *
 * Data arrives via `setTimeline()` from the screen elements, which
 * build it with `mergeTimeline()` from `models.mjs` — the tactical
 * dashboard renders the 24 h slice, the strategic outlook the whole
 * passage.
 *
 * @file components/passage-timeline.js
 */

import { comfortColor } from "./models.mjs";
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
  time: "◷",
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
          grid-template-columns: 4px auto auto 1fr;
          gap: 4px 10px;
          align-items: baseline;
          padding: 6px 0;
          border-bottom: 1px solid rgba(102, 198, 219, 0.15);
        }
        .entry:last-child { border-bottom: none; }
        /* Conditions tab (work doc #18): the comfort tier color the
         * tactical sparkline paints, so the passage's weather
         * development reads at a glance. Slatting stripes like the
         * sparkline's hatch — heavy-weather rough keeps its solid
         * colour. */
        .tab {
          align-self: stretch;
          background: var(--tab-color, var(--comfort-unknown));
        }
        .tab.slatting {
          background: repeating-linear-gradient(
            45deg,
            var(--tab-color, var(--comfort-unknown)) 0 3px,
            transparent 3px 6px
          );
        }
        .when {
          font-family: var(--font-data, ui-monospace, monospace);
          font-variant-numeric: tabular-nums;
          font-size: 0.8rem;
          color: var(--text-muted);
          white-space: nowrap;
        }
        /* Night-darkness context (work doc #32): the cloud mark rides
         * the moon glyph, opacity scaling with the cover — a clear
         * night carries no mark at all */
        .cloud { margin-left: 3px; }
        /* Provenance (work doc #31): one muted arrow when the item
         * names a source — the on-board viewer or the external
         * origin. Metadata, not severity: no new colours. */
        .prov {
          margin-left: 6px;
          color: inherit;
          opacity: 0.7;
          text-decoration: none;
        }
        .prov:hover, .prov:focus { opacity: 1; }
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
          .entry { grid-template-columns: 4px auto 1fr; }
          .tab { grid-area: 1 / 1 / 4 / 2; }
          .when { grid-area: 1 / 2 / 2 / 4; }
          .glyph { grid-area: 2 / 2 / 3 / 3; }
          .body { grid-area: 2 / 3 / 4 / 4; }
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
   *   night: boolean, moon: string|null, cloudCover: number|null,
   *   comfortLevel: string|null, slatting: boolean,
   *   provenance: object|null>}|null>
   *   timeline - From `mergeTimeline()`
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

      const tab = document.createElement("span");
      tab.className = `tab${item.slatting ? " slatting" : ""}`;
      tab.style.setProperty(
        "--tab-color",
        comfortColor(item.comfortLevel ?? null),
      );
      tab.title = item.comfortLevel ? `conditions: ${item.comfortLevel}` : "";

      const when = document.createElement("span");
      when.className = "when";
      const hours = item.hoursFromNow != null ? `+${item.hoursFromNow}h` : "—";
      when.append(
        document.createTextNode(
          `${hours} ${item.stamp || ""}${item.night ? ` ${item.moon || "☾"}` : ""}`.trim(),
        ),
      );
      // Cloud mark beside the moon glyph (work doc #32): how dark
      // the night actually is. Every night entry with a known cover
      // carries the mark — a clear night shows the cloud faint
      // instead of absent, so "no mark" unambiguously means the
      // source publishes none (provider mode). Opacity scales with
      // the cover.
      const cover = item.cloudCover;
      if (item.night && Number.isFinite(cover)) {
        const cloud = document.createElement("span");
        cloud.className = "cloud";
        cloud.textContent = "☁";
        cloud.style.opacity = (
          0.3 +
          0.7 * (Math.min(cover, 100) / 100)
        ).toFixed(2);
        cloud.title = `cloud ${Math.round(cover)} %`;
        when.append(cloud);
      }

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
      // Provenance (work doc #31): the on-board viewer wins when
      // installed (it works underway); the external origin is the
      // fallback. No URL — no glyph.
      const provUrl = item.provenance?.viewerUrl || item.provenance?.url;
      if (provUrl) {
        const prov = document.createElement("a");
        prov.className = "prov";
        prov.href = provUrl;
        prov.target = "_blank";
        prov.rel = "noopener";
        prov.textContent = "↗";
        prov.title = item.provenance.label ?? "source";
        body.appendChild(prov);
      }

      row.append(tab, when, glyph, body);
      this._listEl.appendChild(row);
    }
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("passage-timeline", PassageTimeline);
}

export { PassageTimeline };
