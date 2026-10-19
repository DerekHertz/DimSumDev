// showcase-v1/04: the demo run shows a handoff, queued tickets with no panda, and a lit lantern.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_STEPS } from "./handoff-fixture.mjs";
import { deriveHandoffs, lanternState } from "./handoffs.mjs";
import { sceneFromState } from "./scene-from-state.mjs";

test("the demo run hands over tea -> steamers, then steamers -> pantry", () => {
  const all = DEMO_STEPS.slice(1).flatMap((s, i) => deriveHandoffs(DEMO_STEPS[i], s));
  assert.deepEqual(all.map((h) => [h.from, h.to]), [["tea", "steamers"], ["steamers", "pantry"]]);
});

test("a queued ticket has a basket but no panda", () => {
  const placements = sceneFromState(DEMO_STEPS[0]);
  assert.deepEqual(placements.map((c) => c.ref), ["demo/01-add-login"]);
  assert.ok(DEMO_STEPS[0].frontier.includes("demo/03-queued-idea"));
});

test("the last step lights the pantry lantern and the bell", () => {
  const last = DEMO_STEPS.at(-1);
  const s = lanternState(sceneFromState(last));
  assert.deepEqual([...s.stalls], ["pantry"]);
  assert.equal(s.bell, true);
});
