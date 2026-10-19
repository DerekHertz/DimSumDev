// organism-infra/143 (security finding 3): host.shutdown() must not wait without bound for a spawn in flight.
// With the real runtime a spawn can take a while (or hang); today shutdown() awaits every pending spawn first, so a
// SIGTERM during a slow spawn leaves the live agents running past the signal. The fix is a bound.
//
// PINNED INTERFACE: policy.mjs exports SHUTDOWN_SPAWN_WAIT_MS (a positive number); startBridge's `policy` accepts a
// test-only override `spawnWaitMs` (it can only lower the constant). shutdown() waits at most that long for in-flight
// spawns; past it, the live agents get the synchronous killAllSync path (first recorded call SIGKILL, no graceful
// steps), shutdown resolves, and a spawn that completes late is still terminated afterwards.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeBridge, loadPolicy, until, sleep, FEATURE } from "./host-test-helpers.mjs";

let t;
afterEach(async () => {
  if (t) await t.close();
  t = undefined;
});

const names = (rec) => rec.calls.map((c) => c.call);
const STUBBORN = { stdinCloseEnds: false, sigtermEnds: false };

describe("shutdown waits a bounded time for a spawn in flight", () => {
  test("the bound is a policy constant", async () => {
    const mod = await import("./policy.mjs");
    assert.equal(typeof mod.SHUTDOWN_SPAWN_WAIT_MS, "number", "policy.mjs must export SHUTDOWN_SPAWN_WAIT_MS");
    assert.ok(mod.SHUTDOWN_SPAWN_WAIT_MS > 0);
    await loadPolicy();
  });

  test("a slow spawn past the bound: shutdown resolves quickly, the live agent is SIGKILLed first, the late spawn is still ended", async () => {
    t = await makeBridge({ runtimeConfig: STUBBORN, policy: { spawnWaitMs: 200, killGraceMs: 100 } });
    const first = await t.bridge.host.start({ ref: `${FEATURE}/21-one`, role: "architect" });
    assert.ok(first.ok, JSON.stringify(first));
    t.fake.config.spawnDelayMs = 1500;
    const second = t.bridge.host.start({ ref: `${FEATURE}/22-two`, role: "architect" });
    await until(() => t.fake.spawns.length === 2, { what: "the second spawn to be in flight" });

    const t0 = Date.now();
    await t.bridge.host.shutdown();
    const took = Date.now() - t0;
    assert.ok(took < 1200, `shutdown waited ${took} ms for a spawn in flight`);
    assert.equal(names(t.fake.spawns[0])[0], "SIGKILL", `the live agent got ${names(t.fake.spawns[0])} instead of an immediate SIGKILL`);

    await second.catch(() => {});
    await until(() => t.fake.spawns[1].exited, { ms: 4000, what: "the late spawn to be terminated" });
  });

  test("a spawn inside the bound: shutdown waits for it and both agents take the graceful path", async () => {
    t = await makeBridge({ runtimeConfig: { stdinCloseEnds: true }, policy: { spawnWaitMs: 800, killGraceMs: 100 } });
    const first = await t.bridge.host.start({ ref: `${FEATURE}/21-one`, role: "architect" });
    assert.ok(first.ok, JSON.stringify(first));
    t.fake.config.spawnDelayMs = 50;
    const second = t.bridge.host.start({ ref: `${FEATURE}/22-two`, role: "architect" });
    await until(() => t.fake.spawns.length === 2, { what: "the second spawn to be in flight" });
    await t.bridge.host.shutdown();
    await second.catch(() => {});
    await sleep(50);
    for (const rec of t.fake.spawns) assert.equal(names(rec)[0], "closeInput", `an in-bound spawn must shut down gracefully, got ${names(rec)}`);
  });
});
