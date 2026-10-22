import { test } from "node:test";
import assert from "node:assert/strict";
import { createCodexProtocol } from "./codex-adapter.mjs";

const spec = { type: "function", name: "mcp__tree__status", description: "Read this live tree", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(executeTool = async () => ({ content: [{ type: "text", text: "accepted fixture result" }] })) {
  const sent = [], calls = [];
  const protocol = createCodexProtocol({
    authorizeExecution: async () => ({ profileId: "fixture", cwd: "/fixture", dynamicTools: [spec] }),
    executeTool: async (...args) => { calls.push(args); return executeTool(...args); },
    write(line) {
      const message = JSON.parse(line); sent.push(message);
      if (!message.method || !message.id) return;
      const result = message.method === "initialize" ? { userAgent: "fixture/0.163.0" }
        : message.method === "model/list" ? { data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null }
        : message.method === "thread/start" ? { thread: { id: "native-thread" }, model: "gpt-6.1-sol", cwd: "/fixture", activePermissionProfile: { id: "fixture" } }
        : message.method === "turn/start" ? { turn: { id: "native-turn", status: "inProgress" } } : {};
      queueMicrotask(() => protocol.feed(JSON.stringify({ id: message.id, result }) + "\n"));
    },
  });
  await protocol.prepareThread({ model: "gpt-6.1-sol", effort: "high" });
  await protocol.startTurn("Inspect the bounded fixture.");
  if (typeof protocol.decideTool !== "function") {
    protocol.close();
    assert.fail("protected dynamic tool authorization is missing");
  }
  const request = (id, patch = {}) => protocol.feed(JSON.stringify({ id, method: "item/tool/call", params: { threadId: "native-thread", turnId: "native-turn", callId: `call-${id}`, namespace: null, tool: spec.name, arguments: {}, ...patch } }) + "\n");
  return { protocol, sent, calls, request };
}

test("dynamic tools use canonical 0.163 specs and await host authorization before protected execution", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.sent.find(message => message.method === "thread/start").params.dynamicTools, [spec]);
    f.request("tool-request");
    assert.equal(f.calls.length, 0);
    let permission;
    for await (const event of f.protocol.events) { if (event.type === "permission-request") { permission = event; break; } }
    assert.equal(permission.tool, spec.name);
    assert.deepEqual(permission.input, {});
    await f.protocol.decideTool(permission.requestId, { allow: true });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][0], spec.name);
    assert.equal(f.calls[0][2].threadId, "native-thread");
    assert.deepEqual(f.sent.find(message => message.id === "tool-request").result, { success: true, contentItems: [{ type: "inputText", text: "accepted fixture result" }] });
    await assert.rejects(f.protocol.decideTool(permission.requestId, { allow: true }), /pending tool/);
  } finally { f.protocol.close(); }
});

test("foreign, unlisted and secret-bearing dynamic calls never reach execution or an approval", async () => {
  const f = await fixture();
  try {
    for (const [id, patch] of [["foreign", { threadId: "other" }], ["unknown", { tool: "account/read" }], ["namespace", { namespace: "unapproved" }], ["secret", { arguments: { token: "ghp_" + "x".repeat(36) } }]]) {
      f.request(id, patch);
      assert.ok(f.sent.find(message => message.id === id)?.error, id);
    }
    assert.equal(f.calls.length, 0);
  } finally { f.protocol.close(); }
});

test("interruption aborts a pending protected tool and refuses late authorization", async () => {
  const f = await fixture();
  try {
    f.request("cancelled");
    let permission;
    for await (const event of f.protocol.events) { if (event.type === "permission-request") { permission = event; break; } }
    assert.equal(typeof f.protocol.decideTool, "function");
    await f.protocol.interrupt();
    await assert.rejects(f.protocol.decideTool(permission.requestId, { allow: true }), /pending tool/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.sent.filter(message => message.id === "cancelled").length, 1);
  } finally { f.protocol.close(); }
});

test("an executing protected tool receives cancellation and cannot reply after its turn ends", async () => {
  let release, captured;
  const f = await fixture(async (_name, _input, context) => { captured = context.signal; return new Promise(resolve => { release = resolve; }); });
  try {
    f.request("in-flight");
    let permission;
    for await (const event of f.protocol.events) { if (event.type === "permission-request") { permission = event; break; } }
    assert.equal(typeof f.protocol.decideTool, "function");
    const pending = f.protocol.decideTool(permission.requestId, { allow: true });
    await tick();
    await f.protocol.interrupt();
    assert.equal(captured.aborted, true);
    release({ content: [{ type: "text", text: "late result" }] });
    await pending;
    assert.equal(f.sent.filter(message => message.id === "in-flight").length, 1);
    assert.ok(f.sent.find(message => message.id === "in-flight").error);
  } finally { f.protocol.close(); }
});
