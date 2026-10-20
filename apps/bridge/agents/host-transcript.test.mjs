// den-v1 loop S2 (ADR 0016 amendment 10): the live transcript. Contract:
//
//   The host turns CellEvents into transcript entries and publishes each as a change frame
//       { seq, type: "transcript", agentId, entry }
//   entry = { id, at, kind: "message", role: "agent", text }
//         | { id, at, kind: "tool", name, summary, status: "running" | "done" | "failed", result? }
//         | { id, at, kind: "permission", name, status: "pending" | "allowed" | "denied" | "expired" }
//         | { id, at, kind: "ended", state }
//   `id` counts an agent's entries from 1. A frame whose id was already sent replaces that entry (a tool call gets its
//   result, a permission request its answer); it is never a second row.
//   The snapshot carries `transcripts: { [agentId]: { entries, dropped } }`: the last TRANSCRIPT_ENTRIES entries of at
//   most TRANSCRIPT_AGENTS agents, so a reloaded page can refill F.
//   Every string is agent output (decision 6.4, 6.8): secrets masked, control and bidi characters escaped, length
//   capped. A tool's input never reaches an entry; the approval route stays the only place it is served.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startBridge } from "../server.mjs";
import { makeStateFixture } from "../bridge-fixture.mjs";
import { CODE, login, authed, send } from "../bridge-auth-helpers.mjs";
import { makeBridge, openSse, until, DISPATCH_REF, FEATURE } from "./host-test-helpers.mjs";
import { LIVE_STATES, TRANSCRIPT_ENTRIES, TRANSCRIPT_AGENTS, TRANSCRIPT_TEXT_MAX, TRANSCRIPT_RESULT_MAX } from "./policy.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { makeStub, alive } from "./claude-stub.mjs";
import { appendTranscript, entryFromFrame, seedTranscripts } from "../../ui/src/state/transcript-buffer.mjs";
import { transcriptView } from "../../ui/src/overlay/transcript-view.mjs";
import { unconfinedLauncher } from "./launcher-test-helpers.mjs";

const AWS_KEY = ["AKIA", "IOSFODNN7", "EXAMPLE"].join(""); // built here so the root secret scan does not flag the file
const BIDI = String.fromCharCode(0x202e);
const BEL = String.fromCharCode(7);
const LIVE_FIXTURE = new URL("./fixtures/live.jsonl", import.meta.url);
const LIVE_TOOL_INPUTS = readFileSync(LIVE_FIXTURE, "utf8").split("\n").filter(Boolean)
  .map((line) => JSON.parse(line))
  .flatMap((line) => line.type === "assistant" ? line.message?.content ?? [] : [])
  .filter((block) => block.type === "tool_use" && block.name === "Write")
  .map((block) => block.input);

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup(options) {
  const t = await makeBridge(options);
  const sse = openSse(t.bridge);
  await sse.opened;
  cleanups.push(async () => {
    sse.close();
    await t.close();
  });
  const entriesOf = (id) => sse.frames.filter((f) => f.event === "change" && f.data.type === "transcript" && f.data.agentId === id).map((f) => f.data.entry);
  const waitFor = (id, pred, what) => until(() => entriesOf(id).find(pred), { what });
  const buffer = async (id) => (await t.state()).transcripts?.[id];
  return { ...t, sse, entriesOf, waitFor, buffer };
}
const strip = ({ at, source, invocationId, ...rest }) => {
  if (source) {
    assert.deepEqual({ project: source.project, runtime: source.runtime, role: source.role }, {
      project: "den", runtime: "claude", role: "architect",
    });
    assert.match(source.runId, /^c-/);
    assert.equal(source.entryId, rest.id);
  }
  if (invocationId) assert.match(invocationId, /^tu-[1-2]$/);
  return rest;
};

