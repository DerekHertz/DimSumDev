// codex-residents/01: public host/HTTP acceptance contract. No live CLI or confinement claim.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { startBridge } from "../server.mjs";
import { makeStateFixture } from "../bridge-fixture.mjs";
import { CODE, login, authed, send } from "../bridge-auth-helpers.mjs";
import { addProject } from "../projects.mjs";
import { createHost } from "./host.mjs";
import { createFakeRuntime } from "./runtime.mjs";
import { DISPATCH_REF, FEATURE, UUID_RE, until, seedSessions } from "./host-test-helpers.mjs";
import { createWorkspaces, workspaceNames } from "./workspace.mjs";
import { CONVERSATION_READ_BYTES } from "./policy.mjs";

const cleanups = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const SESSION = "08376463-453a-4135-a7df-4ee921c22e86";
const A = "c-0123456789abcdef";
const B = "c-1111111111111111";
const C = "c-2222222222222222";
const AT = "2026-10-01T09:00:00.000Z";
const rows = async (file) => (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
const journal = (root) => path.join(root, ".scratch/_run/sessions.jsonl");
const historyFile = (root, project = "den", runtime = "claude", role = "architect") => path.join(root, ".scratch/_run/conversations", ...(project === "den" && runtime === "claude" ? [] : ["projects", project, runtime]), `${role}.jsonl`);
async function putRows(file, lines) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines.map((r) => typeof r === "string" ? r : JSON.stringify(r)).join("\n") + "\n");
}
const spawnRow = (over = {}) => ({ ts: AT, event: "spawn", agentId: A, ref: DISPATCH_REF, role: "architect", sessionId: SESSION, route: "POST /agents", ...over });
const endRow = (agentId = A, over = {}) => ({ ts: "2026-10-01T09:05:00.000Z", event: "end", agentId, ref: DISPATCH_REF, state: "done", ...over });
const entry = (runId, text, over = {}) => ({ runId, ref: DISPATCH_REF, id: 1, at: AT, kind: "message", role: "agent", text, ...over });

// Adapter identity is deliberately unrelated to canonical runtime policy. The only extra seam
// is the documented session acknowledgement on CellProcess; events/actions use the existing fake.
function adapter({ thread = "thread_codex_01", config = {} } = {}) {
  const fake = createFakeRuntime({ send: true, cancel: true, ...config });
  const spawn = fake.spawn.bind(fake);
  fake.preflights = 0;
  fake.probes = [];
  fake.resumes = [];
  fake.preflightResult = { ok: true };
  fake.preflight = async () => { fake.preflights += 1; return fake.preflightResult; };
  fake.stillRunning = async (id) => { fake.probes.push(id); return false; };
  fake.resumeCommand = (id) => { fake.resumes.push(id); return `fake-resume ${id}`; };
  fake.spawn = async (args) => {
    const proc = await spawn(args);
    const value = typeof thread === "function" ? thread(args, fake.spawns.length) : thread;
    if (value !== undefined) proc.runtimeSessionId = value;
    return proc;
  };
  return fake;
}

async function setup({ legacy = false, configured = ["claude", "codex"], claude = adapter({ thread: () => undefined }), codex = adapter(), preWrite, root, usage, usageByRuntime, denState } = {}) {
  const fx = root ? { root, cleanup: async () => {} } : await makeStateFixture({ git: true });
  cleanups.push(() => fx.cleanup());
  if (preWrite) await preWrite(fx.root);
  const runtimes = Object.fromEntries(configured.map((key) => [key, key === "claude" ? claude : codex]));
  const bridge = await startBridge({ root: fx.root, port: 0, auth: { launchCode: CODE }, policy: { killGraceMs: 30 }, ...(legacy ? { runtime: claude } : { runtimes }), ...(usage ? { usage } : {}), ...(usageByRuntime ? { usageByRuntime } : {}), ...(denState ? { denState } : {}) });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const fake of [claude, codex]) for (const rec of fake.spawns) rec.exit({ code: 1 });
    await bridge.close();
  };
  cleanups.push(close);
  const headers = authed(bridge, await login(bridge));
  const post = (url, body = {}) => send(bridge, { method: "POST", path: url, body, headers });
  const get = (url) => send(bridge, { path: url, headers });
  const state = async () => (await get("/state")).body;
  const dispatch = (runtime = "claude", ref = DISPATCH_REF, extra = {}) => post("/agents", { role: "architect", ref, runtime, ...extra });
  const say = (body, role = "architect") => post(`/conversations/${role}/message`, body);
  const thread = (runtime = "claude", project = "den", more = "") => get(`/conversations/architect?runtime=${runtime}&project=${project}${more}`);
  const finish = async (res, fake = claude) => {
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const rec = fake.spawns.at(-1);
    if (rec.args.promptId) rec.emit({ type: "message-applied", id: rec.args.promptId });
    rec.emit({ type: "done", ok: true });
    await until(async () => (await state()).agents.find((a) => a.id === res.body.agent.id)?.state === "done", { what: "run to finish" });
    return rec;
  };
  return { fx, bridge, claude, codex, headers, post, get, state, dispatch, say, thread, finish, close };
}

