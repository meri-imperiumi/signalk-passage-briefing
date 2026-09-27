/**
 * Passage briefing webapp entrypoint: registers the custom elements
 * and boots the root component. Loaded as an ES module from
 * index.html — no build step, no dependencies.
 *
 * @file app.js
 */

import "./components/passage-outlook.js";
import "./components/tactical-dashboard.js";
import "./components/strategic-outlook.js";
import "./components/backfill-controls.js";
import "./components/conditions-here.js";
import "./components/horizon-sparkline.js";

document.documentElement.dataset.mode ??= "night";
