/**
 * `<source-status>` — data source checklist (work doc #23). Renders
 * the plugin's per-source status registry (`GET /plugins/
 * signalk-passage-briefing/sources`) as a pseudo-console checklist:
 * one row per ingest path or Signal K source, the outcome of its
 * latest cycle in a right-aligned status bracket.
 *
 * Collapsed by default (only the summary line shows), expanded state
 * remembered in localStorage; rows update in place — textContent and
 * class attributes only, no re-render of the list. Polls at a
 * generous minute rate: source status changes on the order of
 * minutes, not seconds.
 *
 * The status→bracket mapping lives in `models.mjs` as the pure
 * {@link statusVerdict} view model (tested browser-free there).
 *
 * @file components/source-status.js
 */

import { fmtShip, statusVerdict } from "./models.mjs";
import { fetchJson } from "./sk-api.js";
import { SK_BASE_CSS } from "./sk-base-css.js";

/** Plugin REST base (same unscoped mount as the other API calls). */
const PLUGIN_SOURCES_URL = "/plugins/signalk-passage-briefing/sources";

/** Poll interval — source status changes on the order of minutes. */
const POLL_MS = 60000;

/** localStorage key remembering the collapsed/expanded choice. */
const EXPANDED_KEY = "passage-briefing.source-status.expanded";

/**
 * The custom element (browser only).
 */
