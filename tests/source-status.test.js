const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { readFile } = require("node:fs/promises");

const {
  classifyError,
  createSourceStatus,
  statusPath,
} = require("../plugin/source-status.js");

describe("source status classifier (work doc #23)", () => {
  test("buckets the fetch engine's describe() strings", () => {
    // "<url> returned <status>: <detail>" — fetch-engine.js §status
    assert.equal(
      classifyError(new Error("https://x returned 404: not found")),
      "http-404",
    );
    assert.equal(
      classifyError(new Error("https://x returned 429: slow down")),
      "http-429",
    );
    assert.equal(
      classifyError(new Error("https://x returned 503: upstream busy")),
      "http-5xx",
    );
    assert.equal(
      classifyError(new Error("https://x returned 403: forbidden")),
      "http-4xx",
    );
  });

  test("buckets plain fetcher status strings and transport errors", () => {
    assert.equal(classifyError(new Error("404 Not Found")), "http-404");
    assert.equal(
      classifyError(new Error("503 Service Unavailable")),
      "http-5xx",
    );
    assert.equal(classifyError(new Error("400 Bad Request")), "http-4xx");
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    assert.equal(classifyError(abort), "timeout");
    assert.equal(classifyError(new Error("Timeout reached")), "timeout");
    assert.equal(classifyError(new Error("fetch failed")), "network");
    assert.equal(
      classifyError(new Error("getaddrinfo ENOTFOUND example.com")),
      "network",
    );
    assert.equal(
      classifyError(new Error("connect ECONNREFUSED 1.2.3.4:443")),
      "network",
    );
    assert.equal(
      classifyError(new Error("unable to verify the first certificate")),
      "network",
    );
  });

  test("buckets parse failures from the raster converter and JSON", () => {
    assert.equal(classifyError(new Error("unsupported chart format")), "parse");
    assert.equal(
      classifyError(new Error("Unexpected token < in JSON")),
      "parse",
    );
  });

  test("unknown messages default to network; null errs safe", () => {
    assert.equal(classifyError(new Error("something odd happened")), "network");
    assert.equal(classifyError(null), "network");
  });
});

describe("source status registry (work doc #23)", () => {
  const NOW = new Date("2026-10-03T06:00:00Z");

  test("ok then fail: consecutive failures count, success resets", () => {
    const registry = createSourceStatus({});
    const meta = { id: "hazard-gdacs", label: "GDACS", kind: "hazard" };
    registry.record({ ...meta, now: NOW });
    registry.record({ ...meta, error: new Error("returned 404"), now: NOW });
    registry.record({ ...meta, error: new Error("fetch failed"), now: NOW });
    const entry = registry.list().find((e) => e.id === "hazard-gdacs");
    assert.equal(entry.consecutiveFailures, 2);
    assert.equal(entry.lastStatus, "fail");
    assert.equal(entry.lastError.class, "network");
    assert.equal(entry.lastSuccessAt, "2026-10-03T06:00:00.000Z");
    registry.record({ ...meta, now: NOW });
    assert.equal(entry.consecutiveFailures, 0);
    assert.equal(entry.lastError, null);
    assert.equal(entry.lastStatus, "ok");
  });

  test("skip records the cycle but freezes success and failure state", () => {
    const registry = createSourceStatus({});
    const meta = { id: "weather-track", label: "Weather", kind: "weather" };
    registry.record({ ...meta, now: NOW });
    registry.record({ ...meta, error: new Error("returned 404"), now: NOW });
    const before = registry.list()[0];
    registry.record({ ...meta, skip: true, now: NOW });
    const entry = registry.list()[0];
    assert.equal(entry.lastStatus, "skip");
    assert.equal(entry.consecutiveFailures, 1, "failure count frozen");
    assert.equal(entry.lastError.class, "http-404", "last error kept");
    assert.equal(entry.lastSuccessAt, before.lastSuccessAt);
  });

  test("absent marks optional sources without failing them", () => {
    const registry = createSourceStatus({});
    registry.record({
      id: "sk-polar",
      label: "Active polar",
      kind: "signalk",
      absent: true,
      now: NOW,
    });
    const entry = registry.list()[0];
    assert.equal(entry.lastStatus, "absent");
    assert.equal(entry.lastError, null);
    assert.equal(entry.consecutiveFailures, 0);
  });

  test("errorClass override records the unavailable class", () => {
    const registry = createSourceStatus({});
    registry.record({
      id: "sk-internet-state",
      label: "Internet state",
      kind: "signalk",
      error: new Error("No value received since startup"),
      errorClass: "unavailable",
      now: NOW,
    });
    assert.equal(registry.list()[0].lastError.class, "unavailable");
  });

  test("define seeds entries without clobbering recorded state", () => {
    const registry = createSourceStatus({});
    registry.record({
      id: "hazard-gdacs",
      label: "GDACS",
      kind: "hazard",
      error: new Error("returned 404"),
      now: NOW,
    });
    registry.define({ id: "hazard-gdacs", label: "GDACS hazards" });
    const entry = registry.list()[0];
    assert.equal(entry.label, "GDACS hazards", "metadata refreshed");
    assert.equal(entry.lastStatus, "fail", "state untouched");
    assert.equal(entry.consecutiveFailures, 1);
  });

  test("list is stable-ordered by id and includes unattempted sources", () => {
    const registry = createSourceStatus({});
    registry.define({ id: "weather-track", label: "Weather" });
    registry.define({ id: "hazard-gdacs", label: "GDACS" });
    assert.deepEqual(
      registry.list().map((e) => e.id),
      ["hazard-gdacs", "weather-track"],
    );
    assert.equal(registry.list()[1].lastStatus, null);
    assert.equal(registry.list()[1].bracket, undefined);
  });

  test("persists across a simulated restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "source-status-"));
    const first = createSourceStatus({ dataDir: dir });
    first.record({
      id: "bulletin-zone-14",
      label: "GMDSS zone 14 bulletins",
      kind: "bulletin",
      error: new Error("https://x returned 404: not found"),
      now: NOW,
    });
    first.record({
      id: "weather-track",
      label: "Weather",
      kind: "weather",
      now: NOW,
    });
    await first.flush();
    const raw = JSON.parse(await readFile(statusPath(dir), "utf8"));
    assert.equal(raw.length, 2);

    // Restart: the registry picks the evidence back up
    const second = createSourceStatus({ dataDir: dir });
    await second.flush();
    const entry = second.list().find((e) => e.id === "bulletin-zone-14");
    assert.equal(entry.lastStatus, "fail");
    assert.equal(entry.lastError.class, "http-404");
    assert.equal(entry.consecutiveFailures, 1);
    assert.equal(entry.lastSuccessAt, null);
  });

  test("corrupt persistence file starts clean, not crashes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "source-status-bad-"));
    const { writeFile } = require("node:fs/promises");
    await writeFile(statusPath(dir), "{not json");
    const registry = createSourceStatus({ dataDir: dir });
    await registry.flush();
    registry.record({ id: "x", now: NOW });
    await registry.flush();
    assert.equal(registry.list().length, 1);
  });
});

