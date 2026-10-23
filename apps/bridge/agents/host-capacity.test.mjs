// organism-infra/226 (batch 226-227): dispatch any frontier ticket within one shared capacity rule.
// Seams: POST /agents and POST /tasks over startBridge with the fake runtime, plus host.start() and createHost's
// `lockedRefs` parameter. Design: ADR 0016 amendment 14. Tests that need a full house inject maxConcurrent: 2.
//
// Criterion -> test (226), also listed in the handoff:
//   AC1 second/third frontier ticket starts ........ "any frontier ticket starts ..."
//   AC2 live + foreign lock -> 429 names both ...... "one live agent and one foreign lock ...", "two live host agents ..."
//   AC3 claimed host agent counts once ............. "a host agent that has claimed its own ticket ..."
//   AC4 eligibility statuses ....................... "eligibility: ..." (any role may start; host-core.test.mjs)
//   AC5 atomicity .................................. "two dispatches for different tickets ...", host-core.test.mjs races
//   AC6 session cap ................................ host-core.test.mjs "the 4-session cap is a hard ceiling ..."
//   AC7 default slots (den-mvp outcome 1) .......... host-core.test.mjs "policy constants"
//   AC8 capacity table tests ....................... capacity.test.mjs
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createHost } from "./host.mjs";
import { createFakeRuntime } from "./runtime.mjs";
import { makeStateFixture, FEATURE } from "../bridge-fixture.mjs";
import { makeBridge, NO_GATE_REF, until } from "./host-test-helpers.mjs";
import { withLocks, refOf } from "./capacity-test-helpers.mjs";

const R02 = refOf("02-ready-p0"); // frontier[0] in the fixture
const R07 = refOf("07-bumpable"); // frontier[1]
const R08 = refOf("08-plain"); // frontier[2]

let t;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe("any frontier ticket may be dispatched while there is room", () => {
  test("any frontier ticket starts: the second and third need no dispatch gate, and the first need not go first", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 3 } }); // room for all three
    const third = await t.dispatch("architect", R08);
    assert.equal(third.status, 201, third.text);
    const second = await t.dispatch("architect", R07);
    assert.equal(second.status, 201, second.text);
    const first = await t.dispatch("architect", R02);
    assert.equal(first.status, 201, first.text);
    assert.equal(t.fake.spawns.length, 3);
  });

  test("a live agent keeps its ticket from a second dispatch (409 names the live agent)", async () => {
    t = await makeBridge();
    assert.equal((await t.dispatch("architect", R08)).status, 201);
    const again = await t.dispatch("architect", R08);
    assert.equal(again.status, 409);
    assert.match(again.body.error, /live agent/i);
    assert.equal(t.fake.spawns.length, 1);
  });
});

describe("eligibility is membership of the frontier, not the gate", () => {
  const refused = async (res, status) => {
    assert.equal(res.status, status, res.text);
    assert.equal(t.fake.spawns.length, 0, "nothing was spawned");
  };

  test("eligibility: a ticket outside the frontier is 409 'not in the frontier'", async () => {
    t = await makeBridge();
    for (const ref of [NO_GATE_REF /* ready but blocked */, refOf("04-review"), refOf("05-blocked"), refOf("06-human")]) {
      const res = await t.dispatch("architect", ref);
      assert.equal(res.status, 409, `${ref}: ${res.text}`);
      assert.match(res.body.error, /not in the frontier/i, ref);
    }
    assert.equal(t.fake.spawns.length, 0);
  });

  test("eligibility: a ticket that holds a claim lock is outside the frontier (409)", async () => {
    t = await makeBridge({ preWrite: withLocks("07-bumpable") });
    const res = await t.dispatch("architect", R07);
    await refused(res, 409);
    assert.match(res.body.error, /not in the frontier/i);
  });

  test("eligibility: an unknown ref is 404", async () => {
    t = await makeBridge();
    await refused(await t.dispatch("architect", refOf("99-nope")), 404);
  });

  test("eligibility: developer, qa and security start on a frontier ticket like any role (den-mvp outcome 1)", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 3 } });
    // den-mvp/89: the bridge claims for the role, and the board wants qa's mode.
    for (const [role, ref, extra] of [["developer", R02, {}], ["qa", R07, { mode: "verify" }], ["security", R08, {}]]) {
      const res = await t.dispatch(role, ref, extra);
      assert.equal(res.status, 201, `${role}: ${res.text}`);
    }
    assert.equal(t.fake.spawns.length, 3);
  });
});

