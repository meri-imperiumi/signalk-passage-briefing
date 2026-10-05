const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseSailsString,
  sailStateKey,
  classifySailChange,
  extractSailEvents,
  normalizeLogEntry,
  readLogbookEntries,
  readLogbookSailEvents,
} = require("../plugin/logbook-source.js");

/**
 * Asserts two numbers are equal within float noise (the SI
 * conversions round-trip exactly in formula, not in IEEE 754).
 *
 * @param {number} actual
 * @param {number} expected
 * @param {number} [epsilon]
 */
function approx(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);
}

describe("parseSailsString", () => {
  test("parses a plain sail list", () => {
    const state = parseSailsString("Main, Genoa 1");
    assert.deepEqual(state, {
      MAIN: { reefs: null, furledPercent: null },
      GENOA_1: { reefs: null, furledPercent: null },
    });
  });

  test("parses reef and furl modifiers", () => {
    const state = parseSailsString("Main (1st reef), Genoa 1 (20% furled)");
    assert.equal(state.MAIN.reefs, 1);
    assert.equal(state.GENOA_1.furledPercent, 20);
  });

  test("cuts manually appended free text at the first period", () => {
    const state = parseSailsString(
      "Main (1st reef), Genoa 1 (30% furled). Big waves and low clouds",
    );
    assert.deepEqual(Object.keys(state), ["MAIN", "GENOA_1"]);
    assert.equal(state.MAIN.reefs, 1);
    assert.equal(state.GENOA_1.furledPercent, 30);
  });

  test("filters free-text noise against the sail inventory", () => {
    const known = new Set(["MAIN", "GENOA_1", "STAYSAIL"]);
    // Manual edit without a period separator: unknown component ends
    // the parse before the noise
    const state = parseSailsString(
      "Main, the combo stopped working so we drifted",
      { knownSailKeys: known },
    );
    assert.deepEqual(Object.keys(state), ["MAIN"]);
    // Without an inventory everything parses (and the noise pollutes)
    const unfiltered = parseSailsString("Main, the combo stopped working");
    assert.equal(unfiltered.THE_COMBO_STOPPED_WORKING.reefs, null);
  });

  test("keeps periods inside parentheticals", () => {
    const state = parseSailsString("Main, Genoa 1 (2.5 oz cloth)");
    assert.deepEqual(Object.keys(state), ["MAIN", "GENOA_1"]);
  });

  test("ignores unrecognized parentheticals but keeps the sail", () => {
    const state = parseSailsString("Main (?)");
    assert.deepEqual(state, { MAIN: { reefs: null, furledPercent: null } });
  });

  test("returns null for a fragment with no sail component", () => {
    assert.equal(parseSailsString(". Just notes, no sails"), null);
    assert.equal(parseSailsString(""), null);
  });
});

describe("sailStateKey", () => {
  test("is order-independent and canonical", () => {
    const a = sailStateKey(parseSailsString("Main (1st reef), Genoa 1"));
    const b = sailStateKey(parseSailsString("Genoa 1, Main (1st reef)"));
    assert.equal(a, b);
    assert.equal(a, "GENOA_1_MAIN_1_REEF");
  });

  test("encodes furl ratio", () => {
    assert.equal(
      sailStateKey(parseSailsString("Genoa 1 (20% furled)")),
      "GENOA_1_20_FURLED",
    );
  });

  test("bare poles", () => {
    assert.equal(sailStateKey({}), "NO_SAILS");
    assert.equal(sailStateKey(null), "NO_SAILS");
  });
});

describe("classifySailChange", () => {
  const s = (text) => parseSailsString(text);

  test("reef increase", () => {
    assert.equal(
      classifySailChange(s("Main, Genoa 1"), s("Main (1st reef), Genoa 1")),
      "REEF_INCREASE",
    );
  });

  test("reef decrease", () => {
    assert.equal(
      classifySailChange(
        s("Main (2nd reef), Staysail"),
        s("Main (1st reef), Staysail"),
      ),
      "REEF_DECREASE",
    );
  });

  test("furling in counts as a reef increase", () => {
    assert.equal(
      classifySailChange(s("Main, Genoa 1"), s("Main, Genoa 1 (30% furled)")),
      "REEF_INCREASE",
    );
  });

  test("handing a sail is a sail change even with reefs involved", () => {
    assert.equal(
      classifySailChange(s("Main (1st reef), Genoa 1"), s("Main (2nd reef)")),
      "SAIL_CHANGE",
    );
  });

  test("unknown previous state is a plain sail change", () => {
    assert.equal(classifySailChange(null, s("Main")), "SAIL_CHANGE");
  });
});

