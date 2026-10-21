import { test } from "node:test";
import assert from "node:assert/strict";
import { CODEX_PRODUCTION_ENABLED, createCodexProtocol, MAX_FRAME_BYTES } from "./codex-adapter.mjs";

const MODEL = "gpt-6.1-sol";
const PROFILE = "fixture-bounded";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const models = (model = MODEL) => ({ data: [{ id: model, model, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null });

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
          "thread/start": { thread: { id: "thread-1" }, model: MODEL, cwd: "/fixture", activePermissionProfile: { id: PROFILE } },
          "thread/resume": { thread: { id: message.params.threadId }, model: MODEL, cwd: "/fixture", activePermissionProfile: { id: PROFILE } },
          "turn/start": { turn: { id: "turn-1", status: "inProgress" } },
          "turn/steer": { turnId: "turn-1" },
          "turn/interrupt": {},
        };
        respond(message.id, results[message.method]);
      });
    },
    close() { closed += 1; },
  });
  const respond = (id, result) => protocol.feed(Buffer.from(JSON.stringify({ id, result }) + "\n"));
  const notify = (method, params) => protocol.feed(Buffer.from(JSON.stringify({ method, params }) + "\n"));
  const request = (id, method, params) => protocol.feed(Buffer.from(JSON.stringify({ id, method, params }) + "\n"));
  return { protocol, sent, respond, notify, request, get closed() { return closed; } };
}

async function started(fx) {
  await fx.protocol.initialize();
  await fx.protocol.prepareThread({ model: MODEL, effort: "high" });
  await fx.protocol.startTurn("Inspect one file.");
}

test("the transport is unregistered and execution is denied without a protected integration", async () => {
  assert.equal(CODEX_PRODUCTION_ENABLED, false);
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
  assert.equal(fx.sent[0].params.capabilities.experimentalApi, true);
  fx.protocol.close();
});

test("model discovery follows bounded pagination and never substitutes model or effort", async () => {
  const fx = fixture({ handler(message, respond) {
    if (message.method === "initialize") return respond(message.id, { userAgent: "fixture" });
    if (message.method === "model/list") return respond(message.id, message.params.cursor
      ? models("gpt-6-luna") : { ...models(), nextCursor: "next-page" });
  } });
  assert.equal(await fx.protocol.supportsModel({ model: "gpt-6-luna", effort: "high" }), true);
  assert.equal(await fx.protocol.supportsModel({ model: MODEL, effort: "ultra" }), false);
  assert.equal(await fx.protocol.supportsModel({ model: "not-available", effort: "high" }), false);
  assert.deepEqual(fx.sent.filter((m) => m.method === "model/list").map((m) => m.params.cursor ?? null), [null, "next-page"]);
  fx.protocol.close();
});

test("repeated pagination cursors fail closed", async () => {
  const fx = fixture({ handler(message, respond) {
    respond(message.id, message.method === "initialize" ? { userAgent: "fixture" } : { ...models(), nextCursor: "loop" });
  } });
  await assert.rejects(fx.protocol.supportsModel({ model: MODEL, effort: "high" }), /model discovery/);
  assert.equal(fx.closed, 1);
});

