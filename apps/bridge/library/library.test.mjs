// den-mvp outcome 4 (spec section 3 and the "MCP" testing decisions): the library at the bridge's own seam, with the fake
// runtime. A role is started with the connections the catalog and its role file both name; a connection's tool call is
// answered from the catalog before it can become a question; a connection that is not available shows a reason; and
// neither the catalog view nor the log holds a tool's input.
//
// This amends one line of the approvals contract (host-approvals.test.mjs, "the bridge never allows on its own"): the
// bridge now allows a call the catalog marks as a read. Every other request is held for the user as before.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeBridge, send, until } from "../agents/host-test-helpers.mjs";
import { ROUTES } from "../routes.mjs";
import { parseCatalog } from "./catalog.mjs";
import { CONNECTION_AUTO_BYTES, CONNECTION_AUTO_CALLS } from "../agents/policy.mjs";
import { AUTO_INPUT_MAX_BYTES, LOG_MAX_BYTES, createLibrary, skillOf } from "./library.mjs";

const CATALOG = parseCatalog({
  connections: [
    { name: "docs", title: "Docs", purpose: "Look things up.", url: "https://docs.example.com/mcp", credential: "none", roles: ["sre", "architect"], tools: { find: "read", save: "change" } },
    { name: "notes", title: "Notes", purpose: "Keep notes.", script: "apps/bridge/library/servers/test-server.mjs", credential: "none", roles: ["architect"], tools: { echo: "read", note: "publish" } },
  ],
});
const SECRET = ["ghp_", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"].join(""); // built at runtime so the repo secret scan stays clean

let t;
let dirs = [];
afterEach(async () => {
  await t?.close();
  t = undefined;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});
// A den checkout with role files and skills, and a state directory, both disposable.
async function den({ architect = "tools: Read, Skill, mcp__docs, mcp__notes__echo", sre = "tools: Read, Bash" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "den-library-"));
  dirs.push(root);
  await mkdir(path.join(root, ".claude", "agents"), { recursive: true });
  await mkdir(path.join(root, ".claude", "skills", "tdd"), { recursive: true });
  await mkdir(path.join(root, ".claude", "skills", "empty"), { recursive: true });
  await writeFile(path.join(root, ".claude", "agents", "architect.md"), `---\nname: architect\n${architect}\n---\nbody\n`);
  await writeFile(path.join(root, ".claude", "agents", "sre.md"), `---\nname: sre\n${sre}\n---\nbody\n`);
  await writeFile(path.join(root, ".claude", "skills", "tdd", "SKILL.md"), "---\nname: tdd\ndescription: Test first.\n---\n# TDD\n");
  return { denRoot: root, stateDir: path.join(root, "state") };
}
const library = async (over) => createLibrary({ catalog: CATALOG, ...(await den(over)) });
const request = (rec, requestId, tool, input = { text: "hi" }) => rec.emit({ type: "permission-request", requestId, tool, input });
const approvalsOf = async (agentId) => ((await t.state()).approvals ?? []).filter((a) => a.agentId === agentId);

describe("what a run is started with", () => {
  test("the connections the catalog and the role file both name, as data for the runtime and not in the prompt", async () => {
    t = await makeBridge({ library: await library() });
    await t.dispatch("architect");
    const { args } = t.fake.spawns[0];
    assert.deepEqual(args.connections, [{ name: "docs", url: "https://docs.example.com/mcp" }, { name: "notes", script: CATALOG.connections[1].target.script }]);
    assert.doesNotMatch(args.prompt, /docs\.example\.com|mcp__/);
  });

  test("a role whose file does not name the connection is started without it, and so is a role the catalog leaves out", async () => {
    t = await makeBridge({ library: await library() });
    await t.dispatch("sre"); // in the catalog, not in its role file
    assert.equal(t.fake.spawns[0].args.connections, undefined);
    t.fake.spawns[0].exit();
    await t.close();
    t = await makeBridge({ library: await library() });
    await t.dispatch("product"); // in neither
    assert.equal(t.fake.spawns[0].args.connections, undefined);
  });

  test("with no library passed, no run is given a connection and every connection tool is refused", async () => {
    t = await makeBridge();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    assert.equal(rec.args.connections, undefined);
    request(rec, "r1", "mcp__docs__find");
    await until(() => rec.decisions.length === 1, { what: "the refusal" });
    assert.equal(rec.decisions[0].allow, false);
    assert.deepEqual(await approvalsOf(agent.id), []);
  });
});

