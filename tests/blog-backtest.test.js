/**
 * Smoketests for the blog backtest (bin/blog-backtest.js): front-matter
 * parsing, hour aggregation, marine archive lookup, crew sea-state
 * decoding, and underway filtering — all offline against fixtures.
 *
 * @file blog-backtest.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  circularMean,
  crewSeaStates,
  douglasBand,
  headingSpreadDeg,
  keywordTierOf,
  leeShelterDeg,
  marineAt,
  max,
  mean,
  mergeAttitude,
  pairCrewSamples,
  parseEntry,
  proseOf,
} = require("../bin/blog-backtest.js");

test("parseEntry reads the log front matter subset", () => {
  const raw = [
    "---",
    "title: Hihifo - Neiafu",
    "draft: false",
    "created: 2026-09-15T13:21:43+13:00",
    "position:",
    "  lon: -173.9907215",
    "  lat: -18.6579493",
    "---",
    "Body text here.",
  ].join("\n");
  const { meta, body } = parseEntry(raw);
  assert.equal(meta.title, "Hihifo - Neiafu");
  assert.equal(meta.created, "2026-09-15T13:21:43+13:00");
  assert.deepEqual(meta.position, { lon: -173.9907215, lat: -18.6579493 });
  assert.equal(body.trim(), "Body text here.");
});

test("proseOf strips image embeds", () => {
  const prose = proseOf(
    "Words first.\n\n![](../2026/20260915_093056.webp)\n\nWords after.",
  );
  assert.match(prose, /Words first\./);
  assert.match(prose, /Words after\./);
  assert.doesNotMatch(prose, /!\[/);
});

test("circularMean wraps across the ±π seam", () => {
  const mean = circularMean([3.0, -3.0]);
  assert.ok(Math.abs(mean) < 0.01 || Math.abs(Math.abs(mean) - Math.PI) < 0.01);
});

test("headingSpreadDeg separates steady and maneuvering hours", () => {
  // Steady: all samples within a few degrees
  const steady = [0, 0.01, -0.01, 0.02].map((d) => (d * Math.PI) / 180);
  assert.ok(headingSpreadDeg(steady) < 2);
  // Tacking: samples split between two headings ~90° apart (radians:
  // 0.4 rad ≈ 23°, −1.2 rad ≈ −69°)
  const tacking = [0.4, 0.4, -1.2, -1.2];
  assert.ok(headingSpreadDeg(tacking) > 20);
  assert.equal(headingSpreadDeg([]), null);
});

test("mean and max ignore nulls", () => {
  assert.equal(mean([1, null, 3]), 2);
  assert.equal(max([1, null, 3]), 3);
  assert.equal(mean([null]), null);
  assert.equal(max([null]), null);
});

test("marineAt interpolates between archive hours", () => {
  const marine = {
    time: ["2025-10-18T00:00", "2025-10-18T01:00"],
    hs: [1.0, 2.0],
    tp: [10, 20],
    dirFromDeg: [10, 30],
  };
  const mid = marineAt(marine, Date.parse("2025-10-18T00:30:00Z"));
  assert.equal(mid.hsMeters, 1.5);
  assert.equal(mid.tpSeconds, 15);
  // Direction wraps the short way
  assert.ok(Math.abs((mid.dirFromRad * 180) / Math.PI - 20) < 0.001);
  const outside = marineAt(marine, Date.parse("2025-10-18T05:00:00Z"));
  assert.equal(outside.hsMeters, 2.0);
  const none = marineAt(null, Date.now());
  assert.equal(none.hsMeters, null);
});

test("crewSeaStates decodes Beaufort through the WMO correspondence", () => {
  const states = crewSeaStates([
    {
      datetime: "2026-09-13T22:52:29.401Z",
      text: "Finally enough wind for wing on wing",
      telemetry: [
        {
          path: "navigation.position",
          value: { latitude: -18.7, longitude: -173.5 },
        },
        { path: "environment.water.seaStateValue", value: 5 },
      ],
    },
  ]);
  assert.equal(states.length, 1);
  assert.equal(states[0].beaufort, 5);
  // Beaufort 5 ↔ Douglas 4 (moderate), not the Douglas-5 label
  assert.equal(states[0].douglas, 4);
  assert.equal(states[0].label, "moderate");
});

test("mergeAttitude keeps only samples with both axes", () => {
  const merged = mergeAttitude(
    [
      { tMs: 1000, rollRad: 0.1, pitchRad: null },
      { tMs: 2000, rollRad: 0.2, pitchRad: null },
    ],
    [{ tMs: 2000, pitchRad: 0.05 }],
  );
  assert.deepEqual(merged, [{ tMs: 2000, rollRad: 0.2, pitchRad: 0.05 }]);
});

test("keywordTierOf picks the most severe vocabulary hit", () => {
  assert.equal(keywordTierOf("A gale caught up to us.").tier, "miserable");
  assert.equal(keywordTierOf("Seas have been somewhat lumpy").tier, "sporty");
  assert.equal(keywordTierOf("We enjoyed quite a smooth ride").tier, "easy");
  assert.equal(
    keywordTierOf("Motoring in nearly millpond conditions").tier,
    "champagne",
  );
  assert.equal(keywordTierOf("A thunderstorm delivered a gust").tier, "sporty");
  assert.equal(keywordTierOf("Nothing about weather here").tier, null);
});

test("keywordTierOf flags the slatting mechanism vocabulary", () => {
  const flapping = keywordTierOf("Our sails were flapping a lot");
  assert.equal(flapping.tier, "rough");
  assert.equal(flapping.slatting, true);
  assert.equal(keywordTierOf("Quite a smooth ride").slatting, false);
});

test("keywordTierOf flags fatigue without bumping the tier", () => {
  const tired = keywordTierOf("Little sleep, but the sea was smooth");
  assert.equal(tired.tier, "easy");
  assert.equal(tired.fatigue, true);
  assert.equal(
    keywordTierOf("After a good night's sleep we continued").fatigue,
    false,
  );
});

test("douglasBand maps sea states to tiers", () => {
  assert.equal(douglasBand(0), "champagne");
  assert.equal(douglasBand(3), "easy");
  assert.equal(douglasBand(4), "sporty");
  assert.equal(douglasBand(5), "rough");
  assert.equal(douglasBand(7), "miserable");
});

test("leeShelterDeg measures land-from-dead-upwind of the waves", () => {
  const rad = (deg) => (deg * Math.PI) / 180;
  // Waves travel east → they come from the west; land to the west
  // sits dead to windward (fetch cut)
  assert.equal(leeShelterDeg(rad(90), rad(270)), 0);
  assert.equal(leeShelterDeg(rad(90), rad(90)), 180);
  assert.equal(leeShelterDeg(rad(90), rad(0)), 90);
  assert.equal(leeShelterDeg(null, rad(0)), null);
});

test("pairCrewSamples pairs hours with the nearest observation", () => {
  const hours = [
    {
      hourIso: "2025-10-18T10:00:00Z",
      underway: true,
      comfort: "champagne",
      slatting: false,
      twsKnots: 5,
      awsKnots: 1.2,
      twaRad: 3,
      waveRelDeg: 50,
      hsMeters: 0.5,
    },
  ];
  const seaStates = [{ iso: "2025-10-18T09:00:00Z", douglas: 2 }];
  const samples = pairCrewSamples(hours, seaStates);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].crewDouglas, 2);
  assert.equal(samples[0].crewTier, "easy");
  // Out of tolerance → no pairing
  assert.equal(
    pairCrewSamples(hours, [{ iso: "2025-10-19T09:00:00Z", douglas: 2 }])
      .length,
    0,
  );
});
