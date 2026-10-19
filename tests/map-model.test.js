/**
 * Unit tests for the warnings map model (`public/components/
 * map-model.mjs`, work doc #47): pure geometry — the same shapes the
 * bulletin engine computes for filtering, normalized for drawing.
 *
 * The fixture is the TC Wati bulletin's parsed shapes
 * (tests/fixtures/bulletins/fqps01-nffn-2026-10-16.txt through the
 * engine): a point-typed storm warning, a gale polygon spanning the
 * hemisphere, a corridor band, and an antimeridian-straddling bbox.
 *
 * @file map-model.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const engine = require("../plugin/bulletin-engine.js");

test("map model", async (t) => {
  const {
    blockShape,
    blockShapes,
    corridorRing,
    frameBounds,
    isSevereText,
    notePins,
    regionShapes,
    trackLine,
    unwrapFrame,
  } = await import("../public/components/map-model.mjs");

  await t.test("unwrapFrame keeps dateline-crossing shapes contiguous", () => {
    // A convergence zone from 170E across the seam to 165W
    assert.deepEqual(
      unwrapFrame([
        [170, -5],
        [-178, -7],
        [-165, -9],
      ]),
      [
        [170, -5],
        [182, -7],
        [195, -9],
      ],
    );
    // Westward across the seam too
    assert.deepEqual(
      unwrapFrame([
        [-170, 0],
        [175, -1],
      ]),
      [
        [-170, 0],
        [-185, -1],
      ],
    );
    // Input untouched
    const raw = [
      [178, -20],
      [-178, -21],
    ];
    unwrapFrame(raw);
    assert.deepEqual(raw, [
      [178, -20],
      [-178, -21],
    ]);
  });

  await t.test("frameBounds spans the unwrapped frame", () => {
    assert.deepEqual(
      frameBounds([
        [178, -20],
        [182, -21],
      ]),
      [178, -21, 182, -20],
    );
    assert.equal(frameBounds([]), null);
    assert.equal(frameBounds(null), null);
  });

  await t.test("isSevereText uses the console's own highlighter", () => {
    assert.equal(isSevereText("EXPECT WINDS OVER 33 KNOTS"), false);
    assert.equal(isSevereText("GALE WARNING 011 ISSUED FROM RSMC NADI"), true);
    assert.equal(isSevereText("TROPICAL CYCLONE WATI CENTRE 994HPA"), true);
    assert.equal(isSevereText(""), false);
  });

  await t.test("corridorRing expands an axis into the stated band", () => {
    const ring = corridorRing(
      [
        [169, -7],
        [182, -9],
      ],
      120,
    );
    // 120 nm ≈ 2° latitude pad; the ring is closed
    assert.equal(ring.length, 5);
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    const lats = ring.map(([, lat]) => lat);
    const maxLat = Math.max(...lats);
    assert.ok(maxLat > -7, `northern edge north of the axis (${maxLat})`);
    assert.ok(
      Math.abs(maxLat - (-7 + 2)) < 0.01,
      "120 nm reads as 2 degrees of latitude",
    );
  });

  await t.test("the Wati bulletin draws its warning shapes", () => {
    const { readFileSync } = require("node:fs");
    const raw = readFileSync(
      require("node:path").join(
        __dirname,
        "fixtures",
        "bulletins",
        "fqps01-nffn-2026-10-16.txt",
      ),
      "utf8",
    );
    const result = engine.filterBulletin({
      rawText: raw,
      source: "spool",
      track: [[-173.98, -18.65]],
    });
    const shapes = blockShapes(result.blocks);
    // The storm warning: a point at the analysed position, severe
    const storm = shapes.find((shape) => shape.kind === "point");
    assert.ok(storm, "storm declaration draws as a point");
    assert.deepEqual(storm.points, [[-163, -12.1]]);
    assert.equal(storm.severe, true);

    // A vessel inside the gale area sees the gale polygon too
    const inside = engine.filterBulletin({
      rawText: raw,
      source: "spool",
      track: [[-160, -15]],
    });
    const gale = blockShapes(inside.blocks).find(
      (shape) => shape.kind === "polygon" && shape.severe,
    );
    assert.ok(gale, "gale area draws as a severe polygon");
    assert.equal(
      gale.index,
      inside.blocks.indexOf(
        inside.blocks.find((b) => /GALE WARNING 011/.test(b.text)),
      ),
      "shape index pairs with its console text card",
    );
    // The polygon ring is closed
    assert.deepEqual(gale.points[0], gale.points[gale.points.length - 1]);
    // Every area shape names its block for the map tooltip: the
    // console card's first line (work doc #47 session: a dashed swell
    // box used to hover silent). Point shapes are exempt — the storm
    // marker supplies its own label
    for (const shape of blockShapes(inside.blocks)) {
      if (shape.kind === "point") {
        continue;
      }
      assert.ok(shape.label?.length > 0, `shape ${shape.index} has a label`);
      const block = inside.blocks[shape.index];
      assert.ok(
        block.text.split("\n")[0].startsWith(shape.label),
        `label ${shape.label} reads from the block's own first line`,
      );
    }
  });

  await t.test("trackLine unwraps and drops non-finite waypoints", () => {
    // A Tonga→Opua style hop across the seam: the frame follows the
    // predecessor shortest-arc, so 179E reads as -181 after -179W
    assert.deepEqual(
      trackLine([
        { lat: -18.65, lon: -173.98 },
        { lat: -19, lon: 178 },
        { lat: NaN, lon: 170 },
        { lat: -30, lon: 174.3 },
      ]),
      [
        [-173.98, -18.65],
        [-182, -19],
        [-185.7, -30],
      ],
    );
    assert.deepEqual(trackLine(null), []);
  });

  await t.test(
    "regionShapes maps published regions into the map's frame",
    () => {
      // Ours: provenance properties carry the honesty cues; severity
      // re-derives from the description text
      const ours = regionShapes({
        "metarea-area-abc": {
          name: "GALE WARNING",
          description:
            "IN THE AREA SOUTH OF 10S AND WEST OF 169W, EXPECT SOUTHEAST WINDS 25 TO 30 KNOTS. ROUGH TO VERY ROUGH SEAS.",
          feature: {
            geometry: {
              type: "Polygon",
              coordinates: [
                [-180, -30],
                [-180, -10],
                [-169, -10],
                [-169, -30],
                [-180, -30],
              ],
            },
            properties: {
              sourcePlugin: "signalk-passage-briefing",
              geometryType: "bbox",
              derived: "extracted",
            },
          },
        },
      });
      assert.equal(ours.length, 1);
      assert.equal(ours[0].id, "metarea-area-abc");
      assert.equal(ours[0].severe, true);
      assert.equal(ours[0].dashed, true);
      assert.equal(ours[0].ours, true);
      assert.equal(ours[0].rings.length, 1);
      assert.equal(ours[0].coverage, null);
      assert.equal(ours[0].derived, "extracted");

      // The wider-area coverage marker and the derivation marker ride
      // our properties; third-party resources carry neither
      const wider = regionShapes({
        "metarea-wide-abc": {
          name: "GALE WARNING 011",
          description: "GALE WARNING 011. EXPECT WEST WINDS 35 KNOTS.",
          feature: {
            geometry: {
              type: "Polygon",
              coordinates: [
                [0, 0],
                [0, 1],
                [1, 1],
                [0, 0],
              ],
            },
            properties: {
              sourcePlugin: "signalk-passage-briefing",
              coverage: "wider",
              derived: "extracted",
            },
          },
        },
      });
      assert.equal(wider[0].coverage, "wider");
      assert.equal(wider[0].derived, "extracted");

      // Third-party: no provenance, no dashes, no console click-through
      const third = regionShapes({
        "urn:uuid:1234": {
          name: "Anchorage",
          description: "Popular overnight anchorage.",
          feature: {
            geometry: {
              type: "Polygon",
              coordinates: [
                [0, 0],
                [0, 1],
                [1, 1],
                [0, 0],
              ],
            },
          },
        },
      });
      assert.equal(third[0].ours, false);
      assert.equal(third[0].dashed, false);
      assert.equal(third[0].severe, false);

      // MultiPolygon: one spec, one ring per polygon part
      const multi = regionShapes({
        "cap-area-x": {
          feature: {
            geometry: {
              type: "MultiPolygon",
              coordinates: [
                [
                  [
                    [178, -20],
                    [180, -20],
                    [180, -22],
                    [178, -20],
                  ],
                ],
                [
                  [
                    [-180, -20],
                    [-178, -20],
                    [-178, -22],
                    [-180, -20],
                  ],
                ],
              ],
            },
          },
        },
      });
      assert.equal(multi[0].rings.length, 2);

      // Geometry-less entries draw nothing
      assert.deepEqual(regionShapes({ broken: { feature: {} } }), []);
    },
  );

  await t.test("notePins: paired notes hide under their region's shape", () => {
    const notes = {
      "hazard-abc": {
        title: "TC ONE-26",
        description: "Tropical cyclone forecast to pass near the route.",
        position: { latitude: -12.1, longitude: -163 },
        properties: { sourcePlugin: "signalk-passage-briefing" },
        url: "https://www.gdacs.org/x",
      },
      "metarea-def": {
        title: "GALE WARNING",
        description: "GALE WARNING.",
        position: { latitude: -20, longitude: -174 },
        href: "/resources/regions/metarea-area-def",
        properties: { sourcePlugin: "signalk-passage-briefing" },
      },
      placementless: {
        title: "no position",
        description: "...",
      },
    };
    // Without its region drawn, the paired note shows as the marker
    const alone = notePins(notes, new Set(), null);
    assert.equal(alone.length, 2);
    const gale = alone.find((pin) => pin.id === "metarea-def");
    assert.deepEqual({ lon: gale.lon, lat: gale.lat }, { lon: -174, lat: -20 });
    assert.equal(gale.severe, true);

    // With the region drawn, the paired note stays hidden — the
    // polygon is the extent, the marker would render twice
    const paired = notePins(notes, new Set(["metarea-area-def"]), null);
    assert.deepEqual(
      paired.map((pin) => pin.id),
      ["hazard-abc"],
    );
  });

  await t.test("dashed bbox blocks carry their tooltip label", () => {
    // The swell box the crew hovered silent: "IN THE AREA SOUTH OF
    // 22S AND WEST OF 175E, EXPECT MODERATE SOUTHERLY SWELLS." — a
    // cardinal-bound approximation, dashed orange, and until now no
    // tooltip at all
    const shape = blockShape(
      {
        text: "IN THE AREA SOUTH OF 22S AND WEST OF 175E, EXPECT MODERATE SOUTHERLY\nSWELLS.",
        geometry: { type: "bbox", coordinates: [175, -30, 180, -22] },
      },
      3,
    );
    assert.equal(shape.kind, "bbox");
    assert.equal(shape.dashed, true);
    assert.equal(shape.severe, false);
    assert.equal(
      shape.label,
      "IN THE AREA SOUTH OF 22S AND WEST OF 175E, EXPECT MODERATE SOUTHERLY",
    );
  });
});

test("ribbon segments and event pins (work doc #47)", async (t) => {
  const { eventPins, ribbonSegments, routeRibbon, fitPoints, vesselFitBounds } =
    await import("../public/components/map-model.mjs");

  await t.test("ribbonSegments run-length groups the plan's regimes", () => {
    const track = [
      {
        hoursFromNow: 0,
        lat: -18.6,
        lon: -174,
        comfortLevel: "pleasant",
        slatting: false,
        motoring: false,
        night: false,
      },
      {
        hoursFromNow: 1,
        lat: -18.7,
        lon: -174.2,
        comfortLevel: "pleasant",
        slatting: false,
        motoring: false,
        night: false,
      },
      {
        hoursFromNow: 2,
        lat: -18.8,
        lon: -174.4,
        comfortLevel: "rough",
        slatting: true,
        motoring: false,
        night: true,
      },
      {
        hoursFromNow: 3,
        lat: -18.9,
        lon: -174.6,
        comfortLevel: "rough",
        slatting: true,
        motoring: false,
        night: true,
      },
      {
        hoursFromNow: 4,
        lat: -19,
        lon: -174.8,
        comfortLevel: "rough",
        slatting: false,
        motoring: true,
        night: false,
      },
    ];
    const segments = ribbonSegments(track);
    assert.equal(segments.length, 3, "three regime stretches");
    assert.deepEqual(segments[0], {
      points: [
        [-174, -18.6],
        [-174.2, -18.7],
        [-174.4, -18.8],
      ],
      comfortLevel: "pleasant",
      slatting: false,
      motoring: false,
      night: false,
    });
    assert.equal(segments[1].comfortLevel, "rough");
    assert.equal(segments[1].night, true);
    assert.equal(segments[2].motoring, true);
    // Continuity: each segment starts where the previous ended
    assert.deepEqual(
      segments[1].points[0],
      segments[0].points.at(-1),
      "segments share their boundary point",
    );
  });

  await t.test("ribbonSegments bridges rows without coordinates", () => {
    const segments = ribbonSegments([
      {
        hoursFromNow: 0,
        lat: -18.6,
        lon: -174,
        comfortLevel: "pleasant",
        slatting: false,
        motoring: false,
        night: false,
      },
      {
        hoursFromNow: 1,
        lat: null,
        lon: null,
        comfortLevel: "pleasant",
        slatting: false,
        motoring: false,
        night: false,
      },
      {
        hoursFromNow: 2,
        lat: -18.8,
        lon: -174.4,
        comfortLevel: "pleasant",
        slatting: false,
        motoring: false,
        night: false,
      },
    ]);
    // The same regime on both sides of the gap joins into one
    // stretch — no visual gap where a row lacked coordinates
    assert.equal(segments.length, 1);
    assert.equal(segments[0].points.length, 2);
    assert.deepEqual(ribbonSegments(null), []);
  });

  await t.test(
    "routeRibbon colorizes the real route by the plan's regimes",
    () => {
      // The payload's waypoints are the route's own geometry, sampled
      // along it; each point takes the attributes of the simulated row
      // whose made-good distance covers it — one colorized route line,
      // not a route line plus a second sim-track ribbon (work doc #47
      // session map report)
      const waypoints = [
        { lat: -18.6, lon: -174, distanceFromStartNm: 0 },
        { lat: -18.8, lon: -174.4, distanceFromStartNm: 30 },
        { lat: -19, lon: -174.8, distanceFromStartNm: 60 },
        { lat: -19.2, lon: -175.2, distanceFromStartNm: 90 },
      ];
      const track = [
        {
          distanceFromStartNm: 0,
          lat: -18.6,
          lon: -174,
          comfortLevel: "pleasant",
          slatting: false,
          motoring: false,
          night: false,
        },
        {
          distanceFromStartNm: 45,
          lat: -18.9,
          lon: -174.6,
          comfortLevel: "rough",
          slatting: true,
          motoring: false,
          night: true,
        },
        {
          distanceFromStartNm: 100,
          lat: -19.3,
          lon: -175.4,
          comfortLevel: "rough",
          slatting: true,
          motoring: false,
          night: true,
        },
      ];
      const segments = routeRibbon(waypoints, track);
      assert.equal(segments.length, 2, "two regime stretches on the route");
      assert.deepEqual(segments[0], {
        points: [
          [-174, -18.6],
          [-174.4, -18.8],
          [-174.8, -19],
        ],
        comfortLevel: "pleasant",
        slatting: false,
        motoring: false,
        night: false,
      });
      assert.equal(segments[1].comfortLevel, "rough");
      assert.equal(segments[1].night, true);
      assert.deepEqual(
        segments[1].points[0],
        segments[0].points.at(-1),
        "segments share their boundary point",
      );
    },
  );

  await t.test(
    "routeRibbon keeps the route on the map without row data",
    () => {
      const waypoints = [
        { lat: -18.6, lon: -174, distanceFromStartNm: 0 },
        { lat: -18.8, lon: -174.4, distanceFromStartNm: 30 },
      ];
      const segments = routeRibbon(waypoints, []);
      assert.equal(segments.length, 1, "one neutral stretch");
      assert.equal(segments[0].comfortLevel, null);
      assert.equal(segments[0].points.length, 2);
    },
  );

  await t.test("routeRibbon needs route geometry", () => {
    assert.equal(routeRibbon(null, []), null);
    assert.equal(routeRibbon([{ lat: 1, lon: 2 }], []), null);
  });

  await t.test(
    "fitPoints frames the route, then the vessel, then the warnings",
    () => {
      const ribbon = [
        {
          points: [
            [-174, -18.6],
            [-174.4, -18.8],
          ],
        },
        {
          points: [
            [-174.4, -18.8],
            [-175.2, -19.2],
          ],
        },
      ];
      const shapes = [
        {
          kind: "bbox",
          // A cardinal-bound box down to the pole: the old fit zoomed
          // the whole map to 90°S for it
          points: [
            [175, -22],
            [180, -22],
            [180, -90],
            [175, -90],
          ],
        },
      ];
      const eventPins = [{ lon: -174.2, lat: -18.7 }];
      const vessel = { lat: -18.65, lon: -173.98 };
      // Route exists: the fit is the route and its pins — never the
      // hemisphere-sized warning box
      assert.deepEqual(fitPoints({ ribbon, shapes }), [
        [-174, -18.6],
        [-174.4, -18.8],
        [-174.4, -18.8],
        [-175.2, -19.2],
      ]);
      assert.deepEqual(fitPoints({ ribbon, eventPins, shapes }), [
        [-174, -18.6],
        [-174.4, -18.8],
        [-174.4, -18.8],
        [-175.2, -19.2],
        [-174.2, -18.7],
      ]);
      // No route: the vessel anchors the view as a single point (the
      // map centers there with a fabricated span)
      assert.deepEqual(fitPoints({ shapes, vessel }), [[-173.98, -18.65]]);
      // No route, no vessel fix: the warnings drive the fit as before
      assert.deepEqual(fitPoints({ shapes }), [
        [175, -22],
        [180, -22],
        [180, -90],
        [175, -90],
      ]);
    },
  );

  await t.test(
    "vesselFitBounds spans a couple hundred miles around her",
    () => {
      const bounds = vesselFitBounds({ lat: -18.65, lon: -173.98 });
      assert.ok(bounds, "a usable position yields a box");
      const dLat = bounds[1][1] - bounds[0][1];
      const dLon = bounds[1][0] - bounds[0][0];
      // 240 nm of latitude across the box (±120 nm)
      assert.ok(Math.abs(dLat - 4) < 1e-9, `lat span ${dLat}`);
      // The longitude span widens by the latitude's cosine so the box
      // stays square in nautical miles
      assert.ok(
        Math.abs(dLon - 4 / Math.cos((-18.65 * Math.PI) / 180)) < 1e-9,
        `lon span ${dLon}`,
      );
      assert.equal(vesselFitBounds(null), null);
      assert.equal(vesselFitBounds({ lat: NaN, lon: 0 }), null);
    },
  );

  await t.test(
    "eventPins carry the timeline's own emoji at the anchored position",
    () => {
      const events = [
        {
          hoursFromNow: 5,
          kind: "maneuver",
          severity: "warn",
          label: "Tack to port",
          detail: "32 nm · 12.2 kn TWS",
          position: { lat: -18.825, lon: -174.49 },
        },
        {
          hoursFromNow: null,
          kind: "space",
          severity: "info",
          label: "Comet",
          detail: "",
          position: null,
        },
        {
          hoursFromNow: 12,
          kind: "convective",
          severity: "severe",
          label: "Convection risk",
          detail: "CAPE 3000 J/kg",
          position: { lat: -19.5, lon: -175.2 },
        },
      ];
      const pins = eventPins(events);
      assert.equal(pins.length, 2, "unplaceable events stay off the map");
      assert.deepEqual(
        {
          index: pins[0].index,
          glyph: pins[0].glyph,
          severity: pins[0].severity,
        },
        { index: 0, glyph: "⇄", severity: "warn" },
      );
      assert.deepEqual(
        { lon: pins[1].lon, glyph: pins[1].glyph },
        {
          lon: -175.2,
          glyph: "⚡",
        },
      );
      assert.deepEqual(eventPins(null), []);
    },
  );
});

test("the advisory cyclone graphic (work doc #47 phase 3)", async (t) => {
  const { readFileSync } = require("node:fs");
  const { stormGraphic, stormRingColor } = await import(
    "../public/components/map-model.mjs"
  );
  const engine = require("../plugin/bulletin-engine.js");

  await t.test(
    "the NHC advisory draws rings, track and forecast points",
    () => {
      const raw = readFileSync(
        require("node:path").join(
          __dirname,
          "fixtures",
          "bulletins",
          "wtpz23-knhc-tcmep3.txt",
        ),
        "utf8",
      );
      const result = engine.filterBulletin({
        rawText: raw,
        source: "api",
        track: [[-112.5, 20]],
      });
      const blockIndex = result.blocks.findIndex((b) => b.storm);
      const graphic = stormGraphic(result.blocks[blockIndex], blockIndex);
      assert.ok(graphic, "storm graphic built from the parsed advisory");
      assert.equal(graphic.name, "HURRICANE RACHEL");
      assert.equal(graphic.severityLabel, "HURRICANE FORCE");
      // The centre is the analysed position
      assert.deepEqual(graphic.center, [-111.5, 19.4]);
      // The present wind fields arrive as ready quadrant rings
      const thresholds = graphic.rings
        .filter((ring) => ring.kind === "wind")
        .map((ring) => ring.threshold);
      assert.deepEqual(thresholds, [64, 50, 34]);
      for (const ring of graphic.rings) {
        assert.ok(ring.points.length > 3, "ring is a polygon");
        for (const [lon, lat] of ring.points) {
          assert.ok(Number.isFinite(lon) && Number.isFinite(lat));
        }
      }
      // The track runs from the centre through every forecast position
      assert.equal(graphic.track.length, 1 + 6);
      assert.deepEqual(graphic.track[0], [-111.5, 19.4]);
      const last = graphic.forecastPoints.at(-1);
      assert.match(graphic.forecastPoints[0].label, /FORECAST VALID 03\/1200Z/);
      assert.equal(last.lon, -117.7);
      assert.equal(last.lat, 20.7);
    },
  );

  await t.test("a text-only NFFN storm declaration has no graphic", () => {
    assert.equal(
      stormGraphic(
        {
          text: "TROPICAL CYCLONE WATI CENTRE 994HPA WAS LOCATED NEAR 12.1S 163.0W",
        },
        0,
      ),
      null,
    );
    assert.equal(stormGraphic(null, 0), null);
  });

  await t.test("ring colors follow the severity ladder", () => {
    assert.equal(stormRingColor({ threshold: 64, kind: "wind" }), "#ff3b3b");
    assert.equal(stormRingColor({ threshold: 50, kind: "wind" }), "#ff8c42");
    assert.equal(stormRingColor({ threshold: 34, kind: "wind" }), "#ffd166");
    assert.equal(stormRingColor({ threshold: 4, kind: "seas" }), "#4ec9b0");
  });
});
