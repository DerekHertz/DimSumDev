// organism-infra/107 (ADR 0016 slice 2): cancel a message while it is queued, and the stop-then-resume hand-over.
// The message half (queued -> applied) shipped in den-v1 loop S5 and stays covered by host-message.test.mjs.
//
// PINNED INTERFACE (what these tests hold the developer to; qa specify, 2026-10-12). Names follow ADR 0019 decision 10
// (agent, /agents), so the ticket's "/cells/:id/message" is the existing POST /agents/:id/message.
//
//   POST /agents/:id/message/cancel { messageId }      (token-gated, mutating; a new row in routes.mjs)
//       -> 200 { ok: true }   the runtime dropped the message before the child took it; the SAME transcript entry is
//                             resent with status "cancelled"; the message stops counting toward MESSAGE_QUEUE_MAX;
//                             the agent's state does not change; nothing is written to the child except the cancel
//       -> 400 messageId is not a UUID string; 404 no such agent;
//          409 the agent has ended or is being stopped, its process has no cancel, the message is not waiting
//              (already applied, undelivered, cancelled, never sent, or another agent's), or the runtime says the
//              child already took it ("too late"; the row stays queued);
//          502 the runtime could not carry the cancel out (the row stays queued)
//   CellProcess.cancel(messageId) -> Promise<boolean>  optional, like send. true: dropped before the child took it.
//       false: too late. A rejection: it could not be tried. A process with no cancel makes cancel a 409.
//   Fake runtime (createFakeRuntime): config.cancel (default false) gives its process a cancel method;
//       config.cancelTooLate: cancel resolves false; config.failCancel: cancel rejects;
//       a taken cancel is recorded in record.cancelled (ids, in order); config.handover (default true) is the
//       handover capability. No new runtime capability key: capabilities stay { spawn, stop, approve, send, handover }.
//   Transcript entry status gains "cancelled"; the page note for it is "Cancelled".
//   sessions.jsonl: { event: "cancel", agentId, ref, messageId, route: "POST /agents/:id/message/cancel" }: never text.
//   A cancel that leaves nothing queued after the agent reported done ends the agent at once: the wait for a message
//   that will never be taken (MESSAGE_SETTLE_MS) is over.
//
//   POST /agents/:id/handover                          (token-gated, mutating; no body; a new row in routes.mjs)
//       -> 202 { ok: true }   the host runs the stop sequence on the child (close input, grace, SIGTERM, SIGKILL);
//                             the agent ends state "terminated" with reason "handed-over" (the end line in sessions.jsonl
//                             carries the same reason); its `resume` is runtime.resumeCommand(sessionId), set only once
//                             the process has exited, and shown to the user, never run: the bridge starts no second process
//       -> 404 no such agent; 409 the agent has already ended, or its runtime's handover capability is false
//          (the child keeps running, nothing is closed)
//   sessions.jsonl: { event: "handover", agentId, ref, route: "POST /agents/:id/handover" } before the end line.
//   The user runs the string in the agent's worktree, which the snapshot already carries as `worktree`.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startBridge } from "../server.mjs";
import { makeStateFixture, FEATURE } from "../bridge-fixture.mjs";
import { CODE, login, authed, send } from "../bridge-auth-helpers.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { makeStub, alive } from "./claude-stub.mjs";
import { makeBridge, openSse, until, sleep, DISPATCH_REF, UUID_RE } from "./host-test-helpers.mjs";
import { unconfinedLauncher } from "./launcher-test-helpers.mjs";
import { MESSAGE_QUEUE_MAX } from "./policy.mjs";
import { transcriptView } from "../../ui/src/overlay/transcript-view.mjs";
import { appendTranscript, entryFromFrame } from "../../ui/src/state/transcript-buffer.mjs";

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup({ runtimeConfig = {}, ...options } = {}) {
  const t = await makeBridge({ runtimeConfig: { send: true, cancel: true, ...runtimeConfig }, ...options });
  const sse = openSse(t.bridge);
  await sse.opened;
  cleanups.push(async () => {
    sse.close();
    await t.close();
  });
  const frames = (id) => sse.frames.filter((f) => f.event === "change" && f.data.type === "transcript" && f.data.agentId === id);
  const entriesOf = (id) => frames(id).map((f) => f.data.entry);
  const mine = (id) => entriesOf(id).filter((e) => e.kind === "message" && e.role === "user");
  const waitFor = (id, pred, what) => until(() => entriesOf(id).find(pred), { what });
  const say = (id, text) => t.post(`/agents/${id}/message`, { text });
  const cancel = (id, messageId, headers) => t.post(`/agents/${id}/message/cancel`, { messageId }, headers);
  const handover = (id, headers) => t.post(`/agents/${id}/handover`, {}, headers);
  const called = (rec, name) => rec.calls.some((c) => c.call === name);
  const auditLines = () => {
    try {
      return readFileSync(t.sessionsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { ...t, sse, frames, entriesOf, mine, waitFor, say, cancel, handover, called, auditLines };
}
const NEVER_SENT = "00000000-0000-4000-8000-00000000beef";

describe("cancel a message while it is queued", () => {
  test("the row is resent as cancelled, the runtime is asked once, and the agent is unaffected", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    const { messageId } = (await t.say(agent.id, "use port 5173")).body;
    const queued = await t.waitFor(agent.id, (e) => e.role === "user", "the queued message");

    const res = await t.cancel(agent.id, messageId);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, { ok: true });
    assert.deepEqual(rec.cancelled, [messageId], "the runtime was asked to drop exactly this message");

    const cancelled = await t.waitFor(agent.id, (e) => e.role === "user" && e.status === "cancelled", "the cancelled row");
    assert.equal(cancelled.id, queued.id, "the same entry, resent: never a second row");
    assert.equal(cancelled.messageId, messageId);
    assert.equal(cancelled.text, "use port 5173");
    assert.deepEqual(t.mine(agent.id).map((e) => e.status), ["queued", "cancelled"]);
    assert.equal((await t.agent(agent.id)).state, "working", "a cancel does not change the agent's state");
    assert.equal(rec.exited, false);
  });

  test("the page shows it as yours and cancelled", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const { messageId } = (await t.say(agent.id, "also run the tests")).body;
    await t.waitFor(agent.id, (e) => e.role === "user", "the queued message");
    await t.cancel(agent.id, messageId);
    await t.waitFor(agent.id, (e) => e.status === "cancelled", "the cancelled row");
    const buffers = t.frames(agent.id).reduce((b, f) => { const line = entryFromFrame(f.data); return appendTranscript(b, line.agentId, line.entry); }, {});
    const rows = transcriptView(buffers[agent.id], { expanded: [], atBottom: true, seenThrough: 0, connection: { phase: "live" } }).rows;
    assert.deepEqual(rows.map((r) => [r.speaker, r.text, r.note]), [["You", "also run the tests", "Cancelled"]]);
  });

  test("the audit line names the message, never its text", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const { messageId } = (await t.say(agent.id, "use port 5173")).body;
    await t.cancel(agent.id, messageId);
    const line = await until(() => t.auditLines().find((l) => l.event === "cancel"), { what: "the cancel audit line" });
    assert.deepEqual({ ...line, ts: undefined }, { ts: undefined, event: "cancel", agentId: agent.id, ref: DISPATCH_REF, messageId, route: "POST /agents/:id/message/cancel" });
    assert.equal(readFileSync(t.sessionsFile, "utf8").includes("use port"), false);
  });

  test("a cancelled message gives its place in the queue back", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const ids = [];
    for (let i = 0; i < MESSAGE_QUEUE_MAX; i += 1) ids.push((await t.say(agent.id, `m${i}`)).body.messageId);
    assert.equal((await t.say(agent.id, "one too many")).status, 429);
    assert.equal((await t.cancel(agent.id, ids[3])).status, 200);
    assert.equal((await t.say(agent.id, "room now")).status, 202);
    assert.equal((await t.say(agent.id, "full again")).status, 429);
  });

  test("a runtime report that the child took a cancelled message changes nothing", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    const { messageId } = (await t.say(agent.id, "hello")).body;
    await t.cancel(agent.id, messageId);
    rec.emit({ type: "message-applied", id: messageId });
    rec.emit({ type: "text", text: "still here" });
    await t.waitFor(agent.id, (e) => e.text === "still here", "a later event");
    assert.deepEqual(t.mine(agent.id).map((e) => e.status), ["queued", "cancelled"]);
  });

  test("only the message named is cancelled", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    const first = (await t.say(agent.id, "first")).body.messageId;
    const second = (await t.say(agent.id, "second")).body.messageId;
    assert.equal((await t.cancel(agent.id, first)).status, 200);
    rec.emit({ type: "message-applied", id: second });
    await t.waitFor(agent.id, (e) => e.text === "second" && e.status === "applied", "the second message applied");
    assert.deepEqual(rec.cancelled, [first]);
    const finalRows = new Map(t.mine(agent.id).map((e) => [e.text, e.status])); // later frames replace earlier ones
    assert.deepEqual([...finalRows], [["first", "cancelled"], ["second", "applied"]]);
  });

  test("done with the only message cancelled does not wait for a message that will never come", async () => {
    const t = await setup(); // production settle wait: far longer than this test lets the agent live
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    const { messageId } = (await t.say(agent.id, "too late")).body;
    rec.emit({ type: "done", ok: true });
    await t.waitFor(agent.id, (e) => e.status === "queued", "the queued row");
    await sleep(30);
    assert.equal(t.called(rec, "closeInput"), false, "held open while the message is still queued");
    assert.equal((await t.cancel(agent.id, messageId)).status, 200);
    await until(async () => (await t.agent(agent.id)).state === "done", { what: "the agent to end now that nothing is waiting" });
    assert.equal(t.called(rec, "closeInput"), true);
    assert.deepEqual(t.mine(agent.id).map((e) => e.status), ["queued", "cancelled"], "cancelled is not rewritten to undelivered");
  });
});

