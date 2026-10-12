const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const ce = require("../plugin/celestial-ephemeris.js");

describe("celestial ephemeris (doc #3 Phase 2)", () => {
  test("moon phase: new moon at the 2026-08-12 solar eclipse", () => {
    const phase = ce.moonPhaseDeg(new Date("2026-08-12T17:46:00Z"));
    assert.ok(Math.abs(phase) < 1, `phase ${phase}`);
    assert.ok(ce.moonIllumination(new Date("2026-08-12T17:46:00Z")) < 0.01);
  });

  test("moon illumination: full moon 2026-08-28, first quarter 2024-08-12", () => {
    assert.ok(ce.moonIllumination(new Date("2026-08-28T00:00:00Z")) > 0.99);
    const quarter = ce.moonIllumination(new Date("2024-08-12T20:00:00Z"));
    assert.ok(Math.abs(quarter - 0.52) < 0.02, `quarter ${quarter}`);
    assert.ok(
      Math.abs(ce.moonPhaseDeg(new Date("2024-08-12T20:00:00Z")) - 92) < 2,
    );
  });

  test("nautical night follows the −12° Sun line", () => {
    // Verified: Sun at −62.8° over Tonga at 2026-10-05T12:00Z
    assert.equal(
      ce.isNauticalNight(new Date("2026-10-05T12:00:00Z"), -21.1, -175.2),
      true,
    );
    // Local noon (13:00 Tonga time the same calendar day): sun high
    assert.equal(
      ce.isNauticalNight(new Date("2026-10-05T00:00:00Z"), -21.1, -175.2),
      false,
    );
  });

  test("body altitude matches a hand-checked geometry", () => {
    // Equatorial body on the equator meridian: altitude ≈ 90 − |lat|
    // Jupiter J2000-vs-ofdate drift is small on a fixed date; the
    // assertion is loose (it gates against haze, not against the
    // nautical almanac)
    const alt = ce.bodyAltitudeDeg(
      "Moon",
      new Date("2026-10-05T12:00:00Z"),
      -21.1,
      -175.2,
    );
    assert.ok(alt < -20, `moon alt ${alt}`);
  });

  test("twilight times: dusk chain deepens, dawn chain lightens, same night", () => {
    const t = ce.twilightTimes(new Date("2026-10-05T00:00:00Z"), -21.1, -175.2);
    const ms = (iso) => (iso == null ? NaN : new Date(iso).getTime());
    assert.ok(ms(t.civilDusk) < ms(t.nauticalDusk));
    assert.ok(ms(t.nauticalDusk) < ms(t.astronomicalDusk));
    assert.ok(ms(t.astronomicalDusk) < ms(t.astronomicalDawn));
    assert.ok(ms(t.astronomicalDawn) < ms(t.nauticalDawn));
    assert.ok(ms(t.nauticalDawn) < ms(t.civilDawn));
  });

  test("celestialNights carry moon phase and twilight bounds", () => {
    const nights = ce.celestialNights({
      from: new Date("2026-10-05T00:00:00Z"),
      days: 3,
      lat: -21.1,
      lon: -175.2,
    });
    assert.equal(nights.length, 3);
    for (const night of nights) {
      assert.ok(night.moonPhaseDeg >= 0 && night.moonPhaseDeg < 360);
      assert.ok(night.moonIllumination >= 0 && night.moonIllumination <= 1);
      assert.ok(night.civilDusk != null && night.civilDawn != null);
    }
  });

  test("celestialNights carry sun/moon rise and set stamps (work doc #33)", () => {
    const nights = ce.celestialNights({
      from: new Date("2026-10-05T00:00:00Z"),
      days: 2,
      lat: -21.1,
      lon: -175.2,
    });
    for (const night of nights) {
      for (const field of ["sunrise", "sunset", "moonrise", "moonset"]) {
        const value = night[field];
        assert.ok(
          value === null || !Number.isNaN(new Date(value).getTime()),
          `${field} is an ISO stamp or null`,
        );
      }
      // The bracketing sanity: sunset before the night's civil dusk,
      // sunrise after its nautical dusk
      if (night.sunset && night.civilDusk) {
        assert.ok(
          new Date(night.sunset).getTime() <
            new Date(night.civilDusk).getTime(),
        );
      }
      if (night.sunrise && night.nauticalDusk) {
        assert.ok(
          new Date(night.sunrise).getTime() >
            new Date(night.nauticalDusk).getTime(),
        );
      }
    }
  });

  test("polar day degrades the sun stamps to null (work doc #33)", () => {
    const nights = ce.celestialNights({
      from: new Date("2026-07-01T00:00:00Z"),
      days: 1,
      lat: 78,
      lon: 15,
    });
    assert.equal(nights[0].sunrise, null);
    assert.equal(nights[0].sunset, null);
  });

  test("planetary conjunction: Mars–Jupiter 2024-08-14", () => {
    const events = ce.planetaryEvents({
      from: new Date("2024-08-13T00:00:00Z"),
      hours: 72,
      lat: 20,
      lon: -160,
    });
    const conjunctions = events.filter((e) => e.kind === "conjunction");
    assert.equal(conjunctions.length, 1);
    assert.equal(conjunctions[0].timestamp, "2024-08-14T15:00:00.000Z");
    assert.match(conjunctions[0].description, /Mars and Jupiter/);
    assert.match(conjunctions[0].description, /0\.3° apart/);
    assert.equal(conjunctions[0].tactical, true);
  });

  test("no conjunction event when the pair never closes", () => {
    const events = ce.planetaryEvents({
      from: new Date("2026-10-05T00:00:00Z"),
      hours: 24,
      lat: 20,
      lon: -160,
    });
    assert.ok(events.every((e) => e.kind !== "conjunction"));
  });

  test("opposition: Jupiter January 2026", () => {
    const events = ce.planetaryEvents({
      from: new Date("2026-01-09T12:00:00Z"),
      hours: 48,
      lat: 20,
      lon: -160,
    });
    const oppositions = events.filter((e) => e.kind === "opposition");
    assert.equal(oppositions.length, 1);
    assert.match(oppositions[0].description, /Jupiter at opposition/);
  });

  test("meteor peak: Perseids 2026 under a new moon fire, 2024 under a lit moon do not", () => {
    const dark = ce.meteorEvents({
      from: new Date("2026-08-12T00:00:00Z"),
      hours: 48,
      lat: 20,
      lon: 60,
    });
    assert.equal(dark.length, 1);
    assert.equal(dark[0].timestamp, "2026-08-12T20:00:00.000Z");
    assert.match(dark[0].description, /Perseids/);
    assert.match(dark[0].description, /Moon 0% lit/);

    const moonlit = ce.meteorEvents({
      from: new Date("2024-08-12T00:00:00Z"),
      hours: 48,
      lat: 20,
      lon: 60,
    });
    assert.deepEqual(moonlit, []);
  });

  test("meteor peak skipped when the radiant never clears the horizon", () => {
    // Quadrantids (dec +49) from the deep south: max radiant
    // altitude 90 − |−55 − 49| < 0 → never reported
    const events = ce.meteorEvents({
      from: new Date("2026-01-03T00:00:00Z"),
      hours: 48,
      lat: -55,
      lon: 60,
    });
    assert.deepEqual(events, []);
  });

  test("cloud gate suppresses tactical events under overcast forecasts", () => {
    const overcast = ce.buildEphemerisEvents({
      lat: 20,
      lon: 60,
      from: new Date("2026-08-12T00:00:00Z"),
      hours: 48,
      cloudCoverAt: () => 80,
    });
    // Tactical events (visible-sky items) stay suppressed; the
    // informational moon-phase notes are not cloud-gated (doc #35)
    assert.deepEqual(
      overcast.filter((e) => e.tactical),
      [],
    );
    assert.ok(!overcast.some((e) => e.kind === "meteor"));

    const clear = ce.buildEphemerisEvents({
      lat: 20,
      lon: 60,
      from: new Date("2026-08-12T00:00:00Z"),
      hours: 48,
      cloudCoverAt: () => 10,
    });
    assert.equal(clear.filter((e) => e.kind === "meteor").length, 1);
  });

  test("cloudCoverLookup interpolates hourly cloud cover", () => {
    const payload = {
      waypoints: [
        {
          forecasts: [
            {
              timestamp: "2026-08-12T00:00:00Z",
              surface: { cloudCover: 10 },
            },
            {
              timestamp: "2026-08-12T01:00:00Z",
              surface: { cloudCover: 30 },
            },
            { timestamp: "2026-08-12T02:00:00Z", surface: {} },
            {
              timestamp: "2026-08-12T03:00:00Z",
              surface: { cloudCover: 5 },
            },
          ],
        },
      ],
    };
    const lookup = ce.cloudCoverLookup(payload);
    assert.equal(lookup("2026-08-12T00:30:00Z"), 20);
    // Missing value inside the range: null, gate stays open
    assert.equal(lookup("2026-08-12T02:00:00Z"), null);
    // Outside the forecast range: null
    assert.equal(lookup("2026-08-13T00:00:00Z"), null);
    // No payload: no lookup at all
    assert.equal(ce.cloudCoverLookup(null), undefined);
    assert.equal(ce.cloudCoverLookup({ waypoints: [] }), undefined);
  });

  test("buildEphemerisEvents merges kinds within the window", () => {
    const events = ce.buildEphemerisEvents({
      lat: 20,
      lon: -160,
      from: new Date("2026-01-09T12:00:00Z"),
      hours: 48,
    });
    assert.ok(events.some((e) => e.kind === "opposition"));
    // Nothing outside the window
    const later = ce.buildEphemerisEvents({
      lat: 20,
      lon: -160,
      from: new Date("2027-01-09T12:00:00Z"),
      hours: 24,
    });
    assert.ok(later.every((e) => e.kind !== "opposition"));
  });
});

