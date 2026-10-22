import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createLibrary } from "../library/library.mjs";
import { parseCatalog } from "../library/catalog.mjs";
const url = new URL("./codex-connections.mjs", import.meta.url);
const module = existsSync(url) ? await import(url) : {};

async function fixture(t) {
  assert.equal(typeof module.prepareCodexTools, "function", "protected Codex connection interposition is missing");
  const root = await mkdtemp("/tmp/den-codex-connection-fixture-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(`${root}/.claude/agents`, { recursive: true });
  await mkdir(`${root}/credentials`);
  await writeFile(`${root}/.claude/agents/developer.md`, "---\ntools: Read, mcp__github\n---\n");
  const token = "dummy" + "k".repeat(38);
  await writeFile(`${root}/credentials/github.token`, token, { mode: 0o600 });
  const library = createLibrary({ denRoot: root, catalog: parseCatalog({ connections: [{ name: "github", title: "Github fixture", purpose: "bounded fixture", url: "https://example.com/mcp", credential: "den", roles: ["developer"], tools: { inspect: "read", mutate: "change" } }] }) });
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    const input = JSON.parse(options.body);
    if (!input.id) return new Response(null, { status: 202 });
    const result = input.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : input.method === "tools/list" ? { tools: [{ name: "inspect", description: "Inspect fixture", inputSchema: { type: "object" } }, { name: "mutate", description: "Mutate fixture", inputSchema: { type: "object" } }, { name: "unapproved", description: "Must be hidden", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: "protected result" }] };
    return Response.json({ jsonrpc: "2.0", id: input.id, result }, { headers: { "Mcp-Session-Id": "fixture-session" } });
  };
  return { root, token, library, requests, options: { role: "developer", connections: await library.connectionsFor("developer"), library, credentialRoot: `${root}/credentials`, fetcher } };
}

test("Codex exposes only approved catalog tools and keeps connection credentials in trusted transport", async t => {
  const f = await fixture(t);
  const broker = await module.prepareCodexTools(f.options);
  assert.deepEqual(broker.tools.map(tool => tool.name), ["mcp__github__inspect", "mcp__github__mutate"]);
  assert.equal(JSON.stringify(broker.tools).includes(f.token), false);
  const result = await broker.call("mcp__github__inspect", { query: "small public fixture" }, { signal: new AbortController().signal });
  assert.equal(result.content[0].text, "protected result");
  assert.ok(f.requests.every(request => request.options.headers.Authorization === `Bearer ${f.token}`));
  assert.ok(f.requests.every(request => request.options.redirect === "error"));
  await broker.close();
  assert.equal(f.requests.at(-1).options.method, "DELETE");
});

test("forged targets and unauthorized roles refuse before any connection request", async t => {
  const f = await fixture(t);
  await assert.rejects(module.prepareCodexTools({ ...f.options, connections: [{ ...f.options.connections[0], url: "https://evil.example/mcp" }] }), /approved catalog/);
  await assert.rejects(module.prepareCodexTools({ ...f.options, role: "scout" }), /approved catalog/);
  assert.equal(f.requests.length, 0);
});

test("unlisted tools and secret inputs never reach protected connection transport", async t => {
  const f = await fixture(t);
  const broker = await module.prepareCodexTools(f.options);
  const before = f.requests.length;
  for (const [name, input] of [["mcp__github__unapproved", {}], ["mcp__github__inspect", { token: "ghp_" + "x".repeat(36) }]]) {
    await assert.rejects(broker.call(name, input, { signal: new AbortController().signal }), /refused|not approved/);
  }
  assert.equal(f.requests.length, before);
  await broker.close();
});

test("cancelled calls and unsafe credential files refuse without tool execution", async t => {
  const f = await fixture(t);
  const broker = await module.prepareCodexTools(f.options);
  const controller = new AbortController(); controller.abort();
  const before = f.requests.length;
  await assert.rejects(broker.call("mcp__github__inspect", {}, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(f.requests.length, before);
  await broker.close();
  await writeFile(`${f.root}/credentials/github.token`, " ", { mode: 0o600 });
  await assert.rejects(module.prepareCodexTools(f.options), /credential/);
});
