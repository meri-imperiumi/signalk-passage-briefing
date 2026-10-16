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
    assert.equal(fourth.active.size, 1);
    assert.deepEqual(fourth.cleared, []);
  });

  test("tropical cyclone notifications latch and carry level and distance", () => {
    const notifications = ha.escalateHazards({
      gdacsEvents: [
        {
          id: "TC1001339",
          type: "TC",
          alertLevel: "orange",
          title: "ONE-26",
          distanceNm: 708.3,
        },
      ],
      vessel: { lat: -18.65, lon: -173.98 },
    });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].latch, true);
    assert.equal(notifications[0].level, "orange");
    assert.equal(notifications[0].distanceNm, 708.3);
  });

  test("latched notifications clear only after the long grace", () => {
    const latched = [
      {
        id: "gdacs-TC1",
        eventId: "TC1",
        level: "orange",
        latch: true,
        state: "emergency",
        message: "TC",
      },
    ];
    const plain = [
      { id: "bulletin-x", eventId: "x", state: "error", message: "gale" },
    ];
    const misses = new Map();
    // Cycle 1: both held (plain misses counted toward its clear at 2)
    let state = ha.applyHysteresis({
      previous: new Map([
        ["gdacs-TC1", latched[0]],
        ["bulletin-x", plain[0]],
      ]),
      current: [],
      missCounts: misses,
      latchMissesToClear: 4,
    });
    assert.deepEqual(state.cleared, []);
    // Cycle 2: the plain block clears at two misses, the latched
    // cyclone is still held
    state = ha.applyHysteresis({
      previous: state.active,
      current: [],
      missCounts: state.missCounts,
      latchMissesToClear: 4,
    });
    assert.deepEqual(state.cleared, ["bulletin-x"]);
    assert.ok(state.active.has("gdacs-TC1"), "latched TC held at 2 misses");
    state = ha.applyHysteresis({
      previous: state.active,
      current: [],
      missCounts: state.missCounts,
      latchMissesToClear: 4,
    });
    assert.ok(state.active.has("gdacs-TC1"), "latched TC held at 3 misses");
    state = ha.applyHysteresis({
      previous: state.active,
      current: [],
      missCounts: state.missCounts,
      latchMissesToClear: 4,
    });
    assert.deepEqual(
      state.cleared,
      ["gdacs-TC1"],
      "latched TC clears at the latch grace",
    );
  });

  test("retainLatched: fresh floor orange, latched cyclones ride any level", () => {
    const wide = [
      { id: "TC1", type: "TC", alertLevel: "orange", distanceNm: 300 },
      { id: "TC2", type: "TC", alertLevel: "green", distanceNm: 400 },
      { id: "FL1", type: "FL", alertLevel: "orange", distanceNm: 100 },
    ];
    const previous = new Map([
      ["gdacs-TC2", { id: "gdacs-TC2", latch: true, state: "emergency" }],
    ]);
    const kept = ha.retainLatched({ events: wide, previous });
    assert.deepEqual(
      kept.map((e) => e.id),
      ["TC1", "TC2", "FL1"],
      "orange fresh passes, latched TC rides green, flood unaffected",
    );
    assert.equal(kept[1].latched, true, "carried event is marked latched");

    // Nothing latched: the green cyclone drops, the matrix stays at
    // the fresh floor
    const none = ha.retainLatched({ events: wide, previous: new Map() });
    assert.deepEqual(
      none.map((e) => e.id),
      ["TC1", "FL1"],
    );
  });

  test("the Wati flap: a 12-minute GDACS dip never clears the notification", () => {
    // Logbook 2026-10-16: raised 21:17, cleared 21:50 (2-cycle grace
    // expired on a dip), re-raised 22:02 — alarm each time. The dip
    // lasted ~12 min; the latch grace is an hour
    const raised = ha.escalateHazards({
      gdacsEvents: [
        {
          id: "TC1001339",
          type: "TC",
          alertLevel: "orange",
          title: "ONE-26",
          distanceNm: 708.3,
        },
      ],
      vessel: { lat: -18.65, lon: -173.98 },
    });
    assert.equal(raised.length, 1);
    const misses = new Map();
    let active = new Map([[raised[0].id, raised[0]]]);
    // Twelve minutes of the event being out of the escalation matrix:
    // the notification stays up, no clear, no re-raise
    for (let cycle = 0; cycle < 12; cycle++) {
      const state = ha.applyHysteresis({
        previous: active,
        current: [],
        missCounts: misses,
      });
      assert.deepEqual(
        state.cleared,
        [],
        `dip cycle ${cycle + 1} must not clear the cyclone`,
      );
      active = state.active;
    }
    // The cyclone returns at green (GDACS re-evaluated): still
    // warnable, carried by the latch, no fresh raise
    const wide = [
      {
        id: "TC1001339",
        type: "TC",
        alertLevel: "green",
        title: "ONE-26",
        distanceNm: 708.3,
      },
    ];
    const carried = ha.retainLatched({
      events: wide,
      previous: active,
      minLevel: "orange",
    });
    assert.equal(carried.length, 1, "latched cyclone rides the green dip");
    const back = ha.escalateHazards({
      gdacsEvents: carried,
      vessel: { lat: -18.65, lon: -173.98 },
    });
    assert.equal(back.length, 1);
    assert.equal(back[0].id, "gdacs-TC1001339");
  });

  test("shouldRaise: ack silences the level, escalation and closing distance re-alarm", () => {
    const orange = {
      level: "orange",
      distanceNm: 708.3,
      state: "emergency",
      message: "TC",
    };
    // No ack: raise
    assert.equal(
      ha.shouldRaise({ notification: orange, ack: undefined }),
      true,
    );
    // Acked at orange: silent
    assert.equal(
      ha.shouldRaise({
        notification: orange,
        ack: { level: "orange", distanceNm: 708.3, at: "2026-10-16T21:20:00Z" },
      }),
      false,
    );
    // Escalated to red: re-alarm
    assert.equal(
      ha.shouldRaise({
        notification: { ...orange, level: "red" },
        ack: { level: "orange", distanceNm: 708.3, at: "x" },
      }),
      true,
    );
    // Downgraded to green after a red ack: stays silent
    assert.equal(
      ha.shouldRaise({
        notification: { ...orange, level: "green" },
        ack: { level: "red", distanceNm: 708.3, at: "x" },
      }),
      false,
    );
    // Same level but closed to half the acked distance: re-alarm
    assert.equal(
      ha.shouldRaise({
        notification: { ...orange, distanceNm: 350 },
        ack: { level: "orange", distanceNm: 708.3, at: "x" },
      }),
      true,
    );
    // Closed to 90% of the acked distance: still silent
    assert.equal(
      ha.shouldRaise({
        notification: { ...orange, distanceNm: 640 },
        ack: { level: "orange", distanceNm: 708.3, at: "x" },
      }),
      false,
    );
    // Level-less notifications suppress on any ack (unchanged)
    assert.equal(
      ha.shouldRaise({
        notification: { state: "error", message: "gale" },
        ack: { level: null, distanceNm: null, at: "x" },
      }),
      false,
    );
  });
});
