const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { existsSync } = require("node:fs");

const pluginFactory = require("../plugin/index.js");

/**
 * Mock Signal K app following the signalk-internet test pattern.
 */
function createMockApp() {
  let status = "";
  const errors = [];
  const subscriptions = [];
  const deltaHandlers = [];
  const routes = [];
  const dataDir = mkdtempSync(join(tmpdir(), "passage-plugin-"));
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
      subscribe: (subscription, _unsub, _onError, onDelta) => {
        subscriptions.push(subscription);
        deltaHandlers.push(onDelta);
      },
    },
    router: {
      get(path, handler) {
        routes.push({ method: "get", path, handler });
      },
      post(path, handler) {
        routes.push({ method: "post", path, handler });
      },
    },
    dataDir,
    getStatus: () => status,
    getErrors: () => errors,
    getSubscriptions: () => subscriptions,
    getDeltaHandlers: () => deltaHandlers,
    getRoutes: () => routes,
  };
}

describe("plugin", () => {
  test("has correct metadata and the spec configuration schema", () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    assert.equal(plugin.id, "signalk-passage-briefing");
    assert.ok(plugin.name);
    assert.ok(plugin.description);

    const properties = plugin.schema.properties;
    assert.equal(properties.motoring_tws_threshold.default, 3.5);
    assert.equal(properties.drift_mode_enabled.default, true);
    assert.equal(properties.waterline_length_m.default, 9.4);
    assert.ok(properties.spool_directory);
    assert.equal(properties.k_heel.default, 0.35);
    assert.equal(properties.k_pitch.default, 0.4);
  });

  test("starts, creates the sqlite store, and stops cleanly", () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({});
    assert.ok(existsSync(join(app.dataDir, "passage-outlook.sqlite")));
    plugin.stop();
  });

  test("subscribes to the three state machine paths", () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({});
    plugin.stop();

    const [subscription] = app.getSubscriptions();
    assert.equal(subscription.context, "vessels.self");
    const paths = subscription.subscribe.map((s) => s.path);
    assert.deepEqual(paths, [
      "network.internet.state",
      "navigation.state",
      "electrical.batteries.house.capacity.stateOfCharge",
    ]);
  });

  test("internet transition triggers a oneshot fetch via plugin status", async () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({});

    const feed = app.getDeltaHandlers()[0];
    feed({
      updates: [
        {
          values: [
            { path: "network.internet.state", value: "online" },
            { path: "navigation.state", value: "sailing" },
          ],
        },
      ],
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    assert.match(app.getStatus(), /No route briefed yet/);

    // Stable repeat: no new fetch.
    feed({
      updates: [
        { values: [{ path: "network.internet.state", value: "online" }] },
      ],
    });
    await tick();
    assert.match(app.getStatus(), /No route briefed yet/);

    plugin.stop();
  });

  test("ignores unrelated paths and unexpected values", () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({});

    const feed = app.getDeltaHandlers()[0];
    feed({
      updates: [
        { values: [{ path: "environment.wind.speedTrue", value: 5 }] },
        { values: [{ path: "network.internet.state", value: "offline" }] },
      ],
    });
    assert.match(app.getStatus(), /started/);

    plugin.stop();
  });

  test("registers a status route on the plugin router", async () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({});
    app.getDeltaHandlers()[0]({
      updates: [
        {
          values: [
            { path: "network.internet.state", value: "metered" },
            { path: "navigation.state", value: "sailing" },
          ],
        },
      ],
    });
    plugin.registerWithRouter(app.router);

    const route = app.getRoutes().find((r) => r.path === "/api/status");
    assert.ok(route, "status route registered");

    const res = {
      json(payload) {
        this.payload = payload;
      },
    };
    await route.handler({}, res);
    assert.equal(res.payload.state, "STANDBY_OFFSHORE");
    assert.equal(res.payload.nextCronRun, null);

    plugin.stop();
  });

  test("briefing routes: refresh caches, briefing serves the cache, offline refuses", async () => {
    const { mockOpenMeteo } = require("./openmeteo-mock.js");
    const app = createMockApp();
    app.resourcesApi = {
      async getResource(resType, resId) {
        if (resType === "routes" && resId === "r1") {
          return {
            name: "Test crossing",
            feature: {
              geometry: {
                coordinates: [
                  [0, 0],
                  [0, 1.5],
                ],
              },
            },
          };
        }
        throw new Error("not found");
      },
      async listResources(resType) {
        if (resType === "routes") {
          return {
            r1: {
              name: "Test crossing",
              feature: {
                geometry: {
                  coordinates: [
                    [0, 0],
                    [0, 1.5],
                  ],
                },
              },
            },
          };
        }
        return {};
      },
    };
    const plugin = pluginFactory(app);
    plugin.start({});
    plugin.registerWithRouter(app.router);
    const feed = app.getDeltaHandlers()[0];
    const routeCalls = app.getRoutes();
    const call = async (path, req) => {
      const route = routeCalls.find((r) => r.path === path);
      assert.ok(route, `${path} registered`);
      const res = {
        code: null,
        payload: null,
        status(code) {
          this.code = code;
          return this;
        },
        json(payload) {
          this.payload = payload;
        },
      };
      await route.handler(req, res);
      return res;
    };

    // No cache yet
    let res = await call("/api/briefing", { query: { route: "r1" } });
    assert.equal(res.code, 404);

    // Refresh refuses while offline
    feed({
      updates: [
        { values: [{ path: "network.internet.state", value: "offline" }] },
      ],
    });
    res = await call("/api/briefing/refresh", { query: { route: "r1" } });
    assert.equal(res.code, 503);

    // Online: refresh fetches, caches and records the route
    feed({
      updates: [
        { values: [{ path: "network.internet.state", value: "online" }] },
      ],
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockOpenMeteo();
    try {
      res = await call("/api/briefing/refresh", { query: { route: "r1" } });
      assert.equal(res.code, null);
      assert.equal(res.payload.cached, true);
      assert.ok(existsSync(join(app.dataDir, "weather", "latest-r1.json")));

      // The briefing now serves from cache, also after going offline
      feed({
        updates: [
          { values: [{ path: "network.internet.state", value: "offline" }] },
        ],
      });
      res = await call("/api/briefing", { query: { route: "r1" } });
      assert.equal(res.code, null);
      assert.equal(res.payload.online, false);
      assert.equal(res.payload.payload.metadata.source, "api");
      assert.ok(res.payload.cachedAt);

      // Routes listing carries distances
      res = await call("/api/routes", { query: {} });
      assert.equal(res.payload.length, 1);
      assert.ok(
        res.payload[0].distanceNm > 89 && res.payload[0].distanceNm < 91,
      );

      // Unknown route briefing: 404
      res = await call("/api/briefing", { query: { route: "nope" } });
      assert.equal(res.code, 404);
    } finally {
      globalThis.fetch = originalFetch;
    }

    plugin.stop();
  });
});