describe("extractSailEvents", () => {
  test("inventory filter keeps events but normalizes state keys", () => {
    const known = new Set(["MAIN", "GENOA_1"]);
    const events = extractSailEvents(
      [
        {
          datetime: "2023-03-20T14:19:16.099Z",
          text: "Sails set: Main (1st reef), The cone",
          wind: { speed: 15, direction: 225 },
        },
        {
          datetime: "2023-03-20T16:00:00.000Z",
          text: "Sails set: Main (2nd reef), Genoa 1",
          wind: { speed: 20, direction: 225 },
        },
        {
          datetime: "2023-03-20T18:00:00.000Z",
          text: "Sails set: Main (3rd reef), Genoa 1",
          wind: { speed: 24, direction: 225 },
        },
      ],
      { knownSailKeys: known },
    );
    // First event parses to just the Main component; the state still
    // transitions, and the noise never becomes a sail state key
    assert.equal(events.length, 3);
    assert.equal(events[0].sailState, "MAIN_1_REEF");
    assert.equal(events[1].sailState, "GENOA_1_MAIN_2_REEF");
    assert.equal(events[2].sailState, "GENOA_1_MAIN_3_REEF");
    // Unknown → Main is a plain change; handing the genoa alongside a
    // reef is a mixed change; the third step is a pure reef increase
    assert.equal(events[0].eventType, "SAIL_CHANGE");
    assert.equal(events[1].eventType, "SAIL_CHANGE");
    assert.equal(events[2].eventType, "REEF_INCREASE");
  });

  test("tracks state across the real-world text patterns", () => {
    const events = extractSailEvents([
      {
        datetime: "2023-03-20T10:00:00.000Z",
        text: "Motor stopped, sailing with Main, Genoa 1",
        wind: { speed: 11.2, direction: 210 },
      },
      {
        datetime: "2023-03-20T12:00:00.000Z",
        text: "Sailing with Main, Genoa 1",
        wind: { speed: 12, direction: 220 },
      },
      {
        datetime: "2023-03-20T14:19:16.099Z",
        text: "Sails set: Main (1st reef), Genoa 1",
        wind: { speed: 15.5, direction: 225 },
      },
      {
        datetime: "2023-03-20T15:49:51.097Z",
        text: "Sails set: Main, Genoa 1",
        wind: { speed: 13, direction: 230 },
      },
      {
        datetime: "2023-03-20T17:00:00.000Z",
        text: "Sails down, motoring. Thunder.",
        wind: { speed: 6, direction: 180 },
      },
      {
        datetime: "2023-03-20T17:30:00.000Z",
        text: "Sails up, motor off",
      },
    ]);

    assert.equal(events.length, 3);
    // The motor-stop snapshot established the state, so the identical
    // "Sailing with" declaration produced no event — the reef went in next
    assert.equal(events[0].eventType, "REEF_INCREASE");
    assert.equal(events[0].sailState, "GENOA_1_MAIN_1_REEF");
    assert.equal(events[0].twsKnots, 15.5);
    assert.equal(events[0].twaDeg, 135);
    assert.match(events[0].notes, /Sails set/);
    // Shake-out
    assert.equal(events[1].eventType, "REEF_DECREASE");
    // Bare poles (manual suffix ignored)
    assert.equal(events[2].eventType, "SAIL_CHANGE");
    assert.equal(events[2].sailState, "NO_SAILS");
    assert.equal(events[2].twaDeg, 180);
  });

  test("skips duplicate state declarations and sorts out of order input", () => {
    const events = extractSailEvents([
      { datetime: "2023-03-20T12:00:00.000Z", text: "Sails set: Main" },
      {
        datetime: "2023-03-20T10:00:00.000Z",
        text: "Sails set: Main, Genoa 1",
      },
      { datetime: "2023-03-20T14:00:00.000Z", text: "Sails set: Main" },
    ]);
    assert.equal(events.length, 2);
    assert.equal(events[0].sailState, "GENOA_1_MAIN");
    assert.equal(events[1].sailState, "MAIN");
  });

  test("unknown motor-stop snapshots do not clobber known state", () => {
    const events = extractSailEvents([
      {
        datetime: "2023-03-20T10:00:00.000Z",
        text: "Sails set: Main (1st reef)",
      },
      { datetime: "2023-03-20T11:00:00.000Z", text: "Motor stopped, sailing" },
      {
        datetime: "2023-03-20T12:00:00.000Z",
        text: "Sails set: Main (2nd reef)",
      },
    ]);
    assert.equal(events.length, 2);
    assert.equal(events[1].eventType, "REEF_INCREASE");
  });
});

