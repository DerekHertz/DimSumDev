// den-scene-v1/01: snapshots -> handoff events -> the same stepRoamer lifecycle Den renders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveHandoffs } from "./handoffs.mjs";
import { placeRole, STALL_CENTERS } from "./banquet-layout.mjs";
import { stepRoamer, WALK_SPEED } from "./roam.mjs";

const roles = { tea: "qa", steamers: "developer", "front-of-house": "designer", pantry: "security" };
const snapshot = (placement) => ({ tickets: [{ ref: "feature/01", status: "claimed", holder: { role: placement } }] });
for (const [from, type] of Object.entries(roles)) {
  for (const [to, nextType] of Object.entries(roles)) {
    if (from === to) continue;
    test(`live handoff lifecycle: ${from} panda delivers ${to} then returns to its slot`, () => {
      const handoffs = deriveHandoffs(snapshot(type), snapshot(nextType)).map((h) => ({ ...h, id: 1 }));
      const slot = placeRole(type, 1);
      const input = { seed: type, slot, working: false, handoffs, obstacles: [], reduced: false, dt: 1 / 30 };
      let state = stepRoamer(undefined, { ...input, handoffs: [], now: 0 });
      let delivered = false, travelled = false;
      for (let frame = 1; frame <= 120 * 30; frame++) {
        const previous = state;
        // Events can expire during the walk; the panda must finish its accepted delivery.
        state = stepRoamer(state, { ...input, handoffs: frame < 30 ? handoffs : [], now: frame / 30 });
        assert.ok(Math.hypot(state.x, state.z) >= 2.1 - 1e-9, "rendered panda clears tabletop continuously");
        assert.ok(Math.hypot(state.x - previous.x, state.z - previous.z) <= WALK_SPEED / 30 + 1e-9, "handoff never teleports");
        if (state.moving) travelled = true;
        if (Math.hypot(state.x - STALL_CENTERS[to].x, state.z - STALL_CENTERS[to].z) < 1e-6) delivered = true;
      }
      assert.ok(travelled, "snapshot change moves the source panda");
      assert.ok(delivered, "source panda actually reaches receiving team");
      assert.deepEqual([state.x, state.y, state.z, state.moving, state.phase], [slot.x, slot.y, slot.z, false, "idle"]);
      const finished = stepRoamer(state, { ...input, now: 121 });
      assert.equal(finished.moving, false, "same event is never replayed");
    });
  }
}

test("same-team and unrelated handoffs never displace an idle panda", () => {
  const slot = placeRole("developer", 0);
  const handoffs = [
    ...deriveHandoffs(snapshot("developer"), snapshot("scout")),
    ...deriveHandoffs(snapshot("qa"), snapshot("security")),
  ].map((h, id) => ({ ...h, id }));
  const state = stepRoamer(undefined, { seed: "developer", slot, working: false, handoffs, obstacles: [], reduced: false, dt: 1, now: 1 });
  assert.deepEqual([state.x, state.y, state.z, state.moving], [slot.x, slot.y, slot.z, false]);
});

test("reduced motion consumes handoffs without walking or fading away from the team", () => {
  const slot = placeRole("qa", 0);
  const handoffs = deriveHandoffs(snapshot("qa"), snapshot("designer")).map((h) => ({ ...h, id: 3 }));
  let state;
  for (let frame = 0; frame < 60; frame++) {
    state = stepRoamer(state, { seed: "qa", slot, working: true, handoffs, reduced: true, dt: 1 / 30, now: frame / 30 });
    assert.deepEqual([state.x, state.y, state.z, state.moving, state.opacity], [slot.x, slot.y, slot.z, false, 1]);
  }
});
