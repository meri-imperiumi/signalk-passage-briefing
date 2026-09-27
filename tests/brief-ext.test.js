const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildManifest,
  registerPlotterExtension,
  staticAssetHandler,
} = require("../plugin/brief-ext.js");
const { tileModel, briefAge } = require("../public/brief-ext-model.js");

const PLUGIN_ID = "signalk-passage-briefing";
const ASSET_BASE = `/plotterext/${PLUGIN_ID}`;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

describe("plotter-extension manifest & provider (doc #8)", () => {
  test("manifest targets plotter extension API v1", () => {
    const m = buildManifest(ASSET_BASE, "1.2.3");
    assert.equal(m.apiVersion, "1");
    assert.equal(m.name, "Passage Briefing");
    assert.equal(m.version, "1.2.3");
    assert.ok(m.description.length > 0);
  });

  test("manifest requires the widget grid and the SK relay", () => {
    const m = buildManifest(ASSET_BASE, "1.2.3");
    assert.ok(m.requires.includes("widgets"));
    assert.ok(m.requires.includes("signalk.stream"));
    for (const cap of m.optional ?? []) {
      assert.ok(!m.requires.includes(cap));
    }
  });

  test("manifest contributes a valid 1x1 iframe widget", () => {
    const m = buildManifest(ASSET_BASE, "1.2.3");
    assert.equal(m.widgets.length, 1);
    const [w] = m.widgets;
    assert.equal(w.id, "passage-brief-tile");
    assert.equal(w.type, "iframe");
    assert.equal(w.size, "1x1");
    assert.equal(w.lifecycle, "whileEnabled");
    assert.ok(w.url.startsWith(`${ASSET_BASE}/`));
  });

  test("provider serves the manifest and empties on teardown", async () => {
    const providers = [];
    const mounts = [];
    const app = {
      registerResourceProvider: (p) => providers.push(p),
      use: (prefix, handler) => mounts.push({ prefix, handler }),
    };
    const teardown = registerPlotterExtension(app, { id: PLUGIN_ID });
    assert.equal(providers.length, 1);
    assert.equal(providers[0].type, "plotterExtensions");
    assert.equal(mounts[0].prefix, ASSET_BASE);

    const manifest = await providers[0].methods.getResource(PLUGIN_ID);
    assert.equal(manifest.name, "Passage Briefing");
    const listing = await providers[0].methods.listResources();
    assert.deepEqual(Object.keys(listing), [PLUGIN_ID]);

    // Read-only
    await assert.rejects(
      () => providers[0].methods.setResource(PLUGIN_ID, {}),
      /read-only/,
    );

    teardown();
    assert.deepEqual(
      await providers[0].methods.listResources(),
      {},
      "provider empty after teardown",
    );
    await assert.rejects(() => providers[0].methods.getResource(PLUGIN_ID));
  });

  test("static handler serves known assets with traversal guard", () => {
    const handler = staticAssetHandler(PUBLIC_DIR, ASSET_BASE);
    const next = () => {
      throw new Error("should have been handled");
    };

    const serve = (urlPath) =>
      new Promise((resolve) => {
        const chunks = [];
        const res = {
          statusCode: 0,
          headers: {},
          setHeader(k, v) {
            this.headers[k] = v;
          },
          end(data) {
            chunks.push(data);
            resolve({
              status: this.statusCode,
              type: this.headers["Content-Type"],
              body: Buffer.concat(chunks),
            });
          },
        };
        handler({ path: urlPath }, res, next);
      });

    const fallthrough = (urlPath) =>
      new Promise((resolve) => {
        const res = {
          statusCode: 0,
          setHeader() {},
          end() {},
        };
        handler({ path: urlPath }, res, () => resolve(true));
        // If neither end nor next fired within a tick, resolve false
        setTimeout(() => resolve(false), 50);
      });

    return (async () => {
      const widget = await serve(`${ASSET_BASE}/brief-ext-widget.html`);
      assert.equal(widget.status, 200);
      assert.match(widget.type, /text\/html/);
      assert.ok(widget.body.includes("brief-ext-widget"));

      // Traversal attempt falls through, never escapes the root
      assert.ok(
        await fallthrough(`${ASSET_BASE}/../plugin/index.js`),
        "traversal attempt falls through",
      );

      // Unknown file falls through
      assert.ok(await fallthrough(`${ASSET_BASE}/nope.js`));
    })();
  });
});

describe("brief tile model (doc #8)", () => {
  const NOW = new Date("2026-09-27T12:00:00Z");

  test("no compiled brief renders muted with no badge", () => {
    const model = tileModel(
      { generatedAt: null, route: null, hasNew: null },
      NOW,
    );
    assert.equal(model.severity, "muted");
    assert.equal(model.badge, false);
    assert.equal(model.title, "No brief");
    assert.equal(briefAge(null, NOW), "");
  });

  test("available brief shows route name and age", () => {
    const model = tileModel({
      generatedAt: "2026-09-27T09:00:00Z",
      route: "Tonga to Opua",
      hasNew: false,
      now: NOW,
    });
    assert.equal(model.severity, "ok");
    assert.equal(model.badge, false);
    assert.equal(model.title, "Tonga to Opua");
    assert.equal(model.detail, "3 h old");
  });

  test("new brief flags the badge until acknowledged", () => {
    const model = tileModel({
      generatedAt: "2026-09-27T11:45:00Z",
      route: "",
      hasNew: true,
      now: NOW,
    });
    assert.equal(model.severity, "new");
    assert.equal(model.badge, true);
    // Here mode: empty route falls back to the generic title
    assert.equal(model.title, "Passage brief");
    assert.equal(model.detail, "15 m old");
  });

  test("age buckets minutes, hours and days", () => {
    assert.equal(briefAge("2026-09-27T11:48:00Z", NOW), "12 m old");
    assert.equal(briefAge("2026-09-27T06:00:00Z", NOW), "6 h old");
    assert.equal(briefAge("2026-09-25T12:00:00Z", NOW), "2 d old");
  });
});

// The static-handler test asserts against a real file; make sure the
// asset it needs actually shipped.
assert.ok(
  fs.existsSync(path.join(PUBLIC_DIR, "brief-ext-widget.html")),
  "widget HTML exists in public/",
);
assert.ok(
  fs.existsSync(
    path.join(PUBLIC_DIR, "vendor", "plotterext-bus", "extension.js"),
  ),
  "vendored bus client exists",
);
