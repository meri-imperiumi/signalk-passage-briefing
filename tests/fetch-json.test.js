/**
 * Smoketests for the webapp's fetchJson error plumbing
 * (`public/components/sk-api.js`). The component layer is a browser
 * module (ESM in a `.js` file, no package `type: module`), so the
 * shipped source is imported through a data URL — the real code runs,
 * served against a local HTTP server.
 *
 * @file Tests the non-ok body surfacing: server error bodies carry the
 * actionable part (work doc #55 session sea trial — the refresh
 * button's "502 Bad Gateway" toast hid a "Route …#72 not found" the
 * plugin had answered all along).
 */

const test = require("node:test");
const assert = require("node:assert");
const { createServer } = require("node:http");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

/** The real browser module's source, imported as a data URL module. */
async function loadFetchJson() {
  const source = readFileSync(
    join(__dirname, "..", "public", "components", "sk-api.js"),
    "utf8",
  );
  // The file's own import specifiers are relative; this module has
  // none (pure REST plumbing), so the data URL import is safe. A
  // relative import appearing later would fail loudly here — the
  // smoketest guards the file it tests.
  if (/^\s*import\s/m.test(source) || /from\s+["']\./.test(source)) {
    throw new Error("sk-api.js grew imports — data URL import invalid");
  }
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const module = await import(dataUrl);
  return module.fetchJson;
}

/** Local HTTP server answering one configured response. */
function serveOnce(status, contentType, body) {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": contentType });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      resolve({
        url,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("fetchJson surfaces the server error body's message", async () => {
  const fetchJson = await loadFetchJson();
  const { url, close } = await serveOnce(
    502,
    "application/json",
    JSON.stringify({
      error: "Route 3547c5b7-d1fc-4a9f-a415-533f16fe4d04#72 not found",
    }),
  );
  try {
    await assert.rejects(
      fetchJson(url),
      (error) =>
        error.message ===
        "502 Bad Gateway — Route 3547c5b7-d1fc-4a9f-a415-533f16fe4d04#72 not found",
    );
  } finally {
    await close();
  }
});

test("fetchJson surfaces an Open-Meteo-style reason field", async () => {
  const fetchJson = await loadFetchJson();
  const { url, close } = await serveOnce(
    400,
    "application/json",
    JSON.stringify({ error: true, reason: "Cannot initialize ChargingDomain" }),
  );
  try {
    await assert.rejects(
      fetchJson(url),
      (error) =>
        error.message === "400 Bad Request — Cannot initialize ChargingDomain",
    );
  } finally {
    await close();
  }
});

test("fetchJson falls back to the status line for non-JSON bodies", async () => {
  const fetchJson = await loadFetchJson();
  const { url, close } = await serveOnce(
    502,
    "text/html",
    "<html><body>502 Bad Gateway</body></html>",
  );
  try {
    await assert.rejects(
      fetchJson(url),
      (error) => error.message === "502 Bad Gateway",
    );
  } finally {
    await close();
  }
});

test("fetchJson truncates overly long error details", async () => {
  const fetchJson = await loadFetchJson();
  const detail = "x".repeat(500);
  const { url, close } = await serveOnce(
    500,
    "application/json",
    JSON.stringify({ error: detail }),
  );
  try {
    await assert.rejects(
      fetchJson(url),
      (error) =>
        error.message.startsWith("500 Internal Server Error — ") &&
        error.message.length <= "500 Internal Server Error — ".length + 200,
    );
  } finally {
    await close();
  }
});

test("fetchJson still parses happy-path responses", async () => {
  const fetchJson = await loadFetchJson();
  const { url, close } = await serveOnce(
    200,
    "application/json",
    JSON.stringify({ online: true }),
  );
  try {
    assert.deepEqual(await fetchJson(url), { online: true });
  } finally {
    await close();
  }
});
