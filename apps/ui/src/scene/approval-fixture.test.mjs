// den-v1/06 (user decision 2026-10-08): a dev-only ?demo=approval mode seeds one pending approval through a stub
// bridge so the review panel can be seen in `npm run ui`. Pure model, no network, no DOM.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { approvalDemoParams, createApprovalDemo } from "./approval-fixture.mjs";
import { sceneFromState } from "./scene-from-state.mjs";
import { cardFor } from "../overlay/proximity-card.mjs";
import { createApprovalReview } from "../overlay/approval-review.mjs";

const clock = () => { let t = Date.UTC(2026, 9, 8, 12, 0, 0); return { now: () => t, advance: (ms) => { t += ms; } }; };
const panda = (snapshot) => {
  const [placement] = sceneFromState(snapshot);
  const agent = snapshot.agents.find((a) => a.ref === placement.ref && a.role === placement.role);
  return { id: "p", name: "dev-02", role: placement.role, position: { x: -2, z: 0 }, ref: placement.ref, agent };
};
const viewer = { x: 0, z: 0, yaw: Math.PI / 2 };
const cardOf = (snapshot) => cardFor([panda(snapshot)], snapshot.approvals, viewer);

describe("the URL switch", () => {
  test("only ?demo=approval turns it on, and only in dev", () => {
    assert.deepEqual(approvalDemoParams("?demo=approval", true), { refuse: null });
    assert.equal(approvalDemoParams("?demo=approval", false), null);
    assert.equal(approvalDemoParams("?demo=handoff", true), null);
    assert.equal(approvalDemoParams("", true), null);
  });
  test("refuse=<status> picks a refusal the stub bridge will send", () => {
    assert.deepEqual(approvalDemoParams("?demo=approval&refuse=409", true), { refuse: 409 });
    assert.deepEqual(approvalDemoParams("?demo=approval&refuse=nonsense", true), { refuse: null });
  });
  test("App.jsx gates it on import.meta.env.DEV and keeps it apart from the handoff demo", () => {
    const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
    assert.match(app, /approvalDemoParams\([^)]*import\.meta\.env\.DEV/);
    assert.doesNotMatch(app, /demo=approval/);
  });
});

describe("the seeded snapshot", () => {
  test("puts a developer panda with one pending approval whose card can answer", () => {
    const demo = createApprovalDemo({ now: clock().now });
    const snap = demo.getSnapshot();
    assert.equal(snap.approvals.length, 1);
    assert.equal(snap.approvals[0].status, "pending");
    const card = cardOf(snap);
    assert.equal(card.actions.E.enabled, true);
    assert.equal(card.actions.Q.enabled, true);
    assert.equal(card.approval.id, snap.approvals[0].id);
  });
  test("expiresAt is in the future and inputLength matches the stub's input", async () => {
    const c = clock();
    const demo = createApprovalDemo({ now: c.now });
    const approval = demo.getSnapshot().approvals[0];
    assert.ok(Date.parse(approval.expiresAt) > c.now());
    const res = await demo.client.getApproval(approval.id);
    assert.equal(res.inputLength, JSON.stringify(res.input).length);
    assert.equal(approval.inputLength, res.inputLength);
    assert.ok(res.inputLength > 200, "longer than the 200-character summary, so the panel proves it shows the full input");
  });
});

describe("the stub bridge", () => {
  test("allow settles the approval, tells subscribers, and the agent leaves needs-you", async () => {
    const demo = createApprovalDemo({ now: clock().now });
    const seen = [];
    demo.subscribe(() => seen.push(demo.getSnapshot()));
    const id = demo.getSnapshot().approvals[0].id;
    assert.deepEqual(await demo.client.decide(id, { decision: "allow" }), { ok: true });
    const snap = demo.getSnapshot();
    assert.equal(snap.approvals.find((a) => a.id === id).status, "allowed");
    assert.equal(cardOf(snap).approval, null);
    assert.notEqual(snap.agents[0].state, "needs-you");
    assert.ok(seen.length >= 1);
  });
  test("deny settles it as denied", async () => {
    const demo = createApprovalDemo({ now: clock().now });
    const id = demo.getSnapshot().approvals[0].id;
    await demo.client.decide(id, { decision: "deny", note: "no" });
    assert.equal(demo.getSnapshot().approvals[0].status, "denied");
  });
  test("a second answer to the same approval is refused 409 and changes nothing", async () => {
    const demo = createApprovalDemo({ now: clock().now });
    const id = demo.getSnapshot().approvals[0].id;
    await demo.client.decide(id, { decision: "allow" });
    await assert.rejects(demo.client.decide(id, { decision: "deny" }), (e) => e.status === 409 && typeof e.reason === "string");
    assert.equal(demo.getSnapshot().approvals[0].status, "allowed");
  });
  test("an unknown id is refused 404", async () => {
    const demo = createApprovalDemo({ now: clock().now });
    await assert.rejects(demo.client.getApproval("nope"), (e) => e.status === 404);
    await assert.rejects(demo.client.decide("nope", { decision: "allow" }), (e) => e.status === 404);
  });
  test("refuse=<status> rejects every decision with that status and a reason, and changes nothing", async () => {
    for (const status of [400, 401, 409, 429, 500]) {
      const demo = createApprovalDemo({ now: clock().now, refuse: status });
      const before = JSON.stringify(demo.getSnapshot());
      await assert.rejects(demo.client.decide(demo.getSnapshot().approvals[0].id, { decision: "allow" }),
        (e) => e.status === status && typeof e.reason === "string" && e.reason.length > 0, String(status));
      assert.equal(JSON.stringify(demo.getSnapshot()), before, String(status));
    }
  });
  test("rearm() seeds a fresh pending approval with a new id so the demo can be tried again", async () => {
    const demo = createApprovalDemo({ now: clock().now });
    const first = demo.getSnapshot().approvals[0].id;
    await demo.client.decide(first, { decision: "deny" });
    demo.rearm();
    const pending = demo.getSnapshot().approvals.filter((a) => a.status === "pending");
    assert.equal(pending.length, 1);
    assert.notEqual(pending[0].id, first);
    assert.equal(cardOf(demo.getSnapshot()).actions.E.enabled, true);
  });
});

