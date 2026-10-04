const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const ha = require("../plugin/hazard-alerts.js");

describe("critical hazard notifications (work doc #30)", () => {
  test("tropical cyclone: GDACS TC red/orange escalates to emergency", () => {
    const notifications = ha.escalateHazards({
      gdacsEvents: [
        {
          id: "TC1001325",
          type: "TC",
          alertLevel: "red",
          title: "Rachel",
          distanceNm: 240,
        },
        {
          id: "FL1",
          type: "FL",
          alertLevel: "orange",
          title: "flood far away",
          distanceNm: 900,
        },
        {
          id: "TCgreen",
          type: "TC",
          alertLevel: "green",
          title: "weak system",
          distanceNm: 100,
        },
      ],
      vessel: { lat: -21.1, lon: -175.2 },
      navigationState: "sailing",
    });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].state, "emergency");
    assert.match(notifications[0].message, /Rachel/);
    assert.equal(notifications[0].eventId, "TC1001325");
  });

  test("tsunami at anchor escalates to emergency; deep-water transit does not", () => {
    const capAlerts = [
      {
        identifier: "TSU-1",
        event: "Tsunami Warning",
        severity: "extreme",
        headline: "Tsunami Warning for Tonga waters",
      },
    ];
    const atAnchor = ha.escalateHazards({
      capAlerts,
      vessel: { lat: -21.1, lon: -175.2 },
      navigationState: "anchored",
    });
    assert.equal(atAnchor.length, 1);
    assert.equal(atAnchor[0].state, "emergency");
    assert.match(atAnchor[0].message, /at anchor/);

    // Underway in deep water (no sounding): the same warning stays
    // passive — in hundreds of metres it is a non-event for the hull
    const deepTransit = ha.escalateHazards({
      capAlerts,
      vessel: { lat: -21.1, lon: -175.2 },
      navigationState: "sailing",
      hasDepthReading: false,
    });
    assert.deepEqual(deepTransit, []);

    // Underway but shallow (transducer in range): error, not emergency
    const shallowTransit = ha.escalateHazards({
      capAlerts,
      vessel: { lat: -21.1, lon: -175.2 },
      navigationState: "sailing",
      hasDepthReading: true,
    });
    assert.equal(shallowTransit[0].state, "error");
  });

  test("hurricane/typhoon CAP events escalate to emergency", () => {
    const notifications = ha.escalateHazards({
      capAlerts: [
        {
          identifier: "HUR-1",
          event: "Hurricane Warning",
          severity: "extreme",
          headline: "Hurricane warning near the route",
        },
      ],
      vessel: { lat: 20, lon: -112 },
      navigationState: "sailing",
    });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].state, "emergency");
  });

  test("hysteresis: one miss keeps the notification, two clear it", () => {
    const escalation = [
      { id: "gdacs-TC1", eventId: "TC1", state: "emergency", message: "TC" },
    ];
    // Cycle 1: active
    const first = ha.applyHysteresis({
      previous: new Map(),
      current: escalation,
      missCounts: new Map(),
    });
    assert.equal(first.active.size, 1);
    assert.deepEqual(first.cleared, []);

    // Cycle 2: the event dipped out — one miss, still active
    const second = ha.applyHysteresis({
      previous: first.active,
      current: [],
      missCounts: first.missCounts,
    });
    assert.equal(second.active.size, 1, "one miss does not clear");
    assert.deepEqual(second.cleared, []);

    // Cycle 3: still out — cleared
    const third = ha.applyHysteresis({
      previous: second.active,
      current: [],
      missCounts: second.missCounts,
    });
    assert.equal(third.active.size, 0);
    assert.deepEqual(third.cleared, ["gdacs-TC1"]);
  });

  test("hysteresis: a returning event resets its miss counter", () => {
    const escalation = [
      { id: "cap-1", eventId: "cap-1", state: "emergency", message: "x" },
    ];
    const first = ha.applyHysteresis({
      previous: new Map(),
      current: escalation,
      missCounts: new Map(),
    });
    const second = ha.applyHysteresis({
      previous: first.active,
      current: [],
      missCounts: first.missCounts,
    });
    assert.equal(second.active.size, 1);
    // Back in the matrix: the miss counter resets
    const third = ha.applyHysteresis({
      previous: second.active,
      current: escalation,
      missCounts: second.missCounts,
    });
    const fourth = ha.applyHysteresis({
      previous: third.active,
      current: [],
      missCounts: third.missCounts,
    });
    assert.equal(
      fourth.active.size,
      1,
      "counter was reset: one miss after return",
    );
    assert.deepEqual(fourth.cleared, []);
  });
});