class SourceStatus extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    this.shadowRoot.innerHTML = `
      <style>
        ${SK_BASE_CSS}
        :host { display: block; }
        section { margin-bottom: 12px; }
        h2 { cursor: pointer; margin-bottom: 4px; }
        .summary {
          font-family: var(--font-data, ui-monospace, monospace);
          font-size: 0.8rem;
          color: var(--text-muted);
        }
        .summary .count-red { color: var(--color-red); font-weight: 700; }
        .summary .count-orange { color: var(--color-orange); font-weight: 700; }
        .rows { margin-top: 8px; }
        .row {
          display: grid;
          grid-template-columns: 9em 1fr auto;
          gap: 0 8px;
          align-items: baseline;
          font-family: var(--font-data, ui-monospace, monospace);
          font-size: 0.8rem;
          padding: 3px 0;
          border-bottom: 1px solid rgba(102, 198, 219, 0.15);
          cursor: pointer;
        }
        .row .ts { color: var(--text-muted); font-variant-numeric: tabular-nums; }
        .row .label { color: var(--text-main); word-break: break-word; }
        .row .label .kind {
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-size: 0.7rem;
          margin-left: 6px;
        }
        .row .bracket {
          font-weight: 700;
          white-space: pre;
          color: var(--theme-color, var(--text-main));
        }
        .row .detail {
          grid-column: 1 / -1;
          color: var(--text-muted);
          white-space: pre-wrap;
          word-break: break-word;
          padding: 2px 0 6px 1ch;
        }
      </style>
      <section class="sk-card theme-teal">
        <h2 id="toggle">Data Sources</h2>
        <div class="summary" id="summary">Loading…</div>
        <div class="rows" id="rows"></div>
      </section>
    `;
    this._rowsEl = this.shadowRoot.getElementById("rows");
    this._summaryEl = this.shadowRoot.getElementById("summary");
    this._rowEls = new Map();
    this.shadowRoot
      .getElementById("toggle")
      .addEventListener("click", () => this.toggle());
    this._expanded = localStorage.getItem(EXPANDED_KEY) === "1";
    this._rowsEl.hidden = !this._expanded;
    this._timer = setInterval(() => this.poll(), POLL_MS);
    this.poll();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  /** Collapsed-by-default: the summary line is always visible. */
  toggle() {
    this._expanded = !this._expanded;
    localStorage.setItem(EXPANDED_KEY, this._expanded ? "1" : "0");
    this._rowsEl.hidden = !this._expanded;
  }

  async poll() {
    let sources;
    try {
      sources = await fetchJson(PLUGIN_SOURCES_URL);
    } catch {
      this._summaryEl.textContent = "Source status unavailable";
      return;
    }
    this.setSources(Array.isArray(sources) ? sources : []);
  }

  /**
   * Renders the registry. Rows are cached per source id and updated
   * in place — only textContent and class attributes mutate.
   *
   * @param {Array<object>} sources - Registry entries
   */
  setSources(sources) {
    if (!this._rowsEl) {
      return; // Not yet connected
    }
    const now = new Date();
    let fails = 0;
    let warns = 0;
    const seen = new Set();
    for (const entry of sources) {
      seen.add(entry.id);
      const verdict = statusVerdict(entry, now);
      if (verdict.bracket === "[ FAIL ]") {
        fails += 1;
      } else if (verdict.bracket === "[ WARN ]") {
        warns += 1;
      }
      let row = this._rowEls.get(entry.id);
      if (!row) {
        row = this.buildRow();
        this._rowEls.set(entry.id, row);
        this._rowsEl.appendChild(row.root);
      }
      this.updateRow(row, entry, verdict);
    }
    // Sources that vanished from the registry (config change)
    for (const [id, row] of this._rowEls) {
      if (!seen.has(id)) {
        row.root.remove();
        this._rowEls.delete(id);
      }
    }
    const parts = [`${sources.length} sources`];
    this._summaryEl.textContent = "";
    this._summaryEl.append(document.createTextNode(parts[0]));
    if (fails > 0) {
      const fail = document.createElement("span");
      fail.className = "count-red";
      fail.textContent = `, ${fails} FAIL`;
      this._summaryEl.appendChild(fail);
    }
    if (warns > 0) {
      const warn = document.createElement("span");
      warn.className = "count-orange";
      warn.textContent = `, ${warns} WARN`;
      this._summaryEl.appendChild(warn);
    }
  }

  buildRow() {
    const root = document.createElement("div");
    root.className = "row";
    const ts = document.createElement("span");
    ts.className = "ts";
    const label = document.createElement("span");
    label.className = "label";
    const kind = document.createElement("span");
    kind.className = "kind";
    label.appendChild(kind);
    const bracket = document.createElement("span");
    bracket.className = "bracket";
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.hidden = true;
    root.append(ts, label, bracket, detail);
    root.addEventListener("click", () => {
      detail.hidden = !detail.hidden;
    });
    return { root, ts, kind, label, bracket, detail };
  }

  updateRow(row, entry, verdict) {
    row.ts.textContent = entry.lastAttemptAt
      ? fmtShip(entry.lastAttemptAt)
      : "—";
    row.label.textContent = "";
    row.label.append(document.createTextNode(entry.label ?? entry.id));
    row.kind.textContent = entry.kind ?? "";
    row.bracket.textContent = verdict.bracket;
    row.bracket.className = `bracket ${verdict.theme}`;
    // Expandable detail: enough to decide "fix the URL" vs "wait"
    const lines = [];
    if (entry.url) {
      lines.push(`URL ${entry.url}`);
    }
    lines.push(
      `Last success ${entry.lastSuccessAt ? fmtShip(entry.lastSuccessAt) : "never"}`,
    );
    if (entry.lastError) {
      lines.push(`Error ${entry.lastError.class}: ${entry.lastError.message}`);
    }
    if (verdict.stale) {
      lines.push(
        `Stale: last success is older than the expected ` +
          `${Math.round(entry.expectedRefreshMs / 3600000)} h refresh`,
      );
    }
    if ((entry.consecutiveFailures ?? 0) > 0) {
      lines.push(`${entry.consecutiveFailures} consecutive failures`);
    }
    if (entry.lastStatus === "skip") {
      lines.push("Skipped while the boat was offline");
    }
    if (entry.lastStatus === "absent") {
      lines.push("Not present on this server (informational)");
    }
    row.detail.textContent = lines.join("\n");
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("source-status", SourceStatus);
}

export { SourceStatus };
