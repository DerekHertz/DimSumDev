import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCodexProtocol, openCodexAppServer, MAX_FRAME_BYTES } from "./codex-adapter.mjs";

const STUB = fileURLToPath(new URL("./codex-stub.mjs", import.meta.url));
const MODEL = "gpt-6.1-sol";
const PROFILE = "fixture-bounded";
const models = (model = MODEL) => ({ data: [{ id: model, model, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null });
const threadAck = (over = {}) => ({ thread: { id: "thread-1" }, model: MODEL, cwd: "/fixture", activePermissionProfile: { id: PROFILE }, ...over });

function fixture({ authorizeExecution = async () => ({ profileId: PROFILE, cwd: "/fixture", config: {} }), handler, limits } = {}) {
  const sent = [];
  let closed = 0;
  const protocol = createCodexProtocol({
    authorizeExecution, limits,
    write(line) {
      const message = JSON.parse(line);
      sent.push(message);
      if (!message.method || message.id === undefined) return;
      queueMicrotask(() => {
        if (handler) return handler(message, respond, protocol);
        const results = {
          initialize: { userAgent: "codex-fixture/0.163.0" },
          "model/list": models(),
          "thread/start": threadAck(),
          "thread/resume": threadAck({ thread: { id: message.params.threadId } }),
          "turn/start": { turn: { id: "turn-1", status: "inProgress" } },
          "turn/interrupt": {},
        };
        respond(message.id, results[message.method]);
      });
    },
    close() { closed += 1; },
  });
  const frame = (message) => protocol.feed(Buffer.from(JSON.stringify(message) + "\n"));
  const respond = (id, result) => frame({ id, result });
  const notify = (method, params) => frame({ method, params });
  const request = (id, method, params) => frame({ id, method, params });
  return { protocol, sent, respond, notify, request, get closed() { return closed; } };
}

const baseHandler = (message, respond) => {
  if (message.method === "initialize") return respond(message.id, { userAgent: "fixture" });
  if (message.method === "model/list") return respond(message.id, models());
  if (message.method === "thread/start") return respond(message.id, threadAck());
};

async function started(fx) {
  await fx.protocol.initialize();
  await fx.protocol.prepareThread({ model: MODEL, effort: "high" });
  await fx.protocol.startTurn("Inspect one file.");
}

async function drain(protocol) {
  protocol.close();
  const received = [];
  for await (const event of protocol.events) received.push(event);
  return received;
}

test("execution is denied without a protected integration", async () => {
  const fx = fixture({ authorizeExecution: null });
  await fx.protocol.initialize();
  await assert.rejects(fx.protocol.prepareThread({ model: MODEL, effort: "high" }), /protected execution integration/);
  assert.ok(!fx.sent.some((m) => m.method === "thread/start" || m.method === "turn/start"));
  fx.protocol.close();
});

test("initialize is acknowledged before initialized, and shared calls reuse the handshake", async () => {
  const fx = fixture();
  await Promise.all([fx.protocol.initialize(), fx.protocol.initialize()]);
  assert.deepEqual(fx.sent.map((m) => m.method), ["initialize", "initialized"]);
  fx.protocol.close();
});

test("model discovery follows pagination and never substitutes model or effort", async () => {
  const fx = fixture({ handler(message, respond) {
    if (message.method === "initialize") return respond(message.id, { userAgent: "fixture" });
    respond(message.id, message.params.cursor ? models("gpt-6-luna") : { ...models(), nextCursor: "next-page" });
  } });
  assert.equal(await fx.protocol.supportsModel({ model: "gpt-6-luna", effort: "high" }), true);
  assert.equal(await fx.protocol.supportsModel({ model: MODEL, effort: "ultra" }), false);
  assert.equal(await fx.protocol.supportsModel({ model: "not-available", effort: "high" }), false);
  assert.deepEqual(fx.sent.filter((m) => m.method === "model/list").map((m) => m.params.cursor ?? null), [null, "next-page"]);
  fx.protocol.close();
});

test("an unavailable model stops the thread before any native thread starts", async () => {
  const fx = fixture();
  await assert.rejects(fx.protocol.prepareThread({ model: "gpt-9", effort: "high" }), /unavailable; no fallback/);
  assert.ok(!fx.sent.some((m) => m.method === "thread/start"));
  fx.protocol.close();
});

test("repeated pagination cursors fail closed", async () => {
  const fx = fixture({ handler(message, respond) {
    respond(message.id, message.method === "initialize" ? { userAgent: "fixture" } : { ...models(), nextCursor: "loop" });
  } });
  await assert.rejects(fx.protocol.supportsModel({ model: MODEL, effort: "high" }), /model discovery/);
  assert.equal(fx.closed, 1);
});

test("thread acknowledgements must match thread, model and profile before any turn", async () => {
  for (const [name, ack] of [
    ["thread", threadAck({ thread: { id: "thread-replacement" } })],
    ["model", threadAck({ thread: { id: "thread-original" }, model: "gpt-6-luna" })],
    ["profile", threadAck({ thread: { id: "thread-original" }, activePermissionProfile: { id: "other" } })],
    ["numeric", threadAck({ thread: { id: 9 } })],
  ]) {
    const fx = fixture({ handler(message, respond) { (baseHandler(message, respond), message.method === "thread/resume" && respond(message.id, ack)); } });
    await assert.rejects(fx.protocol.prepareThread({ model: MODEL, effort: "high", resumeThreadId: "thread-original" }), /thread acknowledgement|invalid recorded/, name);
    assert.ok(!fx.sent.some((m) => m.method === "turn/start"));
    assert.equal(fx.closed, 1, name);
  }
});

test("server request IDs cannot spoof a pending client response", async () => {
  const fx = fixture({ handler() {} });
  const initializing = fx.protocol.initialize();
  const pendingId = fx.sent[0].id;
  fx.request(pendingId, "account/chatgptAuthTokens/refresh", {});
  assert.equal(fx.sent.at(-1).error.code, -32601);
  fx.respond(pendingId, { userAgent: "fixture" });
  await initializing;
  fx.protocol.close();
});

test("malformed, oversized, unsolicited and ambiguous responses close and reject pending calls", async () => {
  for (const frame of ["{bad}\n", "x".repeat(MAX_FRAME_BYTES + 1), '{"id":"spoof","result":{}}\n', '{"id":"client-1","result":{},"error":{}}\n']) {
    const fx = fixture({ handler() {} });
    const initializing = fx.protocol.initialize();
    fx.protocol.feed(Buffer.from(frame));
    await assert.rejects(initializing, /protocol/);
    assert.equal(fx.closed, 1);
  }
});

test("native RPC failures do not expose raw account or credential diagnostics", async () => {
  const fx = fixture({ handler() {} });
  const initializing = fx.protocol.initialize();
  fx.protocol.feed(Buffer.from(JSON.stringify({ id: fx.sent[0].id, error: { code: 401, message: "secret-native-diagnostic" } }) + "\n"));
  await assert.rejects(initializing, (err) => !err.message.includes("secret-native-diagnostic") && /RPC failed/.test(err.message));
  fx.protocol.close();
});

test("a request timeout or a partial frame at transport end settles pending calls once", async () => {
  const timed = fixture({ handler() {}, limits: { requestTimeoutMs: 20 } });
  await assert.rejects(timed.protocol.initialize(), /timed out/);
  timed.protocol.close();
  assert.equal(timed.closed, 1);
  const partial = fixture({ handler() {} });
  const pending = partial.protocol.initialize();
  partial.protocol.feed(Buffer.from('{"id":'));
  partial.protocol.end();
  await assert.rejects(pending, /protocol/);
  assert.equal(partial.closed, 1);
});

test("all native approvals are declined, including session rules, grants and stale turns", async () => {
  const fx = fixture();
  await started(fx);
  for (const [id, method, extra] of [
    [1, "item/commandExecution/requestApproval", { availableDecisions: ["acceptForSession"], proposedExecpolicyAmendment: ["sh"] }],
    [2, "item/fileChange/requestApproval", { grantRoot: "/" }],
    [3, "item/permissions/requestApproval", { permissions: { fileSystem: { write: ["/"] } } }],
    [4, "execCommandApproval", {}],
    [5, "item/commandExecution/requestApproval", { turnId: "stale" }],
  ]) {
    fx.request(id, method, { threadId: "thread-1", turnId: "turn-1", ...extra });
    assert.ok(fx.sent.at(-1).result?.decision === "decline" || fx.sent.at(-1).error);
    assert.ok(!JSON.stringify(fx.sent.at(-1)).includes("accept"));
  }
  assert.equal(fx.closed, 0);
  fx.protocol.close();
});

test("question replies are bound to the active turn and exact question IDs, then single use", async () => {
  const fx = fixture();
  await started(fx);
  fx.request("q-1", "item/tool/requestUserInput", { threadId: "thread-1", turnId: "turn-1", itemId: "question-1", isBlocking: true,
    questions: [{ id: "choice", header: "Choice", question: "Which file?", isSecret: false }] });
  await assert.rejects(fx.protocol.answerQuestion("q-1", { wrong: { answers: ["a"] } }), /question answers/);
  await fx.protocol.answerQuestion("q-1", { choice: { answers: ["a.mjs"] } });
  assert.deepEqual(fx.sent.at(-1).result, { answers: { choice: { answers: ["a.mjs"] } } });
  await assert.rejects(fx.protocol.answerQuestion("q-1", { choice: { answers: ["again"] } }), /no pending question/);
  fx.protocol.close();
});

test("secret questions, secret-pattern text and foreign turns never reach the host", async () => {
  const fx = fixture();
  await started(fx);
  const synthetic = "ghp_" + "a".repeat(36);
  const ask = (id, over, params = {}) => fx.request(id, "item/tool/requestUserInput", { threadId: "thread-1", turnId: "turn-1", itemId: id, isBlocking: true,
    questions: [{ id: "key", header: "Key", question: "Which file?", isSecret: false, ...over }], ...params });
  ask("secret", { isSecret: true });
  ask("pattern", { question: synthetic });
  ask("foreign", {}, { threadId: "foreign" });
  for (const answered of fx.sent.slice(-3)) {
    assert.ok(answered.error);
    assert.ok(!JSON.stringify(answered).includes(synthetic));
  }
  assert.ok(!(await drain(fx.protocol)).some((event) => event.type === "permission-request"));
});

test("interrupt cancels held questions and stale answers cannot reopen the turn", async () => {
  const fx = fixture();
  await started(fx);
  fx.request("q", "item/tool/requestUserInput", { threadId: "thread-1", turnId: "turn-1", itemId: "q", isBlocking: true,
    questions: [{ id: "choice", header: "Choice", question: "Which file?" }] });
  await fx.protocol.interrupt();
  await assert.rejects(fx.protocol.answerQuestion("q", { choice: { answers: ["late"] } }), /no pending question/);
  fx.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } });
  assert.equal(fx.protocol.state().turnId, null);
  fx.protocol.close();
});