describe("the host publishes an agent's transcript", () => {
  test("text, a tool call with its result, the reply and the end arrive as frames, and the snapshot keeps them", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    rec.emit({ type: "text", text: "I will read the ADR.\nThen answer." });
    rec.emit({ type: "tool-start", id: "tu-1", name: "Read", summary: "docs/adr/0011.md" });
    await t.waitFor(agent.id, (e) => e.kind === "tool" && e.status === "running", "the running tool");
    rec.emit({ type: "tool-result", id: "tu-1", ok: true, text: "# ADR 0011\nline two" });
    rec.emit({ type: "tool-end", id: "tu-1" });
    rec.emit({ type: "reply", text: "The ADR says reads are open on loopback." });
    rec.emit({ type: "done", ok: true });
    await t.waitFor(agent.id, (e) => e.kind === "ended", "the ended entry");

    const frames = t.entriesOf(agent.id);
    assert.deepEqual(frames.filter((e) => e.kind === "tool").map((e) => e.invocationId), ["tu-1", "tu-1"]);
    assert.deepEqual(frames.map(strip), [
      { id: 1, kind: "message", role: "agent", text: "I will read the ADR.\nThen answer." },
      { id: 2, kind: "tool", name: "Read", summary: "docs/adr/0011.md", status: "running" },
      { id: 2, kind: "tool", name: "Read", summary: "docs/adr/0011.md", status: "done", result: "# ADR 0011\nline two" },
      { id: 3, kind: "message", role: "agent", text: "The ADR says reads are open on loopback." },
      { id: 4, kind: "ended", state: "done" },
    ]);
    for (const e of frames) assert.ok(!Number.isNaN(Date.parse(e.at)), "every entry is stamped");
    const seqs = t.sse.frames.filter((f) => f.event === "change").map((f) => f.data.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "transcript frames ride the one seq sequence");

    const kept = await t.buffer(agent.id);
    assert.equal(kept.dropped, 0);
    assert.deepEqual(kept.entries.map(strip), [frames[0], frames[2], frames[3], frames[4]].map(strip), "one entry per id, in its last state");
  });

  test("a reply that repeats the agent's last text is not a second row", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    rec.emit({ type: "text", text: "All done." });
    rec.emit({ type: "reply", text: "All done." });
    rec.emit({ type: "done", ok: true });
    await t.waitFor(agent.id, (e) => e.kind === "ended", "the ended entry");
    assert.deepEqual(t.entriesOf(agent.id).map((e) => e.kind), ["message", "ended"]);
  });

  test("a failed result marks its identified tool failed; an unidentified end closes no concurrent tool", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    rec.emit({ type: "tool-start", id: "tu-1", name: "Bash", summary: "npm test" });
    rec.emit({ type: "tool-start", id: "tu-2", name: "Grep", summary: "TODO" });
    rec.emit({ type: "tool-result", id: "tu-1", ok: false, text: "exit 1" });
    rec.emit({ type: "tool-end", id: "tu-1" });
    await t.waitFor(agent.id, (e) => e.id === 1 && e.status === "failed", "the identified first tool failed");
    rec.emit({ type: "tool-end" }); // a runtime that reports no result
    assert.equal((await t.buffer(agent.id)).entries.find((e) => e.id === 2).status, "running", "an unidentified end cannot claim the concurrent tool");
    rec.emit({ type: "tool-result", id: "tu-9", ok: true, text: "for no known call" });
    assert.equal((await t.buffer(agent.id)).entries.some((e) => e.id === 3), false, "an orphan result creates no row");
    rec.emit({ type: "tool-end", id: "tu-2" });
    await t.waitFor(agent.id, (e) => e.id === 2 && e.status === "ended", "the explicitly identified second tool ended without success");
    const kept = (await t.buffer(agent.id)).entries.map(strip);
    assert.deepEqual(kept, [
      { id: 1, kind: "tool", name: "Bash", summary: "npm test", status: "failed", result: "exit 1" },
      { id: 2, kind: "tool", name: "Grep", summary: "TODO", status: "ended" },
    ]);
  });

  test("an agent that is stopped ends the transcript with its state, and its running tool is not left running", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    t.fake.spawns[0].emit({ type: "tool-start", id: "tu-1", name: "Bash", summary: "sleep 999" });
    await t.waitFor(agent.id, (e) => e.kind === "tool", "the tool");
    await t.post(`/agents/${agent.id}/stop`);
    await t.waitFor(agent.id, (e) => e.kind === "ended", "the ended entry");
    assert.equal((await t.buffer(agent.id)).entries.find((e) => e.kind === "tool").invocationId, "tu-1");
    assert.deepEqual((await t.buffer(agent.id)).entries.map(strip), [
      { id: 1, kind: "tool", name: "Bash", summary: "sleep 999", status: "stopped" },
      { id: 2, kind: "stop", status: "requested" }, // organism-infra/230: the stop's own trail, closed by the ended entry
      { id: 3, kind: "ended", state: "terminated" },
    ]);
  });
});

