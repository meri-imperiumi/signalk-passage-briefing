/**
 * Graceful degradation: the plugin runs on a server where pieces are
 * missing — no active route, no Weather API provider, the energy
 * predictor disabled, no polar management, no resources API, the
 * link never coming online. None of those may crash the plugin or
 * the webapp routes: the console, bulletins and hazard escalation
 * ride the same start() call, so a dead dependency must cost only
 * its own feature.
 *
 * The harness is deliberately barer than plugin.test.js's: no
 * weatherApi, no resourcesApi, no polar, no energy deltas — only the
 * vessel position (a given per the degradation assumptions).
 *
 * @file plugin-degradation.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const pluginFactory = require("../plugin/index.js");
const { mockOpenMeteo } = require("./openmeteo-mock.js");

/** A bare Signal K app: position available, everything else absent. */
function createBareApp() {
  const errors = [];
  const routes = [];
  const deltaHandlers = [];
  let status = "";
  const dataDir = mkdtempSync(join(tmpdir(), "passage-degrade-"));
  return {
    selfId: "urn:mrn:imo:mmsi:123456789",
    debug: () => {},
    error: (message) => errors.push(message),
    setPluginStatus: (s) => {
      status = s;
    },
    getPluginStatus: () => status,
    getDataDirPath: () => dataDir,
    subscriptionmanager: {
      subscribe: (_subscription, _unsub, _onError, onDelta) => {
        deltaHandlers.push(onDelta);
      },
    },
    handleMessage: () => {},
    registerResourceProvider: () => {},
    registerPutHandler: () => {},
    use: () => {},
    router: {
      get(path, handler) {
        routes.push({ path, handler });
      },
      post(path, handler) {
        routes.push({ path, handler });
      },
    },
    // Position only: no polars.activePolar, no activeRoute, no
    // resources — the degraded server's reality
    getSelfPath: (path) =>
      path === "navigation.position"
        ? { latitude: -18.65, longitude: -173.98 }
        : null,
    dataDir,
    getErrors: () => errors,
    getRoutes: () => routes,
    getDeltaHandlers: () => deltaHandlers,
  };
}

/** Calls a captured route handler with a mock response object. */
async function callRoute(app, path, req = { query: {} }) {
  const route = app.getRoutes().find((r) => r.path === path);
  assert.ok(route, `route ${path} registered`);
  const res = {
    code: null,
    payload: null,
    body: null,
    status(code) {
      this.code = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
    },
    type() {
      return this;
    },
    send(body) {
      this.body = body;
    },
  };
  await route.handler(req, res);
  return res;
}