test("notifications that precede the turn acknowledgement wait for it", async () => {
  const fx = fixture({ handler(message, respond, protocol) {
    if (message.method !== "turn/start") return baseHandler(message, respond);
    protocol.feed(Buffer.from(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } }) + "\n"));
    respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
  } });
  await started(fx);
  assert.equal(fx.protocol.state().turnId, null);
  assert.ok((await drain(fx.protocol)).some((e) => e.type === "done" && e.ok));
});

test("a foreign thread notification before the acknowledgement fails the transport", async () => {
  const fx = fixture({ handler(message, respond, protocol) {
    if (message.method !== "turn/start") return baseHandler(message, respond);
    protocol.feed(Buffer.from(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "foreign", turnId: "turn-1", itemId: "i", delta: "spoof" } }) + "\n"));
    respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
  } });
  await assert.rejects(started(fx), /foreign thread/);
  assert.equal(fx.closed, 1);
});

test("a reused completed turn ID cannot admit old output as a new turn", async () => {
  const fx = fixture();
  await started(fx);
  fx.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
  await assert.rejects(fx.protocol.startTurn("Fresh work"), /reused turn identity/);
  assert.equal(fx.closed, 1);
});

test("only identical terminal duplicates are ignored", async () => {
  const fx = fixture();
  await started(fx);
  const terminal = { id: "turn-1", status: "failed", error: { message: "fixture failure", codexErrorInfo: "other" } };
  fx.notify("turn/completed", { threadId: "thread-1", turn: terminal });
  fx.notify("turn/completed", { threadId: "thread-1", turn: { ...terminal, error: { codexErrorInfo: "other", message: "fixture failure" } } });
  assert.equal(fx.closed, 0);
  fx.notify("turn/completed", { threadId: "thread-1", turn: { ...terminal, status: "completed" } });
  assert.equal(fx.closed, 1);
  assert.deepEqual((await drain(fx.protocol)).filter((event) => event.type === "done"), [{ type: "done", ok: false }]);
});