describe("cancel is accepted only while the message is queued", () => {
  test("a message the child already took (applied) is a 409 and stays applied", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    const { messageId } = (await t.say(agent.id, "use tabs")).body;
    rec.emit({ type: "message-applied", id: messageId });
    await t.waitFor(agent.id, (e) => e.status === "applied", "the applied message");
    const res = await t.cancel(agent.id, messageId);
    assert.equal(res.status, 409);
    assert.equal(typeof res.body.error, "string");
    assert.deepEqual(rec.cancelled ?? [], [], "the runtime is not even asked");
    await sleep(40);
    assert.deepEqual(t.mine(agent.id).map((e) => e.status), ["queued", "applied"]);
  });

  test("a second cancel of the same message is a 409", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const { messageId } = (await t.say(agent.id, "hello")).body;
    assert.equal((await t.cancel(agent.id, messageId)).status, 200);
    assert.equal((await t.cancel(agent.id, messageId)).status, 409);
    assert.deepEqual(t.fake.spawns[0].cancelled, [messageId], "asked once");
  });

  test("a message nobody sent is a 409", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    assert.equal((await t.cancel(agent.id, NEVER_SENT)).status, 409);
    assert.deepEqual(t.fake.spawns[0].cancelled, []);
  });

  test("another agent's message cannot be cancelled through this agent", async () => {
    const t = await setup();
    const a = (await t.dispatch("architect")).body.agent;
    const b = (await t.bridge.host.start({ ref: `${FEATURE}/34-cancel-other`, role: "scout" })).agent;
    const { messageId } = (await t.say(a.id, "for a only")).body;
    assert.equal((await t.cancel(b.id, messageId)).status, 409);
    assert.deepEqual(t.fake.spawns[0].cancelled, []);
    assert.deepEqual(t.fake.spawns[1].cancelled, []);
    await t.waitFor(a.id, (e) => e.role === "user", "the queued message");
    await sleep(40);
    assert.deepEqual(t.mine(a.id).map((e) => e.status), ["queued"]);
  });

  test("the child took it before the runtime could drop it: a 409, and the row goes on to applied", async () => {
    const t = await setup({ runtimeConfig: { cancelTooLate: true } });
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    const { messageId } = (await t.say(agent.id, "hello")).body;
    const res = await t.cancel(agent.id, messageId);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /already|taken|too late/i);
    assert.deepEqual(rec.cancelled, [], "nothing was dropped");
    rec.emit({ type: "message-applied", id: messageId });
    await t.waitFor(agent.id, (e) => e.status === "applied", "the applied message");
    assert.deepEqual(t.mine(agent.id).map((e) => e.status), ["queued", "applied"]);
  });

  test("a runtime that fails to cancel is a 502, and the message is still queued and still counts", async () => {
    const t = await setup({ runtimeConfig: { failCancel: true } });
    const { agent } = (await t.dispatch("architect")).body;
    const ids = [];
    for (let i = 0; i < MESSAGE_QUEUE_MAX; i += 1) ids.push((await t.say(agent.id, `m${i}`)).body.messageId);
    assert.equal((await t.cancel(agent.id, ids[0])).status, 502);
    await sleep(40);
    assert.equal(t.mine(agent.id).every((e) => e.status === "queued"), true);
    assert.equal((await t.say(agent.id, "still full")).status, 429);
    t.fake.config.failCancel = false;
    assert.equal((await t.cancel(agent.id, ids[0])).status, 200, "it can be tried again");
  });

  test("a process that cannot cancel is a 409 and nothing changes", async () => {
    const t = await setup({ runtimeConfig: { cancel: false } });
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    const { messageId } = (await t.say(agent.id, "hello")).body;
    const res = await t.cancel(agent.id, messageId);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /cannot cancel/);
    rec.emit({ type: "message-applied", id: messageId });
    await t.waitFor(agent.id, (e) => e.status === "applied", "the message still goes through");
  });

  test("an agent that has ended, or is being stopped, takes no cancel", async () => {
    const t = await setup({ runtimeConfig: { stdinCloseEnds: false, sigtermEnds: false }, policy: { killGraceMs: 400 } });
    const { agent } = (await t.dispatch("architect")).body;
    const { messageId } = (await t.say(agent.id, "never read")).body;
    assert.equal((await t.post(`/agents/${agent.id}/stop`)).status, 202);
    assert.equal((await t.cancel(agent.id, messageId)).status, 409, "stopping");
    await until(async () => (await t.agent(agent.id)).state === "terminated", { what: "the agent to end" });
    assert.equal((await t.cancel(agent.id, messageId)).status, 409, "ended");
    assert.deepEqual(t.mine(agent.id).map((e) => e.status), ["queued", "undelivered"]);
    assert.deepEqual(t.fake.spawns[0].cancelled, []);
  });

  test("bad input is a 400, an unknown agent a 404", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    await t.say(agent.id, "hello");
    for (const messageId of [undefined, 7, null, "", "not-a-uuid", {}, [NEVER_SENT], "x".repeat(300)]) {
      const res = await t.cancel(agent.id, messageId);
      assert.equal(res.status, 400, `messageId ${JSON.stringify(messageId)?.slice(0, 20)}`);
      assert.equal(typeof res.body.error, "string");
    }
    assert.equal((await t.cancel("c-0000000000000000", NEVER_SENT)).status, 404);
    assert.equal((await t.cancel("nope", NEVER_SENT)).status, 404);
    assert.deepEqual(t.fake.spawns[0].cancelled, []);
    assert.match(NEVER_SENT, UUID_RE);
  });

  test("no token is a 401 and cancels nothing", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const { messageId } = (await t.say(agent.id, "hello")).body;
    const { Authorization, ...noToken } = t.headers;
    assert.equal((await t.cancel(agent.id, messageId, noToken)).status, 401);
    assert.deepEqual(t.fake.spawns[0].cancelled, []);
  });
});

