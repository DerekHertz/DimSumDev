// den-v1 loop S5 (ADR 0016 amendment 12): a message to a running agent. Contract:
//
//   POST /agents/:id/message { text }   (token-gated, mutating; text trimmed, 1 to MESSAGE_MAX_BYTES UTF-8 bytes)
//       -> 202 { ok: true, messageId }     the message is recorded and written to the agent's stdin, once
//       -> 400 bad text (not a string, empty, too long, or it looks like a secret); 404 no such agent;
//          409 the agent has ended, is stopping, has finished its work, or its runtime cannot take a message;
//          429 MESSAGE_QUEUE_MAX messages are already waiting; 502 the runtime could not take it
//   CellProcess.send(messageId, text) -> Promise        (only called when capabilities.send is true)
//   CellEvent { type: "message-applied", id }           the child took the message with that id
//   Transcript entry { id, at, kind: "message", role: "user", text, messageId, status }
//       status: "queued" (written, not yet taken) -> "applied" (the runtime reported it) | "undelivered" (the agent
//       ended first, or the write failed). A change of status resends the entry under the same id.
//   A `done` that arrives while a message is still queued does not end the agent: the child will take the message as
//   a further turn. The host waits MESSAGE_SETTLE_MS for it (policy.messageSettleMs lowers the wait in tests); the
//   next `done` with nothing queued ends the agent as before. Once the host has begun to end an agent, a message is
//   refused.
//   sessions.jsonl gets { event: "message", agentId, ref, messageId, bytes, route }: never the text.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startBridge } from "../server.mjs";
import { makeStateFixture } from "../bridge-fixture.mjs";
import { CODE, login, authed, send } from "../bridge-auth-helpers.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { makeStub, alive } from "./claude-stub.mjs";
import { makeBridge, openSse, until, sleep, seedSessions, DISPATCH_REF, UUID_RE } from "./host-test-helpers.mjs";
import { MESSAGE_MAX_BYTES, MESSAGE_QUEUE_MAX, MESSAGE_SETTLE_MS } from "./policy.mjs";
import { transcriptView } from "../../ui/src/overlay/transcript-view.mjs";
import { appendTranscript, entryFromFrame } from "../../ui/src/state/transcript-buffer.mjs";
import { unconfinedLauncher } from "./launcher-test-helpers.mjs";

const AWS_KEY = ["AKIA", "IOSFODNN7", "EXAMPLE"].join(""); // built here so the root secret scan does not flag the file
const BIDI = String.fromCharCode(0x202e);

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup({ runtimeConfig = {}, ...options } = {}) {
  const t = await makeBridge({ runtimeConfig: { send: true, ...runtimeConfig }, ...options });
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
  const say = (id, text, headers) => t.post(`/agents/${id}/message`, { text }, headers);
  const called = (rec, name) => rec.calls.some((c) => c.call === name);
  return { ...t, sse, frames, entriesOf, mine, waitFor, say, called };
}
const strip = ({ at, ...rest }) => rest;