test("UTF-8 frames split across chunks keep their text", async () => {
  const fx = fixture();
  await started(fx);
  const frame = Buffer.from(JSON.stringify({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "item-1", type: "agentMessage", text: "餃" } } }) + "\n");
  const split = frame.indexOf(Buffer.from("餃")) + 1;
  fx.protocol.feed(frame.subarray(0, split));
  fx.protocol.feed(frame.subarray(split));
  assert.ok((await drain(fx.protocol)).some((event) => event.type === "reply" && event.text === "餃"));
});

test("duplicate server request IDs and a full event queue close the transport", async () => {
  const duplicates = fixture();
  await duplicates.protocol.initialize();
  duplicates.request(7, "unsupported", {});
  duplicates.request(7, "unsupported", {});
  assert.equal(duplicates.closed, 1);
  const fx = fixture({ limits: { events: 2 } });
  await started(fx);
  for (const id of ["a", "b"]) fx.notify("item/started", { threadId: "thread-1", turnId: "turn-1", item: { id, type: "commandExecution", command: "true" } });
  assert.equal(fx.closed, 1);
});

test("command and completion events translate to host events; native child delegation closes", async () => {
  const fx = fixture();
  await started(fx);
  fx.notify("item/started", { threadId: "thread-1", turnId: "turn-1", item: { id: "tool-1", type: "commandExecution", command: "node --check file.mjs" } });
  fx.notify("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { id: "tool-1", type: "commandExecution", status: "completed", aggregatedOutput: "checked" } });
  fx.notify("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { id: "reply-1", type: "agentMessage", text: "The file passed." } });
  fx.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
  const received = await drain(fx.protocol);
  assert.deepEqual(received.map((event) => event.type), ["model", "tool-start", "tool-result", "tool-end", "reply", "done"]);
  assert.deepEqual(received.find((event) => event.type === "tool-result"), { type: "tool-result", id: "tool-1", ok: true, text: "checked" });
  const child = fixture();
  await started(child);
  child.notify("item/started", { threadId: "thread-1", turnId: "turn-1", item: { id: "child-1", type: "collabAgentToolCall" } });
  assert.equal(child.closed, 1);
});

test("config from the execution seam cannot widen the sandbox: only display keys pass, anything else refuses the thread", async () => {
  for (const config of [{ sandbox_mode: "danger-full-access" }, { approval_policy: "never" }, { default_permissions: ":danger-no-sandbox" },
    { sandbox_workspace_write: { writable_roots: ["/"] } }, { permissions: { x: { filesystem: { "/": "write" } } } }, { model_verbosity: "low", sandbox_mode: "danger-full-access" }, { model_verbosity: { nested: 1 } }]) {
    const fx = fixture({ authorizeExecution: async () => ({ profileId: PROFILE, cwd: "/fixture", config }) });
    await fx.protocol.initialize();
    await assert.rejects(fx.protocol.prepareThread({ model: MODEL, effort: "high" }), /refused the policy/, JSON.stringify(config));
    assert.ok(!fx.sent.some((m) => m.method === "thread/start"), JSON.stringify(config));
    fx.protocol.close();
  }
  const fx = fixture({ authorizeExecution: async () => ({ profileId: PROFILE, cwd: "/fixture", config: { model_verbosity: "low" } }) });
  await fx.protocol.initialize();
  await fx.protocol.prepareThread({ model: MODEL, effort: "high" });
  const start = fx.sent.find((m) => m.method === "thread/start").params;
  assert.deepEqual(start.config, { model_verbosity: "low" });
  assert.equal(start.cwd, "/fixture");
  assert.equal(start.permissions, PROFILE);
  assert.equal(start.approvalPolicy, "never");
  fx.protocol.close();
});

test("a secret split across streamed text deltas never reaches an event: deltas are not emitted, only the masked completed reply", async () => {
  const KEY = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
  const fx = fixture();
  await started(fx);
  for (const delta of [KEY.slice(0, 9), KEY.slice(9, 20), KEY.slice(20)]) fx.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta });
  fx.notify("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { id: "msg-1", type: "agentMessage", text: KEY } });
  fx.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
  const received = await drain(fx.protocol);
  assert.ok(!received.some((e) => e.type === "text"), JSON.stringify(received));
  assert.ok(!JSON.stringify(received).includes(KEY.slice(4, 14)), JSON.stringify(received));
  assert.equal(received.find((e) => e.type === "reply").text, "[masked: possible secret]");
});

test("a malformed text delta still closes the protocol", async () => {
  const fx = fixture();
  await started(fx);
  fx.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: 5 });
  assert.equal(fx.closed, 1);
});