describe("source status checklist verdicts (work doc #23)", () => {
  const NOW = new Date("2026-10-03T12:00:00Z");
  let statusVerdict;

  test("module loads browser-free", async () => {
    ({ statusVerdict } = await import("../public/components/models.mjs"));
    assert.equal(typeof statusVerdict, "function");
  });

  test("status-to-theme mapping follows the doc's brackets", () => {
    const entry = (over = {}) => ({
      id: "x",
      lastStatus: "ok",
      lastError: null,
      consecutiveFailures: 0,
      lastSuccessAt: "2026-10-03T11:00:00Z",
      expectedRefreshMs: 12 * 3600000,
      ...over,
    });
    assert.deepEqual(statusVerdict(entry()), {
      bracket: "[ OK ]",
      theme: "theme-green",
      stale: false,
    });
    assert.equal(
      statusVerdict(
        entry({
          lastStatus: "fail",
          lastError: { class: "http-404", message: "" },
        }),
      ).bracket,
      "[ FAIL ]",
    );
    assert.equal(
      statusVerdict(
        entry({
          lastStatus: "fail",
          lastError: { class: "http-404", message: "" },
        }),
      ).theme,
      "theme-red",
    );
    assert.equal(
      statusVerdict(
        entry({
          lastStatus: "fail",
          lastError: { class: "http-5xx", message: "" },
        }),
      ).bracket,
      "[ FAIL ]",
    );
    assert.equal(
      statusVerdict(
        entry({
          lastStatus: "fail",
          lastError: { class: "timeout", message: "" },
        }),
      ).bracket,
      "[ FAIL ]",
    );
    assert.equal(
      statusVerdict(
        entry({
          lastStatus: "fail",
          lastError: { class: "network", message: "" },
        }),
      ).bracket,
      "[ FAIL ]",
    );
    // 429 and parse are WARN: wait for their server, or fix ours
    assert.equal(
      statusVerdict(
        entry({
          lastStatus: "fail",
          lastError: { class: "http-429", message: "" },
        }),
      ).bracket,
      "[ WARN ]",
    );
    assert.equal(
      statusVerdict(
        entry({
          lastStatus: "fail",
          lastError: { class: "parse", message: "" },
        }),
      ).theme,
      "theme-orange",
    );
  });

  test("offline-skipped never renders as FAIL", () => {
    const verdict = statusVerdict({
      id: "x",
      lastStatus: "skip",
      lastError: { class: "http-404", message: "old failure" },
      consecutiveFailures: 3,
    });
    assert.equal(verdict.bracket, "[ SKIP ]");
    assert.equal(verdict.theme, "theme-offline");
    assert.notEqual(verdict.bracket, "[ FAIL ]");
  });

  test("success stale beyond the expected interval reads WARN", () => {
    const entry = {
      id: "x",
      lastStatus: "ok",
      lastSuccessAt: "2026-10-02T12:00:00Z",
      expectedRefreshMs: 12 * 3600000,
    };
    // 24 h old against a 12 h expectation
    assert.equal(statusVerdict(entry, NOW).bracket, "[ WARN ]");
    assert.equal(statusVerdict(entry, NOW).theme, "theme-orange");
    // 11 h old: still fine
    const fresh = { ...entry, lastSuccessAt: "2026-10-03T01:00:00Z" };
    assert.equal(statusVerdict(fresh, NOW).bracket, "[ OK ]");
    // No expected interval: no staleness verdict
    assert.equal(
      statusVerdict({ ...entry, expectedRefreshMs: null }, NOW).bracket,
      "[ OK ]",
    );
  });

  test("absent and never-attempted render muted, never failed", () => {
    assert.equal(
      statusVerdict({ id: "x", lastStatus: "absent" }).bracket,
      "[ N/A ]",
    );
    assert.equal(
      statusVerdict({ id: "x", lastStatus: null }).bracket,
      "[ WAIT ]",
    );
    assert.equal(
      statusVerdict({ id: "x", lastStatus: null }).theme,
      "theme-offline",
    );
  });
});
