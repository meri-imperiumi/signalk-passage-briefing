/**
 * Pure render model for the passage-brief plotter tile (work doc
 * #8). Split from the DOM adapter so Node tests cover the state
 * machine; `brief-ext-widget.js` is the bus/DOM adapter only.
 *
 * Tile states: **no brief** (muted), **brief available** (route name
 * + age), **new brief** (accent + badge until acknowledged — "new"
 * means `generatedAt` is newer than the last acknowledged
 * timestamp, which the plugin publishes as `hasNew`).
 *
 * @file brief-ext-model.js
 */

/**
 * Human age string for a timestamp relative to now: `12 m old`,
 * `3 h old`, `2 d old`.
 *
 * @param {string|null} iso
 * @param {Date} [now]
 * @returns {string}
 */
export function briefAge(iso, now = new Date()) {
  const t = iso != null ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(t)) {
    return "";
  }
  const minutes = Math.max(0, Math.round((now.getTime() - t) / 60000));
  if (minutes < 60) {
    return `${minutes} m old`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours} h old`;
  }
  return `${Math.floor(hours / 24)} d old`;
}

/**
 * Tile state from the three published bus values.
 *
 * @param {object} params
 * @param {string|null} params.generatedAt - `navigation.briefing.generatedAt`
 * @param {string|null} params.route - `navigation.briefing.route`
 * @param {boolean|null} params.hasNew - `navigation.briefing.hasNew`
 * @param {Date} [params.now]
 * @returns {{severity: "muted"|"ok"|"new", badge: boolean, title: string, detail: string}}
 */
export function tileModel({ generatedAt, route, hasNew, now = new Date() }) {
  if (generatedAt == null || Number.isNaN(new Date(generatedAt).getTime())) {
    return {
      severity: "muted",
      badge: false,
      title: "No brief",
      detail: "not compiled yet",
    };
  }
  const isNew = hasNew === true;
  return {
    severity: isNew ? "new" : "ok",
    badge: isNew,
    title: route ? route : "Passage brief",
    detail: briefAge(generatedAt, now),
  };
}