test("agent replies, commands and command output are masked before they become events", async () => {
  const KEY = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
  const fx = fixture();
  await started(fx);
  fx.notify("item/started", { threadId: "thread-1", turnId: "turn-1", item: { id: "tool-1", type: "commandExecution", command: `curl -H "Authorization: Bearer ${KEY}0000" https://x` } });
  fx.notify("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { id: "tool-1", type: "commandExecution", status: "completed", aggregatedOutput: `GITHUB_TOKEN=${KEY}\nrest` } });
  fx.notify("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { id: "reply-1", type: "agentMessage", text: `found ${KEY}` } });
  fx.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
  const received = await drain(fx.protocol);
  const shown = JSON.stringify(received);
  assert.ok(!shown.includes(KEY.slice(4)), shown);
  assert.match(received.find((e) => e.type === "tool-start").summary, /\[masked: possible secret\]/);
  assert.match(received.find((e) => e.type === "tool-result").text, /^\[masked: possible secret\]\nrest$/);
  assert.equal(received.find((e) => e.type === "reply").text, "found [masked: possible secret]");
});

const launched = [];
afterEach(() => { for (const child of launched.splice(0)) child.kill("SIGKILL"); });
const launch = (mode, over = {}) => {
  const child = spawn(process.execPath, [STUB, mode], { stdio: ["pipe", "pipe", "ignore"] });
  launched.push(child);
  const protocol = openCodexAppServer({ child, authorizeExecution: async () => ({ profileId: "den-codex", cwd: process.cwd() }), ...over });
  return { child, protocol };
};

test("a shell command's output comes back through a real app-server process", async () => {
  const { child, protocol } = launch("ok");
  await protocol.prepareThread({ model: "gpt-stub-1", effort: "high" });
  await protocol.startTurn("echo hello-from-shell-$((20+22))");
  const received = [];
  for await (const event of protocol.events) {
    received.push(event);
    if (event.type === "done") break;
  }
  const start = received.find((e) => e.type === "tool-start");
  const result = received.find((e) => e.type === "tool-result");
  assert.match(start.summary, /^echo hello-from-shell/);
  assert.equal(result.ok, true);
  assert.equal(result.text, "hello-from-shell-42\n");
  assert.deepEqual(received.map((e) => e.type), ["model", "tool-start", "tool-result", "tool-end", "reply", "done"]);
  assert.equal(received.at(-1).ok, true);
  protocol.close();
  await new Promise((resolve) => child.once("close", resolve));
});

test("a failing shell command reports ok false with its output", async () => {
  const { child, protocol } = launch("ok");
  await protocol.prepareThread({ model: "gpt-stub-1", effort: "high" });
  await protocol.startTurn("echo nope >&2; exit 4");
  const received = [];
  for await (const event of protocol.events) {
    received.push(event);
    if (event.type === "done") break;
  }
  const result = received.find((e) => e.type === "tool-result");
  assert.equal(result.ok, false);
  assert.equal(result.text, "nope\n");
  protocol.close();
  await new Promise((resolve) => child.once("close", resolve));
});

test("an app-server that exits mid-turn ends the event stream and rejects further work", async () => {
  const { child, protocol } = launch("crash");
  await protocol.prepareThread({ model: "gpt-stub-1", effort: "high" });
  await protocol.startTurn("echo never-runs");
  const received = [];
  for await (const event of protocol.events) received.push(event);
  assert.deepEqual(received.map((e) => e.type), ["model"]);
  assert.equal(protocol.state().closed, true);
  await assert.rejects(protocol.interrupt(), /protocol/);
  await new Promise((resolve) => child.once("close", resolve));
});

test("close ends a child that ignores SIGTERM", async () => {
  const { child, protocol } = launch("ok", { killGraceMs: 100 });
  const deaf = launch("deaf", { killGraceMs: 100 });
  await deaf.protocol.prepareThread({ model: "gpt-stub-1", effort: "high" });
  deaf.protocol.close();
  const [, signal] = await new Promise((resolve) => deaf.child.once("close", (...args) => resolve(args)));
  assert.equal(signal, "SIGKILL");
  protocol.close();
  await new Promise((resolve) => child.once("close", resolve));
});

test("a failed interrupt does not leave questions unanswerable", async () => {
  const fx = fixture({ handler(message, respond, protocol) {
    if (message.method === "turn/interrupt") return protocol.feed(Buffer.from(JSON.stringify({ id: message.id, error: { code: -1, message: "no" } }) + "\n"));
    if (message.method === "turn/start") return respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
    return baseHandler(message, respond);
  } });
  await started(fx);
  await assert.rejects(fx.protocol.interrupt(), /RPC failed/);
  fx.request("q", "item/tool/requestUserInput", { threadId: "thread-1", turnId: "turn-1", itemId: "q", isBlocking: true,
    questions: [{ id: "choice", header: "Choice", question: "Which file?" }] });
  await fx.protocol.answerQuestion("q-1", { choice: { answers: ["a.txt"] } });
  fx.protocol.close();
});