describe("hand over: stop the agent, then show the resume string", () => {
  test("the agent ends handed over, with the resume string set and no second process started", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    assert.equal(agent.capabilities.handover, true);
    assert.equal(agent.resume, null, "nothing to resume while the child runs");

    const res = await t.handover(agent.id);
    assert.equal(res.status, 202, res.text);
    assert.deepEqual(res.body, { ok: true });

    const ended = await until(async () => { const a = await t.agent(agent.id); return a.state === "terminated" ? a : null; }, { what: "the agent to end" });
    assert.equal(ended.reason, "handed-over");
    assert.equal(typeof ended.resume, "string");
    assert.equal(ended.resume, t.fake.resumeCommand(agent.sessionId), "the runtime composes the string; the host only passes it on");
    assert.equal(typeof ended.worktree, "string", "the directory the string is run in");
    assert.equal(t.called(rec, "closeInput"), true, "the child was stopped with the usual sequence");

    await sleep(80);
    assert.equal(t.fake.spawns.length, 1, "the bridge shows the string and never runs it");
    assert.equal((await t.agent(agent.id)).state, "terminated");
    assert.equal(t.entriesOf(agent.id).at(-1).kind, "ended");
  });

  test("the resume string appears only once the process has exited", async () => {
    const t = await setup({ runtimeConfig: { stdinCloseEnds: false, sigtermEnds: false }, policy: { killGraceMs: 300 } });
    const { agent } = (await t.dispatch("architect")).body;
    assert.equal((await t.handover(agent.id)).status, 202);
    await sleep(60);
    const during = await t.agent(agent.id);
    assert.equal(during.resume, null, "two live processes never share a session: no string while the child is still up");
    assert.notEqual(during.state, "terminated");
    const ended = await until(async () => { const a = await t.agent(agent.id); return a.state === "terminated" ? a : null; }, { what: "the escalation to finish" });
    assert.equal(ended.resume, t.fake.resumeCommand(agent.sessionId));
    assert.equal(ended.reason, "handed-over");
    assert.equal(t.fake.spawns.length, 1);
  });

  test("the audit trail says it was a hand-over, and a message still queued ends not delivered", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    await t.say(agent.id, "never read");
    await t.handover(agent.id);
    await until(async () => (await t.agent(agent.id)).state === "terminated", { what: "the agent to end" });
    const lines = t.auditLines();
    const hand = lines.find((l) => l.event === "handover");
    assert.deepEqual({ ...hand, ts: undefined }, { ts: undefined, event: "handover", agentId: agent.id, ref: DISPATCH_REF, route: "POST /agents/:id/handover" });
    const end = lines.find((l) => l.event === "end" && l.agentId === agent.id);
    assert.equal(end.state, "terminated");
    assert.equal(end.reason, "handed-over");
    assert.ok(lines.indexOf(hand) < lines.indexOf(end), "the hand-over line comes before the end line");
    assert.deepEqual(t.mine(agent.id).map((e) => e.status), ["queued", "undelivered"]);
  });

  test("a message after the hand-over is refused", async () => {
    const t = await setup({ runtimeConfig: { stdinCloseEnds: false, sigtermEnds: false }, policy: { killGraceMs: 300 } });
    const { agent } = (await t.dispatch("architect")).body;
    await t.handover(agent.id);
    assert.equal((await t.say(agent.id, "wait")).status, 409);
    assert.deepEqual(t.fake.spawns[0].sent, []);
  });

  test("an agent that has already ended is a 409, an unknown agent a 404", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    t.fake.spawns[0].exit({ code: 0 });
    await until(async () => (await t.agent(agent.id)).state !== "working", { what: "the agent to end" });
    const before = await t.agent(agent.id);
    assert.equal((await t.handover(agent.id)).status, 409);
    assert.equal((await t.agent(agent.id)).reason, before.reason, "an ended agent is not relabelled");
    assert.equal((await t.handover("c-0000000000000000")).status, 404);
    assert.equal((await t.handover("nope")).status, 404);
  });

  test("a runtime that offers no hand-over is a 409: the child keeps running", async () => {
    const t = await setup({ runtimeConfig: { handover: false } });
    const { agent } = (await t.dispatch("architect")).body;
    assert.equal(agent.capabilities.handover, false);
    const res = await t.handover(agent.id);
    assert.equal(res.status, 409);
    await sleep(60);
    assert.equal(t.called(t.fake.spawns[0], "closeInput"), false);
    assert.equal((await t.agent(agent.id)).state, "working");
  });

  test("no token is a 401 and stops nothing", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const { Authorization, ...noToken } = t.headers;
    assert.equal((await t.handover(agent.id, noToken)).status, 401);
    await sleep(40);
    assert.equal(t.called(t.fake.spawns[0], "closeInput"), false);
    assert.equal((await t.agent(agent.id)).state, "working");
  });
});

