// organism-infra/227 (batch 226-227): the snapshot reports capacity and the dispatch gate stops depending on locks.
// Seam: startBridge over HTTP (GET /state, GET /events, POST /requests). Design: ADR 0011 decision 3 (amended
// 2026-10-12) and ADR 0016 amendment 14. Tests that need a full house inject maxConcurrent: 2.
//
// Criterion -> test (227), also listed in the handoff:
//   AC1 locked ticket + two ready: frontier[0] has the dispatch gate ... "the dispatch gate goes to frontier[0] while another ticket is locked"
//   AC2 no other ticket gets it; merge gates unchanged ................. same test, and bridge-state.test.mjs "GET /state with a claim lock"
//   AC3 capacity on GET /state and the SSE snapshot, room 0 at max ..... "capacity in GET /state ...", "capacity in the SSE snapshot ..."
//   AC4 unknown keys stay ignorable (existing consumer tests pass) ..... "the snapshot keeps its envelope ..." plus the whole existing suite
//   AC5 ADR 0011 example gains capacity ................................ documentation: checked by qa verify, no test
//   build item 3 POST /requests rule unchanged ......................... "POST /requests ..."
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { makeBridge, openSse, until } from "./agents/host-test-helpers.mjs";
import { withLocks, lockTicket, refOf, kinds } from "./agents/capacity-test-helpers.mjs";

const R02 = refOf("02-ready-p0");
const R07 = refOf("07-bumpable");
const R08 = refOf("08-plain");
const NUMBERS = ["load", "live"];
const numbers = (c) => Object.fromEntries(NUMBERS.map((k) => [k, c[k]]));

let t;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe("the dispatch gate no longer waits for locks to clear", () => {
  test("the dispatch gate goes to frontier[0] while another ticket is locked, and to no other ticket", async () => {
    t = await makeBridge({ preWrite: withLocks("07-bumpable") }); // 07 is locked, so the frontier is 02, 08
    const snap = await t.state();
    assert.deepEqual(snap.frontier, [R02, R08]);
    const gate = (ref) => snap.tickets.find((x) => x.ref === ref).gate;
    assert.equal(gate(R02), "dispatch", "frontier[0] of the unlocked tickets has the gate (it had none before)");
    assert.equal(gate(R08), null);
    assert.equal(gate(R07), null, "the locked ticket has none");
    assert.deepEqual(snap.tickets.filter((x) => x.gate === "dispatch").map((x) => x.ref), [R02]);
    assert.equal(gate(refOf("04-review")), "merge", "merge gates are unchanged");
  });

  test("with every ready ticket locked the frontier is empty and no ticket has a dispatch gate", async () => {
    t = await makeBridge({ preWrite: withLocks("02-ready-p0", "07-bumpable", "08-plain") });
    const snap = await t.state();
    assert.deepEqual(snap.frontier, []);
    assert.deepEqual(snap.tickets.filter((x) => x.gate === "dispatch"), []);
  });

  test("POST /requests keeps its rule: dispatch-approve needs gate == dispatch, now true for frontier[0] under a lock", async () => {
    t = await makeBridge({ preWrite: withLocks("07-bumpable") });
    const ok = await t.post("/requests", { kind: "dispatch-approve", ref: R02 });
    assert.equal(ok.status, 201, ok.text);
    const none = await t.post("/requests", { kind: "dispatch-approve", ref: R08 });
    assert.equal(none.status, 409, "a frontier ticket without the gate is still refused");
  });
});

describe("capacity in GET /state (portable-den/10: who is running, no limit)", () => {
  test("nothing running: no agents, no max, cap or room", async () => {
    t = await makeBridge();
    const c = (await t.state()).capacity;
    assert.deepEqual(numbers(c), { load: 0, live: 0 });
    assert.deepEqual(c.refs, []);
    assert.deepEqual(Object.keys(c).sort(), ["live", "load", "refs"]);
  });

  test("live agents and a foreign lock are listed, and a host agent that claimed its own ticket is one live ref", async () => {
    t = await makeBridge({ preWrite: withLocks("07-bumpable") });
    assert.equal((await t.dispatch("architect", R02)).status, 201);
    assert.equal((await t.dispatch("architect", R08)).status, 201);
    const c = (await t.state()).capacity;
    assert.deepEqual(numbers(c), { load: 3, live: 2 });
    assert.deepEqual(kinds(c.refs), { [R02]: "live", [R08]: "live", [R07]: "lock" });
  });

  test("an agent that ended no longer counts", async () => {
    t = await makeBridge({ preWrite: withLocks("07-bumpable") });
    assert.equal((await t.dispatch("architect", R02)).status, 201);
    t.fake.spawns[0].exit();
    await until(async () => (await t.state()).capacity.live === 0, { what: "the ended agent to leave capacity" });
    assert.deepEqual(numbers((await t.state()).capacity), { load: 1, live: 0 });
  });

  test("a third agent starts: there is no count refusal", async () => {
    t = await makeBridge();
    assert.equal((await t.dispatch("architect", R02)).status, 201);
    assert.equal((await t.dispatch("architect", R07)).status, 201);
    assert.equal((await t.dispatch("architect", R08)).status, 201);
    assert.equal((await t.state()).capacity.live, 3);
  });
});

describe("capacity in the SSE snapshot", () => {
  test("the first snapshot frame carries the same capacity as GET /state", async () => {
    t = await makeBridge({ preWrite: withLocks("07-bumpable") });
    assert.equal((await t.dispatch("architect", R02)).status, 201);
    const sse = openSse(t.bridge);
    try {
      await sse.opened;
      const frame = await sse.next((f) => f.event === "snapshot");
      assert.deepEqual(numbers(frame.data.capacity), { load: 2, live: 1 });
      assert.deepEqual(kinds(frame.data.capacity.refs), { [R02]: "live", [R07]: "lock" });
      assert.deepEqual(frame.data.capacity, (await t.state()).capacity);
    } finally {
      sse.close();
    }
  });
});

describe("the snapshot stays schema 1 with the capacity key additive", () => {
  test("the snapshot keeps its envelope and existing keys beside capacity", async () => {
    t = await makeBridge();
    const snap = await t.state();
    assert.equal(snap.schema, 1);
    for (const key of ["seq", "generatedAt", "sessions", "tickets", "frontier", "usage", "requests", "agents"]) {
      assert.ok(key in snap, `existing key ${key} is still present`);
    }
    assert.equal(typeof snap.capacity, "object");
    assert.notEqual(snap.capacity, null);
  });
});
