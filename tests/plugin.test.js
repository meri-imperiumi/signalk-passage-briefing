const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

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

  test("subscribes to the state machine and active-route paths", () => {
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
      "navigation.course.activeRoute",
    ]);
  });

  test("internet transition with no route briefs conditions here", async () => {
    const { mockOpenMeteo } = require("./openmeteo-mock.js");
    const app = createMockApp();
    app.getSelfPath = (path) =>
      path === "navigation.position"
        ? { latitude: -21.1, longitude: -175.2 }
        : null;
    const plugin = pluginFactory(app);
    plugin.start({});

    const feed = app.getDeltaHandlers()[0];
    feed({
      updates: [
        {
          values: [
            { path: "network.internet.state", value: "online" },
            { path: "navigation.state", value: "moored" },
          ],
        },
      ],
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 60));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockOpenMeteo();
    try {
      await tick();
      assert.match(app.getStatus(), /Conditions here cached at/);
      assert.ok(
        existsSync(join(app.dataDir, "weather", "here.json")),
        "here payload cached",
      );

      // Stable repeat: re-briefs rather than dead-ending.
      feed({
        updates: [
          { values: [{ path: "network.internet.state", value: "online" }] },
        ],
      });
      await tick();
      assert.match(app.getStatus(), /Conditions here cached at/);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // No position: the here refresh degrades to a status note
    const app2 = createMockApp();
    const plugin2 = pluginFactory(app2);
    plugin2.start({});
    app2.getDeltaHandlers()[0]({
      updates: [
        { values: [{ path: "network.internet.state", value: "online" }] },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.match(app2.getStatus(), /Here refresh failed/);
    plugin2.stop();

    plugin.stop();
  });

  test("here mode: served from cache with mode marker and refreshed online", async () => {
    const { mockOpenMeteo } = require("./openmeteo-mock.js");
    const app = createMockApp();
    app.getSelfPath = (path) =>
      path === "navigation.position"
        ? { latitude: -21.1, longitude: -175.2 }
        : null;
    const plugin = pluginFactory(app);
    plugin.start({});
    plugin.registerWithRouter(app.router);
    const feed = app.getDeltaHandlers()[0];
    const call = async (path, req = { query: {} }) => {
      const route = app.getRoutes().find((r) => r.path === path);
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

    feed({
      updates: [
        { values: [{ path: "network.internet.state", value: "online" }] },
      ],
    });

    // Nothing cached yet
    let res = await call("/api/briefing");
    assert.equal(res.code, 404);

    const originalFetch = globalThis.fetch;
    let forecastCalls = 0;
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes("/v1/forecast")) {
        forecastCalls += 1;
      }
      return mockOpenMeteo()(url, opts);
    };
    try {
      // Refresh without a route targets here mode
      res = await call("/api/briefing/refresh");
      assert.equal(res.code, null);
      assert.equal(res.payload.mode, "here");
      assert.ok(res.payload.cachedAt);
      assert.ok(forecastCalls >= 1, "forecast fetched for here mode");

      // Served with the here marker, one waypoint at the vessel
      res = await call("/api/briefing");
      assert.equal(res.code, null);
      assert.equal(res.payload.mode, "here");
      assert.equal(res.payload.stale, false);
      assert.equal(res.payload.payload.waypoints.length, 1);
      assert.equal(res.payload.payload.waypoints[0].lat, -21.1);
      assert.equal(res.payload.payload.waypoints[0].lon, -175.2);
      assert.equal(res.payload.payload.metadata.mode, "here");

      // Offline: the cache still serves
      feed({
        updates: [
          { values: [{ path: "network.internet.state", value: "offline" }] },
        ],
      });
      res = await call("/api/briefing");
      assert.equal(res.code, null);
      assert.equal(res.payload.online, false);
      assert.equal(res.payload.mode, "here");
      feed({
        updates: [
          { values: [{ path: "network.internet.state", value: "online" }] },
        ],
      });

      // Route briefing still wins when requested explicitly
      app.resourcesApi = {
        async getResource(resType, resId) {
          if (resType === "routes" && resId === "r1") {
            return {
              name: "Test",
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
      };
      res = await call("/api/briefing/refresh", { query: { route: "r1" } });
      assert.equal(res.code, null);
      res = await call("/api/briefing", { query: { route: "r1" } });
      assert.equal(res.payload.mode, "route");
      assert.equal(res.payload.routeId, "r1");

      // The active route wins over here mode without an explicit one
      feed({
        updates: [
          {
            values: [
              {
                path: "navigation.course.activeRoute",
                value: { href: "/resources/routes/r1" },
              },
            ],
          },
        ],
      });
      res = await call("/api/briefing");
      assert.equal(res.payload.mode, "route");
      assert.equal(res.payload.routeId, "r1");
    } finally {
      globalThis.fetch = originalFetch;
    }

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

  test("active route: resolved from deltas and surfaced in status and routes", async () => {
    const app = createMockApp();
    app.resourcesApi = {
      async listResources(resType) {
        if (resType === "routes") {
          return {
            r1: {
              name: "Crossing",
              feature: {
                geometry: {
                  coordinates: [
                    [0, 0],
                    [0, 1],
                  ],
                },
              },
            },
            r2: {
              name: "Other",
              feature: {
                geometry: {
                  coordinates: [
                    [0, 0],
                    [1, 0],
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
    const call = async (path) => {
      const route = app.getRoutes().find((r) => r.path === path);
      const res = {
        json(p) {
          this.payload = p;
        },
      };
      await route.handler({}, res);
      return res.payload;
    };

    assert.equal((await call("/api/status")).activeRouteId, null);

    // Whole-node wrapped delta form ({value: {href…}})
    feed({
      updates: [
        {
          values: [
            {
              path: "navigation.course.activeRoute",
              value: { href: "/resources/routes/r2", pointIndex: 1 },
            },
          ],
        },
      ],
    });
    assert.equal((await call("/api/status")).activeRouteId, "r2");
    const routes = await call("/api/routes");
    assert.deepEqual(
      routes.filter((r) => r.active).map((r) => r.id),
      ["r2"],
    );

    plugin.stop();

    // Leaf-wrapped form ({href: {value…}}) via getSelfPath fallback
    // on an app that has seen no delta for the path
    const app2 = createMockApp();
    app2.getSelfPath = (path) =>
      path === "navigation.course.activeRoute"
        ? { href: { value: "/signalk/v1/api/resources/routes/r1" } }
        : null;
    const plugin2 = pluginFactory(app2);
    plugin2.start({});
    plugin2.registerWithRouter(app2.router);
    const res = {
      json(p) {
        this.payload = p;
      },
    };
    await app2
      .getRoutes()
      .find((r) => r.path === "/api/status")
      .handler({}, res);
    assert.equal(res.payload.activeRouteId, "r1");

    plugin2.stop();
  });

  test("polar route: resolves the active polar, null when none", async () => {
    const TABLE = {
      kind: "polarTable",
      axes: { tws: [5.14], twa: [1.047] },
      values: { boatSpeedMatrix: [[3.29]] },
      symmetry: { portStarboardSymmetric: true },
    };
    const app = createMockApp();
    app.resourcesApi = {
      async getResource(resType, resId) {
        if (resType === "polars" && resId === "lille-o") {
          return TABLE;
        }
        throw new Error("not found");
      },
    };
    app.getSelfPath = (path) => {
      if (path === "polars.activePolar") {
        return { value: { href: "/resources/polars/lille-o" } };
      }
      if (path === "polars.performanceFactor") {
        return { value: 0.9 };
      }
      return null;
    };
    const plugin = pluginFactory(app);
    plugin.start({});
    plugin.registerWithRouter(app.router);
    const route = app.getRoutes().find((r) => r.path === "/api/polar");
    const res = {
      json(payload) {
        this.payload = payload;
      },
    };
    await route.handler({}, res);
    assert.equal(res.payload.id, "lille-o");
    assert.equal(res.payload.table, TABLE);
    assert.equal(res.payload.performanceFactor, 0.9);

    // No active polar → null, not an error
    app.getSelfPath = () => null;
    const res2 = {
      json(p) {
        this.payload = p;
      },
    };
    await route.handler({}, res2);
    assert.equal(res2.payload, null);

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

  test("bulletins: fetched online, filtered per route, served and spliced", async () => {
    const { mockOpenMeteo } = require("./openmeteo-mock.js");
    const NAVAREA = [
      "FQPS01 NFFN 011200Z AUG 26",
      "ZCZC GA14",
      "011200Z AUG 26",
      "NAVAREA XIV 114/26",
      "GALE WARNING",
      "PART 1 WARNING",
      "DEVELOPING TROUGH T1 WITH SQUALLS AND GALES WITHIN 120NM",
      "EAST OF AXIS 16S 170E TO 20S 178W TO 25S 175W.",
      "EXPECT WINDS 35 KNOTS. ROUGH SEAS.",
      "PARTS 2 AND 3 SYNOPSIS AND FORECAST",
      "SITUATION IS MODERATE OVER REMAINDER WATERS.",
      "NNNN",
    ].join("\n");

    const app = createMockApp();
    // Tonga → Opua: crosses the antimeridian
    const route = {
      name: "Tonga to Opua",
      feature: {
        geometry: {
          coordinates: [
            [-175.2, -21.1],
            [174.3, -35.3],
          ],
        },
      },
    };
    app.resourcesApi = {
      async getResource(resType, resId) {
        if (resType === "routes" && resId === "r1") {
          return route;
        }
        throw new Error("not found");
      },
    };
    const plugin = pluginFactory(app);
    plugin.start({ bulletin_urls: ["https://met.test/navarea.txt"] });
    plugin.registerWithRouter(app.router);
    const feed = app.getDeltaHandlers()[0];
    const call = async (path) => {
      const r = app.getRoutes().find((x) => x.path === path);
      const res = {
        code: null,
        payload: null,
        status(c) {
          this.code = c;
          return this;
        },
        json(p) {
          this.payload = p;
        },
      };
      await r.handler({ query: { route: "r1" } }, res);
      return res;
    };

    // Offline: bulletin refresh refuses, briefing refresh refuses
    feed({
      updates: [
        { values: [{ path: "network.internet.state", value: "offline" }] },
      ],
    });
    let res = await call("/api/bulletin/refresh");
    assert.equal(res.code, 503);

    // Online: the combined fetch serves Open-Meteo + the bulletin
    feed({
      updates: [
        { values: [{ path: "network.internet.state", value: "online" }] },
      ],
    });
    const openMeteoFetch = mockOpenMeteo();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes("met.test")) {
        return {
          ok: true,
          text: async () => NAVAREA,
          json: async () => ({}),
        };
      }
      return openMeteoFetch(url, opts);
    };
    try {
      res = await call("/api/bulletin/refresh");
      assert.equal(res.code, null);
      assert.deepEqual(res.payload.fetched, ["https://met.test/navarea.txt"]);

      // Briefing refresh attaches the filtered bulletin to the payload
      res = await call("/api/briefing/refresh");
      assert.equal(res.code, null);

      res = await call("/api/briefing");
      const bulletin = res.payload.payload.metareaBulletin;
      assert.ok(bulletin, "bulletin attached");
      assert.equal(bulletin.source, "api");
      assert.equal(bulletin.blocks.length > 0, true);
      const trough = bulletin.blocks.find((b) => b.text.includes("TROUGH"));
      assert.ok(trough, "trough block intersects the Tonga track");
      assert.equal(trough.geometryType, "polygon");
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Standalone bulletin route serves the filtered view too
    res = await call("/api/bulletin");
    assert.ok(res.payload, "bulletin served");
    assert.ok(res.payload.blocks.some((b) => b.text.includes("TROUGH")));

    plugin.stop();
  });

  test("space events: attached to here briefings, degraded when endpoints fail", async () => {
    const { mockOpenMeteo } = require("./openmeteo-mock.js");
    // Forecast rows inside the 24h forward window relative to now
    const iso = (offsetHours) =>
      new Date(Date.now() + offsetHours * 3600000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "");
    const KP = JSON.stringify([
      { time_tag: iso(-3), kp: 2, observed: "observed" },
      { time_tag: iso(3), kp: 9, observed: "predicted" },
    ]);
    const app = createMockApp();
    app.getSelfPath = (path) => {
      if (path === "navigation.position") {
        return { latitude: -50, longitude: 170 };
      }
      return null;
    };
    const plugin = pluginFactory(app);
    plugin.start({});
    plugin.registerWithRouter(app.router);
    const feed = app.getDeltaHandlers()[0];
    const call = async (path, req = { query: {} }) => {
      const route = app.getRoutes().find((r) => r.path === path);
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
    feed({
      updates: [
        { values: [{ path: "network.internet.state", value: "online" }] },
      ],
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("swpc.noaa.gov")) {
        return {
          ok: true,
          status: 200,
          json: async () => JSON.parse(KP),
        };
      }
      if (u.includes("ssd-api.jpl.nasa.gov")) {
        throw new Error("network down");
      }
      return mockOpenMeteo()(url, opts);
    };
    try {
      // Cached space events are filtered against the position: here
      // mode stores them on the payload; stale-cache splice keeps the
      // freshest events through offline hours
      await call("/api/briefing/refresh");
      const res = await call("/api/briefing");
      assert.equal(res.code, null);
      const events = res.payload.payload.spaceEvents ?? [];
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, "aurora");
      assert.equal(events[0].tactical, true);
      assert.match(events[0].description, /Look south/);

      // Endpoints down: refresh still succeeds, events degrade to none
      globalThis.fetch = async (url, opts) => {
        if (
          String(url).includes("swpc.noaa.gov") ||
          String(url).includes("ssd-api.jpl.nasa.gov")
        ) {
          throw new Error("network down");
        }
        return mockOpenMeteo()(url, opts);
      };
      const res2 = await call("/api/briefing/refresh");
      assert.equal(res2.code, null);
      const res3 = await call("/api/briefing");
      assert.deepEqual(res3.payload.payload.spaceEvents, []);
    } finally {
      globalThis.fetch = originalFetch;
    }

    plugin.stop();
  });

  test("oneshot fetch prefers the active route over the last briefed one", async () => {
    const { mockOpenMeteo } = require("./openmeteo-mock.js");
    const app = createMockApp();
    const geometry = (lat) => ({
      feature: {
        geometry: {
          coordinates: [
            [0, 0],
            [0, lat],
          ],
        },
      },
    });
    app.resourcesApi = {
      async getResource(resType, resId) {
        if (resType === "routes" && resId === "r1") {
          return { name: "Old", ...geometry(1.5) };
        }
        if (resType === "routes" && resId === "r2") {
          return { name: "Active", ...geometry(1.2) };
        }
        throw new Error("not found");
      },
    };
    const plugin = pluginFactory(app);
    plugin.start({});

    // Previous session briefed r1
    mkdirSync(join(app.dataDir, "weather"), { recursive: true });
    writeFileSync(join(app.dataDir, "weather", "last-route"), "r1");

    // Now sailing r2 while the link comes up
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockOpenMeteo();
    try {
      app.getDeltaHandlers()[0]({
        updates: [
          {
            values: [
              { path: "network.internet.state", value: "online" },
              {
                path: "navigation.course.activeRoute",
                value: { href: "/resources/routes/r2" },
              },
            ],
          },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(
      existsSync(join(app.dataDir, "weather", "latest-r2.json")),
      "active route r2 briefed",
    );
    assert.ok(
      !existsSync(join(app.dataDir, "weather", "latest-r1.json")),
      "stale r1 not re-briefed",
    );
    assert.ok(existsSync(join(app.dataDir, "weather", "last-route")));
    assert.equal(
      readFileSync(join(app.dataDir, "weather", "last-route"), "utf8"),
      "r2",
    );

    plugin.stop();
  });
});
