/**
 * Shared base styles for shadow-DOM components. The document-level
 * visuals.css cannot style anything inside a shadow root, so every
 * component carries this subset (panels with corner brackets, theme
 * classes, headings, buttons, selects, tables, consoles) via
 * `${SK_BASE_CSS}` at the top of its template <style>. The palette
 * custom properties inherit from the host page's visuals.css.
 *
 * Mirrors public/css/visuals.css — keep the two in sync.
 *
 * @file components/sk-base-css.js
 */

export const SK_BASE_CSS = `
  .sk-card {
    position: relative;
    background-color: var(--bg-panel);
    border: 1px solid rgba(102, 198, 219, 0.3);
    padding: 12px;
    margin-bottom: 12px;
  }
  .sk-card::before,
  .sk-card::after {
    content: "";
    position: absolute;
    width: 12px;
    height: 12px;
    pointer-events: none;
  }
  .sk-card::before {
    top: -2px;
    left: -2px;
    border-top: 2px solid var(--theme-color, var(--color-teal));
    border-left: 2px solid var(--theme-color, var(--color-teal));
  }
  .sk-card::after {
    bottom: -2px;
    right: -2px;
    border-bottom: 2px solid var(--theme-color, var(--color-teal));
    border-right: 2px solid var(--theme-color, var(--color-teal));
  }
  .theme-green { --theme-color: var(--color-green); }
  .theme-teal { --theme-color: var(--color-teal); }
  .theme-orange { --theme-color: var(--color-orange); }
  .theme-red { --theme-color: var(--color-red); }
  .theme-offline { --theme-color: var(--color-grey); }

  h1, h2, h3 {
    font-size: 0.85rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--theme-color, var(--color-teal));
    margin: 0 0 8px 0;
  }
  .label {
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .value {
    font-family: var(--font-data);
    font-variant-numeric: tabular-nums;
    font-size: 2.5rem;
    font-weight: 700;
    color: var(--text-main);
    line-height: 1.1;
  }
  .muted {
    color: var(--text-muted);
    font-family: var(--font-data);
    font-variant-numeric: tabular-nums;
  }
  .value-small {
    font-family: var(--font-data);
    font-variant-numeric: tabular-nums;
    font-size: 1.1rem;
    font-weight: 700;
    color: var(--text-main);
  }
  .grid-auto {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }
  .cards { display: grid; gap: 8px; }
  .card {
    border: 1px solid var(--theme-color, var(--color-teal));
    padding: 8px 12px;
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: baseline;
    flex-wrap: wrap;
  }

  button {
    appearance: none;
    background: transparent;
    border: 1px solid var(--theme-color, var(--color-teal));
    color: var(--theme-color, var(--color-teal));
    font-family: var(--font-data);
    font-size: 0.85rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    padding: 12px 16px;
    min-height: 48px;
    cursor: pointer;
  }
  button:hover,
  button:active {
    background-color: var(--theme-color, var(--color-teal));
    color: var(--bg-base);
  }
  button:disabled {
    border-color: var(--color-grey);
    color: var(--color-grey);
    cursor: not-allowed;
    background: transparent;
  }
  select {
    appearance: none;
    background-color: var(--bg-panel-muted);
    border: 1px solid var(--color-grey);
    border-bottom: 2px solid var(--color-grey);
    color: var(--text-main);
    font-family: var(--font-data);
    font-size: 0.9rem;
    padding: 12px;
    min-height: 48px;
  }
  select:focus {
    outline: none;
    border-bottom-color: var(--theme-color, var(--color-teal));
  }
  input {
    appearance: none;
    background: transparent;
    border: none;
    border-bottom: 2px solid var(--color-grey);
    color: var(--text-main);
    font-family: var(--font-data);
    font-size: 0.9rem;
    padding: 8px 4px;
    min-height: 32px;
  }
  input:focus {
    outline: none;
    border-bottom-color: var(--theme-color, var(--color-teal));
  }

  .tab-bar { display: flex; gap: 0; }
  .tab-bar[hidden] { display: none; }
  .tab-bar button { flex: 1; border-right: none; }
  .tab-bar button:last-child {
    border-right: 1px solid var(--theme-color, var(--color-teal));
  }
  .tab-bar button[aria-selected="true"] {
    background-color: var(--theme-color, var(--color-teal));
    color: var(--bg-base);
  }

  table.data {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--font-data);
    font-variant-numeric: tabular-nums;
  }
  table.data th {
    font-size: 0.75rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-muted);
    text-align: left;
    padding: 6px 8px;
    border-bottom: 1px solid rgba(102, 198, 219, 0.3);
  }
  table.data td {
    padding: 6px 8px;
    border-bottom: 1px solid rgba(102, 198, 219, 0.15);
    color: var(--text-main);
  }

  .console {
    font-family: var(--font-data);
    font-size: 0.85rem;
    background-color: var(--bg-panel-muted);
    border: 1px solid rgba(102, 198, 219, 0.3);
    padding: 8px;
    max-height: 40vh;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .console .ts { color: var(--text-muted); }
`;