describe("normalizeLogEntry", () => {
  test("converts SI telemetry to the consumer units", () => {
    const entry = normalizeLogEntry({
      id: "1b4e28ba-2fa1-11d2-883f-b9a761bde3fb",
      datetime: "2023-03-20T14:19:16.099Z",
      text: "Sails set: Main (1st reef), Genoa 1",
      telemetry: [
        {
          path: "navigation.position",
          value: {
            latitude: 59.9,
            longitude: 24.9,
            altitude: 0,
            source: "GPS",
          },
        },
        {
          path: "environment.wind.speedOverGround",
          value: 5.144444444444445,
        },
        {
          path: "environment.wind.directionTrue",
          value: 3.9269908169872414,
        },
      ],
      author: "",
      origin: "auto",
      category: "navigation",
    });
    assert.deepEqual(entry.position, { latitude: 59.9, longitude: 24.9 });
    approx(entry.wind.speed, 10);
    approx(entry.wind.direction, 225);
    // Logbook fields beyond the consumer shape are dropped
    assert.equal(entry.id, undefined);
    assert.equal(entry.origin, undefined);
  });

  test("takes the first usable pathvalue when a path repeats", () => {
    const entry = normalizeLogEntry({
      datetime: "2023-03-20T14:19:16.099Z",
      telemetry: [
        { path: "environment.wind.speedOverGround", value: 5.14, $source: "a" },
        {
          path: "environment.wind.speedOverGround",
          value: 10.28,
          $source: "b",
        },
      ],
    });
    approx(entry.wind.speed, 5.14 * (3600 / 1852));
  });

  test("entries without telemetry still parse", () => {
    assert.deepEqual(
      normalizeLogEntry({
        datetime: "2023-03-20T14:19:16.099Z",
        text: "Sails set: Main",
      }),
      {
        datetime: "2023-03-20T14:19:16.099Z",
        text: "Sails set: Main",
      },
    );
    assert.deepEqual(normalizeLogEntry({}), {});
    assert.equal(normalizeLogEntry(null), null);
  });
});

describe("readLogbookEntries", () => {
  test("lists the resource map chronologically through the resources API", async () => {
    const queries = [];
    const app = {
      resourcesApi: {
        async listResources(type, query) {
          assert.equal(type, "logentries");
          queries.push(query);
          return {
            "uuid-b": {
              datetime: "2023-03-20T08:00:00.000Z",
              text: "Sails set: Main (1st reef), Genoa 1",
            },
            "uuid-a": {
              datetime: "2023-03-19T09:00:00.000Z",
              text: "Motor stopped, sailing with Main, Genoa 1",
            },
          };
        },
      },
    };
    const entries = await readLogbookEntries(app);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].datetime, "2023-03-19T09:00:00.000Z");
    assert.equal(entries[1].datetime, "2023-03-20T08:00:00.000Z");
    // The listing contract requires an explicit window or limit
    assert.ok(queries[0].from && queries[0].to);
  });

  test("no resources API or no provider reads as an empty store", async () => {
    assert.deepEqual(await readLogbookEntries({}), []);
    const failing = {
      resourcesApi: {
        async listResources() {
          throw new Error("no provider for the type");
        },
      },
    };
    assert.deepEqual(await readLogbookEntries(failing), []);
  });
});

describe("readLogbookSailEvents", () => {
  test("extracts events from the resources API and filters the range", async () => {
    const app = {
      resourcesApi: {
        async listResources() {
          return {
            "uuid-b": {
              datetime: "2023-03-20T08:00:00.000Z",
              text: "Sails set: Main (1st reef), Genoa 1",
              telemetry: [
                {
                  path: "environment.wind.speedOverGround",
                  value: 8.231111111111111,
                },
                {
                  path: "environment.wind.directionTrue",
                  value: 3.665191429188092,
                },
              ],
            },
            "uuid-c": {
              datetime: "2023-03-20T10:00:00.000Z",
              text: "Sails down, motoring",
              telemetry: [
                {
                  path: "environment.wind.speedOverGround",
                  value: 4.115555555555556,
                },
              ],
            },
            "uuid-a": {
              datetime: "2023-03-19T09:00:00.000Z",
              text: "Motor stopped, sailing with Main, Genoa 1",
              telemetry: [
                {
                  path: "environment.wind.speedOverGround",
                  value: 5.144444444444445,
                },
                {
                  path: "environment.wind.directionTrue",
                  value: 3.490658503988659,
                },
              ],
            },
          };
        },
      },
    };

    const all = await readLogbookSailEvents({ app });
    assert.equal(all.length, 2);
    assert.equal(all[0].eventType, "REEF_INCREASE");
    approx(all[0].twsKnots, 16);
    assert.equal(all[1].eventType, "SAIL_CHANGE");

    const windowed = await readLogbookSailEvents({
      app,
      from: "2023-03-20T00:00:00.000Z",
      to: "2023-03-20T09:00:00.000Z",
    });
    assert.equal(windowed.length, 1);
    assert.equal(windowed[0].eventType, "REEF_INCREASE");
  });

  test("state tracking reaches back before the requested range", async () => {
    const app = {
      resourcesApi: {
        async listResources() {
          return {
            "uuid-a": {
              datetime: "2023-03-19T09:00:00.000Z",
              text: "Sails set: Main (1st reef)",
            },
            "uuid-b": {
              datetime: "2023-03-20T08:00:00.000Z",
              text: "Sails set: Main (2nd reef)",
            },
          };
        },
      },
    };
    const windowed = await readLogbookSailEvents({
      app,
      from: "2023-03-20T00:00:00.000Z",
    });
    assert.equal(windowed.length, 1);
    // Classified against the state from the previous day's entry
    assert.equal(windowed[0].eventType, "REEF_INCREASE");
  });

  test("missing provider is not fatal", async () => {
    const failing = {
      resourcesApi: {
        async listResources() {
          throw new Error("no provider for the type");
        },
      },
    };
    assert.deepEqual(await readLogbookSailEvents({ app: failing }), []);
    assert.deepEqual(await readLogbookSailEvents({ app: {} }), []);
  });
});