describe("a message to a running agent", () => {
  test("it is recorded as queued, written to the agent once, and marked applied when the runtime reports it", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    assert.equal(agent.capabilities.send, true);
    const rec = t.fake.spawns[0];

    const res = await t.say(agent.id, "  use port 5173  ");
    assert.equal(res.status, 202);
    assert.equal(res.body.ok, true);
    assert.match(res.body.messageId, UUID_RE);
    const { messageId } = res.body;
    assert.deepEqual(rec.sent, [{ id: messageId, text: "use port 5173" }], "the trimmed text reaches the agent once");

    const queued = await t.waitFor(agent.id, (e) => e.role === "user", "the queued message");
    assert.deepEqual(strip(queued), { id: queued.id, kind: "message", role: "user", text: "use port 5173", messageId, status: "queued" });

    rec.emit({ type: "message-applied", id: messageId });
    const applied = await t.waitFor(agent.id, (e) => e.role === "user" && e.status === "applied", "the applied message");
    assert.equal(applied.id, queued.id, "the same entry, resent: never a second row");
    assert.equal(applied.messageId, messageId);
    assert.deepEqual((await t.state()).transcripts[agent.id].entries.filter((e) => e.role === "user").map((e) => e.status), ["applied"]);
    assert.equal((await t.agent(agent.id)).state, "working", "a message does not change the agent's state");
  });

  test("the page shows it as yours, queued and then received", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const { messageId } = (await t.say(agent.id, "also run the tests")).body;
    await t.waitFor(agent.id, (e) => e.role === "user", "the queued message");
    const rows = () => {
      const buffers = t.frames(agent.id).reduce((b, f) => { const line = entryFromFrame(f.data); return appendTranscript(b, line.agentId, line.entry); }, {});
      return transcriptView(buffers[agent.id], { expanded: [], atBottom: true, seenThrough: 0, connection: { phase: "live" } }).rows;
    };
    assert.deepEqual(rows().map((r) => [r.speaker, r.text, r.note]), [["You", "also run the tests", "Queued"]]);
    t.fake.spawns[0].emit({ type: "message-applied", id: messageId });
    await t.waitFor(agent.id, (e) => e.status === "applied", "the applied message");
    assert.deepEqual(rows().map((r) => [r.speaker, r.note]), [["You", "Received"]]);
  });

  test("what the page shows is cleaned, and the agent gets the text as typed", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const typed = `rename it ${BIDI}now`;
    assert.equal((await t.say(agent.id, typed)).status, 202);
    assert.equal(t.fake.spawns[0].sent[0].text, typed);
    const entry = await t.waitFor(agent.id, (e) => e.role === "user", "the queued message");
    assert.equal(entry.text.includes(BIDI), false);
    assert.match(entry.text, /rename it .*now/);
  });

  test("the audit line names the message and its size, never its text", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const { messageId } = (await t.say(agent.id, "use port 5173")).body;
    const raw = await until(() => { const s = readFileSync(t.sessionsFile, "utf8"); return s.includes('"message"') ? s : null; }, { what: "the audit line" });
    const line = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.event === "message");
    assert.deepEqual({ ...line, ts: undefined }, { ts: undefined, event: "message", agentId: agent.id, ref: DISPATCH_REF, messageId, bytes: 13, route: "POST /agents/:id/message" });
    assert.equal(raw.includes("use port"), false);
  });

  test("a bridge restarted over a log with message lines still lists its agents", async () => {
    const id = "c-00000000000000aa";
    const t = await setup({
      preWrite: (root) => seedSessions(root, [
        { ts: "2026-10-10T10:00:00.000Z", event: "spawn", agentId: id, ref: DISPATCH_REF, role: "architect", sessionId: "00000000-0000-4000-8000-000000000001", route: "POST /agents" },
        { ts: "2026-10-10T10:00:01.000Z", event: "message", agentId: id, ref: DISPATCH_REF, messageId: "00000000-0000-4000-8000-000000000002", bytes: 2, route: "POST /agents/:id/message" },
        { ts: "2026-10-10T10:00:02.000Z", event: "end", agentId: id, ref: DISPATCH_REF, state: "done" },
      ]),
    });
    const old = await t.agent(id);
    assert.equal(old.state, "done");
    assert.equal(old.capabilities.send, false, "an agent from an earlier run takes no message");
    assert.equal((await t.say(id, "hello")).status, 409);
  });
});