async function waitFor(predicate, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test("bare boot: starts, serves empty states, stops cleanly", async () => {
  const app = createBareApp();
  const plugin = pluginFactory(app);
  plugin.start({});
  plugin.registerWithRouter(app.router);
  assert.ok(
    existsSync(join(app.dataDir, "passage-outlook.sqlite")),
    "sqlite store created",
  );

  // Briefing endpoint: empty here mode, not a 404 or a crash
  const briefing = await callRoute(app, "/api/briefing");
  assert.equal(briefing.code, null);
  assert.deepEqual(briefing.payload, {
    mode: "here",
    payload: null,
    cached: false,
    online: false,
  });

  // Refresh while offline: explicit 503, not an error page
  const refresh = await callRoute(app, "/api/briefing/refresh", {
    method: "POST",
    query: {},
  });
  assert.equal(refresh.code, 503);
  assert.match(refresh.payload.error, /Offline/);

  // Routes listing without the Resources API: 501, not a crash
  const routes = await callRoute(app, "/api/routes");
  assert.equal(routes.code, 501);
  assert.match(routes.payload.error, /Resources API/);

  // Polar without polar-management: null, the webapp falls back
  const polar = await callRoute(app, "/api/polar");
  assert.equal(polar.payload, null);

  // Sail inventory without polar data: empty, not an error
  const sails = await callRoute(app, "/api/sails");
  assert.equal(sails.code, null);
  assert.ok(!sails.payload.error);

  assert.deepEqual(app.getErrors(), [], "no errors logged at bare boot");
  plugin.stop();
});

test("no Weather API provider: auto falls back to Open-Meteo and briefs", async () => {
  const app = createBareApp();
  const plugin = pluginFactory(app);
  plugin.start({});
  plugin.registerWithRouter(app.router);
  app.getDeltaHandlers()[0]({
    updates: [
      {
        values: [
          { path: "network.internet.state", value: "online" },
          { path: "navigation.state", value: "moored" },
        ],
      },
    ],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockOpenMeteo();
  try {
    await waitFor(() =>
      /Conditions here cached at/.test(app.getPluginStatus()),
    );
    const res = await callRoute(app, "/api/briefing");
    assert.equal(res.payload.mode, "here");
    assert.ok(
      res.payload.payload,
      "here payload compiled without a Weather API provider",
    );
    assert.ok(
      res.payload.cachedAt,
      "here payload compiled without a Weather API provider",
    );
    // No weather-api fallback error: the fetcher never threw
    assert.ok(
      !app.getErrors().some((e) => /Weather API/.test(e)),
      "auto mode degrades silently to Open-Meteo",
    );
  } finally {
    globalThis.fetch = originalFetch;
    plugin.stop();
  }
});

test("weather-api misconfiguration degrades to Open-Meteo instead of killing start", async () => {
  const app = createBareApp();
  const plugin = pluginFactory(app);
  // Before the degradation fix this threw out of start() and took
  // the whole plugin down — console, bulletins and hazard escalation
  // included
  plugin.start({ weather_source: "weather-api" });
  plugin.registerWithRouter(app.router);
  assert.ok(
    app.getErrors().some((e) => /Weather source misconfigured/.test(e)),
    "misconfiguration surfaced as an error, not a crash",
  );

  // The plugin still briefs: Open-Meteo fallback serves the compile
  app.getDeltaHandlers()[0]({
    updates: [
      {
        values: [
          { path: "network.internet.state", value: "online" },
          { path: "navigation.state", value: "moored" },
        ],
      },
    ],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockOpenMeteo();
  try {
    await waitFor(() =>
      /Conditions here cached at/.test(app.getPluginStatus()),
    );
    const res = await callRoute(app, "/api/briefing");
    assert.ok(
      res.payload.payload,
      "here payload compiled via the Open-Meteo fallback",
    );
  } finally {
    globalThis.fetch = originalFetch;
    plugin.stop();
  }
});

test("energy predictor disabled: empty outlook rides the payload", async () => {
  const app = createBareApp();
  const plugin = pluginFactory(app);
  plugin.start({});
  plugin.registerWithRouter(app.router);
  app.getDeltaHandlers()[0]({
    updates: [
      {
        values: [
          { path: "network.internet.state", value: "online" },
          { path: "navigation.state", value: "moored" },
        ],
      },
    ],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockOpenMeteo();
  try {
    await waitFor(() =>
      /Conditions here cached at/.test(app.getPluginStatus()),
    );
    const res = await callRoute(app, "/api/briefing");
    const payload = res.payload.payload;
    // No predictor deltas ever arrived: the energy outlook is empty
    // arrays, not undefined fields or a crashed compile
    assert.deepEqual(payload.energyHourly, []);
    assert.deepEqual(payload.energyEvents, []);
  } finally {
    globalThis.fetch = originalFetch;
    plugin.stop();
  }
});

test("no active route, no delta-fed position: hazard escalation stays quiet", async () => {
  // The escalation matrix with a position track but an empty warning
  // cache raises nothing — pure-function level, since the plugin tick
  // path is covered by the endpoint shape below
  const { escalateHazards } = require("../plugin/hazard-alerts.js");
  const notifications = escalateHazards({
    bulletinBlocks: [],
    vessel: { lat: -18.65, lon: -173.98 },
    navigationState: "moored",
  });
  assert.deepEqual(notifications, []);

  // The endpoint serves the empty active list while offline
  const app = createBareApp();
  const plugin = pluginFactory(app);
  plugin.start({});
  plugin.registerWithRouter(app.router);
  const res = await callRoute(app, "/api/hazards/active");
  assert.deepEqual(res.payload, { notifications: [] });
  plugin.stop();
});

test("factory tolerates a server that exposes getDataDirPath only at start", () => {
  // Signal K calls the plugin factory before the data dir is wired:
  // the hazard ack state used to load at factory time and crashed
  // every start ("app.getDataDirPath is not a function")
  const app = createBareApp();
  const dataDir = app.dataDir;
  delete app.getDataDirPath;
  const plugin = pluginFactory(app); // Factory call must not throw
  app.getDataDirPath = () => dataDir;
  plugin.start({});
  plugin.registerWithRouter(app.router);
  plugin.stop();
});
