// den-mvp/49 security bounce, finding 1 (HIGH, the 48 carry-over): the bridge, not a client, hands every spawn its project handle.
// A target run gets the target flags end to end; a spawn that carries no project and sits outside the control checkout is refused.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startBridge } from "../server.mjs";
import { makeStateFixture } from "../bridge-fixture.mjs";
import { CODE, login, authed, send } from "../bridge-auth-helpers.mjs";
import { addProject } from "../projects.mjs";
import { DISPATCH_REF, makeBridge, until } from "./host-test-helpers.mjs";
import { makeStub, alive } from "./claude-stub.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { unconfinedLauncher } from "./launcher-test-helpers.mjs";

const SESSION = "0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b10";
const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const sh = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "pipe" });

function projectRepo() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "acme-")));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "remote", "add", "origin", dir);
  const issues = path.join(dir, ".scratch", "pf", "issues");
  mkdirSync(issues, { recursive: true });
  writeFileSync(path.join(issues, "01-first.md"), "# 01: First\n\n**Type:** feature\n\n**Priority:** P1\n\n**Blocked by:** none\n\n**Status:** ready-for-agent\n\n## Comments\n\n");
  sh(dir, "add", "-f", ".scratch");
  sh(dir, "commit", "-q", "-m", "init");
  cleanups.unshift(() => rm(dir, { recursive: true, force: true })); // runs last, after the bridge has closed
  return dir;
}

test("a target project's chief-of-staff meeting chair remains a target run", async () => {
  const denState = realpathSync(mkdtempSync(path.join(tmpdir(), "den-state-")));
  const t = await makeBridge({ denState });
  cleanups.push(() => t.close());
  const dir = projectRepo();
  assert.deepEqual(await addProject(denState, { slug: "acme", path: dir, board: { kind: "markdown" } }), { ok: true });
  const result = await t.bridge.host.start({ ref: "meetings/00-m-test", role: "chief-of-staff", project: "acme",
    meeting: { part: "chair", file: "Private meeting fixture", effort: "medium", moderator: "bao", standalone: true, taskRef: null } });
  assert.equal(result.status, 201, result.error);
  assert.equal(result.agent.project, "acme");
  assert.equal(t.fake.spawns[0].args.project.control, false);
  assert.equal(t.fake.spawns[0].args.project.root, dir);
});

test("the fake runtime sees a bridge-derived project on a den run, a target run and a follow-up", async () => {
  const denState = realpathSync(mkdtempSync(path.join(tmpdir(), "den-state-")));
  const t = await makeBridge({ denState });
  cleanups.push(() => t.close());
  const dir = projectRepo();
  assert.deepEqual(await addProject(denState, { slug: "acme", path: dir, board: { kind: "markdown" } }), { ok: true });
  const pluginDir = path.join(t.fx.root, ".claude");
  const recipeFile = path.join(pluginDir, "agents", "architect.md");

  const den = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.equal(den.status, 201, den.text);
  assert.deepEqual(t.fake.spawns.at(-1).args.project, { control: true, root: t.fx.root, pluginDir, recipeFile });
  t.fake.spawns.at(-1).exit();
  await until(async () => (await t.state()).agents.find((a) => a.id === den.body.agent.id)?.state !== "working", { what: "the den run to end" });

  assert.equal((await t.post("/projects/active", { slug: "acme" })).status, 200);
  // The selector accepts an onboarded slug, never client-supplied execution paths.
  const count = t.fake.spawns.length;
  const forged = await t.post("/agents", { ref: "pf/01-first", role: "architect", project: { control: true, root: "/tmp", pluginDir: "/tmp/.claude" } });
  assert.equal(forged.status, 400, forged.text);
  assert.equal(t.fake.spawns.length, count);
  const started = await t.post("/agents", { ref: "pf/01-first", role: "architect", project: "acme" });
  assert.equal(started.status, 201, started.text);
  assert.deepEqual(t.fake.spawns.at(-1).args.project, { control: false, root: dir, pluginDir, recipeFile });
  t.fake.spawns.at(-1).exit();
  await until(async () => (await t.state()).agents.find((a) => a.id === started.body.agent.id)?.state !== "working", { what: "the target run to end" });

  const follow = await t.post("/conversations/architect/message", { text: "and then?", runId: started.body.agent.id });
  assert.equal(follow.status, 201, follow.text);
  assert.equal(follow.body.resumed, true);
  assert.deepEqual(t.fake.spawns.at(-1).args.project, { control: false, root: dir, pluginDir, recipeFile });
});

test("a target run started with host.start gets the target flags from the real runtime", async () => {
  const fx = await makeStateFixture({ git: true });
  const denState = realpathSync(mkdtempSync(path.join(tmpdir(), "den-state-")));
  const stub = await makeStub({ mode: "hang" });
  const runtime = createClaudeRuntime({ launcher: unconfinedLauncher(), controlRoot: fx.root, env: { PATH: process.env.PATH, HOME: process.env.HOME, DEN_CLAUDE_BIN: stub.bin } });
  const bridge = await startBridge({ root: fx.root, port: 0, auth: { launchCode: CODE }, runtime, denState, policy: { killGraceMs: 150 } });
  const headers = authed(bridge, await login(bridge));
  cleanups.push(async () => {
    const start = await stub.start();
    if (start?.pid && alive(start.pid)) process.kill(start.pid, "SIGKILL");
    await bridge.close();
    await fx.cleanup();
  });
  const post = (p, body = {}) => send(bridge, { method: "POST", path: p, body, headers });
  const dir = projectRepo();
  assert.deepEqual(await addProject(denState, { slug: "acme", path: dir, board: { kind: "markdown" } }), { ok: true });
  assert.equal((await post("/projects/active", { slug: "acme" })).status, 200);
  const started = await post("/agents", { ref: "pf/01-first", role: "architect" });
  assert.equal(started.status, 201, started.text);
  const argv = (await until(() => stub.start(), { what: "the stub to start" })).argv;
  const flag = (f) => argv[argv.indexOf(f) + 1];
  assert.equal(flag("--setting-sources"), "");
  assert.equal(flag("--plugin-dir"), path.join(fx.root, ".claude"));
  assert.equal(flag("--agent"), "den:architect");
});

test("the runtime refuses a spawn with no project whose cwd is outside the control checkout, and starts nothing", async () => {
  const control = await mkdtemp(path.join(tmpdir(), "den-ctl-"));
  const outside = await mkdtemp(path.join(tmpdir(), "den-out-"));
  cleanups.push(() => rm(control, { recursive: true, force: true }), () => rm(outside, { recursive: true, force: true }));
  const launched = [];
  const launcher = { ...unconfinedLauncher(), launch: async (...a) => { launched.push(a); throw new Error("no launch"); } };
  const runtime = createClaudeRuntime({ launcher, controlRoot: control, env: { PATH: process.env.PATH, HOME: outside, DEN_CLAUDE_BIN: "claude" } });
  await assert.rejects(runtime.spawn({ role: "developer", cwd: outside, prompt: "go", sessionId: SESSION }), /project/);
  // A sibling that only shares the control path as a string prefix is outside too.
  await assert.rejects(runtime.spawn({ role: "developer", cwd: `${control}-evil`, prompt: "go", sessionId: SESSION }), /project/);
  assert.equal(launched.length, 0);
  // Inside the control checkout it is the den's own, and gets as far as the launcher.
  await assert.rejects(runtime.spawn({ role: "developer", cwd: path.join(control, ".claude", "worktrees", "x"), prompt: "go", sessionId: SESSION }), /no launch/);
});
