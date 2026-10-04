const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { readFile } = require("node:fs/promises");

const cap = require("../plugin/cap-source.js");
const { createNotesStore } = require("../plugin/notes-store.js");
const { publishCapAlertNotes } = require("../plugin/notes-publisher.js");

const readFixture = (name) =>
  require("node:fs").readFileSync(
    join(__dirname, "fixtures", "cap", name),
    "utf8",
  );

describe("CAP source (work doc #24)", () => {
  test("parses the real PHEBCAP document: circle-as-point, severity, expiry", () => {
    const alert = cap.parseCapAlert(readFixture("phebcap-sample.xml"), {
      sourceUrl: cap.CAP_DEFAULT_URL,
      raw: "kept",
    });
    assert.equal(alert.identifier, "PHEB-1-26270050");
    assert.equal(alert.event, "Tsunami Information");
    assert.equal(alert.severity, "minor");
    assert.equal(
      alert.senderName,
      "NWS PACIFIC TSUNAMI WARNING CENTER HONOLULU HI",
    );
    assert.equal(alert.expires, "2026-09-27T22:56:18-00:00");
    // The zero-radius circle is a point: a tiny placeable box
    assert.equal(alert.geometry.type, "bbox");
    const [minLon, minLat, maxLon, maxLat] = alert.geometry.coordinates;
    assert.ok(Math.abs(minLat - 18.483) < 0.02);
    assert.ok(Math.abs(maxLon - -69.134) < 0.02);
  });

  test("CAP polygon: latitude-first order flipped to [lon, lat], ring closed", () => {
    const alert = cap.parseCapAlert(readFixture("tsunami-polygon-alert.xml"));
    assert.equal(alert.severity, "extreme");
    const ring = alert.geometry.coordinates;
    assert.equal(ring.length, 5); // 4 corners + closure
    assert.deepEqual(ring[0], [178, -20]); // lon first, lat second
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    // Antimeridian-crossing fixture: longitudes past 180 in the raw
    // polygon stay as-published (the intersection tests unfold them)
    assert.ok(ring.some(([lon]) => lon > 180));
    assert.match(alert.instruction, /high ground/);
  });

  test("multiple info blocks: highest severity wins, English preferred", () => {
    const xml = `<?xml version="1.0"?><alert>
      <identifier> MULTI-1 </identifier>
      <sent>2026-10-04T03:00:00Z</sent>
      <info><language>fi-FI</language><severity>Minor</severity><event>Tietoa</event></info>
      <info><language>en-US</language><severity>Severe</severity><event>Gale Warning</event></info>
      <info><language>en-US</language><severity>Minor</severity><event>Small craft</event></info>
    </alert>`;
    const alert = cap.parseCapAlert(xml);
    assert.equal(alert.event, "Gale Warning");
    assert.equal(alert.severity, "severe");
  });

  test("FAH-style RSS items are parsed for the follow step", () => {
    const items = cap.parseCapFeedItems(readFixture("fah-rss-sample.xml"));
    assert.equal(items.length, 2);
    assert.match(items[0].link, /cap-alert-1\.xml$/);
  });

  test("merge dedups on identifier+sent, fresher sent wins", () => {
    const cached = [
      {
        id: "TSU-TEST-1|2026-10-03T03:00:00Z",
        identifier: "TSU-TEST-1",
        sent: "2026-10-03T03:00:00Z",
        severity: "severe",
      },
    ];
    const incoming = [
      {
        id: "TSU-TEST-1|2026-10-04T03:00:00Z",
        identifier: "TSU-TEST-1",
        sent: "2026-10-04T03:00:00Z",
        severity: "extreme",
      },
    ];
    const merged = cap.mergeCapAlerts(cached, incoming);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].severity, "extreme");
  });

  test("refresh: RSS indirection follows the linked CAP documents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-"));
    const rss = readFixture("fah-rss-sample.xml");
    const alertsByUrl = {
      "cap-alert-1.xml": readFixture("tsunami-polygon-alert.xml"),
      "cap-alert-2.xml":
        '<?xml version="1.0"?><alert><identifier>FOG-1</identifier><sent>2026-10-04T02:00:00Z</sent><info><severity>Minor</severity><event>Dense Fog</event></info></alert>',
    };
    const { events } = await cap.refreshCapAlerts({
      dataDir: dir,
      urls: ["https://fah.example/rss.xml"],
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes("rss.xml")) {
          return { ok: true, text: async () => rss };
        }
        const name = u.split("/").pop();
        if (alertsByUrl[name]) {
          return { ok: true, text: async () => alertsByUrl[name] };
        }
        return { ok: false, status: 404 };
      },
      timeoutMs: 500,
    });
    assert.equal(events.length, 2);
    assert.ok(events.some((e) => e.identifier === "TSU-TEST-1"));
    // Repoll: dedup keeps one, cache round-trips
    const second = await cap.refreshCapAlerts({
      dataDir: dir,
      urls: ["https://fah.example/rss.xml"],
      fetchImpl: async () => ({ ok: false, status: 503 }),
      timeoutMs: 500,
    });
    assert.equal(second.fetched.length, 0); // Feed down
    assert.equal(second.events.length, 2); // Cache survives
  });

  test("filter: severity gate, deterministic expiry, track intersection", () => {
    const now = new Date("2026-10-04T06:00:00Z");
    const track = [
      [178.5, -20.5],
      [179.5, -21],
    ];
    const events = [
      {
        id: "A",
        identifier: "A",
        sent: "2026-10-04T03:00:00Z",
        severity: "extreme",
        expires: "2026-10-05T03:00:00Z",
        geometry: {
          type: "polygon",
          coordinates: [
            [178, -20],
            [182, -20],
            [182, -22],
            [178, -22],
            [178, -20],
          ],
        },
      },
      {
        id: "B",
        identifier: "B",
        sent: "2026-10-04T03:00:00Z",
        severity: "minor",
        geometry: {
          type: "polygon",
          coordinates: [
            [178, -20],
            [182, -20],
            [182, -22],
            [178, -22],
            [178, -20],
          ],
        },
      },
      {
        id: "C",
        identifier: "C",
        sent: "2026-10-04T03:00:00Z",
        severity: "extreme",
        expires: "2026-10-04T04:00:00Z", // Expired at now
        geometry: {
          type: "polygon",
          coordinates: [
            [178, -20],
            [182, -20],
            [182, -22],
            [178, -22],
            [178, -20],
          ],
        },
      },
      {
        id: "D",
        identifier: "D",
        sent: "2026-10-04T03:00:00Z",
        severity: "extreme",
        geometry: {
          type: "polygon",
          coordinates: [
            [0, 10],
            [10, 10],
            [10, 0],
            [0, 0],
            [0, 10],
          ],
        },
      },
    ];
    const surviving = cap.filterCapAlerts({
      events,
      track,
      minSeverity: "severe",
      now,
    });
    assert.deepEqual(
      surviving.map((e) => e.id),
      ["A"],
    );
  });

  test("notes: polygon geometry preserved, scoped prune", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-notes-"));
    const store = createNotesStore(dir);
    const alerts = [
      {
        id: "TSU-TEST-1|2026-10-04T03:00:00Z",
        identifier: "TSU-TEST-1",
        sent: "2026-10-04T03:00:00Z",
        severity: "extreme",
        event: "Tsunami Warning",
        headline: "Tsunami Warning for Tonga waters",
        description: "Test.",
        instruction: "Move to high ground.",
        geometry: {
          type: "polygon",
          coordinates: [
            [178, -20],
            [182, -20],
            [182, -22],
            [178, -22],
            [178, -20],
          ],
        },
      },
    ];
    const result = await publishCapAlertNotes({ store, alerts });
    assert.equal(result.published.length, 1);
    const listed = await store.list();
    const note = listed[result.published[0]];
    assert.equal(note.properties.category, "cap-alert");
    assert.equal(note.properties.area.geometry.type, "polygon");
    // The polygon survives note publication intact
    assert.equal(note.properties.area.geometry.coordinates.length, 5);
    assert.ok(note.position.latitude != null);

    // Alert drops out: note pruned, foreign notes untouched
    await store.set("metarea-foreign", { title: "foreign" });
    await publishCapAlertNotes({ store, events: [], alerts: [] });
    const after = await store.list();
    assert.ok(after["metarea-foreign"], "foreign note untouched");
    assert.ok(
      !Object.keys(after).some((id) => id.startsWith("cap-")),
      "stale cap notes pruned",
    );
  });

  test("cache round-trips through the disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-disk-"));
    await cap.saveCapAlerts(dir, [
      { id: "X|1", identifier: "X", sent: "1", severity: "severe" },
    ]);
    const loaded = await cap.loadCapAlerts(dir);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].identifier, "X");
    assert.deepEqual(await cap.loadCapAlerts(join(dir, "missing-sub")), []);
  });
});