test("thread and resume acknowledgements must match model, profile and exact resumed ID before any turn", async () => {
  for (const replacement of ["thread-replacement", "model", "profile"]) {
    const fx = fixture({ handler(message, respond) {
      if (message.method === "initialize") return respond(message.id, { userAgent: "fixture" });
      if (message.method === "model/list") return respond(message.id, models());
      respond(message.id, { thread: { id: replacement === "thread-replacement" ? replacement : "thread-original" },
        model: replacement === "model" ? "gpt-6-luna" : MODEL, cwd: "/fixture", activePermissionProfile: { id: replacement === "profile" ? "other" : PROFILE } });
    } });
    await assert.rejects(fx.protocol.prepareThread({ model: MODEL, effort: "high", resumeThreadId: "thread-original" }), /thread acknowledgement/);
    assert.ok(!fx.sent.some((m) => m.method === "turn/start"));
    assert.equal(fx.closed, 1);
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

test("all native approvals are denied, including session rules, permission grants and stale turns", async () => {
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

test("question replies are bound to the active turn and exact question IDs, then become single use", async () => {
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

test("secret questions, foreign turns and unsupported server calls never reach host questions", async () => {
  const fx = fixture();
  await started(fx);
  fx.request("q-secret", "item/tool/requestUserInput", { threadId: "thread-1", turnId: "turn-1", itemId: "q", isBlocking: true,
    questions: [{ id: "key", header: "Key", question: "API key", isSecret: true }] });
  assert.ok(fx.sent.at(-1).error);
  fx.request("q-foreign", "item/tool/requestUserInput", { threadId: "foreign", turnId: "turn-1", questions: [] });
  assert.ok(fx.sent.at(-1).error);
  fx.protocol.close();
});

test("message cancellation precedes native delivery, and receipts follow an exact steer acknowledgement", async () => {
  const fx = fixture();
  await started(fx);
  fx.protocol.enqueueMessage("cancelled", "Do not deliver.");
  assert.equal(fx.protocol.cancelMessage("cancelled"), true);
  await assert.rejects(fx.protocol.flushMessage("cancelled"), /not queued/);
  fx.protocol.enqueueMessage("deliver", "Inspect caller too.");
  await fx.protocol.flushMessage("deliver");
  assert.equal(fx.protocol.cancelMessage("deliver"), false);
  assert.deepEqual(fx.sent.filter((m) => m.method === "turn/steer").map((m) => m.params.clientUserMessageId), ["deliver"]);
  fx.protocol.close();
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

test("out-of-order turn notifications wait for the exact start acknowledgement", async () => {
  const fx = fixture({ handler(message, respond, protocol) {
    if (message.method === "initialize") return respond(message.id, { userAgent: "fixture" });
    if (message.method === "model/list") return respond(message.id, models());
    if (message.method === "thread/start") return respond(message.id, { thread: { id: "thread-1" }, model: MODEL, cwd: "/fixture", activePermissionProfile: { id: PROFILE } });
    protocol.feed(Buffer.from(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } }) + "\n"));
    respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
  } });
  await started(fx);
  assert.equal(fx.protocol.state().turnId, null);
  const events = [];
  fx.protocol.close();
  for await (const event of fx.protocol.events) events.push(event);
  assert.ok(events.some((e) => e.type === "done" && e.ok));
});

test("pending calls and partial frames are settled once on close and transport timeouts", async () => {
  const fx = fixture({ handler() {}, limits: { requestTimeoutMs: 20 } });
  await assert.rejects(fx.protocol.initialize(), /timed out/);
  assert.equal(fx.closed, 1);
  fx.protocol.close();
  assert.equal(fx.closed, 1);
  const second = fixture({ handler() {} });
  const pending = second.protocol.initialize();
  second.protocol.feed(Buffer.from('{"id":'));
  second.protocol.end();
  await assert.rejects(pending, /protocol/);
  assert.equal(second.closed, 1);
  await tick();
});

test("UTF-8 frames may be split across chunks without corrupting text", async () => {
  const fx = fixture();
  await started(fx);
  const frame = Buffer.from(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "餃" } }) + "\n");
  const split = frame.indexOf(Buffer.from("餃")) + 1;
  fx.protocol.feed(frame.subarray(0, split));
  fx.protocol.feed(frame.subarray(split));
  fx.protocol.close();
  const received = [];
  for await (const event of fx.protocol.events) received.push(event);
  assert.ok(received.some((event) => event.type === "text" && event.text === "餃"));
});

test("server IDs, event queues and queued messages have hard bounds", async () => {
  const duplicates = fixture();
  await duplicates.protocol.initialize();
  duplicates.request(7, "unsupported", {});
  duplicates.request(7, "unsupported", {});
  assert.equal(duplicates.closed, 1);

  const fx = fixture({ limits: { events: 2, messages: 1 } });
  await started(fx);
  fx.protocol.enqueueMessage("one", "First message");
  assert.throws(() => fx.protocol.enqueueMessage("two", "Second message"), /cannot be queued/);
  for (const itemId of ["a", "b"]) fx.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId, delta: "bounded" });
  assert.equal(fx.closed, 1);
});

test("tool and completion events translate to host events without permitting native children", async () => {
  const fx = fixture();
  await started(fx);
  fx.notify("item/started", { threadId: "thread-1", turnId: "turn-1", item: { id: "tool-1", type: "commandExecution", command: "node --check file.mjs" } });
  fx.notify("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { id: "tool-1", type: "commandExecution", status: "completed", aggregatedOutput: "checked" } });
  fx.notify("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { id: "reply-1", type: "agentMessage", text: "The file passed." } });
  fx.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
  fx.protocol.close();
  const received = [];
  for await (const event of fx.protocol.events) received.push(event);
  assert.deepEqual(received.map((event) => event.type), ["model", "tool-start", "tool-result", "tool-end", "reply", "done"]);
  assert.equal(received.find((event) => event.type === "tool-result").ok, true);
  const child = fixture();
  await started(child);
  child.notify("item/started", { threadId: "thread-1", turnId: "turn-1", item: { id: "child-1", type: "collabAgentToolCall" } });
  assert.equal(child.closed, 1);
});

test("a late steer acknowledgement cannot change its receipt to another turn", async () => {
  const fx = fixture();
  await started(fx);
  fx.protocol.enqueueMessage("receipt", "Inspect caller.");
  await fx.protocol.flushMessage("receipt");
  fx.protocol.close();
  const received = [];
  for await (const event of fx.protocol.events) received.push(event);
  assert.ok(received.some((event) => event.type === "message-applied" && event.id === "receipt"));
  const wrong = fixture({ handler(message, respond) {
    if (message.method === "initialize") return respond(message.id, { userAgent: "fixture" });
    if (message.method === "model/list") return respond(message.id, models());
    if (message.method === "thread/start") return respond(message.id, { thread: { id: "thread-1" }, model: MODEL, cwd: "/fixture", activePermissionProfile: { id: PROFILE } });
    if (message.method === "turn/start") return respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
    respond(message.id, { turnId: "another-turn" });
  } });
  await started(wrong);
  wrong.protocol.enqueueMessage("bad-receipt", "Inspect caller.");
  await assert.rejects(wrong.protocol.flushMessage("bad-receipt"), /message acknowledged another turn/);
  const rejected = [];
  for await (const event of wrong.protocol.events) rejected.push(event);
  assert.ok(!rejected.some((event) => event.type === "message-applied"));
  assert.equal(wrong.closed, 1);
});

test("foreign early notifications and numeric thread identities fail before work can proceed", async () => {
  const numeric = fixture({ handler(message, respond) {
    if (message.method === "initialize") return respond(message.id, { userAgent: "fixture" });
    if (message.method === "model/list") return respond(message.id, models());
    respond(message.id, { thread: { id: 9 }, model: MODEL, cwd: "/fixture", activePermissionProfile: { id: PROFILE } });
  } });
  await assert.rejects(numeric.protocol.prepareThread({ model: MODEL, effort: "high" }), /thread acknowledgement/);
  assert.equal(numeric.closed, 1);
  const foreign = fixture({ handler(message, respond, protocol) {
    if (message.method === "initialize") return respond(message.id, { userAgent: "fixture" });
    if (message.method === "model/list") return respond(message.id, models());
    if (message.method === "thread/start") return respond(message.id, { thread: { id: "thread-1" }, model: MODEL, cwd: "/fixture", activePermissionProfile: { id: PROFILE } });
    protocol.feed(Buffer.from(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "foreign", turnId: "turn-1", itemId: "item-1", delta: "spoof" } }) + "\n"));
    respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
  } });
  await assert.rejects(started(foreign), /foreign thread/);
  assert.equal(foreign.closed, 1);
});