describe("a permission request in the transcript", () => {
  test("it shows as pending, then with the answer, and the tool input is in no frame and no snapshot", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    rec.emit({ type: "permission-request", requestId: "r-1", tool: "Write", input: { file_path: "/tmp/x.txt", content: "INPUT-MARKER-1" } });
    rec.emit({ type: "permission-request", requestId: "r-2", tool: "Bash", input: { command: "echo INPUT-MARKER-2" } });
    await t.waitFor(agent.id, (e) => e.id === 2 && e.kind === "permission", "both requests");
    const [first, second] = (await t.state()).approvals;
    // organism-infra/230: each entry names its approval, and once answered says when (and carries the user's note, if any).
    assert.deepEqual(t.entriesOf(agent.id).map(strip), [
      { id: 1, kind: "permission", name: "Write", status: "pending", approvalId: first.id },
      { id: 2, kind: "permission", name: "Bash", status: "pending", approvalId: second.id },
    ]);
    await send(t.bridge, { path: `/approvals/${first.id}`, headers: t.headers });
    assert.equal((await t.post(`/approvals/${first.id}`, { decision: "allow" })).status, 200);
    assert.equal((await t.post(`/approvals/${second.id}`, { decision: "deny" })).status, 200);
    await t.waitFor(agent.id, (e) => e.id === 2 && e.status === "denied", "the denial");
    assert.deepEqual((await t.buffer(agent.id)).entries.map(({ answeredAt, ...e }) => strip(e)), [
      { id: 1, kind: "permission", name: "Write", status: "allowed", approvalId: first.id },
      { id: 2, kind: "permission", name: "Bash", status: "denied", approvalId: second.id },
    ]);
    const everything = JSON.stringify(t.sse.frames.filter((f) => f.data.type === "transcript")) + JSON.stringify((await t.state()).transcripts);
    assert.equal(everything.includes("INPUT-MARKER"), false);
    assert.equal(everything.includes('"input"'), false, "no entry has an input key");
  });

  test("a request still open when the agent ends shows as expired", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    t.fake.spawns[0].emit({ type: "permission-request", requestId: "r-1", tool: "Write", input: { file_path: "a" } });
    await t.waitFor(agent.id, (e) => e.kind === "permission", "the request");
    t.fake.spawns[0].exit({ code: 0 });
    await t.waitFor(agent.id, (e) => e.kind === "ended", "the ended entry");
    assert.equal((await t.buffer(agent.id)).entries[0].status, "expired");
  });
});