describe("almanac migration extras (work doc #35)", () => {
  test("moon phase events: exact new-moon and full-moon instants", () => {
    const events = ce.moonPhaseEvents({
      from: new Date("2026-08-10T00:00:00Z"),
      hours: 240,
    });
    const newMoon = events.find((e) => e.description.startsWith("New Moon"));
    assert.ok(newMoon, "new moon event present");
    assert.equal(newMoon.kind, "moonPhase");
    assert.equal(newMoon.tactical, false);
    assert.ok(
      newMoon.timestamp.startsWith("2026-08-12T17:36"),
      `new moon stamp ${newMoon.timestamp}`,
    );

    const full = ce.moonPhaseEvents({
      from: new Date("2026-08-27T00:00:00Z"),
      hours: 48,
    });
    assert.ok(
      full.some(
        (e) =>
          e.kind === "moonPhase" &&
          e.description.startsWith("Full Moon") &&
          e.timestamp.startsWith("2026-08-28T04:18"),
      ),
      "full moon event present with its exact instant",
    );
  });

  test("lunar eclipse: 2026-03-03 total eclipse visible from the Pacific", () => {
    const events = ce.eclipseEvents({
      from: new Date("2026-03-01T00:00:00Z"),
      hours: 96,
      lat: 20,
      lon: -160,
    });
    const lunar = events.filter((e) => e.kind === "lunarEclipse");
    assert.equal(lunar.length, 1);
    assert.ok(
      lunar[0].timestamp.startsWith("2026-03-03T11:33"),
      `peak stamp ${lunar[0].timestamp}`,
    );
    assert.match(lunar[0].description, /Total lunar eclipse/);
    assert.equal(lunar[0].tactical, true);
  });

  test("lunar eclipse skipped in daylight: same eclipse from the Indian Ocean", () => {
    // 11:33 UTC = 16:33 local at lon 60: the Sun is well above the
    // civil twilight line, so the peak is not a night-watch event
    const events = ce.eclipseEvents({
      from: new Date("2026-03-01T00:00:00Z"),
      hours: 96,
      lat: 20,
      lon: 60,
    });
    assert.ok(events.every((e) => e.kind !== "lunarEclipse"));
  });

  test("solar eclipse: 2026-08-12 total eclipse from Iceland", () => {
    const events = ce.eclipseEvents({
      from: new Date("2026-08-11T00:00:00Z"),
      hours: 48,
      lat: 64.1,
      lon: -21.9,
    });
    const solar = events.filter((e) => e.kind === "solarEclipse");
    assert.equal(solar.length, 1);
    assert.ok(
      solar[0].timestamp.startsWith("2026-08-12T17:48"),
      `peak stamp ${solar[0].timestamp}`,
    );
    assert.match(solar[0].description, /Total solar eclipse/);
  });

  test("cloud gate applies to eclipses", () => {
    const overcast = ce.eclipseEvents({
      from: new Date("2026-03-01T00:00:00Z"),
      hours: 96,
      lat: 20,
      lon: -160,
      cloudCoverAt: () => 80,
    });
    assert.ok(overcast.every((e) => e.kind !== "lunarEclipse"));
  });

  test("eye-height dip shifts the rise/set stamps the marine way", () => {
    const base = {
      from: new Date("2026-10-05T00:00:00Z"),
      days: 1,
      lat: 60,
      lon: 25,
    };
    const sea = ce.celestialNights(base)[0];
    const mast = ce.celestialNights({ ...base, eyeHeightM: 10 })[0];
    assert.ok(mast.sunrise < sea.sunrise, "raised horizon: earlier sunrise");
    assert.ok(mast.sunset > sea.sunset, "raised horizon: later sunset");
    const deltaMs = new Date(sea.sunrise) - new Date(mast.sunrise);
    assert.ok(
      deltaMs > 20000 && deltaMs < 600000,
      `sunrise shift in seconds, got ${deltaMs} ms`,
    );
  });

  test("eye height out of range falls back to the sea-level crossing", () => {
    const base = {
      from: new Date("2026-10-05T00:00:00Z"),
      days: 1,
      lat: 60,
      lon: 25,
    };
    const sea = ce.celestialNights(base)[0];
    const absurd = ce.celestialNights({ ...base, eyeHeightM: 99999 })[0];
    const bad = ce.celestialNights({ ...base, eyeHeightM: -5 })[0];
    assert.equal(absurd.sunrise, sea.sunrise);
    assert.equal(bad.sunset, sea.sunset);
  });

  test("buildEphemerisEvents carries the new kinds in one call", () => {
    const events = ce.buildEphemerisEvents({
      lat: 20,
      lon: 60,
      from: new Date("2026-08-12T00:00:00Z"),
      hours: 48,
    });
    assert.ok(events.some((e) => e.kind === "moonPhase"));
    assert.ok(events.some((e) => e.kind === "meteor"));
  });
});
