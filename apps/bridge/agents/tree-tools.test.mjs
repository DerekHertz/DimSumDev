import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { callTreeTool, TREE_TOOLS } from "./tree-tools.mjs";

const TOKEN = randomBytes(32).toString("base64url");
const URL = "http://127.0.0.1:43210";
const toolText = (result) => result.content.map((part) => part.text).join("\n");

test("tree tools expose only approved child identity and parent-owned result lookup", () => {
  const delegate = TREE_TOOLS.find((tool) => tool.name === "delegate").inputSchema;
  assert.deepEqual(Object.keys(delegate.properties), ["nodeId"]);
  assert.deepEqual(delegate.required, ["nodeId"]);
  assert.equal(delegate.additionalProperties, false);
  const result = TREE_TOOLS.find((tool) => tool.name === "result").inputSchema;
  assert.deepEqual(Object.keys(result.properties), ["childId"]);
  assert.deepEqual(result.required, ["childId"]);
  assert.equal(result.additionalProperties, false);
});

test("tree transport sends one authenticated loopback request without trusting parent identity", async () => {
  const calls = [];
  const response = await callTreeTool("delegate", { nodeId: "approved-manager" }, {
    url: URL, token: TOKEN,
    fetcher: async (...args) => {
      calls.push(args);
      return { ok: true, json: async () => ({ childId: "c-1234567890abcdef" }) };
    },
  });
  assert.equal(response.isError, undefined);
  assert.deepEqual(JSON.parse(toolText(response)), { childId: "c-1234567890abcdef" });
  assert.equal(calls.length, 1);
  const [url, request] = calls[0];
  assert.equal(url, `${URL}/tree-tools/delegate`);
  assert.equal(request.method, "POST");
  assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(request.headers.Origin, URL);
  assert.deepEqual(JSON.parse(request.body), { nodeId: "approved-manager" });
  assert.ok(request.signal instanceof AbortSignal, "every request has a bounded timeout");
  assert.doesNotMatch(toolText(response), new RegExp(TOKEN));
});

test("unknown tools and absent or non-loopback credentials never contact a server", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error("unexpected fetch"); };
  for (const [name, url, token] of [
    ["spawn", URL, TOKEN],
    ["delegate", URL, undefined],
    ["delegate", URL, "short-token"],
    ["delegate", "http://localhost:43210", TOKEN],
    ["delegate", "https://example.com", TOKEN],
    ["delegate", `${URL}/untrusted-path`, TOKEN],
  ]) {
    const result = await callTreeTool(name, { nodeId: "child" }, { url, token, fetcher });
    assert.equal(result.isError, true, `${name} ${url}`);
  }
  assert.equal(calls, 0);
});

test("server refusals retain their reason and uncertain outcomes never retry a spawn", async () => {
  let calls = 0;
  const refused = await callTreeTool("delegate", { nodeId: "child" }, {
    url: URL, token: TOKEN,
    fetcher: async () => { calls++; return { ok: false, status: 403, json: async () => ({ error: "not this parent's child" }) }; },
  });
  assert.equal(refused.isError, true);
  assert.match(toolText(refused), /403.*not this parent's child/);
  assert.equal(calls, 1);
  calls = 0;
  const uncertain = await callTreeTool("delegate", { nodeId: "child" }, {
    url: URL, token: TOKEN,
    fetcher: async () => { calls++; throw new Error("connection closed after admission"); },
  });
  assert.equal(calls, 1);
  assert.equal(uncertain.isError, true);
  assert.match(toolText(uncertain), /uncertain/i);
  assert.match(toolText(uncertain), /do not retry/i);
});

test("stdio MCP initializes, lists bounded tools and forwards authenticated calls", { timeout: 10000 }, async (t) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "approved child admitted" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(process.execPath, [fileURLToPath(new globalThis.URL("./tree-tools.mjs", import.meta.url))], {
    env: { ...process.env, DEN_BRIDGE_URL: url, DEN_RUN_TOKEN: TOKEN },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  t.after(() => lines.close());
  let id = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    const requestId = ++id;
    pending.set(requestId, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
  });
  const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(init.result.protocolVersion, "2024-11-05");
  assert.ok(init.result.capabilities.tools);
  const tools = (await rpc("tools/list")).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["delegate", "result"]);
  const result = await rpc("tools/call", { name: "delegate", arguments: { nodeId: "approved-child" } });
  assert.equal(toolText(result.result), "approved child admitted");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/tree-tools/delegate");
  assert.equal(requests[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(requests[0].headers.origin, url);
  assert.deepEqual(requests[0].body, { nodeId: "approved-child" });
  const unknown = await rpc("tree/escape", {});
  assert.equal(unknown.error.code, -32601);
  assert.equal((await rpc("ping")).result.constructor, Object);
});
