// den-mvp/37: an agent's question to the user. AskUserQuestion reaches the bridge as a can_use_tool ask; the approval
// carries the questions whole, waits far longer than a tool ask, and an allow sends the user's picks back as
// `answers` in updatedInput, keyed by each question's text (the shape claude 2.1.293 reads, checked live on
// 2026-10-15; fixtures/live-question.jsonl holds that run's request and result lines).
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startBridge } from "../server.mjs";
import { makeStateFixture } from "../bridge-fixture.mjs";
import { CODE, login, authed, send } from "../bridge-auth-helpers.mjs";
import { until, DISPATCH_REF } from "./host-test-helpers.mjs";
import { APPROVAL_TTL_MS } from "./policy.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { makeStub, alive } from "./claude-stub.mjs";
import { createApprovalStore, questionsOf } from "./approvals.mjs";
import { unconfinedLauncher } from "./launcher-test-helpers.mjs";

const FIXTURE = new URL("./fixtures/live-question.jsonl", import.meta.url);
const QUESTION = "Which colour do you prefer?";
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function questionRun() {
  const stub = await makeStub({ mode: "replay", replayFile: FIXTURE.pathname });
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
  const res = await post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.equal(res.status, 201, res.text);
  const approval = await until(async () => (await send(bridge, { path: "/state" })).body.approvals.find((a) => a.state === "pending"), { what: "the question's approval" });
  return { stub, post, approval };
}

describe("an agent's question in the den", () => {
  test("the approval shows the questions and waits longer than a tool ask", { timeout: 30000 }, async () => {
    const { approval } = await questionRun();
    assert.equal(approval.tool, "AskUserQuestion");
    assert.deepEqual(approval.questions, [{
      question: QUESTION, header: "Colour", multiSelect: false,
      options: [{ label: "Red", description: "Pick red" }, { label: "Blue", description: "Pick blue" }],
    }]);
    assert.ok(Date.parse(approval.expiresAt) - Date.parse(approval.ts) > APPROVAL_TTL_MS, "a question expires like a tool ask");
  });

  test("the user's pick goes back as answers keyed by the question, with no read first", { timeout: 30000 }, async () => {
    const { stub, post, approval } = await questionRun();
    const bare = await post(`/approvals/${approval.id}`, { decision: "allow" });
    assert.equal(bare.status, 400, "an allow with no answer and no note is refused");
    const res = await post(`/approvals/${approval.id}`, { decision: "allow", answers: ["Blue"] });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.approval.note, "Blue", "the transcript shows what was picked");
    const reply = await until(async () => (await stub.stdinLines()).find((l) => l.type === "control_response"), { what: "the answer on stdin" });
    assert.equal(reply.response.response.behavior, "allow");
    assert.deepEqual(reply.response.response.updatedInput.answers, { [QUESTION]: "Blue" });
    assert.deepEqual(reply.response.response.updatedInput.questions, approval.questions.map(({ question, header, options, multiSelect }) => ({ question, header, options, multiSelect })));
  });

  test("a note on Allow answers the question (the 2026-10-15 case that reached Bao as no answer)", { timeout: 30000 }, async () => {
    const { stub, post, approval } = await questionRun();
    const res = await post(`/approvals/${approval.id}`, { decision: "allow", note: "transcript formatting first please" });
    assert.equal(res.status, 200, res.text);
    const reply = await until(async () => (await stub.stdinLines()).find((l) => l.type === "control_response"), { what: "the answer on stdin" });
    assert.deepEqual(reply.response.response.updatedInput.answers, { [QUESTION]: "transcript formatting first please" });
  });
});

describe("the approval store's question rules", () => {
  const input = { questions: [
    { question: "Which?", header: "One", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
    { question: "Which ones?", header: "Many", options: [{ label: "X" }, { label: "Y" }], multiSelect: true },
  ] };
  const store = () => {
    const sent = [];
    const s = createApprovalStore({
      canAnswer: () => true, isLive: () => true, audit: async () => {}, onChange: () => {},
      answer: async (agentId, requestId, verdict) => void sent.push(verdict),
    });
    s.hold("c-1", { requestId: "r-1", tool: "AskUserQuestion", input });
    return { s, sent, id: s.list()[0].id };
  };

  test("a multiSelect answer joins its labels; the note names each question by its header", async () => {
    const { s, sent, id } = store();
    const res = await s.decide(id, { decision: "allow", answers: ["A", ["X", "Y"]] });
    assert.equal(res.status, 200, res.error);
    assert.deepEqual(sent[0].answers, ["A", "X, Y"]);
    assert.equal(res.approval.note, "One: A · Many: X, Y");
  });

  test("answers of the wrong count, an empty answer, and answers on a deny are refused", async () => {
    const { s, id } = store();
    assert.equal((await s.decide(id, { decision: "allow", answers: ["A"] })).status, 400);
    assert.equal((await s.decide(id, { decision: "allow", answers: ["A", ""] })).status, 400);
    assert.equal((await s.decide(id, { decision: "deny", answers: ["A", "X"] })).status, 400);
    const deny = await s.decide(id, { decision: "deny", note: "not now" });
    assert.equal(deny.status, 200);
  });

  test("a tool ask is unchanged: answers are refused and an allow still needs the read", async () => {
    const sent = [];
    const s = createApprovalStore({ canAnswer: () => true, isLive: () => true, audit: async () => {}, onChange: () => {}, answer: async (a, r, v) => void sent.push(v) });
    s.hold("c-1", { requestId: "r-1", tool: "Bash", input: { command: "ls" } });
    const id = s.list()[0].id;
    assert.equal(s.list()[0].questions, undefined);
    assert.equal((await s.decide(id, { decision: "allow", answers: ["x"] })).status, 400);
    assert.equal((await s.decide(id, { decision: "allow" })).status, 409);
  });

  test("a malformed question input is shown as an ordinary ask", () => {
    assert.equal(questionsOf("AskUserQuestion", { questions: [] }), null);
    assert.equal(questionsOf("AskUserQuestion", { questions: [{ question: "Q", options: [] }] }), null);
    assert.equal(questionsOf("Bash", input), null);
  });
});
