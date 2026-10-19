// den-layout/03: with the bridge running and a live agent, the den shows that agent's panda at its station.
// Seam: startBridge({root, port: 0}) plus GET /state, fed through liveActorsFromSnapshot and the den's
// createReviewAgents().applyLive. The fixture's lock is `developer` on fx/09-claimed.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { startBridge } from "./server.mjs";
import { makeStateFixture, FEATURE } from "./bridge-fixture.mjs";
import { liveActorsFromSnapshot } from "../ui/src/review/live-actors.mjs";
import { createReviewAgents } from "../ui/src/review/agents.mjs";
import { createBao } from "../ui/src/scene/procedural/bao.mjs";
import { createDenScene } from "../ui/src/scene/procedural/den-scene.mjs";
import { canvasDocument } from "../ui/src/scene/procedural/den-test-helpers.mjs";
import { createFakeRuntime } from "./agents/runtime.mjs";

async function liveSnapshot(lock, { withProcess = false } = {}) {
  const fx = await makeStateFixture({ lock, git: withProcess });
  // The existing fake process exercises Claude's presentation identity, not an unknown runtime.
  const runtime = withProcess ? { ...createFakeRuntime(), id: "claude" } : null;
  const bridge = await startBridge({ root: fx.root, port: 0, ...(runtime ? { runtime } : {}) });
  try {
    if (runtime) {
      const started = await bridge.host.start({ ref: `${FEATURE}/09-claimed`, role: "developer" });
      assert.equal(started.ok, true, JSON.stringify(started));
      assert.equal(runtime.spawns.length, 1, "the bridge owns a matching fixture process before fetching /state");
      runtime.spawns[0].emit({ type: "tool-start", name: "Read", summary: "live actor fixture" });
    }
    const res = await fetch(`${bridge.url}/state`);
    assert.equal(res.status, 200);
    return await res.json();
  } finally {
    await bridge.close();
    await fx.cleanup();
  }
}

test("a locked ticket with a matching live process in the bridge's real /state binds the holder's panda at its station", async () => {
  const snapshot = await liveSnapshot(true, { withProcess: true });
  const liveAgent = snapshot.agents.find(agent => agent.ref === `${FEATURE}/09-claimed` && agent.role === "developer");
  assert.ok(liveAgent?.id, "the HTTP payload contains the matching bridge-run agent");
  assert.equal(liveAgent.runtime, "claude");
  assert.equal(liveAgent.state, "working");
  assert.deepEqual(liveAgent.tool, { name: "Read", summary: "live actor fixture" }, "the HTTP payload contains ingested process telemetry");
  const actors = liveActorsFromSnapshot(snapshot, { now: Date.now() });
  const dev = actors.find((a) => a.role === "developer");
  assert.ok(dev, "the developer lock and matching live process produce a live actor");
  assert.equal(dev.ref, `${FEATURE}/09-claimed`);
  assert.equal(dev.state, "working");
  assert.equal(dev.split, false);

  const previous = globalThis.document;
  globalThis.document = canvasDocument();
  let den, agents;
  try {
    den = createDenScene(THREE, createBao);
    agents = createReviewAgents(den, createBao);
    agents.applyLive(actors);
    for (let i = 0; i < 600; i++) agents.update(0.1);
    const actor = agents.actors.get("developer");
    assert.equal(actor.state, "working");
    assert.ok(Math.hypot(actor.panda.model.position.x - actor.home[0], actor.panda.model.position.z - actor.home[1]) < 1.0, "at its station");
    assert.ok(actor.task.includes(`${FEATURE}/09-claimed`));
  } finally {
    agents?.dispose();
    den?.dispose();
    globalThis.document = previous;
  }
});

test("a locked ticket without a live process in the bridge's real /state binds no panda", async () => {
  const snapshot = await liveSnapshot(true);
  assert.equal(snapshot.tickets.find(ticket => ticket.ref === `${FEATURE}/09-claimed`).holder.role, "developer", "the real claim lock remains present");
  assert.deepEqual(snapshot.agents, [], "the HTTP payload contains no bridge-run process");
  assert.deepEqual(snapshot.roles ?? [], [], "the HTTP payload contains no external live-agent telemetry");
  assert.deepEqual(liveActorsFromSnapshot(snapshot, { now: Date.now() }), []);
});

test("a bridge with no lock binds no panda: every role keeps idle wandering", async () => {
  const snapshot = await liveSnapshot(false);
  assert.deepEqual(liveActorsFromSnapshot(snapshot, { now: Date.now() }), []);
});