describe("a message that is refused changes nothing", () => {
  test("bad text is a 400: nothing is written to the agent and no row appears", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    for (const text of [undefined, 7, "", "   ", "x".repeat(MESSAGE_MAX_BYTES + 1), "é".repeat(MESSAGE_MAX_BYTES / 2 + 1), `the key is ${AWS_KEY}`]) {
      const res = await t.say(agent.id, text);
      assert.equal(res.status, 400, `text ${JSON.stringify(String(text).slice(0, 20))}`);
      assert.equal(typeof res.body.error, "string");
    }
    assert.equal((await t.say(agent.id, "x".repeat(MESSAGE_MAX_BYTES))).status, 202, "exactly the limit is accepted");
    assert.equal(t.fake.spawns[0].sent.length, 1);
    await t.waitFor(agent.id, (e) => e.role === "user", "the one accepted message");
    await sleep(40);
    assert.equal(t.mine(agent.id).length, 1);
  });

  test("no token is a 401, an unknown agent a 404", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const { Authorization, ...noToken } = t.headers;
    assert.equal((await send(t.bridge, { method: "POST", path: `/agents/${agent.id}/message`, body: { text: "hi" }, headers: noToken })).status, 401);
    assert.equal((await t.say("c-0000000000000000", "hi")).status, 404);
    assert.equal((await t.say("nope", "hi")).status, 404);
    assert.deepEqual(t.fake.spawns[0].sent, []);
  });

  test("a runtime that cannot take messages is a 409", async () => {
    const t = await setup({ runtimeConfig: { send: false } });
    const { agent } = (await t.dispatch("architect")).body;
    assert.equal(agent.capabilities.send, false);
    const res = await t.say(agent.id, "hi");
    assert.equal(res.status, 409);
    assert.match(res.body.error, /cannot take a message/);
    assert.deepEqual(t.fake.spawns[0].sent, []);
  });

  test("an agent that has ended, or is being stopped, is a 409", async () => {
    const t = await setup({ runtimeConfig: { stdinCloseEnds: false, sigtermEnds: false }, policy: { killGraceMs: 400 } });
    const { agent } = (await t.dispatch("architect")).body;
    assert.equal((await t.post(`/agents/${agent.id}/stop`)).status, 202);
    assert.equal((await t.say(agent.id, "wait")).status, 409, "stopping");
    await until(async () => (await t.agent(agent.id)).state === "terminated", { what: "the agent to end" });
    assert.equal((await t.say(agent.id, "wait")).status, 409, "ended");
    assert.deepEqual(t.fake.spawns[0].sent, []);
  });

  test("an agent that reported done is finishing: a message then is a 409", async () => {
    const t = await setup({ runtimeConfig: { stdinCloseEnds: false }, policy: { killGraceMs: 300 } });
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    rec.emit({ type: "done", ok: true });
    await until(() => t.called(rec, "closeInput"), { what: "the host to close the agent's input" });
    const res = await t.say(agent.id, "one more thing");
    assert.equal(res.status, 409);
    assert.match(res.body.error, /finished/);
    assert.deepEqual(rec.sent, []);
  });

  test(`only ${MESSAGE_QUEUE_MAX} messages may wait at once; one taken makes room`, async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const ids = [];
    for (let i = 0; i < MESSAGE_QUEUE_MAX; i += 1) ids.push((await t.say(agent.id, `m${i}`)).body.messageId);
    const res = await t.say(agent.id, "one too many");
    assert.equal(res.status, 429);
    assert.equal(t.fake.spawns[0].sent.length, MESSAGE_QUEUE_MAX);
    t.fake.spawns[0].emit({ type: "message-applied", id: ids[0] });
    await t.waitFor(agent.id, (e) => e.status === "applied", "the applied message");
    assert.equal((await t.say(agent.id, "room now")).status, 202);
  });

  test("a runtime that fails to take it is a 502, and the row says it was not delivered", async () => {
    const t = await setup({ runtimeConfig: { failSend: true } });
    const { agent } = (await t.dispatch("architect")).body;
    const res = await t.say(agent.id, "hello");
    assert.equal(res.status, 502);
    const entry = await t.waitFor(agent.id, (e) => e.role === "user" && e.status === "undelivered", "the undelivered row");
    assert.equal(entry.text, "hello");
    t.fake.config.failSend = false;
    assert.equal((await t.say(agent.id, "again")).status, 202, "a failed message does not hold a place in the queue");
  });

  test("an applied report for an unknown message changes nothing", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    await t.say(agent.id, "hello");
    const rec = t.fake.spawns[0];
    for (const id of ["00000000-0000-4000-8000-00000000dead", "", 7, null, undefined, {}]) rec.emit({ type: "message-applied", id });
    rec.emit({ type: "text", text: "still here" });
    await t.waitFor(agent.id, (e) => e.text === "still here", "a later event");
    assert.deepEqual(t.mine(agent.id).map((e) => e.status), ["queued"]);
  });
});