describe("through the review controller", () => {
  test("open, read the full input, allow: one answer, the card follows the snapshot", async () => {
    const c = clock();
    const demo = createApprovalDemo({ now: c.now });
    const review = createApprovalReview({ client: demo.client, now: c.now, hooks: {} });
    const card = cardOf(demo.getSnapshot());
    assert.equal(review.open(card, { mode: "walk" }).opened, true);
    await new Promise((r) => setImmediate(r));
    assert.equal(review.getState().allowEnabled, true);
    await review.press("allow");
    assert.equal(review.getState().open, false);
    review.sync({ approvals: demo.getSnapshot().approvals, agents: demo.getSnapshot().agents });
    assert.equal(cardOf(demo.getSnapshot()).approval, null);
  });
});

// den-v1/07 fix round 1 (user's choice): the same dev-only demo can send a message, so every composer state is visible.
describe("the stub bridge's sendMessage", () => {
  const manual = () => { const queue = []; return { schedule: (fn, ms) => { queue.push({ fn, ms }); return queue.length; }, queue }; };
  test("the demo agent can send, so T is enabled on its card", () => {
    const demo = createApprovalDemo({ now: clock().now });
    assert.equal(demo.getSnapshot().agents[0].capabilities.send, true);
    assert.equal(cardOf(demo.getSnapshot()).actions.T.enabled, true);
  });
  test("resolves { ok, messageId } with no network and a fresh id each time", async () => {
    const demo = createApprovalDemo({ now: clock().now, schedule: manual().schedule });
    const a = await demo.client.sendMessage("demo-agent-1", { text: "hello" });
    const b = await demo.client.sendMessage("demo-agent-1", { text: "again" });
    assert.equal(a.ok, true);
    assert.equal(typeof a.messageId, "string");
    assert.notEqual(a.messageId, b.messageId);
  });
  test("about 2 s later a message-ack event for that id reaches onEvent listeners", async () => {
    const m = manual();
    const demo = createApprovalDemo({ now: clock().now, schedule: m.schedule });
    const events = [];
    demo.onEvent((e) => events.push(e));
    const { messageId } = await demo.client.sendMessage("demo-agent-1", { text: "hello" });
    assert.deepEqual(events, [], "no ack yet");
    assert.equal(m.queue.length, 1);
    assert.equal(m.queue[0].ms, 2000);
    m.queue[0].fn();
    assert.deepEqual(events, [{ type: "message-ack", agentId: "demo-agent-1", messageId }]);
  });
  test("a message containing noack gets no ack, so 'Sent, not yet received' is reachable", async () => {
    const m = manual();
    const demo = createApprovalDemo({ now: clock().now, schedule: m.schedule });
    const res = await demo.client.sendMessage("demo-agent-1", { text: "please NoAck this" });
    assert.equal(res.ok, true);
    assert.equal(m.queue.length, 0);
  });
  test("onEvent returns an unsubscribe", async () => {
    const m = manual();
    const demo = createApprovalDemo({ now: clock().now, schedule: m.schedule });
    const events = [];
    const off = demo.onEvent((e) => events.push(e));
    await demo.client.sendMessage("demo-agent-1", { text: "hi" });
    off();
    m.queue[0].fn();
    assert.deepEqual(events, []);
  });
  test("an unknown agent is refused 404; refuse=<status> refuses sends too", async () => {
    await assert.rejects(createApprovalDemo({ now: clock().now }).client.sendMessage("nope", { text: "hi" }), (e) => e.status === 404 && typeof e.reason === "string");
    await assert.rejects(createApprovalDemo({ now: clock().now, refuse: 429 }).client.sendMessage("demo-agent-1", { text: "hi" }), (e) => e.status === 429 && e.reason.length > 0);
  });
  test("through the composer: sent, then received once the demo's ack is observed; noack stays sent", async () => {
    const { createMessageComposer } = await import("../overlay/message-composer.mjs");
    const m = manual();
    const demo = createApprovalDemo({ now: clock().now, schedule: m.schedule });
    const composer = createMessageComposer({ client: demo.client, hooks: {} });
    demo.onEvent((e) => composer.observe(e));
    const card = { ...cardOf(demo.getSnapshot()), mode: "walk" };
    for (const [text, expected] of [["hello", "received"], ["please noack", "sent"]]) {
      assert.equal(composer.open(card, { mode: "walk" }).opened, true);
      composer.setText(text);
      await composer.send();
      assert.equal(composer.statusFor(card).kind, "sent");
      m.queue.splice(0).forEach((q) => q.fn());
      assert.equal(composer.statusFor(card).kind, expected);
    }
  });
  test("App.jsx feeds the demo's events into composer.observe", () => {
    const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
    assert.match(app, /approvalDemo[^;\n]*onEvent[^;\n]*observe|onEvent\([^)]*observe/);
  });
});
