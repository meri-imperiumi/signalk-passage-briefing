const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { readFile } = require("node:fs/promises");

const hs = require("../plugin/hazard-source.js");
const { createNotesStore } = require("../plugin/notes-store.js");
const { publishHazardNotes } = require("../plugin/notes-publisher.js");

const readFixture = (name) =>
  require("node:fs").readFileSync(join(__dirname, "fixtures", name), "utf8");

describe("GDACS hazard event feed (work doc #22)", () => {
  const events = () => hs.parseHazardsXml(readFixture("gdacs-rss-sample.xml"));

  test("parses type, level, position and timestamps from the real feed shape", () => {
    const parsed = events();
    assert.equal(parsed.length, 6); // 7 items, 1 malformed skipped
    const tc = parsed.find((e) => e.id === "TC1001325");
    assert.ok(tc, "red TC present");
    assert.equal(tc.type, "TC");
    assert.equal(tc.alertLevel, "red");
    assert.equal(tc.lat, 30.5);
    assert.equal(tc.lon, -108);
    assert.equal(tc.timestamp, "2026-10-01T05:00:43.000Z");
    assert.match(tc.title, /tropical cyclone/i);
    // Entities unescaped in description text
    assert.ok(!/&amp;/.test(tc.description));
    // Freshness prefers datemodified when the feed updated in place
    const updated = parsed.find((e) => e.id === "TC1001332");
    assert.equal(updated.timestamp, "2026-10-03T05:59:45.000Z");
    // Newest first
    assert.deepEqual(
      [...parsed].sort((a, b) =>
        String(b.timestamp).localeCompare(String(a.timestamp)),
      ),
      parsed,
    );
  });

  test("malformed items are skipped, not fatal", () => {
    // The fixture's last item lost its guid and both coordinate
    // encodings: it must vanish without costing the rest
    assert.ok(!events().some((e) => e.type === "WF"));
    assert.deepEqual(hs.parseHazardsXml("not xml at all"), []);
    assert.deepEqual(hs.parseHazardsXml(null), []);
  });

  test("merge deduplicates on the event id, fresher stamp wins", () => {
    const cached = [
      {
        id: "TC1001325",
        type: "TC",
        alertLevel: "orange",
        timestamp: "2026-09-30T05:00:00.000Z",
        lat: 30.5,
        lon: -108,
      },
    ];
    const incoming = events();
    const merged = hs.mergeHazards(cached, incoming);
    const tc = merged.find((e) => e.id === "TC1001325");
    assert.equal(tc.alertLevel, "red"); // Updated in place
    assert.equal(tc.timestamp, "2026-10-01T05:00:43.000Z");
    assert.equal(merged.filter((e) => e.id === "TC1001325").length, 1);
  });

  test("refresh persists the cache and degrades on failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hazards-"));
    const xml = readFixture("gdacs-rss-sample.xml");
    const first = await hs.refreshHazards({
      dataDir: dir,
      fetchImpl: async () => ({ ok: true, text: async () => xml }),
      timeoutMs: 500,
    });
    assert.equal(first.fetched, true);
    assert.equal(first.events.length, 6);
    // The cache file holds the parsed events
    const saved = JSON.parse(await readFile(hs.hazardsCachePath(dir), "utf8"));
    assert.equal(saved.events.length, 6);

    // Network down: the cached events survive, nothing throws
    const second = await hs.refreshHazards({
      dataDir: dir,
      fetchImpl: async () => {
        throw new Error("offline");
      },
      timeoutMs: 500,
    });
    assert.equal(second.fetched, false);
    assert.equal(second.events.length, 6);

    // HTTP failure: same degradation
    const third = await hs.refreshHazards({
      dataDir: dir,
      fetchImpl: async () => ({ ok: false, status: 503 }),
      timeoutMs: 500,
    });
    assert.equal(third.fetched, false);
    assert.equal(third.events.length, 6);
  });

  test("filter keeps Orange and Red near the route, drops the rest", () => {
    const all = events();
    // Vessel in the eastern Pacific near the red TC (30.5N 108W)
    const vessel = { lat: 29, lon: -107 };
    const surviving = hs.filterHazards({
      events: all,
      vessel,
      waypoints: [],
      minAlertLevel: "orange",
      aheadRadiusNm: 1000,
      offRouteRadiusNm: 500,
      now: new Date("2026-10-03T08:00:00Z"),
    });
    assert.deepEqual(
      surviving.map((e) => [e.id, e.alertLevel]),
      [["TC1001325", "red"]],
    );
    assert.ok(surviving[0].distanceNm < 1000);
    assert.equal(typeof surviving[0].bearingDeg, "number");
  });

  test("route corridor admits events the vessel radius misses", () => {
    const all = events();
    // The Orange drought at 9.25N 26.13E is ~1000 nm from the vessel,
    // but the route passes through the Gulf of Guinea
    const surviving = hs.filterHazards({
      events: all,
      vessel: { lat: -18.1, lon: 178.4 },
      waypoints: [{ lat: 9.3, lon: 26.2 }],
      minAlertLevel: "orange",
      offRouteRadiusNm: 500,
      aheadRadiusNm: 100,
      now: new Date("2026-10-03T08:00:00Z"),
    });
    assert.deepEqual(
      surviving.map((e) => e.id),
      ["DR1027450"],
    );
  });

  test("aging drops events older than the window", () => {
    const all = events();
    const nearDrought = { lat: 9.3, lon: 26.2 };
    // The Orange drought is ~2 h old: in a 24 h window it survives
    const fresh = hs.filterHazards({
      events: all,
      vessel: nearDrought,
      waypoints: [],
      minAlertLevel: "green",
      maxAgeHours: 24,
      aheadRadiusNm: 100,
      now: new Date("2026-10-03T08:00:00Z"),
    });
    assert.ok(fresh.some((e) => e.id === "DR1027450"));
    // A 1 h window ages it out: nothing survives
    const stale = hs.filterHazards({
      events: all,
      vessel: nearDrought,
      waypoints: [],
      minAlertLevel: "green",
      maxAgeHours: 1,
      aheadRadiusNm: 100,
      now: new Date("2026-10-03T08:00:00Z"),
    });
    assert.deepEqual(stale, []);
  });

  test("antimeridian: a route crossing 180° admits events on both sides", () => {
    const synthetic = [
      {
        id: "EQ-W",
        type: "EQ",
        alertLevel: "orange",
        timestamp: "2026-10-03T00:00:00.000Z",
        lat: -18.5,
        lon: 179.5, // West of the seam
      },
      {
        id: "EQ-E",
        type: "EQ",
        alertLevel: "orange",
        timestamp: "2026-10-03T00:00:00.000Z",
        lat: -18.5,
        lon: -179.5, // East of the seam
      },
    ];
    const surviving = hs.filterHazards({
      events: synthetic,
      vessel: { lat: -18.1, lon: 178.4 },
      waypoints: [
        { lat: -18.2, lon: 179.9 },
        { lat: -18.3, lon: -179.9 },
      ],
      minAlertLevel: "orange",
      now: new Date("2026-10-03T08:00:00Z"),
    });
    assert.deepEqual(surviving.map((e) => e.id).sort(), ["EQ-E", "EQ-W"]);
    // Both are a couple of degrees from the track, not half the globe
    assert.ok(surviving.every((e) => e.distanceNm < 200));
  });

  test("hazard notes publish content-addressed and prune scoped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hazard-notes-"));
    const store = createNotesStore(dir);
    const all = events()
      .filter((e) => e.alertLevel !== "green")
      .concat([
        // A placeless event must not publish a note
        { id: "NOPos", type: "EQ", alertLevel: "red", lat: null, lon: null },
      ]);
    const result = await publishHazardNotes({ store, events: all });
    assert.equal(result.published.length, 2); // TC red + DR orange
    const listed = await store.list();
    assert.ok(Object.keys(listed).some((id) => id.startsWith("hazard-")));
    const note = listed[result.published[0]];
    assert.equal(note.properties.category, "hazard-event");
    assert.equal(note.properties.source, "gdacs");
    assert.ok(note.position.latitude != null);

    // A repoll with the event dropped out: its note expires, and a
    // foreign note (other clients, metarea pass) survives
    await store.set("metarea-foreign", { title: "foreign" });
    const second = await publishHazardNotes({
      store,
      events: [], // Everything dropped
    });
    assert.equal(second.published.length, 0);
    const after = await store.list();
    assert.ok(after["metarea-foreign"], "foreign note untouched");
    assert.ok(
      !Object.keys(after).some((id) => id.startsWith("hazard-")),
      "stale hazard notes pruned",
    );
  });
});