async function hostSetup({ makeProjects, ...options } = {}) {
  const fx = await makeStateFixture({ git: true });
  const fake = adapter({ thread: () => undefined });
  const host = createHost({ root: fx.root, ...(Object.hasOwn(options, "runtimes") ? {} : { runtime: fake }), policy: { killGraceMs: 30 }, ...(makeProjects ? { projects: makeProjects(fx.root) } : {}), ...options });
  cleanups.push(async () => { for (const runtime of Object.values(options.runtimes ?? { claude: fake })) for (const rec of runtime.spawns) rec.exit({ code: 1 }); await host.shutdown(); await fx.cleanup(); });
  await host.ready;
  return { fx, fake, host };
}

// A passing base proves the fixture, HTTP authentication, worktrees and legacy resume work.
test("legacy baseline: omitted runtime task and follow-up preserve bridge UUID and worktree", async () => {
  const t = await setup({ legacy: true });
  const first = await t.post("/tasks", { role: "architect", text: "Inspect the baskets." });
  const rec = await t.finish(first);
  assert.match(first.body.agent.sessionId, UUID_RE);
  const follow = await t.say({ text: "Inspect the lids too." });
  assert.equal(follow.status, 201, JSON.stringify(follow.body));
  assert.notEqual(follow.body.runId, first.body.agent.id);
  assert.equal(follow.body.agent.sessionId, first.body.agent.sessionId);
  assert.equal(t.claude.spawns.at(-1).args.cwd, rec.args.cwd);
  assert.equal(t.claude.spawns.at(-1).args.resume, true);
  assert.equal(t.codex.spawns.length, 0);
});

test("omitted runtime maps fake adapter and historical records to canonical Claude", async () => {
  const t = await setup({ legacy: true, preWrite: (root) => seedSessions(root, [spawnRow(), endRow()]) });
  const old = (await t.state()).agents.find((a) => a.id === A);
  assert.deepEqual([old.runtime, old.project, old.runtimeSessionId], ["claude", "den", SESSION]);
  const started = await t.post("/tasks", { role: "scout", text: "Inspect baskets." });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.agent.runtime, "claude");
  assert.equal(started.body.agent.runtimeSessionId, started.body.agent.sessionId);
  const saved = (await rows(journal(t.fx.root))).find((r) => r.agentId === started.body.agent.id);
  assert.deepEqual([saved.runtime, saved.project, saved.resourceId], ["claude", "den", started.body.agent.id]);
});

for (const runtime of ["other", null, {}, "", [], 7]) {
  test(`invalid runtime ${JSON.stringify(runtime)} is rejected by every route before side effects`, async () => {
    const t = await setup({ legacy: true });
    const before = await readdir(path.join(t.fx.root, ".claude/worktrees")).catch(() => []);
    const task = await t.post("/tasks", { role: "architect", text: "Inspect baskets.", runtime });
    assert.equal(task.status, 400, JSON.stringify(task.body));
    assert.equal((await t.post("/agents", { ref: DISPATCH_REF, role: "architect", runtime })).status, 400);
    assert.equal((await t.say({ text: "hello", runtime })).status, 400);
    assert.equal(t.claude.preflights, 0);
    assert.equal(t.claude.spawns.length, 0);
    assert.deepEqual(await readdir(path.join(t.fx.root, ".scratch/den/issues")).catch(() => []), []);
    assert.deepEqual(await readdir(path.join(t.fx.root, ".claude/worktrees")).catch(() => []), before);
  });
}

test("host.direct validates runtime before usage, preflight and createTicket", async () => {
  let tickets = 0;
  let usage = 0;
  const t = await hostSetup({ readUsage: async () => { usage += 1; return null; } });
  const res = await t.host.direct({ role: "architect", runtime: "unknown", createTicket: async () => { tickets += 1; return { ref: DISPATCH_REF }; } });
  assert.deepEqual([res.status, tickets, usage, t.fake.preflights, t.fake.spawns.length], [400, 0, 0, 0, 0]);
});

test("known unconfigured Codex is 503 and never falls back to legacy Claude", async () => {
  const t = await setup({ legacy: true });
  assert.equal((await t.post("/tasks", { role: "scout", text: "Inspect baskets.", runtime: "codex" })).status, 503);
  assert.equal((await t.dispatch("codex")).status, 503);
  assert.equal((await t.say({ runtime: "codex", text: "hello" }, "orchestrator")).status, 503, "an unbound Codex desk cannot become Bao's desk");
  assert.equal(t.claude.preflights, 0);
  assert.equal(t.claude.spawns.length, 0);
  assert.deepEqual(await readdir(path.join(t.fx.root, ".scratch/den/issues")).catch(() => []), []);
});

