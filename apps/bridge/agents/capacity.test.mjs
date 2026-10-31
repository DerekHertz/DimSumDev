// organism-infra/226, cut down by portable-den/10: the pure capacity rule lists who is running or holds a lock. It has no limit.
//   capacity({ liveRefs, lockedRefs }) -> { load, live, refs }
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCapacity, kinds } from "./capacity-test-helpers.mjs";

const A = "fx/02-a";
const B = "fx/03-b";

const TABLE = [
  ["nothing running", { liveRefs: [], lockedRefs: [] }, { load: 0, live: 0 }, {}],
  ["two live host agents", { liveRefs: [A, B], lockedRefs: [] }, { load: 2, live: 2 }, { [A]: "live", [B]: "live" }],
  ["one live agent and one foreign lock", { liveRefs: [A], lockedRefs: [B] }, { load: 2, live: 1 }, { [A]: "live", [B]: "lock" }],
  ["a host agent that claimed its own ticket counts once, as live", { liveRefs: [A], lockedRefs: [A] }, { load: 1, live: 1 }, { [A]: "live" }],
  ["a ref listed twice as a lock counts once", { liveRefs: [], lockedRefs: [A, A] }, { load: 1, live: 0 }, { [A]: "lock" }],
];

for (const [label, input, numbers, expectedKinds] of TABLE) {
  test(`capacity: ${label}`, async () => {
    const { capacity } = await loadCapacity();
    const c = capacity(input);
    assert.deepEqual({ load: c.load, live: c.live }, numbers);
    assert.deepEqual(kinds(c.refs), expectedKinds);
  });
}

test("capacity: no count limit, so thirty live agents report no max, cap or room", async () => {
  const { capacity } = await loadCapacity();
  const c = capacity({ liveRefs: Array.from({ length: 30 }, (_, i) => `fx/${String(i + 10)}-a`), lockedRefs: [] });
  assert.equal(c.load, 30);
  assert.deepEqual(Object.keys(c).sort(), ["live", "load", "refs"]);
});
