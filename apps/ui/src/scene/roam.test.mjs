// den-scene-v1/01 supersedes free grass wandering, grass homes, entry/exit and fade tests.
// Their replacements cover fixed-slot lifecycle, handoff motion (handoff-motion.test.mjs), and
// 60-second idle acceptance (horseshoe-layout.test.mjs). Prop footprints remain available.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ROAMER_TYPES, roamObstacles, stepRoamer } from "./roam.mjs";
import { placeRole } from "./banquet-layout.mjs";

for (const reduced of [false, true]) {
  test("work starts and ends in place, without grass travel or fade (reduced=" + reduced + ")", () => {
    for (const seed of ROAMER_TYPES) {
      const slot = placeRole(seed, 0);
      let state;
      for (const working of [false, true, false, true, false]) {
        state = stepRoamer(state, { seed, slot, working, dt: 1 / 30, reduced });
        assert.equal(state.phase, working ? "working" : "idle");
        assert.deepEqual([state.x, state.y, state.z, state.moving, state.opacity], [slot.x, slot.y, slot.z, false, 1]);
      }
    }
  });
}

test("unassigned pandas use their team slot instead of an arbitrary grass home", () => {
  for (const seed of ROAMER_TYPES) {
    const slot = placeRole(seed, 0);
    const state = stepRoamer(undefined, { seed, slot: null, working: false, dt: 1, reduced: false });
    assert.deepEqual([state.x, state.y, state.z, state.moving], [slot.x, slot.y, slot.z, false]);
  }
});

const covered = (obstacles, x, z) => obstacles.some((o) => o.kind === "circle"
  ? Math.hypot(x - o.x, z - o.z) < o.r
  : x > o.x0 && x < o.x1 && z > o.z0 && z < o.z1);
test("clearance footprints follow the horseshoe props, including the moved Cubs and Tally", () => {
  const obstacles = roamObstacles();
  for (const [x,z] of [[0,0], [1.5,0], [0,-2.4], [-3.0,-1.4], [3.0,-1.4], [-4.9,2], [4.9,2], [-1.8,3], [1.8,3]]) {
    assert.ok(covered(obstacles, x, z), "prop at " + x + "," + z);
  }
  assert.equal(covered(obstacles, -7, 4.6), false);
});
test("widened rotated stalls extend their clearance footprint outward", () => {
  assert.equal(covered(roamObstacles(), -6, -1.4), false);
  assert.equal(covered(roamObstacles({ steamers: 6 }), -6, -1.4), true);
});
