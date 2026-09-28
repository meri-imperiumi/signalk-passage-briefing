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
  const putHandlers = {};
  const publishedDeltas = [];
  const resourceProviders = [];
  const mounts = [];
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
    handleMessage: (_source, delta) => publishedDeltas.push(delta),
    registerResourceProvider: (provider) => resourceProviders.push(provider),
    registerPutHandler: (context, path, handler) => {
      putHandlers[path] = { context, handler };
    },
    use: (prefix, handler) => mounts.push({ prefix, handler }),
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
    getPutHandlers: () => putHandlers,
    getPublishedDeltas: () => publishedDeltas,
    getResourceProviders: () => resourceProviders,
    getMounts: () => mounts,
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
    assert.equal(properties.motor_fuel_l_per_hour.default, 1.8);
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

  /** Waits until the predicate holds (refreshes span several event
   * loop turns once the physics module and synoptic fetches join the
   * here path). */
  async function waitFor(predicate, ms = 5000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return predicate();
  }

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
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockOpenMeteo();
    app.debug = (m) => console.error("DBG:", m);
    app.error = (m) => console.error("PLUGIN-ERR:", m);
    try {
      await waitFor(() => /Conditions here cached at/.test(app.getStatus()));
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
      await waitFor(() => /Conditions here cached at/.test(app.getStatus()));
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
    // Failures land in the plugin error state, not the status line
    assert.match(app2.getErrors().join("\n"), /Here refresh failed/);
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

    // Nothing cached yet: empty payload, not an error
    let res = await call("/api/briefing");
    assert.equal(res.code, null);
    assert.equal(res.payload.mode, "here");
    assert.equal(res.payload.payload, null);

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

    // No cache yet: empty payload, not an error
    let res = await call("/api/briefing", { query: { route: "r1" } });
    assert.equal(res.code, null);
    assert.equal(res.payload.payload, null);

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

      // Unknown route briefing: empty payload, not an error
      res = await call("/api/briefing", { query: { route: "nope" } });
      assert.equal(res.code, null);
      assert.equal(res.payload.mode, "route");
      assert.equal(res.payload.payload, null);
      assert.equal(res.payload.cached, false);
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

  test("zone sources: TGFTP fast path and UKHO structured warnings merge", async () => {
    const { mockOpenMeteo } = require("./openmeteo-mock.js");
    const TGFTP_TEXT = [
      "FQPS01 NFFN 011200Z AUG 26",
      "ZCZC GA14",
      "NAVAREA XIV 114/26",
      "GALE WARNING.",
      "DEVELOPING TROUGH T1 WITH GALES WITHIN 120NM",
      "OF AXIS 21S 178W TO 24S 175W.",
      "NNNN",
    ].join("\n");
    const UKHO_JSON = JSON.stringify({
      warnings: [
        {
          text: "NAVAREA XIV 115/26",
          issuedAt: "2026-09-27T10:00:00Z",
          coordinates: [
            [-20.8, -175.6],
            [-21.2, -174.8],
            [-21.6, -175.4],
          ],
        },
        {
          text: "NAVAREA I 1/26",
          issuedAt: "2026-09-27T09:00:00Z",
          coordinates: [[50.0, -5.0]],
        },
      ],
    });

    const app = createMockApp();
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
    plugin.start({
      bulletin_stations: [{ zone: 14, header: "fqps01", station: "NFFN" }],
    });
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

    feed({
      updates: [
        { values: [{ path: "network.internet.state", value: "online" }] },
      ],
    });
    const openMeteoFetch = mockOpenMeteo();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("tgftp.nws.noaa.gov")) {
        return { ok: true, text: async () => TGFTP_TEXT };
      }
      if (u.includes("msi.admiralty.co.uk")) {
        return { ok: true, text: async () => UKHO_JSON };
      }
      if (u.includes("weather.gmdss.org")) {
        throw new Error("portal down");
      }
      return openMeteoFetch(url);
    };
    try {
      const res = await call("/api/briefing/refresh");
      assert.equal(res.code, null);

      // Both ingestion paths merge into one console, track-filtered:
      // the UKHO polygon near Tonga and the TGFTP trough axis band
      // stay, the UKHO warning in the North Sea is dropped
      const briefing = await call("/api/briefing");
      const bulletin = briefing.payload.payload.metareaBulletin;
      assert.ok(bulletin, "bulletin attached");
      const texts = bulletin.blocks.map((b) => b.text);
      assert.ok(texts.includes("NAVAREA XIV 115/26"), "ukho polygon kept");
      assert.ok(!texts.includes("NAVAREA I 1/26"), "ukho far warning dropped");
      assert.ok(
        bulletin.blocks.some((b) => b.text.includes("TROUGH")),
        "tgftp text block kept",
      );
      assert.ok(
        bulletin.blocks.some((b) => b.source === "ukho"),
        "ukho blocks carry their source",
      );
      assert.match(bulletin.header, /NAVAREA XIV/);
      assert.equal(bulletin.issuedAt, "2026-09-27T10:00:00.000Z");

      // Standalone bulletin route serves the merged view too
      const direct = await call("/api/bulletin");
      assert.ok(
        direct.payload.blocks.some((b) => b.source === "ukho"),
        "ukho blocks on the standalone route",
      );
      assert.ok(
        direct.payload.blocks.some((b) => b.text.includes("TROUGH")),
        "tgftp blocks on the standalone route",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    plugin.stop();
  });

  test("synoptic chart: fetched on the online gate, served for the position zone", async () => {
    const { mockOpenMeteo } = require("./openmeteo-mock.js");
    const UTIF = require("../public/vendor/utif/UTIF.js");
    const rgba = new Uint8Array(8 * 4 * 4);
    for (let i = 0; i < 8 * 4; i++) {
      const v = i % 3 === 0 ? 0 : 255;
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
    const tif = Buffer.from(UTIF.encodeImage(rgba, 8, 4));

    const app = createMockApp();
    // Vessel in zone I waters (English Channel)
    app.getSelfPath = (path) =>
      path === "navigation.position"
        ? { latitude: 50.0, longitude: -5.0 }
        : null;
    const plugin = pluginFactory(app);
    plugin.start({});
    plugin.registerWithRouter(app.router);
    const feed = app.getDeltaHandlers()[0];
    const call = async (path) => {
      const [base, qs] = path.split("?");
      const r = app.getRoutes().find((x) => x.path === base);
      const res = {
        code: null,
        payload: null,
        body: null,
        type: null,
        status(c) {
          this.code = c;
          return this;
        },
        json(p) {
          this.payload = p;
        },
        type(t) {
          this.type = t;
          return this;
        },
        send(b) {
          this.body = b;
          return this;
        },
      };
      await r.handler(
        { query: Object.fromEntries(new URLSearchParams(qs ?? "")) },
        res,
      );
      return res;
    };

    feed({
      updates: [
        { values: [{ path: "network.internet.state", value: "online" }] },
      ],
    });
    const openMeteoFetch = mockOpenMeteo();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/fax/")) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => tif,
        };
      }
      return openMeteoFetch(url);
    };
    try {
      // The online transition runs the here refresh, which pulls the
      // zone XIV chart alongside the weather
      await new Promise((resolve) => setTimeout(resolve, 80));
      const res = await call("/api/synoptic");
      assert.equal(res.type, "image/png");
      assert.equal(res.body[0], 0x89);
      assert.ok(res.body.length > 8);

      // Brief meta serves the same view the tile publishes
      const meta = await call("/api/brief-meta");
      assert.equal(meta.payload.comfort, "coffee");
      assert.equal(meta.payload.stale, false);
      assert.equal(meta.payload.ageHours, 0);

      // Explicit zone override and the no-chart case
      const z1 = await call("/api/synoptic?zone=1");
      assert.equal(z1.body[0], 0x89);
      const missing = await call("/api/synoptic?zone=15");
      assert.equal(missing.code, 404);
    } finally {
      globalThis.fetch = originalFetch;
    }

    plugin.stop();
  });

  test("notes: here refresh publishes placeable blocks to resources", async () => {
    const { mockOpenMeteo } = require("./openmeteo-mock.js");
    const TGFTP_TEXT = [
      "FQPS01 NFFN 271800",
      "ZCZC GA14",
      "NAVAREA XIV 114/26",
      "IN THE AREA SOUTH OF 10S AND WEST OF 165W, EXPECT SOUTHEAST WINDS 20",
      "TO 30 KNOTS. ROUGH TO VERY ROUGH SEAS.",
      "NNNN",
    ].join("\n");

    const app = createMockApp();
    app.getSelfPath = (path) =>
      path === "navigation.position"
        ? { latitude: -18.658, longitude: -173.982 }
        : null;
    const plugin = pluginFactory(app);
    plugin.start({});
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
      await r.handler({ query: {} }, res);
      return res;
    };

    feed({
      updates: [
        { values: [{ path: "network.internet.state", value: "online" }] },
      ],
    });
    const openMeteoFetch = mockOpenMeteo();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes("tgftp.nws.noaa.gov")) {
        return { ok: true, text: async () => TGFTP_TEXT };
      }
      return openMeteoFetch(url);
    };
    try {
      const res = await call("/api/briefing/refresh");
      assert.equal(res.code, null);

      // The plugin serves its notes through the registered provider
      const provider = app
        .getResourceProviders()
        .find((p) => p.type === "notes");
      assert.ok(provider, "notes provider registered");
      const listed = await provider.methods.listResources({});
      const metareaIds = Object.keys(listed).filter((id) =>
        id.startsWith("metarea-"),
      );
      assert.equal(metareaIds.length, 1, "one metarea note written");
      const note = listed[metareaIds[0]];
      assert.match(note.description, /SOUTHEAST WINDS/);
      // Position is the center of the quadrant nearest the vessel
      assert.equal(note.position.latitude, -30);
      assert.equal(note.position.longitude, -176.25);
      assert.equal(note.properties.zone, 14);
      assert.equal(note.properties.sourcePlugin, "signalk-passage-briefing");
    } finally {
      globalThis.fetch = originalFetch;
    }

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
    // A naked-eye comet: deterministic (no night gate), so the wiring
    // assertion below holds at any wall-clock time; the aurora path
    // (Kp x magnetic latitude x night) is covered by the unit tests
    const SBDB = JSON.stringify({
      fields: ["full_name", "M1", "K1", "r", "dist"],
      rows: [["C/2026 A1 (Plugin Test)", 4.0, 10, 1.2, 0.5]],
    });
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
        return {
          ok: true,
          status: 200,
          json: async () => JSON.parse(SBDB),
        };
      }
      return mockOpenMeteo()(url, opts);
    };
    try {
      // Space events attach to the here payload. The comet is
      // wall-clock independent; the aurora depends on local night at
      // the vessel and may or may not fire (unit-tested separately)
      await call("/api/briefing/refresh");
      const res = await call("/api/briefing");
      assert.equal(res.code, null);
      const events = res.payload.payload.spaceEvents ?? [];
      const comet = events.find((e) => e.kind === "comet");
      assert.ok(comet, "comet event attached");
      assert.match(comet.description, /C\/2026 A1/);
      for (const e of events.filter((x) => x.kind === "aurora")) {
        assert.equal(e.tactical, true);
        assert.match(e.description, /Look south/);
      }

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

  test("plotter tile: publishes brief meta, acknowledge clears hasNew", async () => {
    const { mockOpenMeteo } = require("./openmeteo-mock.js");
    const app = createMockApp();
    app.resourcesApi = {
      async getResource(resType, resId) {
        if (resType === "routes" && resId === "r1") {
          return {
            name: "Sabado Crossing",
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
    const plugin = pluginFactory(app);
    plugin.start({});
    plugin.registerWithRouter(app.router);
    const feed = app.getDeltaHandlers()[0];
    feed({
      updates: [
        { values: [{ path: "network.internet.state", value: "online" }] },
      ],
    });

    // Providers + asset mount registered: the plotter-extension
    // manifest, the Status Tiles example set, and the notes store
    const providers = app.getResourceProviders();
    assert.equal(providers.length, 3);
    assert.deepEqual(providers.map((p) => p.type).sort(), [
      "notes",
      "plotterExtensions",
      "statusTileExamples",
    ]);
    assert.equal(
      app.getMounts()[0].prefix,
      "/plotterext/signalk-passage-briefing",
    );

    const values = (delta) =>
      Object.fromEntries(delta.updates[0].values.map((v) => [v.path, v.value]));
    const briefValues = () =>
      app
        .getPublishedDeltas()
        .filter((d) =>
          d.updates[0].values.some((v) =>
            v.path.startsWith("navigation.briefing."),
          ),
        )
        .map(values);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockOpenMeteo();
    try {
      const call = async (path, req = { query: {} }) => {
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
        await r.handler(req, res);
        return res;
      };
      await call("/api/briefing/refresh", { query: { route: "r1" } });

      const meta = briefValues().at(-1);
      assert.equal(meta["navigation.briefing.route"], "Sabado Crossing");
      assert.equal(meta["navigation.briefing.hasNew"], true);
      assert.ok(meta["navigation.briefing.generatedAt"]);

      // Acknowledge put clears the NEW badge
      const ack = app.getPutHandlers()["navigation.briefing.acknowledgedAt"];
      assert.ok(ack, "ack put handler registered");
      await ack.handler(
        "vessels.self",
        "navigation.briefing.acknowledgedAt",
        meta["navigation.briefing.generatedAt"],
      );
      const after = briefValues().at(-1);
      assert.equal(after["navigation.briefing.hasNew"], false);
      assert.ok(
        existsSync(join(app.dataDir, "weather", "ack.json")),
        "ack persisted",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Stop empties the provider so hosts tear the context down
    plugin.stop();
    assert.deepEqual(await providers[0].methods.listResources(), {});
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

  test("oneshot fetch falls back to conditions here when the briefed route is gone", async () => {
    const { mockOpenMeteo } = require("./openmeteo-mock.js");
    const app = createMockApp();
    app.getSelfPath = (path) =>
      path === "navigation.position"
        ? { latitude: -21.1, longitude: -175.2 }
        : null;
    // The server no longer knows the last briefed route
    app.resourcesApi = {
      async getResource(resType, resId) {
        throw new Error(`Resource not found! (${resId})`);
      },
    };
    const plugin = pluginFactory(app);
    plugin.start({});

    // Previous session briefed a route that has since been deleted
    mkdirSync(join(app.dataDir, "weather"), { recursive: true });
    writeFileSync(
      join(app.dataDir, "weather", "last-route"),
      "31f1ea06-5efa-4e00-b9c8-8d08e16a40f9",
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockOpenMeteo();
    try {
      app.getDeltaHandlers()[0]({
        updates: [
          {
            values: [{ path: "network.internet.state", value: "online" }],
          },
        ],
      });
      await waitFor(() => /Conditions here cached at/.test(app.getStatus()));
      assert.match(app.getStatus(), /Conditions here cached at/);
      assert.ok(
        existsSync(join(app.dataDir, "weather", "here.json")),
        "conditions here refreshed instead",
      );
      assert.ok(
        !existsSync(join(app.dataDir, "weather", "last-route")),
        "stale last-route pointer removed",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    plugin.stop();
  });
});