describe("transcript text is agent output: masked, escaped and capped (ADR 0016 6.4, 6.8)", () => {
  test("a secret is masked and a control or bidi character never arrives raw, in the frames and in /state", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    rec.emit({ type: "text", text: `key ${AWS_KEY} then ${BIDI}reversed${BEL}\nsecond line` });
    rec.emit({ type: "tool-start", id: "tu-1", name: "Bash", summary: "cat .env" });
    rec.emit({ type: "tool-result", id: "tu-1", ok: true, text: `AWS_ACCESS_KEY_ID=${AWS_KEY}\n${BIDI}tail` });
    rec.emit({ type: "reply", text: `the key is ${AWS_KEY}` });
    await t.waitFor(agent.id, (e) => e.id === 3, "the reply");
    const state = (await send(t.bridge, { path: "/state" })).text;
    for (const [where, text] of [["/state", state], ["sse", JSON.stringify(t.sse.frames)]]) {
      assert.ok(!text.includes(AWS_KEY), `${where} leaks the secret`);
      assert.ok(!text.includes(BIDI), `${where} carries a raw bidi character`);
      assert.ok(!text.includes(BEL), `${where} carries a raw control character`);
    }
    const [message] = t.entriesOf(agent.id);
    assert.ok(message.text.includes("\nsecond line"), "a newline is kept, so text reads as written");
    assert.ok(message.text.includes("\\u202e"), "a bidi mark is shown as its escape");
  });

  test("long text and long results are clipped and say so; a non-string or empty text is no entry", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    for (const text of [7, null, "", "   ", { a: 1 }]) rec.emit({ type: "text", text });
    rec.emit({ type: "reply", text: 7 });
    rec.emit({ type: "text", text: "m".repeat(TRANSCRIPT_TEXT_MAX + 50), more: 25 });
    rec.emit({ type: "tool-start", id: "tu-1", name: "Read", summary: "big.txt" });
    rec.emit({ type: "tool-result", id: "tu-1", ok: true, text: "r".repeat(TRANSCRIPT_RESULT_MAX + 10) });
    await t.waitFor(agent.id, (e) => e.id === 2 && e.status === "done", "the clipped result");
    const [message, tool] = (await t.buffer(agent.id)).entries;
    assert.equal(message.id, 1, "the unusable text events made no entry");
    assert.equal(message.text, `${"m".repeat(TRANSCRIPT_TEXT_MAX)}\n[clipped: 75 more characters]`);
    assert.equal(tool.result, `${"r".repeat(TRANSCRIPT_RESULT_MAX)}\n[clipped: 10 more characters]`);
  });
});

describe("the transcript buffer is small", () => {
  test("only the last TRANSCRIPT_ENTRIES entries of an agent are kept, and the count of dropped ones is told", async () => {
    const t = await setup();
    const { agent } = (await t.dispatch("architect")).body;
    const total = TRANSCRIPT_ENTRIES + 7;
    for (let i = 1; i <= total; i += 1) t.fake.spawns[0].emit({ type: "text", text: `line ${i}` });
    await t.waitFor(agent.id, (e) => e.id === total, "the last line");
    const kept = await t.buffer(agent.id);
    assert.equal(kept.dropped, 7);
    assert.equal(kept.entries.length, TRANSCRIPT_ENTRIES);
    assert.deepEqual([kept.entries[0].id, kept.entries.at(-1).id], [8, total]);
  });

  test("buffers are kept for the TRANSCRIPT_AGENTS most recent agents; a live agent's is never dropped", async () => {
    const t = await setup({ policy: { maxConcurrent: 2 } });
    const ids = [];
    const first = (await t.bridge.host.start({ ref: `${FEATURE}/30-long`, role: "architect" })).agent;
    t.fake.spawns[0].emit({ type: "text", text: "still here" });
    for (let i = 0; i < TRANSCRIPT_AGENTS + 1; i += 1) {
      const { agent } = await t.bridge.host.start({ ref: `${FEATURE}/${40 + i}-short`, role: "architect" });
      ids.push(agent.id);
      const rec = t.fake.spawns.at(-1);
      rec.emit({ type: "text", text: `short ${i}` });
      rec.exit({ code: 0 });
      await t.waitFor(agent.id, (e) => e.kind === "ended", `agent ${i} to end`);
    }
    const kept = Object.keys((await t.state()).transcripts);
    assert.equal(kept.length, TRANSCRIPT_AGENTS);
    assert.ok(kept.includes(first.id), "the live agent keeps its buffer");
    assert.deepEqual(kept.filter((id) => id !== first.id), ids.slice(-(TRANSCRIPT_AGENTS - 1)), "the oldest ended agents went first");
  });

  test("a bridge with no agents has an empty transcripts object in its snapshot", async () => {
    const t = await setup();
    assert.deepEqual((await t.state()).transcripts, {});
  });
});

