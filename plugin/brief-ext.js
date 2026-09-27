/**
 * Plotter-extension integration (work doc #8): exposes the passage
 * briefing as a Plotter Extensions API v1 extension so a fresh brief
 * shows up as a tile on the chart plotter. Follows the proven
 * in-family pattern from signalk-dead-reckoning's `plotterext.js`.
 *
 * Two server-side responsibilities:
 *
 * 1. A read-only `plotterExtensions` resource provider whose single
 *    entry is the manifest — presence is the enablement signal, and
 *    the provider goes empty on plugin stop so hosts tear the
 *    contexts down.
 * 2. The extension's iframe assets served at a publicly readable,
 *    non-admin-gated prefix (`/plugins/*` is admin-only and `express`
 *    is not resolvable from a plugin's own tree, hence the minimal
 *    static handler).
 *
 * @file brief-ext.js
 */

const path = require("node:path");
const fs = require("node:fs");
const pkg = require("../package.json");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

/** Content types for the extension's asset kinds (inert UI code). */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Builds the extension manifest (Plotter Extensions API v1). The
 * `panels.iframe` capability is declared optional pending the v1
 * widget→host open-panel settlement; without it the tile falls back
 * to opening the brief webapp URL in a new browser context.
 *
 * @param {string} assetBase - server-relative URL prefix for assets
 * @param {string} version - plugin version for display metadata
 * @returns {object}
 */
function buildManifest(assetBase, version) {
  return {
    name: "Passage Briefing",
    description:
      "Passage brief tile: freshness of the latest compiled brief at a glance, one tap to the full briefing.",
    version,
    apiVersion: "1",
    requires: ["widgets", "signalk.stream"],
    optional: ["nightMode", "panels.iframe", "signalk.put"],
    widgets: [
      {
        id: "passage-brief-tile",
        title: "Passage Brief",
        type: "iframe",
        // ?v= cache-busts the host's iframe when the plugin updates
        url: `${assetBase}/brief-ext-widget.html?v=${version}`,
        size: "1x1",
        lifecycle: "whileEnabled",
      },
    ],
  };
}

/**
 * Minimal static-asset middleware: only regular files directly under
 * `root` are served (traversal-guarded; anything else falls through).
 *
 * @param {string} root - absolute directory to serve
 * @param {string} assetBase - mount prefix, stripped when present
 * @returns {(req: object, res: object, next: Function) => void}
 */
function staticAssetHandler(root, assetBase) {
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  return (req, res, next) => {
    let urlPath = req.path ?? req.url ?? "/";
    const q = urlPath.indexOf("?");
    if (q >= 0) urlPath = urlPath.slice(0, q);
    if (urlPath.startsWith(assetBase)) {
      urlPath = urlPath.slice(assetBase.length);
    }
    if (!urlPath.startsWith("/")) urlPath = `/${urlPath}`;

    let resolved;
    try {
      resolved = path.normalize(
        path.join(rootPrefix, decodeURIComponent(urlPath)),
      );
    } catch {
      next(); // malformed percent-encoding
      return;
    }
    if (!resolved.startsWith(rootPrefix)) {
      next(); // traversal attempt
      return;
    }

    fs.stat(resolved, (err, st) => {
      if (err || !st.isFile()) {
        next();
        return;
      }
      res.statusCode = 200;
      res.setHeader(
        "Content-Type",
        MIME[path.extname(resolved)] ?? "application/octet-stream",
      );
      res.setHeader("Cache-Control", "public, max-age=3600");
      fs.readFile(resolved, (readErr, data) => {
        if (readErr) {
          next();
          return;
        }
        res.end(data);
      });
    });
  };
}

/**
 * Registers the plotter-extension provider and mounts the asset
 * route.
 *
 * @param {import("@signalk/server-api").ServerAPI} app
 * @param {{id: string, version?: string}} opts
 * @returns {() => void} teardown — empties the provider listing
 */
function registerPlotterExtension(app, opts) {
  const { id } = opts;
  const version = opts.version ?? pkg.version;
  const assetBase = `/plotterext/${id}`;
  const manifest = buildManifest(assetBase, version);
  let running = true;

  app.registerResourceProvider({
    type: "plotterExtensions",
    methods: {
      listResources: async () => (running ? { [id]: manifest } : {}),
      getResource: async (resourceId) => {
        if (!running || resourceId !== id) {
          throw new Error(`No such plotterExtensions resource: ${resourceId}`);
        }
        return manifest;
      },
      setResource: async () => {
        throw new Error(`${id} is a read-only provider`);
      },
      deleteResource: async () => {
        throw new Error(`${id} is a read-only provider`);
      },
    },
  });

  app.use(assetBase, staticAssetHandler(PUBLIC_DIR, assetBase));

  return () => {
    running = false;
  };
}

module.exports = {
  buildManifest,
  registerPlotterExtension,
  staticAssetHandler,
};