describe("a connection's tool call", () => {
  test("a read is allowed without a question, and the use is recorded", async () => {
    const lib = await library();
    t = await makeBridge({ library: lib });
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    request(rec, "r1", "mcp__docs__find", { query: "how to proxy the dev server" });
    await until(() => rec.decisions.length === 1, { what: "the answer" });
    assert.deepEqual(rec.decisions[0], { requestId: "r1", allow: true, reason: undefined });
    assert.deepEqual(await approvalsOf(agent.id), []);
    const docs = (await lib.view()).connections.find((c) => c.name === "docs");
    assert.equal(docs.uses.count, 1);
    assert.deepEqual([docs.uses.lastRole, docs.uses.lastTool], ["architect", "find"]);
  });

  test("a call whose input looks like a secret is refused, read or not, and a read with a long input is asked instead of allowed", async () => {
    const lib = await library();
    t = await makeBridge({ library: lib });
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    request(rec, "r1", "mcp__docs__find", { query: `what is ${SECRET}` });
    request(rec, "r2", "mcp__docs__save", { nested: { deep: [SECRET] } });
    await until(() => rec.decisions.length === 2, { what: "both refusals" });
    for (const d of rec.decisions) assert.deepEqual([d.allow, /secret/.test(d.reason)], [false, true]);
    assert.deepEqual(await approvalsOf(agent.id), []);
    request(rec, "r3", "mcp__docs__find", { query: "x".repeat(AUTO_INPUT_MAX_BYTES) });
    const [held] = await until(async () => { const list = await approvalsOf(agent.id); return list.length === 1 && list; }, { what: "the long read to be held" });
    assert.deepEqual([held.tool, held.state], ["mcp__docs__find", "pending"]);
    assert.equal(rec.decisions.length, 2, "the bridge did not answer it");
    request(rec, "r4", "mcp__docs__find", { query: "x".repeat(AUTO_INPUT_MAX_BYTES - 20) });
    await until(() => rec.decisions.length === 3, { what: "the short read to be allowed" });
    assert.equal(rec.decisions[2].allow, true);
    assert.deepEqual([(await lib.view()).connections[0].uses.count, (await lib.view()).connections[0].uses.refused], [2, 2]);
  });

  test("the bridge allows only so many reads per run, and only so much input: past either bound a read is asked", async () => {
    const lib = await library();
    t = await makeBridge({ library: lib, policy: { approvalTtlMs: 60_000 } });
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    for (let i = 0; i < CONNECTION_AUTO_CALLS + 2; i += 1) request(rec, `r${i}`, "mcp__docs__find", { q: "a" });
    const held = await until(async () => { const list = await approvalsOf(agent.id); return list.length === 2 && list; }, { what: "the reads past the bound to be held" });
    assert.equal(rec.decisions.length, CONNECTION_AUTO_CALLS);
    assert.ok(rec.decisions.every((d) => d.allow === true));
    assert.deepEqual(held.map((a) => a.tool), ["mcp__docs__find", "mcp__docs__find"]);
    // The bound is the run's: another run of the same role starts from nothing.
    rec.exit();
    await t.close();
    t = await makeBridge({ library: await library() });
    const second = (await t.dispatch("architect")).body.agent;
    const rec2 = t.fake.spawns[0];
    const big = { q: "x".repeat(AUTO_INPUT_MAX_BYTES - 100) };
    const fits = Math.floor(CONNECTION_AUTO_BYTES / Buffer.byteLength(JSON.stringify(big)));
    for (let i = 0; i < fits + 1; i += 1) request(rec2, `b${i}`, "mcp__docs__find", big);
    await until(async () => (await approvalsOf(second.id)).length === 1, { what: "the read past the byte bound to be held" });
    assert.equal(rec2.decisions.length, fits);
    assert.ok(fits < CONNECTION_AUTO_CALLS, "the byte bound is the one this half meets");
  });

  test("once Stop was asked for, the bridge allows nothing by itself", async () => {
    t = await makeBridge({ library: await library(), runtimeConfig: { stdinCloseEnds: false, sigtermEnds: false, sigkillEnds: false }, policy: { killGraceMs: 400 } });
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    const stop = t.post(`/agents/${agent.id}/stop`);
    await until(() => rec.calls.length > 0, { what: "the stop to reach the process" });
    request(rec, "late", "mcp__docs__find", { q: "a" });
    await until(() => rec.decisions.length === 1, { what: "the answer to the late read" });
    assert.deepEqual([rec.decisions[0].allow, rec.decisions[0].reason], [false, "The run is stopping."]);
    rec.exit();
    await stop;
  });

  test("an input that is not an object is refused, never allowed", async () => {
    const lib = await library();
    for (const input of [undefined, null, "text", 4, ["a"]]) assert.equal(lib.decide("architect", "mcp__docs__find", input).kind, "refuse", String(input));
    const loop = {};
    loop.self = loop;
    assert.equal(lib.decide("architect", "mcp__docs__find", loop).kind, "refuse");
    assert.equal(lib.decide("architect", "mcp__docs__find", { q: "a" }).kind, "allow");
    assert.equal(lib.decide("nobody", "mcp__docs__find", { q: "a" }).kind, "refuse");
  });

  test("a change or a publish is held for the user like any other request, with its exact input", async () => {
    t = await makeBridge({ library: await library() });
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    request(rec, "r1", "mcp__docs__save", { text: "keep this" });
    request(rec, "r2", "mcp__notes__note", { text: "post this" });
    const held = await until(async () => { const list = await approvalsOf(agent.id); return list.length === 2 && list; }, { what: "both requests to be held" });
    assert.deepEqual(held.map((a) => [a.tool, a.state]), [["mcp__docs__save", "pending"], ["mcp__notes__note", "pending"]]);
    assert.equal(rec.decisions.length, 0);
    const full = await send(t.bridge, { path: `/approvals/${held[0].id}`, headers: t.headers });
    assert.deepEqual(full.body.input, { text: "keep this" });
  });

  test("a tool the catalog does not list is refused with a reason and never becomes a question, whatever the server offered", async () => {
    const lib = await library();
    t = await makeBridge({ library: lib });
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    const tools = ["mcp__docs__delete_all", "mcp__notes__admin", "mcp__blender__execute_blender_code", "mcp__docs"];
    tools.forEach((tool, i) => request(rec, `r${i}`, tool));
    await until(() => rec.decisions.length === tools.length, { what: "the refusals" });
    for (const d of rec.decisions) {
      assert.equal(d.allow, false);
      assert.match(d.reason, /catalog/);
    }
    assert.deepEqual(await approvalsOf(agent.id), []);
    assert.equal((await lib.view()).connections.find((c) => c.name === "docs").uses.refused, 2);
  });

  test("another role's connection is refused even when its tools were discovered", async () => {
    t = await makeBridge({ library: await library({ sre: "tools: Read, mcp__docs, mcp__notes" }) });
    await t.dispatch("sre");
    const rec = t.fake.spawns[0];
    assert.deepEqual(rec.args.connections.map((c) => c.name), ["docs"]); // notes lists the architect only
    request(rec, "r1", "mcp__notes__echo");
    await until(() => rec.decisions.length === 1, { what: "the refusal" });
    assert.equal(rec.decisions[0].allow, false);
  });

  test("a tool that is not a connection's goes to the user as before", async () => {
    t = await makeBridge({ library: await library() });
    const { agent } = (await t.dispatch("architect")).body;
    request(t.fake.spawns[0], "r1", "Bash", { command: "npm test" });
    await until(async () => (await approvalsOf(agent.id)).length === 1, { what: "the request to be held" });
    assert.equal(t.fake.spawns[0].decisions.length, 0);
  });
});

