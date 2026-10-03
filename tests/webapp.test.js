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
    moonGlyph,
    sailStateLabel,
    sparklineColumns,
    splitSevere,
    tacticalNow,
    hereHourly,
    hereNow,
  } = await import("../public/components/models.mjs");

  const {
    briefingAgeHours,
    fmtShip,
    parseTimezoneOffset,
    setShipTime,
    shipTimeLabel,
  } = await import("../public/components/models.mjs");

  await t.test("fmtUtc renders MM-DD HH:MMZ in UTC", () => {
    assert.equal(fmtUtc("2026-06-21T06:05:00.000Z"), "06-21 06:05Z");
    assert.equal(fmtUtc(null), "");
    assert.equal(fmtUtc("not a date"), "");
  });

  await t.test("parseTimezoneOffset reads (-)hhmm encodings", () => {
    assert.equal(parseTimezoneOffset(200), 120);
    assert.equal(parseTimezoneOffset(-930), -570);
    assert.equal(parseTimezoneOffset("1300"), 780);
    assert.equal(parseTimezoneOffset(0), 0);
    // Malformed: partial-hour minutes and out-of-range zones
    assert.equal(parseTimezoneOffset(165), null);
    assert.equal(parseTimezoneOffset(2400), null);
    assert.equal(parseTimezoneOffset(null), null);
    assert.equal(parseTimezoneOffset("abc"), null);
  });

  await t.test("fmtShip renders ship's time with the offset on stamps", () => {
    setShipTime({ offsetMinutes: 780, region: "Pacific/Tongatapu" });
    assert.equal(fmtShip("2026-09-29T05:35:00.000Z"), "09-29 18:35 +13");
    assert.equal(shipTimeLabel(), "Pacific/Tongatapu");
    // Fractional zones label with minutes; the stamp shifts too
    setShipTime({ offsetMinutes: -570 });
    assert.equal(fmtShip("2026-06-21T06:05:00.000Z"), "06-20 20:35 -09:30");
    assert.equal(shipTimeLabel(), "UTC-09:30");
    // Invalid input falls back to empty like fmtUtc
    assert.equal(fmtShip(null), "");
    assert.equal(fmtShip("not a date"), "");
    // No published timezone: stamps stay UTC "Z"
    setShipTime(null);
    assert.equal(fmtShip("2026-06-21T06:05:00.000Z"), "06-21 06:05Z");
    assert.equal(shipTimeLabel(), "");
  });

  await t.test("briefingAgeHours measures staleness from fetchedAt", () => {
    const now = new Date("2026-10-03T00:00:00.000Z");
    assert.equal(
      briefingAgeHours(
        { metadata: { fetchedAt: "2026-09-29T00:00:00Z" } },
        now,
      ),
      96,
    );
    assert.equal(briefingAgeHours({ metadata: {} }, now), null);
    assert.equal(briefingAgeHours(null, now), null);
    // Future fetch (clock skew): clamps to zero, never negative
    assert.equal(
      briefingAgeHours(
        { metadata: { fetchedAt: "2026-10-03T06:00:00Z" } },
        now,
      ),
      0,
    );
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

  await t.test(
    "sparklineColumns carries the slatting tag for the hatch",
    () => {
      const cols = sparklineColumns([
        { hoursFromNow: 0, comfortLevel: "rough", awsKnots: 8, slatting: true },
        { hoursFromNow: 1, comfortLevel: "rough", awsKnots: 30 },
      ]);
      assert.equal(cols[0].slatting, true);
      assert.match(cols[0].title, /slatting/);
      assert.equal(cols[1].slatting, false);
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
    assert.deepEqual(
      table.rows.map((row) => row.moon),
      [null, null, null],
    );
    assert.equal(etaTable(null).motorHours, "");
  });

  await t.test("etaTable night arrivals carry the actual moon glyph", () => {
    const table = etaTable(
      {
        passageSummary: {
          etaP50: "2026-06-22T13:00:00Z",
          etaNight: { p50: true },
        },
      },
      {
        celestialNights: [
          {
            timestamp: "2026-06-22T20:00:00.000Z",
            moonPhaseDeg: 178,
            moonIllumination: 1,
          },
        ],
      },
    );
    assert.equal(table.rows[1].night, true);
    assert.equal(table.rows[1].moon, "🌕");
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
    assert.equal(timeline[1].detail, "32 nm · 12.2 kn TWS");
    assert.equal(timeline[2].label, "No sails - drifting");
    assert.deepEqual(mergeTimeline(null, null), []);
  });

  await t.test("mergeTimeline details the conditions at sail changes", () => {
    const timeline = mergeTimeline({
      passageSummary: {
        sailChanges: [
          {
            hoursFromNow: 6,
            timestamp: "2026-06-21T12:00:00.000Z",
            sailState: "MAIN_1_REEF",
            conditions: {
              twsKnots: 14.2,
              awsKnots: 18.4,
              hsMeters: 1.5,
              tpSeconds: 8,
              comfortLevel: "coffee",
            },
          },
          {
            hoursFromNow: 12,
            timestamp: "2026-06-21T18:00:00.000Z",
            sailState: "MAIN_FULL",
            conditions: { twsKnots: 8, comfortLevel: "champagne" },
          },
        ],
      },
    });
    assert.equal(timeline[0].detail, "14.2 kn TWS · Hs 1.5 m · coffee");
    // Missing sea state degrades without inventing values
    assert.equal(timeline[1].detail, "8.0 kn TWS · champagne");
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
    assert.equal(timeline[3].detail, "CAPE 1800 J/kg · K 30.0");
  });

  await t.test("mergeTimeline renders convective episodes with a range", () => {
    const timeline = mergeTimeline({
      passageSummary: {
        sailChanges: [],
        convectiveWarnings: [
          {
            hoursFromNow: 38.7,
            timestamp: "2026-10-05T03:46:00.000Z",
            untilHoursFromNow: 40.6,
            untilTimestamp: "2026-10-05T05:38:00.000Z",
            cape: 712.6,
            kIndex: 28.58,
          },
        ],
      },
    });
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].label, "Convection risk");
    assert.equal(timeline[0].severity, "severe");
    assert.equal(
      timeline[0].detail,
      "CAPE 713 J/kg · K 28.6 · until 10-05 05:38Z",
    );
  });

  await t.test("mergeTimeline renders marginal convection as a warning", () => {
    const timeline = mergeTimeline({
      passageSummary: {
        sailChanges: [],
        convectiveWarnings: [
          {
            hoursFromNow: 44.4,
            timestamp: "2026-10-05T09:26:00.000Z",
            untilHoursFromNow: 45.4,
            untilTimestamp: "2026-10-05T10:26:00.000Z",
            cape: 7.7,
            kIndex: 28.3,
            marginal: true,
          },
        ],
      },
    });
    assert.equal(timeline[0].severity, "warn");
    assert.equal(
      timeline[0].detail,
      "CAPE 8 J/kg · K 28.3 · until 10-05 10:26Z",
    );
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
    assert.equal(timeline[3].detail, "180 nm from departure");
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

  await t.test("mergeTimeline night stamps carry the actual moon glyph", () => {
    // The payload's celestialNights drive the glyph (work doc #3:
    // real moon phase instead of a fixed crescent); full moon the
    // night of the event, so the timeline shows 🌕 where it used to
    // show ☾
    const timeline = mergeTimeline(
      {
        passageSummary: {
          sailChanges: [
            {
              hoursFromNow: 10,
              timestamp: "2026-06-21T16:00:00.000Z",
              sailState: "MAIN_1_REEF",
              night: true,
            },
          ],
        },
      },
      {
        metadata: { fetchedAt: "2026-06-21T06:00:00.000Z" },
        celestialNights: [
          {
            timestamp: "2026-06-21T20:00:00.000Z",
            moonPhaseDeg: 178,
            moonIllumination: 1,
          },
          {
            timestamp: "2026-06-22T20:00:00.000Z",
            moonPhaseDeg: 210,
            moonIllumination: 0.9,
          },
        ],
      },
    );
    assert.equal(timeline[0].night, true);
    assert.equal(timeline[0].moon, "🌕");
  });

  await t.test("moonGlyph covers the eight phase sectors", () => {
    assert.equal(moonGlyph(0), "🌑");
    assert.equal(moonGlyph(45), "🌒");
    assert.equal(moonGlyph(90), "🌓");
    assert.equal(moonGlyph(135), "🌔");
    assert.equal(moonGlyph(180), "🌕");
    assert.equal(moonGlyph(225), "🌖");
    assert.equal(moonGlyph(270), "🌗");
    assert.equal(moonGlyph(315), "🌘");
    assert.equal(moonGlyph(359), "🌑");
    assert.equal(moonGlyph(-45), "🌘");
  });

  await t.test("timeline falls back to ☾ without celestialNights", () => {
    const timeline = mergeTimeline(
      {
        passageSummary: {
          sailChanges: [
            {
              hoursFromNow: 10,
              timestamp: "2026-06-21T16:00:00.000Z",
              sailState: "MAIN_1_REEF",
              night: true,
            },
          ],
        },
      },
      { metadata: { fetchedAt: "2026-06-21T06:00:00.000Z" } },
    );
    assert.equal(timeline[0].moon, null);
  });

  await t.test("mergeTimeline maps lines of interest as line events", () => {
    const timeline = mergeTimeline(
      {
        passageSummary: {
          linesOfInterest: [
            {
              lineId: "antimeridian",
              lineName: "Antimeridian / Date Line",
              ceremony: "Domain of the Golden Dragon",
              note: "the calendar skips or repeats by 24 h",
              lat: -21,
              lon: -180,
              distanceFromStartNm: 640.2,
              eta: "2026-06-23T18:00:00.000Z",
            },
            {
              lineId: "tropic-capricorn",
              lineName: "Tropic of Capricorn",
              ceremony: null,
              lat: -23.4366,
              lon: 174,
              distanceFromStartNm: 810,
              eta: null,
            },
          ],
        },
      },
      { metadata: { fetchedAt: "2026-06-21T06:00:00.000Z" } },
    );
    assert.deepEqual(
      timeline.map((item) => [item.kind, item.hoursFromNow]),
      [
        ["line", 60],
        ["line", null],
      ],
    );
    assert.equal(
      timeline[0].label,
      "Antimeridian / Date Line — Domain of the Golden Dragon",
    );
    assert.match(timeline[0].detail, /21\.0°S 180\.0°W/);
    assert.match(timeline[0].detail, /24 h/);
    assert.equal(timeline[1].label, "Tropic of Capricorn");
  });

  await t.test(
    "mergeTimeline prefers the simulated zone schedule and carries connectivity",
    () => {
      const timeline = mergeTimeline(
        {
          passageSummary: {
            zoneTransitions: [
              {
                kind: "leave",
                territory: { name: "Tonga", iso_ter: "TON" },
                hoursFromNow: 8.5,
                timestamp: "2026-06-21T14:30:00.000Z",
                distanceFromStartNm: 62.4,
                connectivity: "ocean",
              },
              {
                // Payload fallback keeps undated transitions visible
                kind: "enter",
                territory: { name: "Fiji", iso_ter: "FJI" },
                distanceFromStartNm: 640,
              },
            ],
          },
        },
        { metadata: { fetchedAt: "2026-06-21T06:00:00.000Z" } },
      );
      assert.deepEqual(
        timeline.map((item) => [item.kind, item.hoursFromNow]),
        [
          ["zone", 8.5],
          ["zone", null],
        ],
      );
      assert.equal(timeline[0].label, "Leaving Tonga territorial waters");
      assert.match(timeline[0].detail, /ocean data rules beyond this point/);
      assert.match(timeline[0].detail, /62 nm/);
      assert.equal(timeline[1].label, "Entering Fiji territorial waters");
    },
  );

  await t.test("every dated timeline item carries a night indicator", () => {
    // Sun truth at (-21, -175.2): 2026-10-04T09:00Z sits at solar
    // altitude -45° (deep night), 2026-10-04T01:00Z at +62° (day).
    // Base = fetchedAt 18:00Z: hour 15 -> 09:00Z night, hour 7 ->
    // 01:00Z day. Same threshold the sail logic buckets by.
    const timeline = mergeTimeline(
      {
        passageSummary: {
          track: Array.from({ length: 24 }, (_, h) => ({
            hoursFromNow: h,
            lat: -21,
            lon: -175.2,
          })),
          convectiveWarnings: [
            {
              hoursFromNow: 15,
              timestamp: "2026-10-04T09:00:00.000Z",
              cape: 1800,
              kIndex: 30,
            },
          ],
          zoneTransitions: [
            {
              kind: "leave",
              territory: { name: "Tonga", iso_ter: "TON" },
              hoursFromNow: 7,
              timestamp: "2026-10-04T01:00:00.000Z",
              distanceFromStartNm: 90,
            },
          ],
        },
      },
      { metadata: { fetchedAt: "2026-10-03T18:00:00.000Z" } },
    );
    const convective = timeline.find((item) => item.kind === "convective");
    const zone = timeline.find((item) => item.kind === "zone");
    assert.equal(convective.night, true);
    assert.equal(zone.night, false);
  });
});
