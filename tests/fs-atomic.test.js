const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { readFile } = require("node:fs/promises");

const { writeFileAtomic } = require("../plugin/fs-atomic.js");

describe("fs-atomic", () => {
  test("writes the payload and leaves no temporary files behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-atomic-"));
    const target = join(dir, "store.json");
    await writeFileAtomic(target, '{"a":1}\n');
    assert.equal(await readFile(target, "utf8"), '{"a":1}\n');
    assert.deepEqual(readdirSync(dir), ["store.json"]);
  });

  // The race this helper exists for: a reader looping against a
  // writer that rewrites the file must never observe a torn state.
  // Plain writeFile truncates before writing, so a read landing
  // mid-write sees a partial file — the serve-time publish once took
  // such a read for "no bulletins cached" and pruned every published
  // warning (CI flake, publication track test).
  test("concurrent readers only ever see complete writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-atomic-readers-"));
    const target = join(dir, "store.json");
    await writeFileAtomic(target, JSON.stringify({ entries: [] }));

    const payload = JSON.stringify({
      entries: Array.from({ length: 400 }, (_, i) => ({
        url: `https://example.test/${i}`,
        text: "GALE WARNING. ".repeat(40),
      })),
    });

    let reads = 0;
    const reader = (async () => {
      while (reads < 400) {
        const raw = await readFile(target, "utf8");
        const parsed = JSON.parse(raw); // throws on a torn read
        assert.ok(Array.isArray(parsed.entries));
        reads += 1;
      }
    })();

    await Promise.all(
      Array.from({ length: 8 }, () => writeFileAtomic(target, payload)),
    );
    await reader;
    assert.ok(reads > 0);
    assert.deepEqual(readdirSync(dir), ["store.json"]);
  });
});
