/**
 * Unit tests for the sail inventory reader's downwind classification
 * (work doc #41): the proactive recommendations deploy downwind sails
 * when the working canvas would slat, so the inventory must say which
 * sails those are — from the configured `type` and human `name`.
 *
 * @file sails-configuration.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { writeFileSync, mkdirSync, mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  readSailsConfiguration,
  classifySail,
} = require("../plugin/sails-configuration.js");

test("classifySail recognizes the downwind families from type and name", () => {
  assert.deepEqual(classifySail({ name: "Parasailor", type: null }), {
    family: "parasailor",
  });
  assert.deepEqual(classifySail({ name: "A3", type: "gennaker" }), {
    family: "gennaker",
  });
  assert.deepEqual(classifySail({ name: "Code Zero", type: null }), {
    family: "code zero",
  });
  assert.deepEqual(classifySail({ name: "A5", type: "asymmetric spinnaker" }), {
    family: "spinnaker",
  });
  assert.deepEqual(classifySail({ name: "Spinnaker", type: "spinnaker" }), {
    family: "spinnaker",
  });

  // The sailsconfiguration `type` enum pins the vocabulary: of its
  // ten values, spinnaker and gennaker are the downwind ones
  assert.deepEqual(classifySail({ name: "A2", type: "spinnaker" }), {
    family: "spinnaker",
  });
  assert.deepEqual(
    classifySail({ name: "Symmetric spinnaker", type: "spinnaker" }),
    { family: "spinnaker" },
  );

  // Working sails and unknown entries classify as nothing
  assert.equal(classifySail({ name: "Main", type: "mainsail" }), null);
  assert.equal(classifySail({ name: "Genoa 1", type: "genoa" }), null);
  assert.equal(classifySail({ name: "Storm jib", type: "staysail" }), null);
  assert.equal(classifySail({ name: "Jib", type: "jib" }), null);
  assert.equal(classifySail({ name: "Headsail", type: "headsail" }), null);
  assert.equal(classifySail({ name: "Mizzen", type: "mizzen" }), null);
  assert.equal(classifySail({ name: "Lug", type: "lug" }), null);
  assert.equal(
    classifySail({ name: "Steadiersail", type: "steadying sail" }),
    null,
  );
});

test("readSailsConfiguration marks downwind sails in the inventory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sails-config-"));
  const file = join(dir, "sailsconfiguration.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      configuration: {
        sails: [
          { name: "Parasailor", minimumWind: 2.6, maximumWind: 12.9 },
          { name: "Main", area: 21 },
          { name: "Genoa 1", continuousReefing: true },
        ],
      },
    }),
  );
  const sails = await readSailsConfiguration(file);
  assert.equal(sails.length, 3);
  const parasailor = sails.find((s) => s.name === "Parasailor");
  assert.equal(parasailor.downwind, true);
  assert.equal(parasailor.sailFamily, "parasailor");
  // Configured wind limits convert to knots for the envelope gates
  assert.ok(Math.abs(parasailor.minimumWindKnots - 5.05) < 0.01);
  assert.ok(Math.abs(parasailor.maximumWindKnots - 25.07) < 0.01);
  for (const name of ["Main", "Genoa 1"]) {
    const sail = sails.find((s) => s.name === name);
    assert.equal(sail.downwind, false);
    assert.equal(sail.sailFamily, null);
  }
});

test("readSailsConfiguration tolerates a missing file", async () => {
  assert.deepEqual(
    await readSailsConfiguration(join(tmpdir(), "no-such-file.json")),
    [],
  );
});
