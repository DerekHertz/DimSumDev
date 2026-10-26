// multi-project/02 (design decisions 26 and 27): what a run in a target project is given: its ticket as a note in the worktree,
// its toolchain read-only, no network. The fake runtime sees the host's spawn; a recording launcher sees the real runtime's.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { addProject } from "../projects.mjs";
import { DISPATCH_REF, makeBridge } from "./host-test-helpers.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { compileCeiling, buildClaudeArgs } from "./claude-adapter.mjs";
import { parseCatalog } from "../library/catalog.mjs";
import { createLibrary } from "../library/library.mjs";

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const sh = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "pipe" });
const TICKET = "# 01: First\n\n**Type:** feature\n\n**Priority:** P1\n\n**Blocked by:** none\n\n**Status:** ready-for-agent\n\nBuild the thing.\n\n## Comments\n\n";

// A target clone whose board is not in git: no `.scratch/` reaches a worktree made from it.
function targetClone() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "acme-")));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "remote", "add", "origin", dir);
  writeFileSync(path.join(dir, "README.md"), "acme\n");
  sh(dir, "add", "README.md");
  sh(dir, "commit", "-q", "-m", "init");
  mkdirSync(path.join(dir, ".scratch", "pf", "issues"), { recursive: true });
  writeFileSync(path.join(dir, ".scratch", "pf", "issues", "01-first.md"), TICKET);
  mkdirSync(path.join(dir, "node_modules"));
  cleanups.unshift(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const REMOTE = { name: "context7", title: "Docs lookup", purpose: "A remote docs service.", url: "https://mcp.example.com/mcp", credential: "none", roles: ["developer"], tools: { lookup: "read" } };
const remoteLibrary = () => createLibrary({ catalog: parseCatalog({ connections: [REMOTE] }) });

async function targetBridge({ toolchain, library }) {
  const denState = realpathSync(mkdtempSync(path.join(tmpdir(), "den-state-")));
  const t = await makeBridge({ denState, ...(library ? { library } : {}) });
  cleanups.push(() => t.close());
  const dir = targetClone();
  assert.deepEqual(await addProject(denState, { slug: "acme", path: dir, board: { kind: "markdown" }, toolchain: toolchain(dir) }), { ok: true });
  assert.equal((await t.post("/projects/active", { slug: "acme" })).status, 200);
  return { t, dir };
}

test("a target run's prompt names .den/ticket.md, the note holds the board's text, and no ticket file or .scratch reaches the target", async () => {
  const { t, dir } = await targetBridge({ toolchain: (d) => [path.join(d, "node_modules")] });
  const started = await t.post("/agents", { ref: "pf/01-first", role: "developer", project: "acme" });
  assert.equal(started.status, 201, started.text);
  const spawn = t.fake.spawns.at(-1);
  assert.match(spawn.args.prompt, /\.den\/ticket\.md/);
  assert.doesNotMatch(spawn.args.prompt, /\.scratch/);
  assert.equal(spawn.args.ticketFile, undefined, "no ticketFile reaches the runtime, so no container mounts a path that may not exist");
  assert.match(readFileSync(path.join(spawn.args.cwd, ".den", "ticket.md"), "utf8"), /^# 01: First[\s\S]*Build the thing\./); // the board text, as the claim left it
  assert.equal(existsSync(path.join(spawn.args.cwd, ".scratch")), false);
  assert.deepEqual(spawn.args.project.toolchain, [path.join(dir, "node_modules")]);
  assert.equal(execFileSync("git", ["-C", spawn.args.cwd, "status", "--porcelain"], { encoding: "utf8" }), "", ".den/ticket.md is excluded like the other notes");
});

test("the den's own run still names its markdown ticket file and passes no toolchain", async () => {
  const t = await makeBridge();
  cleanups.push(() => t.close());
  const started = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.equal(started.status, 201, started.text);
  const spawn = t.fake.spawns.at(-1);
  assert.match(spawn.args.prompt, /\.scratch\/.*\.md/);
  assert.doesNotMatch(spawn.args.prompt, /\.den\/ticket\.md/);
  assert.equal(typeof spawn.args.ticketFile, "string");
  assert.equal("toolchain" in spawn.args.project, false);
});

test("a missing toolchain path refuses the run, names the setup step, and starts and creates nothing", async () => {
  const { t, dir } = await targetBridge({ toolchain: (d) => [path.join(d, "node_modules")] });
  await rm(path.join(dir, "node_modules"), { recursive: true });
  const before = t.fake.spawns.length;
  const refused = await t.post("/agents", { ref: "pf/01-first", role: "developer", project: "acme" });
  assert.equal(refused.status, 409, refused.text);
  assert.match(refused.body.error ?? refused.text, /node_modules.*does not exist.*setup step.*target-project-setup\.md/s);
  assert.equal(t.fake.spawns.length, before);
  assert.equal(existsSync(path.join(dir, "node_modules")), false, "nothing created the path");
});

test("a toolchain entry that became a symlink to /etc refuses the run; one to a plain folder is passed on resolved", async () => {
  const { t, dir } = await targetBridge({ toolchain: (d) => [path.join(d, "node_modules")] });
  await rm(path.join(dir, "node_modules"), { recursive: true });
  symlinkSync("/etc", path.join(dir, "node_modules"));
  const before = t.fake.spawns.length;
  const refused = await t.post("/agents", { ref: "pf/01-first", role: "developer", project: "acme" });
  assert.equal(refused.status, 409, refused.text);
  assert.match(refused.body.error ?? refused.text, /\/etc/);
  assert.equal(t.fake.spawns.length, before);
  await rm(path.join(dir, "node_modules"));
  const real = realpathSync(mkdtempSync(path.join(tmpdir(), "den-tc-")));
  symlinkSync(real, path.join(dir, "node_modules"));
  const ok = await t.post("/agents", { ref: "pf/01-first", role: "developer", project: "acme" });
  assert.equal(ok.status, 201, ok.text);
  assert.deepEqual(t.fake.spawns.at(-1).args.project.toolchain, [real]);
});

// The real runtime, with a launcher that records what it is given.
function recordingRuntime() {
  const controlDir = realpathSync(mkdtempSync(path.join(tmpdir(), "den-control-")));
  const seen = [];
  const launcher = { enforced: true, container: true, limits: undefined, launch: async (run) => { seen.push(run); throw new Error("stop"); } };
  return { seen, runtime: createClaudeRuntime({ launcher, controlRoot: controlDir, env: { PATH: process.env.PATH, HOME: process.env.HOME, DEN_CLAUDE_BIN: "claude" } }) };
}

test("a target spawn: toolchain reopened for reads, no network hosts, and both launchers are told", async () => {
  const dir = targetClone();
  const wt = path.join(dir, ".worktrees", "w1");
  mkdirSync(wt, { recursive: true });
  const tc = path.join(dir, "node_modules");
  const { seen, runtime } = recordingRuntime();
  await assert.rejects(runtime.spawn({ role: "developer", cwd: wt, prompt: "go", sessionId: "7f1f6f0e-0000-4000-8000-000000000001", project: { control: false, root: dir, pluginDir: path.join(dir, ".claude"), recipeFile: path.join(dir, ".claude", "agents", "developer.md"), toolchain: [tc] } }), /stop/);
  const settings = JSON.parse(seen[0].args[seen[0].args.indexOf("--settings") + 1]);
  assert.deepEqual(settings.sandbox.network.allowedDomains, [], "an empty host list: the shell has no network");
  assert.ok(settings.sandbox.filesystem.allowRead.includes(tc), "host mode: the toolchain is a readOpen path");
  assert.ok(settings.sandbox.filesystem.denyRead.includes("~/"), "the read limit holds for a target run");
  assert.deepEqual(seen[0].container.toolchain, [tc]);
  assert.equal(seen[0].container.target, true);
  assert.equal(seen[0].container.ticketFile, undefined);
});

test("compileCeiling: a target gets no hosts and refuses a host grant; more than eight reopened paths is refused", () => {
  const tc = ["/p/node_modules"];
  const c = compileCeiling("developer", { worktree: "/p/.worktrees/w", target: true, projectToolchain: tc, toolchain: "/n" });
  assert.deepEqual(c.wall.hosts, []);
  assert.equal(c.readLimit, true);
  assert.ok(c.readOpen.includes("/p/node_modules"));
  assert.doesNotThrow(() => buildClaudeArgs({ sessionId: "7f1f6f0e-0000-4000-8000-000000000001", agent: "developer", ...c }));
  assert.throws(() => compileCeiling("developer", { worktree: "/p/.worktrees/w", target: true, grants: [{ kind: "host", value: "example.com" }] }), /no host grants/);
  assert.throws(() => compileCeiling("developer", { worktree: "/p/.worktrees/w", target: true, projectToolchain: Array.from({ length: 9 }, (_, i) => `/t/${i}`) }), /at most eight/);
});

// Security bounce (HIGH): the CLI calls a remote connection outside the sandbox, so a target run gets no connections at all.
test("a target developer run is started with no connections; the den's own developer run keeps its role's", async () => {
  const { t } = await targetBridge({ toolchain: (d) => [path.join(d, "node_modules")], library: remoteLibrary() });
  const started = await t.post("/agents", { ref: "pf/01-first", role: "developer", project: "acme" });
  assert.equal(started.status, 201, started.text);
  assert.equal("connections" in t.fake.spawns.at(-1).args, false, "no connection reaches a target run");

  const den = await makeBridge({ library: remoteLibrary() });
  cleanups.push(() => den.close());
  const own = await den.post("/agents", { ref: DISPATCH_REF, role: "developer" });
  assert.equal(own.status, 201, own.text);
  assert.deepEqual(den.fake.spawns.at(-1).args.connections?.map((c) => c.name), ["context7"], "the den's run is unchanged");
});

test("a target spawn handed a remote connection anyway writes no connection into the settings or the mcp config, or does not start", async () => {
  const dir = targetClone();
  const wt = path.join(dir, ".worktrees", "w2");
  mkdirSync(wt, { recursive: true });
  const { seen, runtime } = recordingRuntime();
  const project = { control: false, root: dir, pluginDir: path.join(dir, ".claude"), recipeFile: path.join(dir, ".claude", "agents", "developer.md"), toolchain: [path.join(dir, "node_modules")] };
  await assert.rejects(runtime.spawn({ role: "developer", cwd: wt, prompt: "go", sessionId: "7f1f6f0e-0000-4000-8000-000000000002", project, connections: [{ name: "docs", url: "https://mcp.example.com/mcp" }] }), /remote connection/);
  assert.equal(seen.length, 0, "fail closed: nothing was launched");
  // the same spawn with no connections: the mcp config is empty
  await assert.rejects(runtime.spawn({ role: "developer", cwd: wt, prompt: "go", sessionId: "7f1f6f0e-0000-4000-8000-000000000003", project }), /stop/);
  assert.equal(seen[0].args.includes("--mcp-config") && seen[0].args[seen[0].args.indexOf("--mcp-config") + 1].includes("example.com"), false);
});

test("compileCeiling: a target ceiling and a remote connection together throw", () => {
  assert.throws(() => compileCeiling("developer", { worktree: "/p/.worktrees/w", target: true, remote: true }), /target run takes no remote connection/);
  assert.doesNotThrow(() => compileCeiling("developer", { worktree: "/p/.worktrees/w", target: true, remote: false }));
  assert.doesNotThrow(() => compileCeiling("developer", { worktree: "/p/.worktrees/w", remote: true }), "a den run keeps remote");
});

// Security LOW 2: a toolchain entry is a read-only reopen; it may not be the control checkout, hold it, or be /etc.
test("compileCeiling: a toolchain entry that is, holds or sits in the control checkout, or is /etc, is refused naming the setup step", () => {
  const base = { worktree: "/p/.worktrees/w", target: true, control: "/den" };
  for (const bad of ["/etc", "/etc/ssl", "/den", "/den/.scratch", "/den/apps/ui"]) {
    assert.throws(() => compileCeiling("developer", { ...base, projectToolchain: [bad] }), /toolchain.*setup step|may not/, bad);
  }
  assert.throws(() => compileCeiling("developer", { ...base, control: "/srv/den/checkout", projectToolchain: ["/srv/den"] }), /toolchain.*setup step/);
  assert.doesNotThrow(() => compileCeiling("developer", { ...base, projectToolchain: ["/p/node_modules", "/opt/etcetera"] }));
  assert.doesNotThrow(() => compileCeiling("developer", { ...base, projectToolchain: ["/denim/node_modules"] }), "a sibling with the same prefix is fine");
});

test("a registry toolchain entry inside the control checkout refuses the run with a 409 that names the setup step", async () => {
  const denState = realpathSync(mkdtempSync(path.join(tmpdir(), "den-state-")));
  const t = await makeBridge({ denState });
  cleanups.push(() => t.close());
  const dir = targetClone();
  assert.deepEqual(await addProject(denState, { slug: "acme", path: dir, board: { kind: "markdown" }, toolchain: [path.join(realpathSync(t.fx.root), ".scratch")] }), { ok: true });
  assert.equal((await t.post("/projects/active", { slug: "acme" })).status, 200);
  const before = t.fake.spawns.length;
  const refused = await t.post("/agents", { ref: "pf/01-first", role: "developer", project: "acme" });
  assert.equal(refused.status, 409, refused.text);
  assert.match(refused.body.error ?? refused.text, /control checkout.*setup step|setup step.*control checkout/s);
  assert.equal(t.fake.spawns.length, before);
});