test("a completed turn's delayed steer response cannot receipt a reused message ID in a new turn", async () => {
  let nativeTurn = 0;
  let held;
  const fx = fixture({ handler(message, respond) {
    if (message.method === "initialize") return respond(message.id, { userAgent: "fixture" });
    if (message.method === "model/list") return respond(message.id, models());
    if (message.method === "thread/start") return respond(message.id, { thread: { id: "thread-1" }, model: MODEL, cwd: "/fixture", activePermissionProfile: { id: PROFILE } });
    if (message.method === "turn/start") return respond(message.id, { turn: { id: `turn-${++nativeTurn}`, status: "inProgress" } });
    held = { message, respond };
  } });
  await started(fx);
  fx.protocol.enqueueMessage("reused", "Old message");
  const sending = fx.protocol.flushMessage("reused");
  await tick();
  fx.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
  await fx.protocol.startTurn("New turn");
  fx.protocol.enqueueMessage("reused", "New message remains queued");
  held.respond(held.message.id, { turnId: "turn-1" });
  assert.equal(await sending, false);
  assert.equal(fx.protocol.cancelMessage("reused"), true);
  fx.protocol.close();
  const received = [];
  for await (const event of fx.protocol.events) received.push(event);
  assert.ok(!received.some((event) => event.type === "message-applied"));
});

test("secret-pattern question IDs, headers, prompts and option text are refused despite isSecret false", async () => {
  const fx = fixture();
  await started(fx);
  const synthetic = "ghp_" + "a".repeat(36);
  for (const [index, location] of ["id", "header", "question", "label", "description"].entries()) {
    const q = { id: "choice", header: "Choice", question: "Which file?", isSecret: false,
      options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }] };
    if (["label", "description"].includes(location)) q.options[0][location] = synthetic;
    else q[location] = synthetic;
    fx.request(`question-${index}`, "item/tool/requestUserInput", { threadId: "thread-1", turnId: "turn-1", itemId: `item-${index}`, isBlocking: true, questions: [q] });
    assert.equal(fx.sent.at(-1).error?.code, -32602);
    assert.ok(!JSON.stringify(fx.sent.at(-1)).includes(synthetic));
  }
  fx.protocol.close();
  const received = [];
  for await (const event of fx.protocol.events) received.push(event);
  assert.ok(!received.some((event) => event.type === "permission-request"));
});
