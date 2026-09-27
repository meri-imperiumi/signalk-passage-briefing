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
    fmtGal,
    fmtHours,
    fmtKn,
    fmtUtc,
    sailActionCards,
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

  await t.test("fmtKn and fmtGal keep one decimal", () => {
    assert.equal(fmtKn(12.34), "12.3 kn");
    assert.equal(fmtGal(3.96), "4.0 gal");
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

  await t.test("sailActionCards format stamps and night flags", () => {
    const cards = sailActionCards({
      next24h: {
        sailChanges: [
          {
            hoursFromNow: 6,
            timestamp: "2026-06-21T12:00:00Z",
            sailState: "GENOA_1_MAIN",
            night: false,
          },
          {
            hoursFromNow: 18,
            timestamp: "2026-06-22T00:00:00Z",
            sailState: "STAYSAIL_MAIN_1_REEF",
            night: true,
          },
        ],
      },
    });
    assert.equal(cards[0].stamp, "06-21 12:00Z");
    assert.equal(cards[1].night, true);
    assert.equal(cards[1].sailState, "STAYSAIL_MAIN_1_REEF");
    assert.deepEqual(sailActionCards(null), []);
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
        totalMotorHours: 40,
        totalFuelGal: 32,
      },
    });
    assert.deepEqual(
      table.rows.map((row) => row.label),
      ["P10", "P50", "P90"],
    );
    assert.equal(table.rows[2].stamp, "06-22 14:30Z");
    assert.equal(table.motorHours, "1d 16h");
    assert.equal(table.fuel, "32.0 gal");
    assert.equal(etaTable(null).motorHours, "");
  });
});
