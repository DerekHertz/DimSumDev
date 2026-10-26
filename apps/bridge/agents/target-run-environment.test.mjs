// multi-project/02 (design decisions 26 and 27): what a run in a target project is given: its ticket as a note in the worktree,
// its toolchain read-only, no network. The fake runtime sees the host's spawn; a recording launcher sees the real runtime's.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { addProject } from "../projects.mjs";
import { DISPATCH_REF, makeBridge } from "./host-test-helpers.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { compileCeiling, buildClaudeArgs } from "./claude-adapter.mjs";

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

async function targetBridge({ toolchain }) {
  const denState = realpathSync(mkdtempSync(path.join(tmpdir(), "den-state-")));
  const t = await makeBridge({ denState });
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

// The real runtime, with a launcher that records what it is given.
function recordingRuntime(root) {
  const seen = [];
  const launcher = { enforced: true, container: true, limits: undefined, launch: async (run) => { seen.push(run); throw new Error("stop"); } };
  return { seen, runtime: createClaudeRuntime({ launcher, controlRoot: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, DEN_CLAUDE_BIN: "claude" } }) };
}

test("a target spawn: toolchain reopened for reads, no network hosts, and both launchers are told", async () => {
  const dir = targetClone();
  const wt = path.join(dir, ".worktrees", "w1");
  mkdirSync(wt, { recursive: true });
  const tc = path.join(dir, "node_modules");
  const { seen, runtime } = recordingRuntime(dir);
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
