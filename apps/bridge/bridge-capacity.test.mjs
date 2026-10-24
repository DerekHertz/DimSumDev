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
const NUMBERS = ["max", "cap", "load", "live", "room"];
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

describe("capacity in GET /state (max 2 injected)", () => {
  test("nothing running: room is the whole max", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 2 } });
    const { capacity } = await t.state();
    assert.deepEqual(numbers(capacity), { max: 2, cap: 3, load: 0, live: 0, room: 2 });
    assert.deepEqual(capacity.refs, []);
  });

  test("the default is two worker slots, and a policy override cannot raise max or cap above the three sessions", async () => {
    t = await makeBridge();
    assert.deepEqual(numbers((await t.state()).capacity), { max: 2, cap: 3, load: 0, live: 0, room: 2 });
    await t.close();
    t = await makeBridge({ policy: { maxConcurrent: 100, sessionCap: 100 } });
    assert.deepEqual(numbers((await t.state()).capacity), { max: 3, cap: 3, load: 0, live: 0, room: 3 });
    await t.close();
    t = await makeBridge({ policy: { maxConcurrent: 3, sessionCap: 2 } });
    assert.deepEqual(numbers((await t.state()).capacity), { max: 3, cap: 2, load: 0, live: 0, room: 2 }, "a lower session cap is reported as the host applies it");
  });

  test("Bao has a reserved slot: it is not worker load, a second Bao run is 429, and there is no scout slot (den-mvp outcome 1)", async () => {
    t = await makeBridge();
    assert.equal((await t.dispatch("orchestrator", R02)).status, 201);
    await lockTicket(t.fx.root, "02-ready-p0", "orchestrator"); // Bao claims its own ticket: still not worker load
    const { capacity } = await t.state();
    assert.deepEqual(numbers(capacity), { max: 2, cap: 3, load: 0, live: 0, room: 2 }, "both worker slots are still free");
    assert.deepEqual(capacity.reserved, { bao: { max: 1, refs: [R02] } });
    const second = await t.dispatch("chief-of-staff", R08);
    assert.equal(second.status, 429, second.text);
    assert.match(second.body.error, /bao slot is in use/);
    assert.equal((await t.dispatch("developer", R07)).status, 201, "a worker still starts beside it");
  });

  test("two live agents: room falls to 0 and refs name both as live", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 2 } });
    assert.equal((await t.dispatch("architect", R02)).status, 201);
    assert.equal((await t.dispatch("architect", R08)).status, 201);
    const { capacity } = await t.state();
    assert.deepEqual(numbers(capacity), { max: 2, cap: 3, load: 2, live: 2, room: 0 });
    assert.deepEqual(kinds(capacity.refs), { [R02]: "live", [R08]: "live" });
  });

  test("one live agent plus one foreign lock: room 0, and refs tells the agent from the lock", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 2 }, preWrite: withLocks("07-bumpable") });
    assert.equal((await t.dispatch("architect", R02)).status, 201);
    const { capacity } = await t.state();
    assert.deepEqual(numbers(capacity), { max: 2, cap: 3, load: 2, live: 1, room: 0 });
    assert.deepEqual(kinds(capacity.refs), { [R02]: "live", [R07]: "lock" });
  });

  test("a host agent that has claimed its own ticket is one live ref, not a lock too", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 2 } });
    assert.equal((await t.dispatch("architect", R02)).status, 201);
    // den-mvp/89: the bridge itself holds the Run's claim now, so the ticket is locked and live at once.
    assert.ok(existsSync(path.join(t.fx.root, ".scratch", "fx", "issues", "02-ready-p0.lock")), "the bridge's claim lock is on the ticket");
    const { capacity } = await t.state();
    assert.deepEqual(numbers(capacity), { max: 2, cap: 3, load: 1, live: 1, room: 1 });
    assert.deepEqual(kinds(capacity.refs), { [R02]: "live" });
  });

  test("an agent that ended no longer counts, and a released lock frees its slot", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 2 }, preWrite: withLocks("07-bumpable") });
    assert.equal((await t.dispatch("architect", R02)).status, 201);
    t.fake.spawns[0].exit();
    await until(async () => (await t.state()).capacity.live === 0, { what: "the ended agent to leave capacity" });
    assert.deepEqual(numbers((await t.state()).capacity), { max: 2, cap: 3, load: 1, live: 0, room: 1 });
  });

  test("the snapshot's room agrees with the host: room 0 means the next dispatch is 429, room 1 means it starts", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 2 }, preWrite: withLocks("07-bumpable") });
    assert.equal((await t.state()).capacity.room, 1);
    assert.equal((await t.dispatch("architect", R02)).status, 201);
    assert.equal((await t.state()).capacity.room, 0);
    assert.equal((await t.dispatch("architect", R08)).status, 429);
  });
});

describe("capacity in the SSE snapshot", () => {
  test("the first snapshot frame carries the same capacity as GET /state", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 2 }, preWrite: withLocks("07-bumpable") });
    assert.equal((await t.dispatch("architect", R02)).status, 201);
    const sse = openSse(t.bridge);
    try {
      await sse.opened;
      const frame = await sse.next((f) => f.event === "snapshot");
      assert.deepEqual(numbers(frame.data.capacity), { max: 2, cap: 3, load: 2, live: 1, room: 0 });
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