test("runtime registry rejects conflicting shorthand and unknown own keys", async () => {
  const fx = await makeStateFixture();
  cleanups.push(() => fx.cleanup());
  for (const options of [{ runtime: adapter(), runtimes: { codex: adapter() } }, { runtimes: { surprise: adapter() } }]) {
    let host;
    try { assert.throws(() => { host = createHost({ root: fx.root, ...options }); }); }
    finally { if (host) { await host.ready; await host.shutdown(); } }
  }
});

test("each selected adapter receives its own usage/preflight/recipe and all launches get runId", async () => {
  const reads = [];
  const t = await setup({ usage: async () => 1, usageByRuntime: { claude: async () => { reads.push("claude"); return 10; }, codex: async () => { reads.push("codex"); return null; } } });
  const a = await t.post("/tasks", { role: "architect", text: "Inspect baskets.", runtime: "claude" });
  const b = await t.post("/tasks", { role: "scout", text: "Inspect lids.", runtime: "codex" });
  assert.deepEqual([a.status, b.status], [201, 201]);
  for (const [runtime, role, fake, result, recipe] of [["claude", "architect", t.claude, a, ".claude/agents/architect.md"], ["codex", "scout", t.codex, b, ".codex/agents/scout.toml"]]) {
    const { args } = fake.spawns[0];
    assert.equal(result.body.agent.runtime, runtime);
    assert.equal(args.runId, result.body.agent.id);
    assert.equal(args.project.recipeFile, path.join(t.fx.root, recipe));
    assert.ok(args.prompt.includes(recipe), `${runtime} trusted recipe is named`);
    assert.equal(args.role, role);
    assert.ok(fake.preflights > 0);
    assert.ok(reads.includes(runtime));
  }
  assert.equal(b.body.usageUnknown, true);
});

test("Claude and Codex share two worker slots and concurrent same-ticket exclusion", async () => {
  const t = await setup();
  const competing = await Promise.all([t.dispatch("claude"), t.dispatch("codex")]);
  assert.deepEqual(competing.map((r) => r.status).sort(), [201, 409]);
  assert.equal(t.claude.spawns.length + t.codex.spawns.length, 1);
  const second = await t.post("/tasks", { role: "scout", text: "Inspect lids.", runtime: competing[0].status === 201 ? "codex" : "claude" });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const third = await t.post("/tasks", { role: "herald", text: "Inspect cups.", runtime: "codex" });
  assert.equal(third.status, 429);
  assert.equal(t.claude.spawns.length + t.codex.spawns.length, 2);
});

test("role and mode restrictions remain shared for both runtime selectors", async () => {
  const t = await setup();
  for (const runtime of ["claude", "codex"]) {
    for (const body of [{ role: "wizard" }, { role: "runner" }, { role: "architect", mode: "direct" }, { role: "qa", mode: "arbitrary" }]) {
      assert.equal((await t.post("/agents", { ref: DISPATCH_REF, runtime, ...body })).status, 400);
    }
  }
  assert.equal(t.claude.spawns.length + t.codex.spawns.length, 0);
});

for (const project of ["../den", "UPPER", "", null, {}, "not-onboarded"]) {
  test(`project selector ${JSON.stringify(project)} is refused before tasks are written`, async () => {
    const t = await setup({ legacy: true });
    const expected = project === "not-onboarded" ? 409 : 400;
    const result = await t.post("/tasks", { role: "architect", text: "Inspect baskets.", project });
    assert.equal(result.status, expected, JSON.stringify(result.body));
    assert.equal((await t.post("/agents", { role: "architect", ref: DISPATCH_REF, project })).status, expected);
    assert.equal(t.claude.spawns.length, 0);
    assert.equal(t.claude.preflights, 0);
    assert.deepEqual(await readdir(path.join(t.fx.root, ".scratch/den/issues")).catch(() => []), []);
  });
}

async function projectSetup(options = {}) {
  const state = await makeStateFixture({ empty: true });
  const target = await makeStateFixture({ git: true });
  execFileSync("git", ["-C", target.root, "remote", "add", "origin", target.root], { stdio: "pipe" });
  cleanups.push(() => state.cleanup(), () => target.cleanup());
  const t = await setup({ ...options, denState: state.root });
  assert.deepEqual(await addProject(state.root, { slug: "acme", path: target.root, board: { kind: "markdown" } }), { ok: true });
  return { ...t, target, denState: state.root };
}

