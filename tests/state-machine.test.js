const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  STATES,
  CRON_HOURS_UTC,
  CRON_MINUTE_UTC,
  SOC_FULL_THRESHOLD,
  nextCronRun,
  PassageStateMachine,
} = require("../plugin/state-machine.js");

const d = (iso) => new Date(iso);

describe("state machine", () => {
  test("starts OFFLINE", () => {
    const machine = new PassageStateMachine();
    assert.equal(machine.state, STATES.OFFLINE);
  });

  test("internet edge to online fires a oneshot fetch and lands in STANDBY_OFFSHORE while sailing", () => {
    const machine = new PassageStateMachine();
    const result = machine.update(
      { internetState: "online", navigationState: "sailing" },
      d("2026-08-01T10:00:00Z"),
    );
    assert.equal(result.fetch, "oneshot");
    assert.equal(result.state, STATES.STANDBY_OFFSHORE);
    assert.equal(machine.state, STATES.STANDBY_OFFSHORE);
  });

  test("online + moored + full battery lands in PERSISTENT_CRON", () => {
    const machine = new PassageStateMachine();
    const result = machine.update(
      {
        internetState: "online",
        navigationState: "moored",
        soc: 0.98,
      },
      d("2026-08-01T10:00:00Z"),
    );
    assert.equal(result.fetch, "oneshot");
    assert.equal(result.state, STATES.PERSISTENT_CRON);
  });

  test("low or unknown state of charge keeps the vessel in STANDBY_OFFSHORE", () => {
    const machine = new PassageStateMachine();
    machine.update(
      { internetState: "online", navigationState: "anchored", soc: 0.5 },
      d("2026-08-01T10:00:00Z"),
    );
    assert.equal(machine.state, STATES.STANDBY_OFFSHORE);

    const unknown = new PassageStateMachine();
    unknown.update(
      { internetState: "online", navigationState: "anchored", soc: null },
      d("2026-08-01T10:00:00Z"),
    );
    assert.equal(unknown.state, STATES.STANDBY_OFFSHORE);
  });

  test("soc threshold matches the spec constant", () => {
    assert.equal(SOC_FULL_THRESHOLD, 0.95);
  });

  test("stable observations do not refetch", () => {
    const machine = new PassageStateMachine();
    machine.update(
      { internetState: "online", navigationState: "sailing" },
      d("2026-08-01T10:00:00Z"),
    );
    const again = machine.update(
      { internetState: "online", navigationState: "sailing" },
      d("2026-08-01T10:00:01Z"),
    );
    assert.equal(again.fetch, null);
    assert.equal(again.transitioned, false);
  });

  test("online to metered flip is a new explicit transition and refetches", () => {
    const machine = new PassageStateMachine();
    machine.update(
      { internetState: "online", navigationState: "sailing" },
      d("2026-08-01T10:00:00Z"),
    );
    const result = machine.update(
      { internetState: "metered", navigationState: "sailing" },
      d("2026-08-01T10:05:00Z"),
    );
    assert.equal(result.fetch, "oneshot");
  });

  test("losing the internet connection returns to OFFLINE", () => {
    const machine = new PassageStateMachine();
    machine.update(
      { internetState: "online", navigationState: "moored", soc: 1 },
      d("2026-08-01T10:00:00Z"),
    );
    const result = machine.update(
      { internetState: "offline", navigationState: "moored", soc: 1 },
      d("2026-08-01T10:05:00Z"),
    );
    assert.equal(result.state, STATES.OFFLINE);
    assert.equal(machine.scheduledCronRun, null);
  });

  test("nextCronRun returns the four UTC publication windows", () => {
    assert.deepEqual(CRON_HOURS_UTC, [2, 8, 14, 20]);
    assert.equal(CRON_MINUTE_UTC, 15);

    // Before the first window: same day 02:15.
    assert.equal(
      nextCronRun(d("2026-08-01T01:00:00Z")).toISOString(),
      "2026-08-01T02:15:00.000Z",
    );
    // Just after a window: the next one the same day.
    assert.equal(
      nextCronRun(d("2026-08-01T02:15:00Z")).toISOString(),
      "2026-08-01T08:15:00.000Z",
    );
    // After the last window: wraps to 02:15 the following day.
    assert.equal(
      nextCronRun(d("2026-08-01T21:00:00Z")).toISOString(),
      "2026-08-02T02:15:00.000Z",
    );
  });

  test("cron fires once per window in PERSISTENT_CRON", () => {
    const machine = new PassageStateMachine();
    machine.update(
      { internetState: "online", navigationState: "moored", soc: 1 },
      d("2026-08-01T10:00:00Z"),
    );
    assert.equal(
      machine.scheduledCronRun?.toISOString(),
      "2026-08-01T14:15:00.000Z",
    );

    const early = machine.tick(d("2026-08-01T14:14:00Z"));
    assert.equal(early.fetch, null);

    const due = machine.tick(d("2026-08-01T14:15:30Z"));
    assert.equal(due.fetch, "cron");
    assert.equal(due.cronWindow.toISOString(), "2026-08-01T14:15:00.000Z");

    // Already handled this window: no double fire.
    assert.equal(machine.tick(d("2026-08-01T14:16:00Z")).fetch, null);
  });

  test("cron never fires outside PERSISTENT_CRON (execution guard)", () => {
    const machine = new PassageStateMachine();
    // Sailing: STANDBY_OFFSHORE, cron disabled even with internet up.
    machine.update(
      { internetState: "online", navigationState: "sailing", soc: 1 },
      d("2026-08-01T10:00:00Z"),
    );
    assert.equal(machine.state, STATES.STANDBY_OFFSHORE);
    assert.equal(machine.scheduledCronRun, null);
    assert.equal(machine.tick(d("2026-08-01T14:20:00Z")).fetch, null);
  });

  test("leaving and re-entering PERSISTENT_CRON reschedules the next window", () => {
    const machine = new PassageStateMachine();
    machine.update(
      { internetState: "online", navigationState: "moored", soc: 1 },
      d("2026-08-01T10:00:00Z"),
    );
    machine.update(
      { internetState: "online", navigationState: "sailing", soc: 1 },
      d("2026-08-01T11:00:00Z"),
    );
    const result = machine.update(
      { internetState: "online", navigationState: "anchored", soc: 1 },
      d("2026-08-01T15:00:00Z"),
    );
    assert.equal(result.state, STATES.PERSISTENT_CRON);
    assert.equal(
      machine.scheduledCronRun?.toISOString(),
      "2026-08-01T20:15:00.000Z",
    );
  });
});