// The slice's done-when: the recorded live run (fixtures/live.jsonl, S3), replayed by the stub as the claude binary
// through the real runtime, fills the F panel with text, tools and the reply.
describe("replaying the recorded live run through the stub fills the transcript panel", () => {
  async function boot() {
    const stub = await makeStub({ mode: "replay", replayFile: LIVE_FIXTURE.pathname });
    const fx = await makeStateFixture({ git: true });
    const runtime = createClaudeRuntime({ launcher: unconfinedLauncher(), env: { PATH: process.env.PATH, HOME: process.env.HOME, DEN_CLAUDE_BIN: stub.bin } });
    const bridge = await startBridge({ root: fx.root, port: 0, auth: { launchCode: CODE }, runtime, policy: { killGraceMs: 150 } });
    const headers = authed(bridge, await login(bridge));
    const sse = openSse(bridge);
    await sse.opened;
    cleanups.push(async () => {
      sse.close();
      const pid = (await stub.start())?.pid;
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      await bridge.close();
      await fx.cleanup();
    });
    const state = async () => (await send(bridge, { path: "/state" })).body;
    return { stub, bridge, headers, sse, state, post: (p, body) => send(bridge, { method: "POST", path: p, body, headers }) };
  }
  // What the panel shows for a buffer, every tool row opened.
  const rowsOf = (buffer) => transcriptView(buffer, { expanded: buffer.entries.map((e) => e.n) }).rows;

  test("F shows both writes with their results, both answered requests, the agent's reply and the end", { timeout: 30000 }, async () => {
    const t = await boot();
    const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
    assert.equal(res.status, 201, res.text);
    const id = res.body.agent.id;
    const answered = new Set();
    await until(async () => {
      const s = await t.state();
      for (const a of s.approvals.filter((x) => x.agentId === id && x.state === "pending" && !answered.has(x.id))) {
        answered.add(a.id);
        await send(t.bridge, { path: `/approvals/${a.id}`, headers: t.headers });
        await t.post(`/approvals/${a.id}`, { decision: "allow" });
      }
      return !LIVE_STATES.includes(s.agents.find((x) => x.id === id).state);
    }, { ms: 20000, every: 25, what: "the replayed run to end" });
    assert.equal(answered.size, 2, "the fixture raises two permission requests");
    await until(() => t.sse.frames.some((f) => f.data.type === "transcript" && f.data.entry.kind === "ended"), { what: "the ended frame" });

    // A page that was open for the whole run: every frame through the UI's own buffer.
    let buffers = {};
    for (const f of t.sse.frames.filter((x) => x.event === "change")) {
      const line = entryFromFrame(f.data);
      if (line) buffers = appendTranscript(buffers, line.agentId, line.entry);
    }
    const rows = rowsOf(buffers[id]);
    assert.deepEqual(rows.map((r) => r.kind), ["tool", "permission", "tool", "permission", "message", "ended"]);
    const [w1, p1, w2, p2, message, ended] = rows;
    for (const w of [w1, w2]) {
      assert.deepEqual({ name: w.name, status: w.status }, { name: "Write", status: "done" });
      assert.match(w.result.text, /^File created successfully at: /);
      assert.deepEqual(JSON.parse(w.inputText), LIVE_TOOL_INPUTS[w === w1 ? 0 : 1]);
    }
    assert.match(w1.summary, /inside\.txt$/);
    assert.match(w2.summary, /live-check\.txt$/);
    for (const p of [p1, p2]) assert.deepEqual({ name: p.name, label: p.label }, { name: "Write", label: "Allowed by you" });
    assert.equal(message.speaker, "Agent");
    assert.match(message.text, /^LIVE-CHECK-OK\./);
    assert.equal(ended.label, "Agent ended: done");
    assert.equal(rows.some((r) => r.kind === "unreadable"), false);

    // A page loaded after the run: the snapshot alone refills the panel with the same rows.
    const reloaded = seedTranscripts({}, (await t.state()).transcripts);
    assert.deepEqual(rowsOf(reloaded[id]), rows);
    assert.ok(readFileSync(LIVE_FIXTURE, "utf8").includes("LIVE-CHECK-OK"), "the reply text comes from the recorded run");
  });
});
