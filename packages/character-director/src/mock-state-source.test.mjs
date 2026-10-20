import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockStateSource } from "./mock-state-source.mjs";

test("subscribers receive agent-state-changed events shaped like the daemon's envelope", () => {
  const source = createMockStateSource();
  const events = [];
  source.subscribe((event) => events.push(event));

  source.setState("agent-1", "working");

  assert.equal(events.length, 1);
  assert.equal(events[0].agent_id, "agent-1");
  assert.equal(events[0].state, "working");
  assert.equal(typeof events[0].ts, "string");
});

test("a dev control can drive the same source by calling setState directly", () => {
  const source = createMockStateSource();
  const events = [];
  source.subscribe((event) => events.push(event));

  for (const state of ["blocked", "done"]) source.setState("agent-1", state);

  assert.deepEqual(events.map((e) => e.state), ["blocked", "done"]);
});

test("unsubscribe stops further events", () => {
  const source = createMockStateSource();
  const events = [];
  const unsubscribe = source.subscribe((event) => events.push(event));
  unsubscribe();

  source.setState("agent-1", "idle");

  assert.deepEqual(events, []);
});
