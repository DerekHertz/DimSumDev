// den-v1 loop, live den runs 1, 3 and 4 (2026-10-10): the bridge held a permission request and sent it on /events,
// and the page never showed it. The UI's reducer (apply-event.mjs) dropped every `approval` change, so a request was
// visible only to a page loaded after it was raised. Each side had tests against its own stub; none crossed the seam.
// These do: a real bridge with the fake runtime, its /events frames fed to the UI's reducer, and the result compared
// with the bridge's own GET /state.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeBridge, openSse, send, until } from "../../../bridge/agents/host-test-helpers.mjs";
import { applyEvent } from "./apply-event.mjs";
import { needsYouModel } from "../overlay/overlay-model.mjs";
import { cardFor } from "../overlay/proximity-card.mjs";

let t, sse;
afterEach(async () => {
  sse?.close();
  await t?.close();
  t = sse = undefined;
});

// The page's view: the first snapshot, then every change frame through the reducer (a gap would return null).
function reduced(frames) {
  let state = null;
  for (const f of frames) {
    if (f.event === "snapshot") state = f.data;
    else if (f.event === "change" && state && f.data.seq > state.seq) {
      state = applyEvent(state, f.data);
      assert.ok(state, `the reducer asked for a refetch at seq ${f.data.seq} (${f.data.type})`);
    }
  }
  return state;
}
const settled = async (pred, what) => {
  let state;
  await until(async () => pred((state = reduced(sse.frames)), await t.state()), { what });
  return state;
};
const shared = (s) => ({ agents: s.agents, approvals: s.approvals, tickets: s.tickets, frontier: s.frontier });

test("a permission request raised after the page loaded reaches the page, and its answer does too", async () => {
  t = await makeBridge();
  sse = openSse(t.bridge);
  await sse.opened;
  await sse.next((f) => f.event === "snapshot");
  const { agent } = (await t.dispatch("architect")).body;
  await until(() => t.fake.spawns.length === 1, { what: "the spawn" });
  const rec = t.fake.spawns[0];
  rec.emit({ type: "tool-start", id: "tu-1", name: "Read", summary: "/outside/package.json" });
  rec.emit({ type: "permission-request", requestId: "r-1", tool: "Read", input: { file_path: "/outside/package.json" } });

  const held = await settled((ui) => ui?.approvals?.some((a) => a.state === "pending"), "the pending approval in the page's state");
  assert.deepEqual(shared(held), shared(await t.state()), "the page's state is the bridge's state");
  const [request] = needsYouModel(held, Date.now()).requests.filter((r) => r.kind === "permission");
  assert.ok(request, "Needs you lists the request");
  assert.equal(request.title, "Wants to read a file");
  assert.deepEqual(request.preview, ["/outside/package.json"]);
  const row = held.agents.find((a) => a.id === agent.id);
  const card = cardFor([{ id: "architect", role: "architect", position: { x: 0, z: -1 }, agent: row }], held.approvals, { x: 0, z: 0, yaw: 0 });
  assert.equal(card.approval?.id, request.card.approval.id, "the panda's card holds the same request");
  assert.equal(card.actions.E.enabled, true);

  // The bridge refuses an allow until the full input was fetched (ADR 0016 decision 6); the review does that fetch.
  const blind = await t.post(`/approvals/${request.card.approval.id}`, { decision: "allow" });
  assert.equal(blind.status, 409, blind.text);
  const full = await send(t.bridge, { path: `/approvals/${request.card.approval.id}`, headers: t.headers });
  assert.equal(JSON.stringify(full.body.input).length, request.card.approval.inputLength, "the review's length check passes on the real input");
  const answer = await t.post(`/approvals/${request.card.approval.id}`, { decision: "allow" });
  assert.equal(answer.status, 200, answer.text);
  const after = await settled((ui) => ui?.approvals?.every((a) => a.state !== "pending"), "the answer in the page's state");
  assert.deepEqual(shared(after), shared(await t.state()));
  assert.equal(needsYouModel(after, Date.now()).requests.filter((r) => r.kind === "permission").length, 0, "the request leaves Needs you");
  assert.deepEqual(rec.decisions.map((d) => [d.requestId, d.allow]), [["r-1", true]]);
});

test("after a whole run the page's state still equals the bridge's: no change type is dropped", async () => {
  t = await makeBridge({ runtimeConfig: { send: true } });
  sse = openSse(t.bridge);
  await sse.opened;
  await sse.next((f) => f.event === "snapshot");
  const started = await t.post("/tasks", { role: "sre", text: "Count the steamer baskets." });
  assert.equal(started.status, 201, started.text);
  await until(() => t.fake.spawns.length === 1, { what: "the spawn" });
  const rec = t.fake.spawns[0];
  rec.emit({ type: "model", model: "fake-model" });
  rec.emit({ type: "tool-start", id: "tu-1", name: "Bash", summary: "ls" });
  rec.emit({ type: "permission-request", requestId: "r-1", tool: "Bash", input: { command: "ls" } });
  const held = await settled((ui) => ui?.approvals?.some((a) => a.state === "pending"), "the pending approval");
  await t.post(`/approvals/${held.approvals.find((a) => a.state === "pending").id}`, { decision: "deny" });
  rec.emit({ type: "tool-result", id: "tu-1", ok: false, text: "denied" });
  rec.emit({ type: "tool-end", id: "tu-1" });
  rec.emit({ type: "usage", input: 10, output: 5 });
  rec.emit({ type: "reply", text: "Could not count them." });
  rec.emit({ type: "done", ok: true, costUsd: 0.0012 });
  rec.exit({ code: 0 });
  const ended = await settled((ui, bridge) => ui?.agents?.[0]?.state === "done" && ui.seq === bridge.seq, "the ended agent at the bridge's seq");
  const bridge = await t.state();
  const types = [...new Set(sse.frames.filter((f) => f.event === "change").map((f) => f.data.type))];
  assert.ok(["agent", "approval", "ticket"].every((type) => types.includes(type)), `the run sent ${types}`);
  assert.deepEqual(shared(ended), shared(bridge));
  assert.equal(ended.seq, bridge.seq);
});
