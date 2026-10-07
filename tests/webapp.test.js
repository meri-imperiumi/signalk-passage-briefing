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
    compiledLabel,
    comfortColor,
    effectiveDeparture,
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
    trimWaypointsToPosition,
    hereHourly,
    hereNow,
  } = await import("../public/components/models.mjs");

  const {
    briefingAgeHours,
    fmtHm,
    fmtShip,
    parseTimezoneOffset,
    setShipTime,
    shipTimeLabel,
    skySegments,
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

  await t.test("compiledLabel names the briefing's compile instant", () => {
    // The header pill's text: prefixed so "compiled when" reads as a
    // fact, not a clock
    assert.equal(
      compiledLabel({ metadata: { fetchedAt: "2026-06-21T06:05:00.000Z" } }),
      "Compiled 06-21 06:05Z",
    );
    // Ship's time applies like every stamp (offset rides along)
    setShipTime({ offsetMinutes: 780, region: "Pacific/Tongatapu" });
    assert.equal(
      compiledLabel({ metadata: { fetchedAt: "2026-06-21T06:05:00.000Z" } }),
      "Compiled 06-21 19:05 +13",
    );
    setShipTime(null);
    // No fetch time (or no payload): nothing to show — the pill
    // hides rather than inventing a stamp
    assert.equal(compiledLabel({ metadata: {} }), null);
    assert.equal(compiledLabel(null), null);
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
    // Now cloud cover (work doc #33): from the first forecast step
    assert.equal(now.cloudCover, null);
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

  await t.test("fmtHm renders clock time in ship's time (doc #33)", () => {
    setShipTime({ offsetMinutes: 780, region: "Pacific/Tongatapu" });
    assert.equal(fmtHm("2026-09-29T05:35:00.000Z"), "18:35");
    setShipTime(null);
    assert.equal(fmtHm("2026-06-21T06:05:00.000Z"), "06:05");
    assert.equal(fmtHm(null), "");
    assert.equal(fmtHm("not a date"), "");
  });

  await t.test("skySegments build the sky line (doc #33)", () => {
    setShipTime({ offsetMinutes: 780, region: "Pacific/Tongatapu" });
    const payload = {
      metadata: { fetchedAt: "2026-10-05T06:00:00.000Z" },
      celestialNights: [
        {
          timestamp: "2026-10-05T08:40:00.000Z",
          nauticalDusk: "2026-10-05T08:40:00.000Z",
          sunset: "2026-10-05T07:15:00.000Z",
          sunrise: "2026-10-05T18:20:00.000Z",
          moonrise: "2026-10-05T10:58:00.000Z",
          moonset: "2026-10-04T19:42:00.000Z",
        },
      ],
    };
    const segments = skySegments(payload, { cloudCover: 40 });
    const texts = segments.map((s) => s.text);
    // Ship time +13: sunset 20:15, dusk 21:40, moonrise 23:58
    assert.ok(texts.includes("☀ 20:15↓"), texts.join(" "));
    assert.ok(texts.includes("☾ 21:40"), texts.join(" "));
    assert.ok(texts.includes("☽↑ 23:58"), texts.join(" "));
    // The moonset belongs to the previous evening — outside the
    // night window, so it stays quiet
    assert.ok(!texts.some((t) => t.includes("19:42")), texts.join(" "));
    assert.ok(texts.includes("☁ 40%"), texts.join(" "));
    assert.equal(segments[0].title, "sunset 10-05 20:15 +13");
    // No cloud field (provider mode): no cloud segment, never invented
    const clearSky = skySegments(payload, { cloudCover: null });
    assert.ok(!clearSky.some((s) => s.text.startsWith("☁")));
    // A payload predating the sky data degrades to empty
    assert.deepEqual(skySegments({}, {}), []);
    assert.deepEqual(skySegments(null, {}), []);
    setShipTime(null);
  });

  await t.test(
    "mergeTimeline stamps cloud cover and derived provenance (docs #31/#32)",
    () => {
      const fetchedAt = "2026-06-21T06:00:00.000Z";
      const timeline = mergeTimeline(
        {
          passageSummary: {
            sailChanges: [
              {
                hoursFromNow: 2,
                timestamp: "2026-06-21T08:00:00.000Z",
                sailState: "MAIN_1_REEF",
              },
            ],
            track: [
              {
                hoursFromNow: 2,
                lat: -18.5,
                lon: 178.0,
                comfortLevel: "easy",
                slatting: false,
                cloudCover: 65,
              },
            ],
          },
        },
        {
          metadata: {
            fetchedAt,
            provenance: {
              kind: "forecast",
              label: "Open-Meteo · forecast:best_match",
              url: "https://open-meteo.com/en/docs?latitude=-18&longitude=178",
              viewerBase: "/signalk-weather-map/",
              at: fetchedAt,
            },
          },
        },
      );
      assert.equal(timeline.length, 1);
      // Cloud rides the item from the track's nearest hour
      assert.equal(timeline[0].cloudCover, 65);
      // The simulated item chains to the weather provenance, with a
      // deep link to the item's own hour and position
      assert.equal(timeline[0].provenance.kind, "derived");
      assert.match(timeline[0].provenance.label, /Simulated on board/);
      assert.equal(
        timeline[0].provenance.viewerUrl,
        "/signalk-weather-map/?lat=-18.5000&lon=178.0000&time=2026-06-21T08:00:00.000Z&layer=wind",
      );
      // The external origin follows the item's position too — the
      // forecast for the patch of ocean the boat plans to be at
      assert.equal(
        timeline[0].provenance.url,
        "https://open-meteo.com/en/docs?latitude=-18.5000&longitude=178.0000",
      );

      // Without an installed viewer the chain keeps the external
      // origin only; without any provenance record items stay quiet
      const bare = mergeTimeline(
        {
          passageSummary: {
            sailChanges: [
              {
                hoursFromNow: 2,
                timestamp: "2026-06-21T08:00:00.000Z",
                sailState: "MAIN_1_REEF",
              },
            ],
          },
        },
        null,
      );
      assert.equal(bare[0].provenance, null);
      assert.equal(bare[0].cloudCover, null);
    },
  );

  await t.test(
    "mergeTimeline passes source provenance through (doc #31)",
    () => {
      const fetchedAt = "2026-06-21T06:00:00.000Z";
      const timeline = mergeTimeline(null, {
        metadata: { fetchedAt },
        hazardEvents: [
          {
            timestamp: "2026-06-21T07:00:00.000Z",
            title: "Orange earthquake",
            alertLevel: "orange",
            distanceNm: 120,
            bearingDeg: 45,
            type: "EQ",
            provenance: {
              kind: "warning",
              label: "GDACS",
              url: "https://www.gdacs.org/report.aspx?eventid=1",
              viewerUrl: null,
              at: "2026-06-21T07:00:00.000Z",
            },
          },
        ],
        spaceEvents: [
          {
            timestamp: "2026-06-21T09:00:00.000Z",
            kind: "satellite",
            tactical: true,
            description: "ISS pass",
            provenance: {
              kind: "feed",
              label: "CelesTrak TLE · live tracker",
              url: "https://www.n2yo.com/satellite/?s=25544",
              viewerUrl: null,
              at: null,
            },
          },
        ],
        zoneTransitions: [
          {
            hoursFromNow: 3,
            kind: "enter",
            territory: { name: "Tonga", iso_ter: "TON" },
            provenance: {
              kind: "data",
              label: "Marine Regions",
              url: "https://www.marineregions.org/",
              viewerUrl: null,
              at: null,
            },
          },
        ],
      });
      const hazard = timeline.find((i) => i.kind === "hazard");
      const space = timeline.find((i) => i.kind === "space");
      const zone = timeline.find((i) => i.kind === "zone");
      assert.equal(hazard.provenance.label, "GDACS");
      assert.equal(
        space.provenance.url,
        "https://www.n2yo.com/satellite/?s=25544",
      );
      assert.equal(zone.provenance.kind, "data");
    },
  );

  await t.test(
    "mergeTimeline links hazard notes to their GDACS page (doc #31)",
    () => {
      const timeline = mergeTimeline({
        passageSummary: {
          hazards: [
            {
              hoursFromNow: 6,
              timestamp: "2026-06-21T12:00:00.000Z",
              noteId: "hazard-eqtest1",
              description: "M6.2 earthquake",
              distanceNm: 34,
              url: "https://www.gdacs.org/report.aspx?eventtype=EQ&eventid=1",
            },
            {
              hoursFromNow: 8,
              timestamp: "2026-06-21T14:00:00.000Z",
              noteId: "hazard-local",
              description: "Firing range",
              distanceNm: 3,
            },
          ],
        },
      });
      assert.equal(timeline.length, 2);
      const linked = timeline[0];
      assert.equal(linked.provenance.kind, "warning");
      assert.equal(linked.provenance.label, "GDACS");
      assert.equal(
        linked.provenance.url,
        "https://www.gdacs.org/report.aspx?eventtype=EQ&eventid=1",
      );
      // An on-board note without a source stays quiet
      assert.equal(timeline[1].provenance, null);
    },
  );

  await t.test("etaTable night rows carry cloud cover (doc #32)", () => {
    const table = etaTable(
      {
        passageSummary: {
          etaP50: "2026-06-22T13:00:00Z",
          etaNight: { p50: true },
          track: [
            {
              hoursFromNow: 31,
              lat: -18.5,
              lon: 178.0,
              comfortLevel: "easy",
              slatting: false,
              cloudCover: 82,
            },
          ],
        },
      },
      { metadata: { fetchedAt: "2026-06-21T06:00:00.000Z" } },
    );
    // ETA at +31 h (fetch-relative): the nearest track row's cloud
    assert.equal(table.rows[1].cloud, 82);

    // Beyond the track horizon: null, never invented
    const farTable = etaTable(
      {
        passageSummary: {
          etaP50: "2026-06-30T13:00:00Z",
          etaNight: { p50: true },
          track: [],
        },
      },
      { metadata: { fetchedAt: "2026-06-21T06:00:00.000Z" } },
    );
    assert.equal(farTable.rows[1].cloud, null);
  });

  await t.test(
    "survival-regime canvas-off reads as storm tactics (doc #26)",
    () => {
      // At survival wind the tactic is the crew's call — the timeline
      // names the decision, it does not claim one (#27 pending)
      const timeline = mergeTimeline({
        passageSummary: {
          sailChanges: [
            {
              hoursFromNow: 20,
              timestamp: "2026-06-22T02:00:00.000Z",
              sailState: "NO_SAILS",
              propulsion: "adrift",
              canvasOffRegime: "survival",
            },
          ],
        },
      });
      assert.equal(timeline.length, 1);
      assert.equal(timeline[0].label, "Storm tactics");
      assert.equal(timeline[0].severity, "info");
    },
  );

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

    // The slatting regime names itself: "rough" alone would send
    // someone looking for wind that isn't there (work doc #14)
    const slatting = mergeTimeline({
      passageSummary: {
        sailChanges: [
          {
            hoursFromNow: 4,
            timestamp: "2026-06-21T10:00:00.000Z",
            sailState: "GENOA_1",
            conditions: {
              twsKnots: 10,
              hsMeters: 1.7,
              comfortLevel: "rough",
              slatting: true,
            },
          },
        ],
      },
    });
    assert.equal(slatting[0].detail, "10.0 kn TWS · Hs 1.7 m · slatting");
  });

  await t.test("mergeTimeline carries the conditions tier for the tab", () => {
    // Every entry paints the comfort tier at its hour (work doc #18)
    // — the simulated track's nearest hourly step, so the timeline's
    // tab colors match the tactical sparkline's columns
    const timeline = mergeTimeline({
      passageSummary: {
        track: [
          {
            hoursFromNow: 0,
            lat: -18.6,
            lon: 174.0,
            comfortLevel: "champagne",
            slatting: false,
          },
          {
            hoursFromNow: 10,
            lat: -18.9,
            lon: 174.5,
            comfortLevel: "coffee",
            slatting: false,
          },
          {
            hoursFromNow: 20,
            lat: -19.3,
            lon: 175.0,
            comfortLevel: "rough",
            slatting: true,
          },
        ],
        // An event type with no conditions of its own: the tier
        // comes from the track
        macroSeaAnomalies: [
          {
            hoursFromNow: 11,
            timestamp: "2026-06-21T17:00:00.000Z",
            steepnessRatio: 3,
            hsMeters: 2.5,
          },
        ],
        sailChanges: [
          {
            hoursFromNow: 19,
            timestamp: "2026-06-22T01:00:00.000Z",
            sailState: "MAIN_2_REEF",
            conditions: { twsKnots: 22, comfortLevel: "sick" },
          },
        ],
      },
    });
    const sea = timeline.find((item) => item.kind === "sea");
    assert.equal(sea.comfortLevel, "coffee");
    assert.equal(sea.slatting, false);
    // The sail change's own enriched conditions block wins over the
    // nearest track hour — it is the reefing logic's tier
    const sail = timeline.find((item) => item.kind === "sail");
    assert.equal(sail.comfortLevel, "sick");
    // No track: the tier degrades to unknown, not invented
    const bare = mergeTimeline({
      passageSummary: {
        macroSeaAnomalies: [
          { hoursFromNow: 3, steepnessRatio: 3, hsMeters: 2.5 },
        ],
      },
    });
    assert.equal(bare[0].comfortLevel, null);
    assert.equal(bare[0].slatting, false);
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

  await t.test(
    "mergeTimeline flags a zone change at a crossing (doc #19)",
    () => {
      // The vessel sits on Fiji time (UTC+12); entering Tonga's waters
      // is a clock change — the event says so
      setShipTime({ offsetMinutes: 720, region: "Pacific/Fiji" });
      try {
        const timeline = mergeTimeline({
          passageSummary: {
            zoneTransitions: [
              {
                kind: "enter",
                territory: { name: "Tonga", iso_ter: "TON" },
                hoursFromNow: 40.2,
                timestamp: "2026-06-22T22:12:00.000Z",
                distanceFromStartNm: 240.5,
                zoneIana: "Pacific/Tongatapu",
                zoneOffsetMinutes: 780,
              },
            ],
          },
        });
        assert.equal(timeline.length, 1);
        assert.equal(timeline[0].kind, "zone");
        assert.match(timeline[0].detail, /time zone \+13/);

        // Same zone as the vessel's: the plain event stands
        const same = mergeTimeline({
          passageSummary: {
            zoneTransitions: [
              {
                kind: "enter",
                territory: { name: "Fiji", iso_ter: "FJI" },
                hoursFromNow: 2,
                timestamp: "2026-06-21T08:00:00.000Z",
                distanceFromStartNm: 12,
                zoneIana: "Pacific/Fiji",
                zoneOffsetMinutes: 720,
              },
            ],
          },
        });
        assert.equal(same.length, 1);
        assert.doesNotMatch(same[0].detail, /time zone/);

        // No vessel zone published: the line still informs
        setShipTime(null);
        assert.match(timeline[0].detail, /time zone \+13/);
      } finally {
        setShipTime(null);
      }
    },
  );

  await t.test(
    "mergeTimeline maps meridian crossing advisories (doc #19)",
    () => {
      const timeline = mergeTimeline({
        passageSummary: {
          timeZoneChanges: [
            {
              hoursFromNow: 30.4,
              timestamp: "2026-06-22T12:24:00.000Z",
              meridian: "165°E",
              eastbound: true,
            },
            {
              hoursFromNow: 54,
              timestamp: "2026-06-23T12:00:00.000Z",
              meridian: "180°",
              eastbound: false,
            },
          ],
        },
      });
      assert.deepEqual(
        timeline.map((item) => [item.kind, item.severity, item.label]),
        [
          ["time", "info", "Crossing 165°E"],
          ["time", "info", "Crossing 180°"],
        ],
      );
      assert.equal(
        timeline[0].detail,
        "solar time 1 h ahead — clock change due",
      );
      assert.equal(
        timeline[1].detail,
        "solar time 1 h behind — clock change due",
      );
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

  await t.test(
    "mergeTimeline maps the predictor's surplus and deficit terms",
    () => {
      const timeline = mergeTimeline(
        { passageSummary: {} },
        {
          metadata: { fetchedAt: "2026-10-03T07:28:57.000Z" },
          energyEvents: [
            {
              type: "surplus",
              timestamp: "2026-10-03T20:28:57.000Z",
              endTimestamp: "2026-10-04T01:28:57.000Z",
              netWh: 1938,
              status: "surplus",
              timeToEmpty: null,
            },
            {
              type: "deficit",
              timestamp: null,
              endTimestamp: null,
              netWh: -780,
              status: "deficit",
              timeToEmpty: "2026-10-05T18:00:00.000Z",
            },
          ],
        },
      );
      assert.deepEqual(
        timeline.map((item) => [item.kind, item.severity, item.label]),
        [
          ["energy", "info", "Energy surplus"],
          ["energy", "warn", "Energy deficit"],
        ],
      );
      assert.match(timeline[0].detail, /\+1\.9 kWh/);
      assert.match(timeline[0].detail, /opportunistic loads/);
      assert.match(timeline[1].detail, /−0\.8 kWh/);
      assert.match(timeline[1].detail, /battery depleted by/);
      assert.equal(timeline[1].severity, "warn");
    },
  );
  await t.test("delayed departure is a timeline event; underway is not", () => {
    const base = { fetchedAt: "2026-10-04T18:00:00.000Z" };
    // Night at the mooring: next first light tomorrow ~06:00Z
    const delayed = mergeTimeline(
      {
        passageSummary: {
          departure: {
            assumed: true,
            time: "2026-10-05T06:00:00.000Z",
            reason: "next_dawn",
          },
        },
      },
      { metadata: base },
    );
    const event = delayed.find((item) => item.kind === "departure");
    assert.ok(event, "delayed departure appears");
    assert.equal(event.label, "Departure at first light");
    // Departure-relative: the departure is hour zero of its own schedule
    assert.equal(event.hoursFromNow, 0);

    // Prep delay variant
    const prep = mergeTimeline(
      {
        passageSummary: {
          departure: {
            assumed: true,
            time: "2026-10-04T19:30:00.000Z",
            reason: "daylight_prep",
          },
        },
      },
      { metadata: base },
    );
    assert.equal(
      prep.find((item) => item.kind === "departure")?.label,
      "Departure after prep",
    );

    // Underway: the forecast sails from now — no departure event
    const underway = mergeTimeline(
      {
        passageSummary: {
          departure: {
            assumed: false,
            time: "2026-10-04T18:00:00.000Z",
            reason: "underway",
          },
        },
      },
      { metadata: base },
    );
    assert.ok(!underway.some((item) => item.kind === "departure"));
  });

  await t.test("effectiveDeparture maps the modes", async () => {
    const now = new Date("2026-10-04T12:00:00Z"); // Night at Tonga
    // Auto at night: next dawn, assumed
    const auto = effectiveDeparture({
      mode: "auto",
      customTime: null,
      now,
      lat: -21.1,
      lon: -175.2,
      underway: false,
      prepHours: 1.5,
      dawnAltitudeDeg: -6,
    });
    assert.equal(auto.assumed, true);
    assert.equal(auto.reason, "next_dawn");
    assert.ok(auto.time > now);

    // Auto underway: sails from now
    const underway = effectiveDeparture({
      mode: "auto",
      customTime: null,
      now,
      lat: -21.1,
      lon: -175.2,
      underway: true,
      prepHours: 1.5,
      dawnAltitudeDeg: -6,
    });
    assert.equal(underway.reason, "underway");
    assert.equal(underway.time, now);

    // Manual modes: the crew's word, never assumed
    assert.deepEqual(
      [
        effectiveDeparture({
          mode: "now",
          customTime: null,
          now,
          lat: -21.1,
          lon: -175.2,
          underway: false,
        }),
        effectiveDeparture({
          mode: "+2h",
          customTime: null,
          now,
          lat: -21.1,
          lon: -175.2,
          underway: false,
        }),
        effectiveDeparture({
          mode: "custom",
          customTime: "2026-10-05T08:00:00.000Z",
          now,
          lat: -21.1,
          lon: -175.2,
          underway: false,
        }),
      ].map((r) => [r.assumed, r.reason, r.time.toISOString()]),
      [
        [false, "manual", "2026-10-04T12:00:00.000Z"],
        [false, "manual", "2026-10-04T14:00:00.000Z"],
        [false, "manual", "2026-10-05T08:00:00.000Z"],
      ],
    );
  });
  await t.test(
    "departure-anchored timeline sorts on one scale (doc #15 regression)",
    () => {
      // The reported bug: the departure event (+7.8h from fetch) sorted
      // after a zone transition stamped 4h later on the wall clock,
      // because zone hours were departure-relative while the departure
      // event's were fetch-relative. With the anchor active, every +Xh
      // is hours-from-departure.
      const fetchedAt = "2026-10-03T09:05:00.000Z";
      const departure = {
        assumed: true,
        time: "2026-10-03T16:55:00.000Z", // +7.8h from fetch
        reason: "next_dawn",
      };
      const timeline = mergeTimeline(
        {
          passageSummary: {
            departure,
            zoneTransitions: [
              {
                kind: "leave",
                territory: { name: "Tonga", iso_ter: "TON" },
                // Departure + 3.4h: wall clock 10-04 09:18 +13
                hoursFromNow: 3.4,
                timestamp: "2026-10-03T20:18:00.000Z",
                distanceFromStartNm: 25,
                connectivity: "ocean",
              },
            ],
          },
        },
        { metadata: { fetchedAt }, departure },
      );
      const ordered = timeline
        .filter((item) => ["departure", "zone"].includes(item.kind))
        .map((item) => [item.kind, item.hoursFromNow, item.stamp]);
      assert.deepEqual(ordered, [
        ["departure", 0, "10-03 16:55Z"],
        ["zone", 3.4, "10-03 20:18Z"],
      ]);
    },
  );

  await t.test(
    "trimWaypointsToPosition re-anchors the plan to the boat",
    async () => {
      const waypoints = [
        { lat: 0, lon: 0, distanceFromStartNm: 0, forecasts: [{ t: "a" }] },
        { lat: 0.5, lon: 0, distanceFromStartNm: 30, forecasts: [{ t: "b" }] },
        { lat: 1.0, lon: 0, distanceFromStartNm: 60, forecasts: [{ t: "c" }] },
      ];
      // Boat 12.5 nm in (nearest waypoint is the origin): both forward
      // waypoints remain, distances recomputed from the boat
      const trimmed = trimWaypointsToPosition(waypoints, {
        lat: 0.2,
        lon: 0.06,
      });
      assert.ok(trimmed, "trim produced");
      assert.equal(trimmed.waypoints.length, 3);
      const boat = trimmed.waypoints[0];
      assert.equal(boat.distanceFromStartNm, 0);
      assert.ok(Math.abs(boat.lat - 0.2) < 1e-9);
      assert.deepEqual(boat.forecasts, [{ t: "a" }]); // Nearest forecasts
      assert.ok(
        trimmed.waypoints[1].distanceFromStartNm > 15 &&
          trimmed.waypoints[1].distanceFromStartNm < 20,
        `first ahead ${trimmed.waypoints[1].distanceFromStartNm}`,
      );
      assert.ok(trimmed.progressNm > 10 && trimmed.progressNm < 15);

      // Boat 45 nm in: the first waypoint is behind — the plan starts
      // at the boat carrying the nearest (30 nm) waypoint's forecasts
      const mid = trimWaypointsToPosition(waypoints, { lat: 0.75, lon: 0 });
      assert.equal(mid.waypoints.length, 2);
      assert.ok(Math.abs(mid.waypoints[0].lat - 0.75) < 1e-9);
      assert.deepEqual(mid.waypoints[0].forecasts, [{ t: "b" }]);
      assert.ok(
        mid.waypoints[1].distanceFromStartNm > 10 &&
          mid.waypoints[1].distanceFromStartNm < 20,
        `mid remaining ${mid.waypoints[1].distanceFromStartNm}`,
      );

      // Boat before the first waypoint: the boat replaces it (carrying
      // its forecasts), both forward waypoints keep their shifted spots
      const before = trimWaypointsToPosition(waypoints, { lat: -0.1, lon: 0 });
      assert.equal(before.waypoints.length, 3);
      assert.equal(before.waypoints[0].distanceFromStartNm, 0);
      assert.ok(before.waypoints[1].distanceFromStartNm > 20);

      // Degenerate inputs
      assert.equal(trimWaypointsToPosition(null, { lat: 0, lon: 0 }), null);
      assert.equal(trimWaypointsToPosition(waypoints, null), null);
    },
  );
});
