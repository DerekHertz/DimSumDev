// organism-infra/226, kept by portable-den/10: any frontier ticket may be dispatched; there is no count limit on live agents.
// Seams: POST /agents and POST /tasks over startBridge with the fake runtime. Eligibility is frontier membership.
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
    t = await makeBridge(); // room for all three
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
    t = await makeBridge();
    // den-mvp/89: the bridge claims for the role, and the board wants qa's mode.
    for (const [role, ref, extra] of [["developer", R02, {}], ["qa", R07, { mode: "verify" }], ["security", R08, {}]]) {
      const res = await t.dispatch(role, ref, extra);
      assert.equal(res.status, 201, `${role}: ${res.text}`);
    }
    assert.equal(t.fake.spawns.length, 3);
  });
});

describe("portable-den/10: no count limit on live agents", () => {
  test("agents start on every frontier ticket at once, and a foreign lock or a live agent never makes a dispatch 429", async () => {
    t = await makeBridge({ preWrite: withLocks("07-bumpable") });
    const a = await t.dispatch("architect", R02);
    const b = await t.dispatch("architect", R08);
    assert.equal(a.status, 201, a.text);
    assert.equal(b.status, 201, b.text);
    const task = await t.post("/tasks", { text: "A third and fourth agent", role: "developer" });
    assert.equal(task.status, 201, task.text);
    assert.equal(t.fake.spawns.length, 3);
  });

  test("dispatches fired together all start", async () => {
    t = await makeBridge();
    const results = await Promise.all([R02, R07, R08].map((r) => t.dispatch("architect", r)));
    assert.deepEqual(results.map((r) => r.status), [201, 201, 201]);
    assert.equal(t.fake.peakLive, 3);
  });

  test("the snapshot capacity key lists who runs and carries no max, cap or room", async () => {
    t = await makeBridge({ preWrite: withLocks("07-bumpable") });
    assert.equal((await t.dispatch("architect", R02)).status, 201);
    const c = (await t.state()).capacity;
    assert.deepEqual(Object.keys(c).sort(), ["live", "load", "refs"]);
    assert.deepEqual(c.refs.map((r) => r.kind).sort(), ["live", "lock"]);
  });
});