describe("the library panel's data", () => {
  test("GET /library is a read in the registry", () => {
    const row = ROUTES.find((r) => r.method === "GET" && r.path === "/library");
    assert.deepEqual([row?.auth, row?.mutating], ["none", false]);
  });

  test("each connection shows its purpose, where it is, its roles and tools, and each skill its roles", async () => {
    t = await makeBridge({ library: await library() });
    const { status, body } = await send(t.bridge, { path: "/library" });
    assert.equal(status, 200);
    const [docs, notes] = body.connections;
    assert.deepEqual([docs.kind, docs.title, docs.purpose, docs.credential], ["connection", "Docs", "Look things up.", "none"]);
    assert.deepEqual(docs.where, { kind: "remote", host: "docs.example.com" });
    assert.deepEqual(notes.where, { kind: "local" });
    assert.deepEqual(docs.tools, [{ name: "find", capability: "read" }, { name: "save", capability: "change" }]);
    assert.deepEqual(docs.status, { state: "not-seen", reason: "No agent has started with it yet." });
    assert.deepEqual(docs.roles.map((r) => [r.role, r.usable]), [["sre", false], ["architect", true]]);
    assert.match(docs.roles[0].reason, /sre\.md does not name it/);
    assert.deepEqual(body.skills, [{ kind: "skill", name: "tdd", description: "Test first.", roles: ["architect"] }]);
  });

  test("a connection that failed or asked for a sign-in shows that with a reason, and one that connected shows when", async () => {
    const lib = await library();
    t = await makeBridge({ library: lib });
    await t.dispatch("architect");
    t.fake.spawns[0].emit({ type: "connections", servers: [{ name: "docs", status: "needs-auth" }, { name: "notes", status: "failed" }, { name: "stranger", status: "connected" }] });
    const seen = await until(async () => { const v = await lib.view(); return v.connections[0].status.state !== "not-seen" && v; }, { what: "the status" });
    assert.equal(seen.connections[0].status.state, "needs-sign-in");
    assert.match(seen.connections[0].status.reason, /sign-in/);
    assert.equal(seen.connections[1].status.state, "failed");
    assert.match(seen.connections[1].status.reason, /architect last started/);
    assert.equal(seen.connections.length, 2); // a name outside the catalog is not added
    t.fake.spawns[0].emit({ type: "connections", servers: [{ name: "docs", status: "connected" }, { name: "notes", status: "something new" }] });
    const next = await until(async () => { const v = await lib.view(); return v.connections[0].status.state === "connected" && v; }, { what: "the new status" });
    assert.ok(!Number.isNaN(Date.parse(next.connections[0].status.at)));
    assert.equal(next.connections[0].status.reason, undefined);
    assert.equal(next.connections[1].status.state, "unavailable");
  });

  test("a restarted bridge shows the status and the uses recorded before, and the log holds no tool input", async () => {
    const where = await den();
    const first = createLibrary({ catalog: CATALOG, ...where });
    t = await makeBridge({ library: first });
    await t.dispatch("architect");
    const rec = t.fake.spawns[0];
    rec.emit({ type: "connections", servers: [{ name: "docs", status: "connected" }] });
    request(rec, "r1", "mcp__docs__find", { query: "private-project-name internals", authorization: "private-header" });
    request(rec, "r2", "mcp__docs__nope", { query: SECRET });
    await until(() => rec.decisions.length === 2, { what: "both answers" });
    await first.flush();
    const log = await readFile(path.join(where.stateDir, "library.jsonl"), "utf8");
    assert.ok(!log.includes(SECRET) && !log.includes("query") && !log.includes("private-"), "the log holds names and decisions only");
    assert.equal(log.trim().split("\n").length, 3);
    const again = await createLibrary({ catalog: CATALOG, ...where }).view();
    assert.equal(again.connections[0].status.state, "connected");
    assert.deepEqual([again.connections[0].uses.count, again.connections[0].uses.refused, again.connections[0].uses.lastTool], [1, 1, "find"]);
    assert.ok(!JSON.stringify(again).includes(SECRET));
  });

  test("the log does not grow without end: past its bound it is rewritten as the state and the totals, and a restart reads the same", async () => {
    const where = await den();
    const lib = createLibrary({ catalog: CATALOG, ...where });
    lib.noteStatus("architect", [{ name: "docs", status: "connected" }]);
    const line = Buffer.byteLength(JSON.stringify({ kind: "use", at: new Date().toISOString(), role: "architect", runId: "c-0123456789abcdef", connection: "docs", tool: null, decision: "refused" })) + 1;
    const calls = Math.ceil(LOG_MAX_BYTES / line) + 50;
    for (let i = 0; i < calls; i += 1) lib.noteUse({ role: "architect", runId: "c-0123456789abcdef", connection: "docs", tool: "bogus", decision: "refused" });
    lib.noteUse({ role: "architect", runId: "c-0123456789abcdef", connection: "docs", tool: "find", decision: "allowed" });
    await lib.flush();
    const size = (await readFile(path.join(where.stateDir, "library.jsonl"))).length;
    assert.ok(size < LOG_MAX_BYTES / 10, `the log was rewritten (${size} bytes)`);
    const again = (await createLibrary({ catalog: CATALOG, ...where }).view()).connections[0];
    assert.deepEqual([again.status.state, again.uses.count, again.uses.refused, again.uses.lastRole, again.uses.lastTool], ["connected", 1, calls, "architect", "find"]);
  });

  test("a log line that is not the library's own is not believed", async () => {
    const where = await den();
    await mkdir(where.stateDir, { recursive: true });
    await writeFile(path.join(where.stateDir, "library.jsonl"), [
      "not json", JSON.stringify({ kind: "status", at: "2026-10-13T00:00:00Z", role: "architect", connection: "stranger", status: "connected" }),
      JSON.stringify({ kind: "status", at: "never", role: "architect", connection: "docs", status: "connected" }),
      JSON.stringify({ kind: "use", at: "2026-10-13T00:00:00Z", role: "root", connection: "docs", tool: "find", decision: "allowed" }),
      JSON.stringify({ kind: "use", at: "2026-10-13T00:00:00Z", role: "architect", connection: "docs", tool: "<script>", decision: "allowed" }),
      JSON.stringify({ kind: "total", connection: "stranger", count: 5, refused: 5 }),
      JSON.stringify({ kind: "total", connection: "notes", count: -3, refused: "many", lastRole: "root", lastAt: "never", lastTool: "<b>" }),
    ].join("\n"));
    const view = await createLibrary({ catalog: CATALOG, ...where }).view();
    assert.equal(view.connections[0].status.state, "not-seen");
    assert.deepEqual([view.connections[0].uses.count, view.connections[0].uses.lastTool], [1, null]);
    assert.deepEqual(view.connections[1].uses, { count: 0, refused: 0, lastAt: null, lastRole: null, lastTool: null });
  });
});

