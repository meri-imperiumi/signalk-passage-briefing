/**
 * Tests for the Status Tiles example-set provider (work doc #13):
 * the bundled JSON parses and has the expected shape, the provider
 * lists while running and empties when stopped, and it is
 * read-only.
 *
 * @file statustilesexamples.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  registerStatusTileExamples,
  EXAMPLES,
} = require("../plugin/statustilesexamples.js");

test("bundled example set parses and references published paths", () => {
  assert.equal(EXAMPLES.name, "Passage Briefing examples");
  const set = EXAMPLES.sets[0];
  assert.equal(set.id, "passage-comfort");
  const tile = set.tiles[0];
  assert.equal(tile.size, "1x1");
  const types = tile.checks.map((c) => c.type);
  assert.deepEqual(types, ["stateMatch", "boolean"]);
  const paths = tile.checks.map((c) => c.path);
  assert.ok(paths.includes("navigation.briefing.comfort"));
  assert.ok(paths.includes("navigation.briefing.stale"));
  const comfortCheck = tile.checks[0];
  assert.deepEqual(
    comfortCheck.map.map((m) => m.value),
    ["champagne", "easy", "coffee", "rough", "sick"],
  );
  const footerPaths = tile.footer.map((f) => f.path);
  assert.ok(footerPaths.includes("navigation.briefing.ageHours"));
  assert.ok(footerPaths.includes("navigation.briefing.route"));
});

test("provider lists while running, empties when stopped, read-only", async () => {
  const registered = [];
  const errors = [];
  const app = {
    registerResourceProvider: (provider) => registered.push(provider),
    error: (m) => errors.push(m),
  };
  const teardown = registerStatusTileExamples(app, {
    id: "signalk-passage-briefing",
  });
  assert.equal(registered.length, 1);
  const provider = registered[0];
  assert.equal(provider.type, "statusTileExamples");

  const listed = await provider.methods.listResources();
  assert.ok(listed["signalk-passage-briefing"]);
  const resource = await provider.methods.getResource(
    "signalk-passage-briefing",
  );
  assert.equal(resource.sets[0].id, "passage-comfort");
  await assert.rejects(() => provider.methods.getResource("some-other-plugin"));
  await assert.rejects(() => provider.methods.setResource("x", {}));
  await assert.rejects(() => provider.methods.deleteResource("x"));

  teardown();
  assert.deepEqual(await provider.methods.listResources(), {});
  await assert.rejects(() =>
    provider.methods.getResource("signalk-passage-briefing"),
  );
});

test("re-start reuses the registration instead of stacking", async () => {
  const registered = [];
  const app = {
    registerResourceProvider: (p) => registered.push(p),
    error: () => {},
  };
  const teardown = registerStatusTileExamples(app, {
    id: "signalk-passage-briefing",
  });
  const teardown2 = registerStatusTileExamples(app, {
    id: "signalk-passage-briefing",
  });
  assert.equal(registered.length, 1); // Idempotent
  teardown();
  teardown2();
  assert.deepEqual(await registered[0].methods.listResources(), {});
});