test("inactive project selector cannot bypass admission or the live-run switch guard", async () => {
  const t = await projectSetup({ legacy: true });
  assert.equal((await t.dispatch("claude", DISPATCH_REF, { project: "acme" })).status, 409);
  assert.equal((await t.post("/tasks", { role: "architect", text: "Inspect baskets.", project: "acme" })).status, 409);
  const started = await t.dispatch("claude", DISPATCH_REF, { project: "den" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal((await t.post("/projects/active", { slug: "acme" })).status, 409);
  await t.finish(started);
  assert.equal((await t.post("/projects/active", { slug: "acme" })).status, 200);
  assert.equal((await t.say({ runId: started.body.agent.id, text: "Resume old project.", project: "den" })).status, 409);
});

test("same-named ticket dispatch uses selected project's eligibility rather than another board", async () => {
  const t = await projectSetup({ legacy: true });
  const ticket = path.join(t.target.root, ".scratch", FEATURE, "issues/02-ready-p0.md");
  const md = await readFile(ticket, "utf8");
  await writeFile(ticket, md.replace("ready-for-agent", "blocked"));
  assert.equal((await t.dispatch("claude", DISPATCH_REF, { project: "acme" })).status, 409);
  assert.equal((await t.post("/projects/active", { slug: "acme" })).status, 200);
  assert.equal((await t.dispatch("claude", DISPATCH_REF, { project: "acme" })).status, 409);
  assert.equal(t.claude.spawns.length, 0);
});

test("direct host captures project before awaited admission and passes callback context", async () => {
  let active = "den";
  let captured;
  const t = await hostSetup({ makeProjects: (root) => ({ active: async () => active, get: async (slug) => slug === "den" ? { slug, root, control: root, workspaces: createWorkspaces(root) } : null }), readUsage: async () => { active = "acme"; return null; } });
  const result = await t.host.direct({ role: "architect", createTicket: async (role, context) => { captured = { role, ...context }; throw new Error("stop after observing ticket context"); } });
  assert.equal(result.status, 500);
  assert.deepEqual(captured, { role: "architect", project: "den", runtime: "claude" });
});

test("gate and foreign-lock callbacks receive fixed project/runtime context", async () => {
  const gates = [], locks = [];
  const t = await hostSetup({ checkGate: async (ref, context) => { gates.push({ ref, ...context }); return "ok"; }, lockedRefs: async (context) => { locks.push(context); return []; } });
  const result = await t.host.dispatch({ role: "architect", ref: DISPATCH_REF, project: "den", runtime: "claude" });
  assert.equal(result.status, 201, JSON.stringify(result));
  assert.deepEqual(gates, [{ ref: DISPATCH_REF, project: "den", runtime: "claude" }]);
  assert.deepEqual(locks, [{ project: "den" }]);
});

test("ledger and end callbacks carry validated canonical runtime and acknowledged session identity", async () => {
  const codex = adapter();
  const ledger = [], ended = [];
  const t = await hostSetup({ runtimes: { claude: adapter({ thread: () => undefined }), codex }, recordRun: async (run) => { ledger.push(run); }, onEnd: async (run) => { ended.push(run); } });
  const result = await t.host.start({ ref: DISPATCH_REF, role: "architect", runtime: "codex" });
  assert.equal(result.status, 201, JSON.stringify(result));
  codex.spawns[0].emit({ type: "done", ok: true });
  await until(() => ledger.length === 1 && ended.length === 1);
  for (const run of [ledger[0], ended[0]]) {
    assert.deepEqual([run.agentId, run.runtime, run.runtimeSessionId], [result.agent.id, "codex", "thread_codex_01"]);
  }
});

test("matching role and identical thread strings never join Claude/Codex conversation tuples", async () => {
  const t = await setup({ claude: adapter({ thread: "same_thread" }), codex: adapter({ thread: "same_thread" }) });
  const a = await t.post("/tasks", { role: "architect", text: "Inspect baskets.", runtime: "claude" });
  const b = await t.post("/tasks", { role: "architect", text: "Inspect lids.", runtime: "codex" });
  assert.deepEqual([a.status, b.status], [201, 201]);
  t.claude.spawns[0].emit({ type: "text", text: "Claude basket report." });
  t.codex.spawns[0].emit({ type: "text", text: "Codex lid report." });
  await until(async () => (await t.thread("codex")).body.entries.some((e) => e.text === "Codex lid report."));
  const ca = (await t.thread()).body.entries;
  const co = (await t.thread("codex")).body.entries;
  assert.ok(ca.every((e) => e.runId === a.body.agent.id && e.runtime === "claude" && e.project === "den"));
  assert.ok(co.every((e) => e.runId === b.body.agent.id && e.runtime === "codex" && e.project === "den"));
  assert.equal((await t.say({ runId: b.body.agent.id, text: "wrong default" })).status, 404);
  assert.equal((await t.say({ runId: a.body.agent.id, text: "wrong explicit", runtime: "codex" })).status, 404);
  assert.equal((await t.say({ text: "for Codex", runtime: "codex" })).status, 202);
  assert.deepEqual(t.codex.spawns[0].sent.map((m) => m.text), ["for Codex"]);
  assert.equal(t.claude.spawns[0].sent.length, 0);
  assert.deepEqual((await t.get("/conversations/scout?runtime=codex&project=den")).body.entries, []);
  assert.equal((await t.say({ runtime: "codex", runId: b.body.agent.id, text: "wrong role" }, "scout")).status, 404);
  assert.equal((await send(t.bridge, { path: "/conversations/architect?runtime=codex" })).status, 401);
});

test("Codex resume preserves acknowledged thread and origin while simultaneous follow-ups reserve once", async () => {
  const t = await setup();
  const first = await t.dispatch("codex");
  const original = await t.finish(first, t.codex);
  assert.match(first.body.agent.sessionId, UUID_RE);
  assert.equal(first.body.agent.runtimeSessionId, "thread_codex_01");
  const results = await Promise.all([t.say({ runtime: "codex", text: "follow A", runId: first.body.agent.id }), t.say({ runtime: "codex", text: "follow B", runId: first.body.agent.id })]);
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(t.codex.spawns.length, 2);
  const continued = results.find((r) => r.status === 201);
  const args = t.codex.spawns[1].args;
  assert.deepEqual([args.cwd, args.sessionId, args.runtimeSessionId, args.resume], [original.args.cwd, original.args.sessionId, "thread_codex_01", true]);
  assert.equal(args.runId, continued.body.runId);
  assert.notEqual(args.runId, first.body.agent.id);
  const saved = (await rows(journal(t.fx.root))).filter((r) => r.event === "spawn");
  assert.ok(saved.every((r) => r.runtime === "codex" && r.runtimeSessionId === "thread_codex_01" && r.resourceId === r.agentId));
  assert.equal(saved[1].origin, first.body.agent.id);
  assert.equal(saved[1].resumeOf, first.body.agent.id);
});

for (const bad of [undefined, "", "../thread", "thread with space", "thread;touch", "thread\ncontrol", ["thread"], 42, "x".repeat(257)]) {
  test(`Codex rejects acknowledged thread ${JSON.stringify(bad)} and stops its process`, async () => {
    const codex = adapter({ thread: () => bad });
    const t = await setup({ codex });
    const result = await t.dispatch("codex");
    assert.equal(result.status, 502, JSON.stringify(result.body));
    assert.equal(codex.spawns.length, 1, "the failure is the acknowledgement, not missing runtime configuration");
    await until(() => codex.spawns[0].exited, { what: "invalid identity process to stop" });
    assert.ok(!JSON.stringify(result.body).includes("thread;touch"));
    assert.ok((await t.state()).agents.every((a) => !a.followUp));
  });
}

test("a changed runtime thread on resume fails closed instead of opening another conversation", async () => {
  const t = await setup({ codex: adapter({ thread: (_args, count) => count === 1 ? "original_thread" : "replacement_thread" }) });
  const first = await t.dispatch("codex");
  await t.finish(first, t.codex);
  const result = await t.say({ runtime: "codex", runId: first.body.agent.id, text: "continue" });
  assert.equal(result.status, 502, JSON.stringify(result.body));
  await until(() => t.codex.spawns[1].exited);
  assert.equal(t.codex.spawns[1].args.runtimeSessionId, "original_thread");
});

test("request session fields cannot select or replace the acknowledged runtime session", async () => {
  const t = await setup();
  const first = await t.dispatch("codex", DISPATCH_REF, { runtimeSessionId: "forged_thread", sessionId: SESSION });
  const rec = await t.finish(first, t.codex);
  assert.equal(first.body.agent.runtimeSessionId, "thread_codex_01");
  assert.notEqual(rec.args.sessionId, SESSION);
  const followed = await t.say({ runtime: "codex", text: "continue", runtimeSessionId: "forged_again", sessionId: SESSION });
  assert.equal(followed.status, 201, JSON.stringify(followed.body));
  assert.equal(t.codex.spawns[1].args.runtimeSessionId, "thread_codex_01");
});

for (const thread of ["a", "thread:a.b-c_9", "t".repeat(256)]) {
  test(`Codex accepts allowlisted opaque thread boundary ${thread.length} characters`, async () => {
    const t = await setup({ codex: adapter({ thread }) });
    const result = await t.dispatch("codex");
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.agent.runtimeSessionId, thread);
    assert.match(result.body.agent.sessionId, UUID_RE);
    assert.notEqual(result.body.agent.sessionId, thread);
  });
}

test("Codex thread survives a real bridge restart and resumes on the selected adapter", async () => {
  const t = await setup();
  const first = await t.dispatch("codex");
  const original = await t.finish(first, t.codex);
  await t.close();
  const again = await setup({ root: t.fx.root });
  const replayed = (await again.state()).agents.find((a) => a.id === first.body.agent.id);
  assert.deepEqual([replayed.runtime, replayed.runtimeSessionId, replayed.sessionId], ["codex", "thread_codex_01", first.body.agent.sessionId]);
  const resumed = await again.say({ runtime: "codex", project: "den", runId: first.body.agent.id, text: "Resume after restart." });
  assert.equal(resumed.status, 201, JSON.stringify(resumed.body));
  assert.deepEqual([again.codex.spawns[0].args.cwd, again.codex.spawns[0].args.runtimeSessionId, again.codex.spawns[0].args.sessionId], [original.args.cwd, "thread_codex_01", original.args.sessionId]);
  assert.equal(again.claude.spawns.length, 0);
});

test("follow-up cannot borrow extra worker capacity from its selected runtime", async () => {
  const t = await setup();
  const first = await t.dispatch("codex");
  await t.finish(first, t.codex);
  assert.equal((await t.post("/tasks", { role: "scout", runtime: "claude", text: "Inspect baskets." })).status, 201);
  assert.equal((await t.post("/tasks", { role: "herald", runtime: "codex", text: "Inspect lids." })).status, 201);
  const result = await t.say({ runtime: "codex", runId: first.body.agent.id, text: "continue" });
  assert.equal(result.status, 429);
  assert.equal(t.codex.spawns.length + t.claude.spawns.length, 3, "only the ended run plus two admitted workers exist");
});

test("replay keeps unavailable Codex canonical identity and end patches cannot replace it", async () => {
  const t = await setup({ legacy: true, preWrite: async (root) => {
    await seedSessions(root, [spawnRow({ runtime: "codex", runtimeSessionId: "saved_thread", project: "den", resourceId: A }), endRow(A, { runtime: "claude", runtimeSessionId: "forged", project: "acme", sessionId: "forged" })]);
    await putRows(historyFile(root, "den", "codex"), [entry(A, "Saved Codex report.", { runtime: "codex", project: "den" })]);
  } });
  const old = (await t.state()).agents.find((a) => a.id === A);
  assert.deepEqual([old.runtime, old.runtimeSessionId, old.sessionId, old.project, old.followUp, old.resume], ["codex", "saved_thread", SESSION, "den", false, null]);
  assert.deepEqual((await t.thread("codex")).body.entries.map((e) => e.text), ["Saved Codex report."]);
  assert.equal((await t.say({ runtime: "codex", text: "continue", runId: A })).status, 503);
  assert.equal(t.claude.spawns.length, 0);
  assert.deepEqual(t.claude.resumes, [], "Claude never builds a resume command for a Codex thread");
});

test("poisoned replay identities are never reinterpreted as legacy Claude/den", async () => {
  const invalid = [{ runtime: null }, { runtime: "" }, { runtime: "fake" }, { runtime: {} }, { project: "../den" }, { project: null }, { runtime: "codex" }, { runtime: "codex", runtimeSessionId: "../unsafe" }];
  const t = await setup({ legacy: true, preWrite: (root) => seedSessions(root, [spawnRow(), ...invalid.map((bad, i) => spawnRow({ agentId: `c-${String(i + 1).padStart(16, "0")}`, ...bad }))]) });
  const all = (await t.state()).agents;
  // A bad explicit thread may survive as non-resumable history, but may never obtain a default thread.
  assert.equal(all.filter((a) => a.id !== A && (a.runtime !== "codex" || a.followUp || a.resume)).length, 0);
  assert.equal(all.find((a) => a.id === A)?.runtime, "claude");
});

test("legacy history overlay is attributed by saved run project, never current project or Codex", async () => {
  const t = await projectSetup({ legacy: true, preWrite: async (root) => {
    await seedSessions(root, [spawnRow(), endRow(), spawnRow({ agentId: B, project: "acme" }), endRow(B)]);
    await putRows(historyFile(root), [entry(A, "den history"), entry(B, "acme history"), entry(C, "unknown run stays den"), entry(A, "mismatched explicit", { id: 2, runtime: "codex", project: "den" })]);
  } });
  assert.deepEqual((await t.thread()).body.entries.map((e) => e.text), ["den history", "unknown run stays den"]);
  assert.deepEqual((await t.thread("claude", "acme")).body.entries.map((e) => e.text), ["acme history"]);
  assert.deepEqual((await t.thread("codex", "den")).body.entries, []);
  assert.deepEqual((await t.thread("codex", "acme")).body.entries, []);
  assert.equal((await t.post("/projects/active", { slug: "acme" })).status, 200);
  assert.deepEqual((await t.thread("claude", "den")).body.entries.map((e) => e.text), ["den history", "unknown run stays den"]);
  assert.equal((await t.say({ project: "den", runtime: "claude", runId: B, text: "cross tuple" })).status, 404);
});

test("tuple history combines legacy/new entries with stable pagination and isolated patches", async () => {
  const t = await projectSetup({ legacy: true, preWrite: async (root) => {
    await seedSessions(root, [spawnRow({ project: "acme" }), endRow()]);
    await putRows(historyFile(root), [entry(A, "legacy", { id: 1 }), entry(A, "legacy duplicate", { id: 2 })]);
    await putRows(historyFile(root, "acme", "claude"), [entry(A, "tuple wins", { id: 2, runtime: "claude", project: "acme" }), entry(A, "latest", { id: 3, at: "2026-10-01T10:00:00.000Z", runtime: "claude", project: "acme", status: "queued" }), { runId: A, id: 3, runtime: "codex", project: "acme", status: "applied" }]);
  } });
  const page = (await t.thread("claude", "acme", "&limit=2")).body;
  assert.deepEqual(page.entries.map((e) => e.text), ["tuple wins", "latest"]);
  assert.equal(page.entries[1].status, "queued", "a patch from another tuple cannot alter an entry");
  assert.equal(page.more, true);
  const older = (await t.thread("claude", "acme", `&limit=2&before=${page.before}`)).body;
  assert.deepEqual(older.entries.map((e) => e.text), ["legacy"]);
  assert.equal(older.more, false);
});

test("new tuple files remain private and history reads retain cleaning and bounded tails", async () => {
  const t = await setup({ preWrite: async (root) => {
    const file = historyFile(root, "den", "codex");
    const old = entry(A, "too old", { runtime: "codex", project: "den" });
    const recent = entry(B, "safe\u202e text", { runtime: "codex", project: "den" });
    await putRows(file, [old, " ".repeat(CONVERSATION_READ_BYTES), recent]);
  } });
  const entries = (await t.thread("codex")).body.entries;
  assert.equal(entries.length, 1);
  assert.ok(entries[0].text.includes("safe") && !entries[0].text.includes("\u202e"));
  const started = await t.dispatch("codex");
  await t.finish(started, t.codex);
  await t.thread("codex");
  const file = historyFile(t.fx.root, "den", "codex");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
});

test("restart and project switch preserve mixed runtime/role history with only Claude available", async () => {
  const t = await projectSetup();
  const first = await t.dispatch("codex");
  await t.finish(first, t.codex);
  const oldEntries = (await t.thread("codex")).body.entries;
  await t.close();
  const again = await setup({ root: t.fx.root, legacy: true, denState: t.denState });
  assert.deepEqual((await again.thread("codex")).body.entries, oldEntries);
  assert.equal((await again.post("/projects/active", { slug: "acme" })).status, 200);
  assert.deepEqual((await again.thread("codex", "den")).body.entries, oldEntries);
  assert.equal((await again.say({ project: "den", runtime: "codex", runId: first.body.agent.id, text: "continue" })).status, 409, "inactive target remains ineligible even when history is readable");
  assert.equal((await again.say({ project: "acme", runtime: "codex", runId: first.body.agent.id, text: "wrong project" })).status, 404);
  assert.equal(again.claude.spawns.length, 0);
});

for (const saved of [false, true]) {
  test(`stale Claude liveness uses ${saved ? "saved run resourceId" : "legacy UUID derivation"} and blocks unknown/alive`, async () => {
    const fake = adapter({ thread: () => undefined });
    fake.stillRunning = async (id) => { fake.probes.push(id); return true; };
    const names = workspaceNames({ ref: DISPATCH_REF, agentId: A });
    const t = await setup({ legacy: true, claude: fake, preWrite: (root) => seedSessions(root, [spawnRow({ ...names, ...(saved ? { runtime: "claude", runtimeSessionId: SESSION, resourceId: A } : {}) })]) });
    const result = await t.say({ runId: A, text: "continue" });
    assert.equal(result.status, 409);
    assert.deepEqual(fake.probes, [saved ? A : SESSION]);
    assert.equal(fake.spawns.length, 0);
  });
}

test("stale Codex liveness probes bridge resourceId, never opaque thread, and fails closed on rejection", async () => {
  const codex = adapter();
  codex.stillRunning = async (id) => { codex.probes.push(id); throw new Error("liveness unavailable"); };
  const names = workspaceNames({ ref: DISPATCH_REF, agentId: A });
  const t = await setup({ codex, preWrite: (root) => seedSessions(root, [spawnRow({ ...names, runtime: "codex", runtimeSessionId: "opaque_thread", resourceId: A })]) });
  assert.equal((await t.say({ runtime: "codex", runId: A, text: "continue" })).status, 409);
  assert.deepEqual(codex.probes, [A]);
  assert.deepEqual(t.claude.probes, []);
  assert.equal(codex.spawns.length, 0);
});

test("run-ID actions and shutdown reach only each run's owning process", async () => {
  const t = await setup();
  const a = await t.post("/tasks", { role: "architect", text: "Inspect baskets.", runtime: "claude" });
  const b = await t.post("/tasks", { role: "architect", text: "Inspect lids.", runtime: "codex" });
  assert.deepEqual([a.status, b.status], [201, 201]);
  const co = t.codex.spawns[0], cl = t.claude.spawns[0];
  const sent = await t.post(`/agents/${b.body.agent.id}/message`, { text: "for Codex", runtime: "claude" });
  assert.equal(sent.status, 202);
  assert.equal((await t.post(`/agents/${b.body.agent.id}/message/cancel`, { messageId: sent.body.messageId })).status, 200);
  assert.deepEqual(co.cancelled, [sent.body.messageId]);
  co.emit({ type: "permission-request", requestId: "codex-permission", tool: "Bash", input: { command: "pwd" } });
  const approval = await until(async () => (await t.state()).approvals.find((p) => p.agentId === b.body.agent.id));
  assert.equal((await t.post(`/approvals/${approval.id}`, { decision: "deny", note: "skip" })).status, 200);
  assert.equal(co.decisions.length, 1);
  assert.equal(cl.decisions.length, 0);
  assert.equal((await t.post(`/agents/${b.body.agent.id}/handover`)).status, 202);
  await until(() => co.exited);
  assert.equal(cl.exited, false);
  const next = await t.post("/tasks", { role: "scout", text: "Inspect cups.", runtime: "codex" });
  assert.equal(next.status, 201, JSON.stringify(next.body));
  assert.equal((await t.post(`/agents/${next.body.agent.id}/stop`, { runtime: "claude" })).status, 202);
  await until(() => t.codex.spawns[1].exited);
  assert.equal(cl.exited, false);
  await t.bridge.host.shutdown();
  assert.equal(cl.exited, true);
});

test("selected runtime preflight and usage failures leave the other runtime usable", async () => {
  const codex = adapter();
  codex.preflightResult = { ok: false, reason: "limits-unavailable" };
  const t = await setup({ codex, usageByRuntime: { claude: async () => 10, codex: async () => 10 } });
  assert.equal((await t.dispatch("codex")).status, 503);
  assert.equal((await t.dispatch("claude")).status, 201);
  assert.equal(codex.spawns.length, 0);
});

test("Codex 90 percent usage refuses tasks without consulting the Claude reader", async () => {
  let claudeReads = 0;
  const t = await setup({ usage: async () => { claudeReads += 1; return 1; }, usageByRuntime: { codex: async () => 90 } });
  const before = claudeReads; // /state or startup may read the Claude snapshot independently.
  const result = await t.post("/tasks", { role: "scout", runtime: "codex", text: "Inspect baskets." });
  assert.equal(result.status, 429);
  assert.equal(claudeReads, before);
  assert.equal(t.codex.preflights, 0);
  assert.equal(t.codex.spawns.length + t.claude.spawns.length, 0);
  assert.deepEqual(await readdir(path.join(t.fx.root, ".scratch/den/issues")).catch(() => []), []);
});

test("control-only and delivery project restrictions survive explicit selectors", async () => {
  const t = await projectSetup({ legacy: true });
  assert.equal((await t.dispatch("claude", DISPATCH_REF, { role: "orchestrator", project: "acme" })).status, 409);
  assert.equal((await t.post("/projects/active", { slug: "acme" })).status, 200);
  const delivery = await t.bridge.host.start({ ref: DISPATCH_REF, role: "developer", project: "acme", delivery: { at: "a".repeat(40), since: "b".repeat(40) } });
  assert.equal(delivery.status, 409);
  assert.equal(t.claude.spawns.length, 0);
});

test("spawn identity journal failure stops the process before success is returned", async () => {
  const fake = adapter();
  const original = fake.spawn.bind(fake);
  let root;
  fake.spawn = async (args) => {
    const proc = await original(args);
    await rm(journal(root), { force: true });
    await mkdir(journal(root), { recursive: true }); // deterministic EISDIR, works even under root.
    return proc;
  };
  const t = await setup({ codex: fake });
  root = t.fx.root;
  const result = await t.dispatch("codex");
  assert.equal(result.status, 500, JSON.stringify(result.body));
  await until(() => fake.spawns[0].exited, { what: "unrecorded process to stop" });
  await t.close();
  const again = await setup({ root: t.fx.root });
  assert.deepEqual((await again.state()).agents, [], "a process without a durable spawn cannot be fabricated on restart");
});

test("history selectors reject invalid runtime and project path segments without spawning", async () => {
  const t = await setup({ legacy: true });
  for (const url of ["/conversations/architect?runtime=unknown", "/conversations/architect?runtime=", "/conversations/architect?project=..%2Fden", "/conversations/architect?project="]) {
    assert.equal((await t.get(url)).status, 400, url);
  }
  assert.equal((await t.get("/conversations/architect?project=not-onboarded")).status, 409);
  assert.equal(t.claude.spawns.length, 0);
});