describe("a skill's header", () => {
  test("the name and one line of description are read; anything else is not a skill", () => {
    assert.deepEqual(skillOf("---\nname: tdd\ndescription: \"Test first.\"\n---\n"), { name: "tdd", description: "Test first." });
    assert.deepEqual(skillOf("---\nname: bare\n---\n"), { name: "bare", description: "" });
    assert.equal(skillOf("# no header"), null);
    assert.equal(skillOf("---\nname: Bad Name\n---\n"), null);
    assert.equal(skillOf("---\nname: long\ndescription: " + "x".repeat(900) + "\n---\n").description.length, 300);
  });
});

describe("a den-held credential (den-mvp/33)", () => {
  const HELD = parseCatalog({ connections: [{ name: "github", title: "GitHub", purpose: "Read PRs.", url: "https://api.githubcopilot.com/mcp/readonly", credential: "den", roles: ["architect"], tools: { get_pull_request: "read" } }] });
  test("with no token saved the card is unavailable with a reason; with one it is not", async () => {
    const where = await den();
    const without = (await createLibrary({ catalog: HELD, ...where, hasCredential: () => false }).view()).connections[0];
    assert.deepEqual(without.status, { state: "unavailable", at: null, role: null, reason: "No GitHub token saved, so the den cannot reach it." });
    const withToken = (await createLibrary({ catalog: HELD, ...where, hasCredential: () => true }).view()).connections[0];
    assert.equal(withToken.status.state, "not-seen");
  });
});
