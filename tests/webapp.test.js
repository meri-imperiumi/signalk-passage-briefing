/**
 * Unit tests for the webapp view models (`public/components/models.mjs`)
 * that back the custom elements (SPEC §6).
 *
 * @file webapp.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

test("webapp view models", async (t) => {
  const {
    COMFORT_TIERS,
    comfortColor,
    etaTable,
    fmtLiters,
    fmtHours,
    fmtKn,
    fmtUtc,
    mergeTimeline,
    sailStateLabel,
    sparklineColumns,
    splitSevere,
    tacticalNow,
    hereHourly,
    hereNow,
  } = await import("../public/components/models.mjs");

  await t.test("fmtUtc renders MM-DD HH:MMZ in UTC", () => {
    assert.equal(fmtUtc("2026-06-21T06:05:00.000Z"), "06-21 06:05Z");
    assert.equal(fmtUtc(null), "");
    assert.equal(fmtUtc("not a date"), "");
  });

  await t.test("fmtHours buckets days, hours and minutes", () => {
    assert.equal(fmtHours(31.5), "1d 07h");
    assert.equal(fmtHours(5.34), "5h 20m");
    assert.equal(fmtHours(0.2), "12m");
    assert.equal(fmtHours(null), "");
  });

  await t.test("fmtKn and fmtLiters keep one decimal", () => {
    assert.equal(fmtKn(12.34), "12.3 kn");
    assert.equal(fmtLiters(71.96), "72.0 l");
    assert.equal(fmtKn(null), "");
  });

  await t.test(
    "sparklineColumns maps comfort tiers and normalizes AWS height",
    () => {
      const blocks = [
        { hoursFromNow: 0, comfortLevel: "champagne", awsKnots: 10 },
        { hoursFromNow: 1, comfortLevel: "rough", awsKnots: 20 },
        { hoursFromNow: 2, comfortLevel: "sick", awsKnots: 0 },
      ];
      const cols = sparklineColumns(blocks);
      assert.equal(cols.length, 3);
      assert.equal(cols[0].heightPct, 50); // 10 of max 20
      assert.equal(cols[1].heightPct, 100);
      assert.equal(cols[2].heightPct, 4); // Floor
      assert.match(cols[0].color, /champagne/);
      assert.match(cols[2].color, /sick/);
      assert.ok(cols[1].title.includes("20.0 kn"));
    },
  );

  await t.test("sparklineColumns caps the window at 24 columns", () => {
    const blocks = Array.from({ length: 30 }, (_, i) => ({
      hoursFromNow: i,
      comfortLevel: "easy",
      awsKnots: 10,
    }));
    assert.equal(sparklineColumns(blocks).length, 24);
  });

  await t.test("comfort tiers cover the Sereno scale", () => {
    assert.deepEqual(
      COMFORT_TIERS.map((tier) => tier.level),
      ["champagne", "easy", "coffee", "rough", "sick"],
    );
    assert.match(comfortColor("unknown"), /unknown/);
  });

  await t.test("tacticalNow reads the first block and colors the tier", () => {
    const exceptions = {
      next24h: {
        comfortBlocks: [
          {
            hoursFromNow: 0,
            comfortLevel: "coffee",
            awsKnots: 14.2,
            timestamp: "2026-06-21T06:00:00Z",
          },
        ],
      },
    };
    const now = tacticalNow(exceptions);
    assert.equal(now.comfortLevel, "coffee");
    assert.equal(now.awsKnots, 14.2);
    assert.equal(now.stamp, "06-21 06:00Z");
    assert.match(now.color, /coffee/);

    assert.equal(tacticalNow(null).comfortLevel, null);
    assert.match(tacticalNow(null).color, /unknown/);
  });

  await t.test("sailStateLabel humanizes canonical keys", () => {
    assert.equal(
      sailStateLabel("GENOA_1_30_FURLED_MAIN_1_REEF"),
      "Genoa 1 30% furled + Main 1 reef",
    );
    assert.equal(
      sailStateLabel("GENOA_1_10_FURLED_MAIN"),
      "Genoa 1 10% furled + Main",
    );
    assert.equal(
      sailStateLabel("GENOA_1_MAIN_1_REEF"),
      "Genoa 1 + Main 1 reef",
    );
    assert.equal(
      sailStateLabel("GENOA_1_10_FURLED_MAIN_1_REEF_STAYSAIL"),
      "Genoa 1 10% furled + Main 1 reef + Staysail",
    );
    assert.equal(sailStateLabel("NO_SAILS"), "No sails");
    assert.equal(sailStateLabel("MAIN_2_REEF"), "Main 2 reefs");
    // Maneuver state side suffix is ignored
    assert.equal(sailStateLabel("GENOA_1_MAIN@starboard"), "Genoa 1 + Main");
    // Unknown keys pass through untouched
    assert.equal(sailStateLabel("?"), "?");
    assert.equal(sailStateLabel(null), "");
  });

  await t.test("splitSevere tokenizes severe keywords", () => {
    const tokens = splitSevere(
      "EXPECT WINDS 35 KNOTS. Rough seas with heavy GALE warnings.",
    );
    const severeWords = tokens
      .filter((t) => t.severe)
      .map((t) => t.text.toUpperCase());
    assert.deepEqual(severeWords, ["ROUGH SEAS", "GALE"]);
    assert.ok(tokens.some((t) => !t.severe && t.text.includes("EXPECT")));
    // Reconstructing the tokens reproduces the input exactly
    const input = "EXPECT WINDS 35 KNOTS. Rough seas with heavy GALE warnings.";
    assert.equal(
      splitSevere(input)
        .map((t) => t.text)
        .join(""),
      input,
    );
    assert.deepEqual(splitSevere("plain text only"), [
      { text: "plain text only", severe: false },
    ]);
    assert.deepEqual(splitSevere(null), []);
  });

  await t.test("hereHourly evaluates comfort at SOG 0 over 24h", () => {
    const payload = {
      metadata: { fetchedAt: "2026-09-27T10:00:00.000Z", mode: "here" },
      waypoints: [
        {
          lat: -21.1,
          lon: -175.2,
          forecasts: Array.from({ length: 40 }, (_, i) => ({
            timestamp: new Date(
              new Date("2026-09-27T00:00:00.000Z").getTime() + i * 3600000,
            ).toISOString(),
            surface: { tws: 12, twd: 45, mslp: 1013, gust: 18 },
            marine: {
              hsCombined: 1.2,
              tpCombined: 7,
              dirCombined: 160,
            },
            current: { drift: 1, set: 45 },
          })),
        },
      ],
    };
    const rows = hereHourly(payload, { waterline_length_m: 9.4 });
    assert.equal(rows.length, 24, "24 hourly rows from fetchedAt");
    assert.equal(rows[0].hoursFromNow, 0);
    assert.equal(rows[0].sogKnots, 0);
    // At SOG 0 AWS equals TWS
    assert.equal(rows[0].awsKnots, 12);
    assert.ok(typeof rows[0].azMs2 === "number");
    assert.ok(typeof rows[0].comfortLevel === "string");
    assert.ok(typeof rows[0].night === "boolean");

    const now = hereNow(payload, rows);
    assert.equal(now.twsKnots, 12);
    assert.equal(now.gustKnots, 18);
    assert.equal(now.hsMeters, 1.2);
    assert.equal(now.currentDriftKnots, 1);
    assert.equal(now.mslpHpa, 1013);
    assert.equal(now.mslpTrend, 0);
    assert.equal(now.comfortLevel, rows[0].comfortLevel);
  });

  await t.test("hereNow and hereHourly handle empty payloads", () => {
    assert.deepEqual(hereHourly(null), []);
    const now = hereNow(null);
    assert.equal(now.comfortLevel, null);
    assert.equal(now.twsKnots, null);
    assert.equal(now.stamp, "");
  });

  await t.test("etaTable builds percentile rows and motor totals", () => {
    const table = etaTable({
      passageSummary: {
        etaP10: "2026-06-22T12:00:00Z",
        etaP50: "2026-06-22T13:00:00Z",
        etaP90: "2026-06-22T14:30:00Z",
        etaNight: { p10: false, p50: true, p90: true },
        totalMotorHours: 40,
        totalFuelLiters: 72,
      },
    });
    assert.deepEqual(
      table.rows.map((row) => row.label),
      ["P10", "P50", "P90"],
    );
    assert.equal(table.rows[2].stamp, "06-22 14:30Z");
    assert.equal(table.motorHours, "1d 16h");
    assert.equal(table.fuel, "72.0 l");
    assert.deepEqual(
      table.rows.map((row) => row.night),
      [false, true, true],
    );
    assert.equal(etaTable(null).motorHours, "");
  });

  await t.test("mergeTimeline maps sail work and maneuvers (doc #18)", () => {
    const timeline = mergeTimeline({
      passageSummary: {
        sailChanges: [
          {
            hoursFromNow: 2,
            timestamp: "2026-06-21T08:00:00.000Z",
            sailState: "MAIN_1_REEF",
          },
          {
            hoursFromNow: 4,
            timestamp: "2026-06-21T10:00:00.000Z",
            sailState: "MAIN_FULL@port",
            maneuver: "tack",
            toTack: "port",
            distanceFromStartNm: 32.4,
            twsAtManeuver: 12.2,
          },
          {
            hoursFromNow: 5,
            timestamp: "2026-06-21T14:00:00.000Z",
            sailState: "NO_SAILS",
            propulsion: "adrift",
          },
        ],
      },
    });
    assert.equal(timeline.length, 3);
    assert.equal(timeline[0].kind, "sail");
    assert.equal(timeline[0].severity, "info");
    assert.equal(timeline[0].label, "Main 1 reef");
    assert.equal(timeline[0].stamp, "06-21 08:00Z");
    assert.equal(timeline[1].kind, "maneuver");
    assert.equal(timeline[1].severity, "warn");
    assert.equal(timeline[1].label, "Tack to port");
    assert.equal(timeline[1].detail, "32 nm · 12.2 kn");
    assert.equal(timeline[2].label, "No sails - drifting");
    assert.deepEqual(mergeTimeline(null, null), []);
  });

  await t.test("mergeTimeline maps sea, convective and hazard sources", () => {
    const timeline = mergeTimeline({
      passageSummary: {
        sailChanges: [],
        macroSeaAnomalies: [
          {
            hoursFromNow: 7,
            timestamp: "2026-06-21T13:00:00.000Z",
            steepnessRatio: 2.4,
            hsMeters: 1.5,
            tpSeconds: 8,
          },
        ],
        convectiveWarnings: [
          {
            hoursFromNow: 8,
            timestamp: "2026-06-21T14:00:00.000Z",
            cape: 1800,
            kIndex: 30,
          },
        ],
        hazards: [
          {
            hoursFromNow: 3,
            timestamp: "2026-06-21T09:00:00.000Z",
            noteId: "rock",
            description: "Shoal water",
            distanceNm: 2.4,
          },
          {
            hoursFromNow: 6,
            timestamp: "2026-06-21T12:00:00.000Z",
            noteId: "restricted-area",
            description: null,
          },
        ],
      },
    });
    assert.deepEqual(
      timeline.map((item) => [item.kind, item.label]),
      [
        ["hazard", "Shoal water"],
        ["hazard", "restricted-area"],
        ["sea", "Steep sea"],
        ["convective", "Convection risk"],
      ],
    );
    assert.equal(timeline[0].severity, "severe");
    assert.equal(timeline[0].detail, "2.4 nm off");
    assert.equal(timeline[2].severity, "warn");
    assert.equal(timeline[2].detail, "ratio 2.4 · Hs 1.5 m");
    assert.equal(timeline[3].severity, "severe");
    assert.equal(timeline[3].detail, "CAPE 1800 · K 30");
  });

  await t.test("mergeTimeline merges payload space and zone events", () => {
    const timeline = mergeTimeline(
      {
        passageSummary: {
          sailChanges: [
            {
              hoursFromNow: 10,
              timestamp: "2026-06-21T16:00:00.000Z",
              sailState: "MAIN_1_REEF",
            },
          ],
        },
      },
      {
        metadata: { fetchedAt: "2026-06-21T06:00:00.000Z" },
        spaceEvents: [
          {
            kind: "aurora",
            timestamp: "2026-06-21T21:00:00.000Z",
            tactical: true,
            description: "Aurora possible: Kp 6 predicted tonight. Look north.",
          },
          {
            kind: "comet",
            timestamp: "2026-06-21T06:00:00.000Z",
            tactical: false,
            description: "Naked-eye comet X (mag 5.2) in range",
          },
        ],
        zoneTransitions: [
          {
            kind: "leave",
            hoursFromNow: 30,
            timestamp: "2026-06-22T12:00:00.000Z",
            distanceFromStartNm: 180.2,
            territory: { name: "Finland", iso_ter: "FI" },
          },
        ],
      },
    );
    assert.deepEqual(
      timeline.map((item) => [item.kind, item.hoursFromNow, item.severity]),
      [
        ["space", 0, "info"],
        ["sail", 10, "info"],
        ["space", 15, "warn"],
        ["zone", 30, "info"],
      ],
    );
    assert.equal(timeline[0].label, "Naked-eye comet X (mag 5.2) in range");
    assert.equal(
      timeline[2].label,
      "Aurora possible: Kp 6 predicted tonight. Look north.",
    );
    assert.equal(timeline[3].label, "Leaving Finland territorial waters");
    assert.equal(timeline[3].detail, "180 nm");
  });

  await t.test("mergeTimeline sorts undated space events last", () => {
    const timeline = mergeTimeline(null, {
      metadata: { fetchedAt: "2026-06-21T06:00:00.000Z" },
      spaceEvents: [
        { timestamp: null, tactical: false, description: "undated" },
        {
          timestamp: "2026-06-21T12:00:00.000Z",
          tactical: false,
          description: "dated",
        },
      ],
    });
    assert.equal(timeline[0].label, "dated");
    assert.equal(timeline[0].hoursFromNow, 6);
    assert.equal(timeline[1].label, "undated");
    assert.equal(timeline[1].hoursFromNow, null);
  });
});
