// organism-infra/226 (batch 226-227): the pure capacity rule, table tests (ADR 0016 amendment 14, item 2).
//   capacity({ liveRefs, lockedRefs, max, cap }) -> { max, cap, load, live, room, refs }
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCapacity, kinds } from "./capacity-test-helpers.mjs";

const live = (...r) => r;
const A = "fx/02-a";
const B = "fx/03-b";
const C = "fx/04-c";
const D = "fx/05-d";

// [label, input, expected numbers, expected kinds by ref]
const TABLE = [
  ["nothing running: the whole max is free", { liveRefs: [], lockedRefs: [], max: 8, cap: 8 }, { load: 0, live: 0, room: 8 }, {}],
  ["two live host agents at max 2: no room", { liveRefs: live(A, B), lockedRefs: [], max: 2, cap: 8 }, { load: 2, live: 2, room: 0 }, { [A]: "live", [B]: "live" }],
  ["one live agent and one foreign lock at max 2: no room", { liveRefs: live(A), lockedRefs: [B], max: 2, cap: 8 }, { load: 2, live: 1, room: 0 }, { [A]: "live", [B]: "lock" }],
  ["one foreign lock alone leaves room", { liveRefs: [], lockedRefs: [A], max: 2, cap: 8 }, { load: 1, live: 0, room: 1 }, { [A]: "lock" }],
  ["a host agent that claimed its own ticket counts once", { liveRefs: live(A), lockedRefs: [A], max: 2, cap: 8 }, { load: 1, live: 1, room: 1 }, { [A]: "live" }],
  ["one claimed host agent plus a foreign lock fills max 2", { liveRefs: live(A), lockedRefs: [A, B], max: 2, cap: 8 }, { load: 2, live: 1, room: 0 }, { [A]: "live", [B]: "lock" }],
  ["a ref listed twice as a lock counts once", { liveRefs: [], lockedRefs: [A, A], max: 8, cap: 8 }, { load: 1, live: 0, room: 7 }, { [A]: "lock" }],
  ["more locks than max: room never goes negative", { liveRefs: [], lockedRefs: [A, B, C], max: 2, cap: 8 }, { load: 3, live: 0, room: 0 }, { [A]: "lock", [B]: "lock", [C]: "lock" }],
  ["the session cap binds when max is higher: live 8, max 100", { liveRefs: live(A, B, C, D, "fx/06-e", "fx/07-f", "fx/08-g", "fx/09-h"), lockedRefs: [], max: 100, cap: 8 }, { load: 8, live: 8, room: 0 }, null],
  ["one session left under the cap when max is higher: live 7, max 100", { liveRefs: live(A, B, C, D, "fx/06-e", "fx/07-f", "fx/08-g"), lockedRefs: [], max: 100, cap: 8 }, { load: 7, live: 7, room: 1 }, null],
  ["locks fill max but never the session cap: live 1, three locks, max 8", { liveRefs: live(A), lockedRefs: [B, C, D], max: 8, cap: 8 }, { load: 4, live: 1, room: 4 }, null],
  ["cap counts only live agents: live 2, two locks, max 8, cap 4", { liveRefs: live(A, B), lockedRefs: [C, D], max: 8, cap: 4 }, { load: 4, live: 2, room: 2 }, null],
  ["a cap lower than the load wins over max: live 3, max 8, cap 3", { liveRefs: live(A, B, C), lockedRefs: [], max: 8, cap: 3 }, { load: 3, live: 3, room: 0 }, null],
];

for (const [label, input, want, wantKinds] of TABLE) {
  test(`capacity: ${label}`, async () => {
    const { capacity } = await loadCapacity();
    const got = capacity(structuredClone(input));
    assert.deepEqual({ max: got.max, cap: got.cap, load: got.load, live: got.live, room: got.room }, { max: input.max, cap: input.cap, ...want });
    assert.ok(Array.isArray(got.refs), "refs is an array");
    assert.equal(got.refs.length, got.load, "refs has one entry per ref that fills a slot");
    if (wantKinds) assert.deepEqual(kinds(got.refs), wantKinds);
  });
}

test("capacity: refs names every ref once and tells a live agent from a lock", async () => {
  const { capacity } = await loadCapacity();
  const got = capacity({ liveRefs: [A], lockedRefs: [A, B], max: 2, cap: 8 });
  assert.deepEqual(got.refs.map((r) => r.ref).sort(), [A, B]);
  assert.deepEqual(kinds(got.refs), { [A]: "live", [B]: "lock" });
});

test("capacity: pure, it does not change its inputs", async () => {
  const { capacity } = await loadCapacity();
  const input = { liveRefs: [A], lockedRefs: [A, B], max: 2, cap: 8 };
  const copy = structuredClone(input);
  capacity(input);
  assert.deepEqual(input, copy);
});
