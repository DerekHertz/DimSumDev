// codex-residents/01 + den-mvp/85: both sides of the snapshot merge remain observable over HTTP and SSE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBridge, openSse } from "./agents/host-test-helpers.mjs";

test("runtime capacity and release readiness coexist in state and initial SSE snapshots", async () => {
  const t = await makeBridge();
  let sse;
  try {
    assert.equal((await t.dispatch()).status, 201);
    const state = await t.state();
    assert.equal(state.capacity.live, 1, "project-qualified asynchronous capacity has resolved");
    assert.equal(state.capacity.room, 1);
    assert.equal(state.readyRelease, null, "checkout launches explicitly report no staged release");
    sse = openSse(t.bridge);
    await sse.opened;
    const frame = await sse.next((f) => f.event === "snapshot");
    assert.deepEqual(frame.data.capacity, state.capacity);
    assert.equal(frame.data.readyRelease, null);
  } finally {
    sse?.close();
    await t.close();
  }
});