describe("a message and the end of the agent's work", () => {
  test("done with a message still queued does not end the agent; it ends after the turn that took the message", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    const { messageId } = (await t.say(agent.id, "also update the README")).body;
    rec.emit({ type: "reply", text: "First part is done." });
    rec.emit({ type: "done", ok: true, costUsd: 0.01 });
    await t.waitFor(agent.id, (e) => e.text === "First part is done.", "the first reply");
    await sleep(80);
    assert.equal(t.called(rec, "closeInput"), false, "the agent's input stays open for the queued message");
    assert.equal((await t.agent(agent.id)).state, "working");

    rec.emit({ type: "message-applied", id: messageId });
    rec.emit({ type: "reply", text: "README updated too." });
    await sleep(40);
    assert.equal(t.called(rec, "closeInput"), false, "taking the message is not the end of its turn");
    rec.emit({ type: "done", ok: true, costUsd: 0.03 });
    const ended = await until(async () => { const a = await t.agent(agent.id); return a.state === "done" ? a : null; }, { what: "the agent to end" });
    assert.equal(ended.costUsd, 0.03, "the later result's totals stand");
    assert.equal(ended.reply, "README updated too.");
    assert.deepEqual(t.mine(agent.id).map((e) => e.status), ["queued", "applied"]);
  });

  test("a further turn that dies leaves the agent failed, and its tokens a running count again", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    const { messageId } = (await t.say(agent.id, "one more thing")).body;
    rec.emit({ type: "done", ok: true, tiers: { input: 1, cacheWrite: 2, cacheRead: 3, output: 4 } });
    rec.emit({ type: "message-applied", id: messageId });
    rec.emit({ type: "usage", input: 10, output: 5, message: "msg-2", tiers: { input: 10, cacheWrite: 0, cacheRead: 0, output: 5 } });
    await until(async () => (await t.agent(agent.id)).usage?.input === 11, { what: "the further turn's tokens" });
    rec.exit({ code: 1 });
    const ended = await until(async () => { const a = await t.agent(agent.id); return a.state !== "working" ? a : null; }, { what: "the agent to end" });
    assert.equal(ended.state, "failed", "the first turn's verdict does not stand for a turn that died");
    assert.deepEqual(ended.usage, { input: 11, cacheWrite: 2, cacheRead: 3, output: 9, final: false });
  });

  test("a queued message nobody takes: after the settle wait the agent ends and the row says not delivered", async () => {
    assert.equal(MESSAGE_SETTLE_MS >= 5000, true, "production waits long enough for a real child to take it");
    const t = await setup({ policy: { messageSettleMs: 60 } });
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    await t.say(agent.id, "too late");
    rec.emit({ type: "done", ok: true });
    await sleep(20);
    assert.equal(t.called(rec, "closeInput"), false);
    await until(async () => (await t.agent(agent.id)).state === "done", { what: "the agent to end after the wait" });
    assert.deepEqual(t.mine(agent.id).map((e) => e.status), ["queued", "undelivered"]);
    const kinds = t.entriesOf(agent.id).map((e) => e.kind);
    assert.equal(kinds.at(-1), "ended");
  });

  test("an agent stopped with a message queued: the row says not delivered", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    await t.say(agent.id, "never read");
    assert.equal((await t.post(`/agents/${agent.id}/stop`)).status, 202);
    await until(async () => (await t.agent(agent.id)).state === "terminated", { what: "the agent to end" });
    assert.deepEqual(t.mine(agent.id).map((e) => e.status), ["queued", "undelivered"]);
  });

  test("a message taken within the turn does not hold the agent open", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    const { messageId } = (await t.say(agent.id, "use tabs")).body;
    rec.emit({ type: "message-applied", id: messageId });
    rec.emit({ type: "done", ok: true });
    await until(async () => (await t.agent(agent.id)).state === "done", { what: "the agent to end" });
    assert.equal(t.called(rec, "closeInput"), true);
  });
});

// The slice's done-when: the route, the host and the real runtime over real pipes, with the stub as the claude binary.
describe("a message through the real runtime, with the stub as the child", () => {
  test("the message is written to the child mid-turn, its replay marks it received, and the agent ends done", { timeout: 30000 }, async () => {
    const stub = await makeStub({ mode: "message" });
    const fx = await makeStateFixture({ git: true });
    const runtime = createClaudeRuntime({ launcher: unconfinedLauncher(), env: { PATH: process.env.PATH, HOME: process.env.HOME, DEN_CLAUDE_BIN: stub.bin } });
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
    const id = res.body.agent.id;
    assert.equal(res.body.agent.capabilities.send, true);
    await until(async () => (await state()).agents.find((a) => a.id === id)?.tool, { what: "the child to be mid-turn" });

    const said = await post(`/agents/${id}/message`, { text: "also say second" });
    assert.equal(said.status, 202, said.text);
    const ended = await until(async () => { const a = (await state()).agents.find((x) => x.id === id); return a.state === "done" ? a : null; }, { ms: 10000, what: "the agent to end" });
    assert.equal(ended.reply, "got: also say second");

    const lines = await stub.stdinLines();
    assert.deepEqual(lines[1], { type: "user", message: { role: "user", content: "also say second" }, uuid: said.body.messageId });
    assert.equal(lines.length, 2);
    const entries = (await state()).transcripts[id].entries;
    assert.deepEqual(entries.filter((e) => e.role === "user").map((e) => [e.text, e.status]), [["also say second", "applied"]]);
    assert.equal(entries.at(-1).kind, "ended");
    assert.equal(entries.some((e) => e.kind === "message" && e.role === "agent" && e.text === "do the thing"), false, "the prompt's replay is not shown as a message");
  });
});
