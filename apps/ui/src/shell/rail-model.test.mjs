// team-and-den-ux/04 (design/04-spec.md): the rail's entries and badges, the two sheet slots, and the Escape order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RAIL_ENTRIES, RAIL_FOOTER, TOPICS, railBadges, entryName, emptyLayers, openLayer, closeLayer, topLayer, escapeAction } from "./rail-model.mjs";

test("the rail lists the spec's eight entries in order, then its footer", () => {
  assert.deepEqual(RAIL_ENTRIES.map((e) => e.label), ["Talk to Bao", "Needs you", "Queue", "Work", "Meetings", "Team", "Library", "Tally"]);
  assert.deepEqual(RAIL_FOOTER.map((e) => e.id), ["build", "demo", "reset"]);
  assert.deepEqual(TOPICS, ["needs", "queue", "work", "meetings", "team", "library", "tally", "build"]);
});

// spec section 9 test 7: every destination of today's masthead, top nav, desk cards and scene chips is on the rail.
test("every place a destination lived before the rail is named by one rail entry", () => {
  const before = [
    "masthead Talk to Bao", "masthead Watch the demo", "top nav Work", "top nav Pandas", "top nav Library",
    "desk Needs you card", "desk Queue button", "desk Teams & queue card", "desk Meetings card", "desk Library card", "desk build card",
    "scene Tally chip", "garden Reset view link",
  ];
  const from = [...RAIL_ENTRIES, ...RAIL_FOOTER].map((e) => e.from).join(" | ");
  for (const place of before) assert.ok(from.includes(place), `${place} has no rail entry`);
});

test("badges: counts from the board, a dot for a running meeting and a ready update", () => {
  const snapshot = { tickets: [], frontier: ["a/01-x", "a/02-y"], meetings: [{ state: "running" }], build: null, requests: [], approvals: [], agents: [], deliveries: [] };
  const b = railBadges({ snapshot, now: Date.now() });
  assert.equal(b.queue.count, 2);
  assert.equal(b.meetings.dot, true);
  assert.equal(b.build.dot, false);
  assert.equal(railBadges({ snapshot: { ...snapshot, meetings: [{ state: "briefed" }] }, now: Date.now() }).meetings.dot, false);
  assert.equal(entryName(RAIL_ENTRIES[1], { count: 3 }), "Needs you, 3 waiting");
  assert.equal(entryName(RAIL_ENTRIES[1], { count: 0 }), "Needs you");
  assert.equal(entryName(RAIL_ENTRIES[4], { dot: true }), "Meetings, one is running");
});

test("one topic and one side sheet: opening replaces the same slot only, and closing touches one slot", () => {
  let layers = emptyLayers();
  layers = openLayer(layers, { slot: "topic", id: "needs" });
  layers = openLayer(layers, { slot: "side", id: "bao" });
  layers = openLayer(layers, { slot: "topic", id: "queue" });
  assert.deepEqual(layers.map((l) => l.id), ["bao", "queue"], "a new topic replaces the topic and becomes the top layer");
  assert.equal(topLayer(layers).id, "queue");
  assert.deepEqual(closeLayer(layers, "topic").map((l) => l.id), ["bao"]);
});

// spec section 9 tests 2 and 3, as rules.
test("Escape: a confirm first, then the last sheet opened, then the card, and walk mode only when nothing else is open", () => {
  const two = [{ slot: "topic" }, { slot: "side" }];
  assert.equal(escapeAction({ layers: two, confirming: true }), "confirm");
  assert.equal(escapeAction({ layers: two }), "sheet");
  assert.equal(escapeAction({ layers: [], picked: true }), "deselect");
  assert.equal(escapeAction({ layers: [], picked: false }), null, "the diorama with nothing open: Escape does nothing");
  assert.equal(escapeAction({ layers: two, walking: true }), "sheet", "with a sheet open in walk mode, Escape closes the sheet, not walk mode");
  assert.equal(escapeAction({ layers: [], walking: true }), "walk");
});