describe("one capacity rule: live host agents plus foreign claim locks (max 2 injected)", () => {
  test("one live agent and one foreign lock ... a dispatch is 429 and the text names both refs", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 2 }, preWrite: withLocks("07-bumpable") }); // foreign lock on 07
    const first = await t.dispatch("architect", R02);
    assert.equal(first.status, 201, `one slot was free (one lock): ${first.text}`);
    const res = await t.dispatch("architect", R08);
    assert.equal(res.status, 429, res.text);
    assert.ok(res.body.error.includes(R02), `names the live agent's ref: ${res.body.error}`);
    assert.ok(res.body.error.includes(R07), `names the locked ref: ${res.body.error}`);
    assert.equal(t.fake.spawns.length, 1);
  });

  test("two live host agents ... a dispatch for another frontier ticket is 429 naming both", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 2 } });
    assert.equal((await t.dispatch("architect", R02)).status, 201);
    assert.equal((await t.dispatch("architect", R07)).status, 201);
    const res = await t.dispatch("architect", R08);
    assert.equal(res.status, 429, res.text);
    assert.ok(res.body.error.includes(R02) && res.body.error.includes(R07), res.body.error);
    assert.equal(t.fake.spawns.length, 2);
  });

  test("an ended agent frees its slot", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 2 } });
    assert.equal((await t.dispatch("architect", R02)).status, 201);
    assert.equal((await t.dispatch("architect", R07)).status, 201);
    t.fake.spawns[0].exit();
    await until(async () => (await t.dispatch("architect", R08)).status === 201, { what: "a slot to free up" });
  });

  test("a host agent that has claimed its own ticket counts once, not twice", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 2 } });
    assert.equal((await t.dispatch("architect", R02)).status, 201);
    // den-mvp/89: the bridge itself holds the Run's claim on the ticket it started the agent on.
    assert.ok(existsSync(path.join(t.fx.root, ".scratch", "fx", "issues", "02-ready-p0.lock")), "the bridge's claim lock is on the ticket");
    const second = await t.dispatch("architect", R08);
    assert.equal(second.status, 201, `live+lock on one ref is one slot, so a slot is still free: ${second.text}`);
    const third = await t.dispatch("architect", R07);
    assert.equal(third.status, 429, third.text);
    assert.ok(third.body.error.includes(R02) && third.body.error.includes(R08), third.body.error);
  });

  test("start() uses the same rule: a foreign lock plus a live agent fills max 2", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 2 }, preWrite: withLocks("07-bumpable") });
    assert.equal((await t.bridge.host.start({ ref: `${FEATURE}/21-hop`, role: "developer" })).status, 201);
    const res = await t.bridge.host.start({ ref: `${FEATURE}/22-hop`, role: "qa" });
    assert.equal(res.status, 429);
    assert.ok(res.error.includes(R07) && res.error.includes(`${FEATURE}/21-hop`), res.error);
  });

  test("POST /tasks uses the same rule, and a refused task writes no ticket", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 2 }, preWrite: withLocks("07-bumpable") });
    assert.equal((await t.bridge.host.start({ ref: `${FEATURE}/21-hop`, role: "architect" })).status, 201);
    const res = await t.post("/tasks", { role: "technical-writer", text: "Polish the lids." });
    assert.equal(res.status, 429, res.text);
    assert.ok(res.body.error.includes(R07), res.body.error);
    const den = await readdir(path.join(t.fx.root, ".scratch", "den", "issues")).catch(() => []);
    assert.deepEqual(den, [], "no den ticket was written");
  });
});

describe("the reservation stays one synchronous step", () => {
  test("two dispatches for different tickets fired at one free slot start one agent", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 2 }, runtimeConfig: { spawnDelayMs: 40 }, preWrite: withLocks("07-bumpable") });
    const both = await Promise.all([t.dispatch("architect", R02), t.dispatch("architect", R08)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 429]);
    assert.equal(t.fake.spawns.length, 1);
  });

  test("a dispatch racing start() for the last slot with a foreign lock held: exactly one wins", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 2 }, runtimeConfig: { spawnDelayMs: 40 }, preWrite: withLocks("07-bumpable") });
    const [viaHttp, viaStart] = await Promise.all([t.dispatch("architect", R02), t.bridge.host.start({ ref: `${FEATURE}/22-racer`, role: "architect" })]);
    assert.equal([viaHttp.status === 201, viaStart.status === 201].filter(Boolean).length, 1, `${viaHttp.status} / ${viaStart.status}`);
    assert.equal(t.fake.spawns.length, 1);
  });
});

describe("createHost takes the locks as a parameter", () => {
  test("lockedRefs is read at each admission and its refs fill slots", async () => {
    const fx = await makeStateFixture({ git: true });
    let locked = [R07];
    let calls = 0;
    const fake = createFakeRuntime();
    const host = createHost({ root: fx.root, runtime: fake, policy: { maxConcurrent: 2 }, lockedRefs: async () => (calls += 1, locked) });
    try {
      await host.ready;
      assert.equal((await host.start({ ref: `${FEATURE}/21-a`, role: "architect" })).status, 201);
      assert.ok(calls >= 1, "lockedRefs was called during admission");
      const full = await host.start({ ref: `${FEATURE}/22-b`, role: "architect" });
      assert.equal(full.status, 429, "one live agent plus one lock fills max 2");
      locked = []; // the foreign agent released its ticket
      assert.equal((await host.start({ ref: `${FEATURE}/22-b`, role: "architect" })).status, 201, "the next admission sees the new locks");
    } finally {
      for (const r of fake.spawns ?? []) if (!r.exited) r.exit();
      await host.shutdown();
      await fx.cleanup();
    }
  });
});
