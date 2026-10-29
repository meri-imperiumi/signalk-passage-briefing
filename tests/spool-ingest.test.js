/**
 * Unit tests for the spool ingestion path (SPEC §2.2, audit fix):
 * bulletins dropped into the spool directory by the on-board HF
 * gateway merge into the same bulletin cache the online fetches use —
 * keyed per spool file, re-dropped files update in place, and the
 * cache rewrite only happens when the spool actually changed the
 * picture. Also covers the spool issue-time parser's UTC handling for
 * offsetless ISO stamps (audit fix).
 *
 * @file spool-ingest.test.js
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  loadBulletinCache,
  ingestSpoolBulletins,
} = require("../plugin/bulletin-source.js");
const { extractIssuedAt } = require("../plugin/spool-watcher.js");

function dataDir() {
  return mkdtempSync(join(tmpdir(), "spool-ingest-"));
}

const GALE = {
  file: "gale.txt",
  issuedAt: "2026-10-28T09:00:00.000Z",
  bulletinText: "GALE WARNING 020 ISSUED FROM RSMC NADI 280900Z OCT 26",
};

describe("ingestSpoolBulletins", () => {
  test("a spool file lands in the bulletin cache as its own entry", async () => {
    const dir = dataDir();
    const { changed, count } = await ingestSpoolBulletins({
      dataDir: dir,
      bulletins: [GALE],
    });
    assert.equal(changed, true);
    assert.equal(count, 1);
    const cached = await loadBulletinCache(dir);
    assert.equal(cached.length, 1);
    assert.equal(cached[0].url, "spool:gale.txt");
    assert.equal(cached[0].source, "spool");
    assert.equal(cached[0].fetchedAt, GALE.issuedAt);
    assert.equal(cached[0].text, GALE.bulletinText);
  });

  test("re-ingesting the same spool picture rewrites nothing", async () => {
    const dir = dataDir();
    await ingestSpoolBulletins({ dataDir: dir, bulletins: [GALE] });
    const second = await ingestSpoolBulletins({
      dataDir: dir,
      bulletins: [GALE],
    });
    assert.equal(second.changed, false);
    assert.equal(second.count, 1);
  });

  test("a re-dropped file updates in place, the newer issue time winning", async () => {
    const dir = dataDir();
    await ingestSpoolBulletins({ dataDir: dir, bulletins: [GALE] });
    const updated = await ingestSpoolBulletins({
      dataDir: dir,
      bulletins: [
        {
          ...GALE,
          issuedAt: "2026-10-28T15:00:00.000Z",
          bulletinText: `${GALE.bulletinText} (REISSUED)`,
        },
      ],
    });
    assert.equal(updated.changed, true);
    const cached = await loadBulletinCache(dir);
    assert.equal(cached.length, 1);
    assert.equal(cached[0].fetchedAt, "2026-10-28T15:00:00.000Z");
    assert.match(cached[0].text, /REISSUED/);
  });

  test("an older re-drop never replaces a newer bulletin", async () => {
    const dir = dataDir();
    await ingestSpoolBulletins({
      dataDir: dir,
      bulletins: [{ ...GALE, issuedAt: "2026-10-28T15:00:00.000Z" }],
    });
    await ingestSpoolBulletins({ dataDir: dir, bulletins: [GALE] });
    const cached = await loadBulletinCache(dir);
    assert.equal(cached.length, 1);
    assert.equal(cached[0].fetchedAt, "2026-10-28T15:00:00.000Z");
  });
});

describe("spool issue times are UTC (audit fix)", () => {
  test("an offsetless ISO stamp parses as Zulu, not server-local", () => {
    // On a UTC+13 boat server this previously read as 03:00 local
    // (= 14:00Z the previous day), shifting the whole issue stamp
    assert.equal(
      extractIssuedAt("2026-01-02 03:00\nGALE WARNING."),
      "2026-01-02T03:00:00.000Z",
    );
    assert.equal(
      extractIssuedAt("ISSUED 2026-01-02T03:00\nGALE WARNING."),
      "2026-01-02T03:00:00.000Z",
    );
  });

  test("a stamped ISO instant keeps its offset", () => {
    assert.equal(
      extractIssuedAt("2026-01-02T03:00:00Z\nGALE WARNING."),
      "2026-01-02T03:00:00.000Z",
    );
    assert.equal(
      extractIssuedAt("2026-01-02T03:00:00+13:00\nGALE WARNING."),
      "2026-01-01T14:00:00.000Z",
    );
  });

  test("the NAVTEX and NHC forms still parse", () => {
    assert.equal(
      extractIssuedAt("ZCZC GA05 011200Z AUG 26\nGALE WARNING."),
      "2026-08-01T12:00:00.000Z",
    );
    assert.equal(
      extractIssuedAt("HIGH SEAS FORECAST\nNHC\n0430 UTC SAT OCT 3 2026"),
      "2026-10-03T04:30:00.000Z",
    );
  });
});