// The slice's done-when for the hand-over: the route, the host and the real runtime over real pipes, with the stub as the claude binary.
describe("a hand-over through the real runtime, with the stub as the child", () => {
  test("the child is stopped, the claude --resume string is shown, and no second claude is started", { timeout: 30000 }, async () => {
    const stub = await makeStub({ mode: "hang" });
    const fx = await makeStateFixture({ git: true });
    const runtime = createClaudeRuntime({ env: { PATH: process.env.PATH, HOME: process.env.HOME, DEN_CLAUDE_BIN: stub.bin }, launcher: unconfinedLauncher() });
    const bridge = await startBridge({ root: fx.root, port: 0, auth: { launchCode: CODE }, runtime, policy: { killGraceMs: 150 } });
    const headers = authed(bridge, await login(bridge));
    cleanups.push(async () => {
      const pid = (await stub.start())?.pid;
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      await bridge.close();
      await fx.cleanup();
    });
    const post = (p, body) => send(bridge, { method: "POST", path: p, body, headers });
    const state = async () => (await send(bridge, { path: "/state" })).body;

    const res = await post("/agents", { ref: DISPATCH_REF, role: "architect" });
    assert.equal(res.status, 201, res.text);
    const { id, sessionId } = res.body.agent;
    assert.equal(res.body.agent.capabilities.handover, true);
    await until(async () => (await state()).agents.find((a) => a.id === id)?.tool, { what: "the child to be mid-turn" });
    const pid = (await stub.start()).pid;

    assert.equal((await post(`/agents/${id}/handover`, {})).status, 202);
    const ended = await until(async () => { const a = (await state()).agents.find((x) => x.id === id); return a.state === "terminated" ? a : null; }, { ms: 10000, what: "the child to be stopped" });
    assert.equal(ended.reason, "handed-over");
    assert.equal(ended.resume, `claude --resume ${sessionId}`);
    assert.equal(alive(pid), false, "the child the bridge started is gone");

    await sleep(100);
    const starts = (await stub.log()).filter((e) => e.kind === "start");
    assert.equal(starts.length, 1, "the bridge never ran the resume string");
    assert.equal(starts[0].argv.includes("--resume"), false);
  });
});
