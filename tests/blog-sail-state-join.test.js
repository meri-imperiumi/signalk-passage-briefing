const test = require("node:test");
const assert = require("node:assert");
const { sailEvents, joinSailState } = require("../bin/blog-sail-state-join.js");

test("parses the observed logbook event styles", () => {
  const { events } = sailEvents([
    {
      datetime: "2024-04-09T00:28:00Z",
      text: "Motor stopped, sailing with Main, Genoa 1",
    },
    { datetime: "2024-04-09T12:29:00Z", text: "Sails down, motoring" },
    {
      datetime: "2024-04-09T16:48:00Z",
      text: "Motor stopped, sailing with Main (1st reef), Staysail",
    },
  ]);
  assert.deepEqual(
    events.map((e) => e.state),
    ["sailing", "motoring", "sailing"],
  );
  assert.equal(events[2].text, "sailing with Main (1st reef), Staysail");
});

test("narrative prose mentioning sails does not create events", () => {
  const { events } = sailEvents([
    {
      datetime: "2024-04-09T12:51:00Z",
      text: "Between 2 fronts. As the wind started dropping from the easterly we took the sails down before it got too hairy.",
    },
  ]);
  assert.equal(events.length, 0);
});

test("carries the latest event forward to underway hours", () => {
  const day = {
    hours: [
      { hourIso: "2024-04-09T00:00Z", underway: true },
      { hourIso: "2024-04-09T01:00Z", underway: true },
      { hourIso: "2024-04-09T13:00Z", underway: true },
      { hourIso: "2024-04-09T17:00Z", underway: true },
      { hourIso: "2024-04-09T18:00Z", underway: false },
      { hourIso: "2024-04-09T19:00Z", underway: true },
    ],
  };
  joinSailState(day, [
    {
      datetime: "2024-04-09T00:28:00Z",
      text: "Motor stopped, sailing with Main, Genoa 1",
    },
    { datetime: "2024-04-09T12:29:00Z", text: "Sails down, motoring" },
  ]);
  assert.equal(day.hours[0].sailState, null, "no event yet -> null");
  assert.equal(day.hours[1].sailState, "sailing");
  assert.equal(day.hours[2].sailState, "motoring");
  assert.equal(day.hours[3].sailState, "motoring");
  assert.equal(day.hours[4].sailState, undefined, "stopped hours skipped");
  assert.equal(day.hours[5].sailState, "motoring");
});

test("recognizes canvas-adjustment and poling phrasing", () => {
  const { events } = sailEvents([
    {
      datetime: "2022-07-10T23:05:00Z",
      text: "Sail(main) to 1st reef to arrive later.",
    },
    {
      datetime: "2022-07-10T19:11:00Z",
      text: "Suski on duty, poled out jib. Swapped courtesy flags",
    },
  ]);
  assert.deepEqual(
    events.map((e) => e.state),
    ["sailing", "sailing"],
  );
  assert.equal(events[1].text, "sailing with main (canvas adjusted)");
});

test("recognizes the structured Sails set: phrasing", () => {
  const { events } = sailEvents([
    {
      datetime: "2026-04-03T08:03:00Z",
      text: "Sails set: Staysail, Genoa 1 (10% furled). Main was slatting too much",
    },
    { datetime: "2026-04-03T14:31:00Z", text: "Sails set: Parasailor" },
  ]);
  assert.deepEqual(
    events.map((e) => e.state),
    ["sailing", "sailing"],
  );
  assert.equal(
    events[0].text,
    "sailing with Staysail, Genoa 1 (10% furled). Main was slatting too much",
  );
  assert.equal(events[1].text, "sailing with Parasailor");
});

test("extracts the crew's watch handovers for deployment anchoring", () => {
  const { watchEvents } = sailEvents([
    { datetime: "2024-04-09T20:00:00Z", text: "Bergie on watch" },
    {
      datetime: "2024-04-10T00:02:00Z",
      text: "Suski on watch. Dolphins at sunset!",
    },
    {
      datetime: "2024-04-10T04:21:00Z",
      text: "Suski on duty, poled out jib. Swapped flags",
    },
  ]);
  assert.deepEqual(
    watchEvents.map((w) => [w.iso.slice(11, 16), w.who]),
    [
      ["20:00", "Bergie"],
      ["00:02", "Suski"],
      ["04:21", "Suski"],
    ],
  );
});
