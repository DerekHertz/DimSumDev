// hardening/10 (ADR 0031): the pure half of "the bridge spawns agents in containers": the `docker run` argv built from the ceiling.
import assert from "node:assert/strict";
import test from "node:test";
import { SAFE_GIT, containerCliArgs, containerRunArgs } from "./container.mjs";
import { LIMITS } from "./resource-group.mjs";

const base = {
  image: "den-agent:0123456789ab", name: "den-agent-abcd1234", worktree: "/h/repo/.claude/worktrees/w1", mainGit: "/h/repo/.git",
  limits: LIMITS.classes.worker, env: { HOME: "/root", ANTHROPIC_BASE_URL: "http://den-proxy:8080" }, cliArgs: ["-p", "--verbose"],
};
const pairs = (argv, flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));

test("the argv carries the isolation flags of ADR 0031 decision 2", () => {
  const a = containerRunArgs(base);
  assert.deepEqual(a.slice(0, 5), ["run", "--rm", "-i", "--name", "den-agent-abcd1234"]);
  assert.deepEqual(pairs(a, "--network"), ["den-agents"]);
  assert.deepEqual(pairs(a, "--user"), ["0:0"]);
  assert.deepEqual(pairs(a, "--cap-drop"), ["ALL"]);
  assert.deepEqual(pairs(a, "--security-opt"), ["no-new-privileges"]);
  assert.ok(a.includes("--read-only"));
  assert.deepEqual(pairs(a, "--tmpfs").map((t) => t.split(":")[0]), ["/tmp", "/root"]);
  assert.deepEqual(a.slice(-4), ["den-agent:0123456789ab", "claude", "-p", "--verbose"]);
});

test("limits come from the class: memory, memory-swap equal to memory, cpus, pids", () => {
  const g = LIMITS.classes.worker;
  const a = containerRunArgs(base);
  assert.deepEqual(pairs(a, "--memory"), [`${g.memoryMiB}m`]);
  assert.deepEqual(pairs(a, "--memory-swap"), [`${g.memoryMiB}m`]);
  assert.deepEqual(pairs(a, "--cpus"), [String(g.cpuPercent / 100)]);
  assert.deepEqual(pairs(a, "--pids-limit"), [String(g.tasks)]);
  const bao = containerRunArgs({ ...base, limits: LIMITS.classes.bao });
  assert.deepEqual(pairs(bao, "--cpus"), ["0.5"]);
});

test("mounts: the worktree read-write, the main .git read-only with only what a commit writes read-write, each at its host path", () => {
  const v = pairs(containerRunArgs(base), "-v");
  assert.deepEqual(v, [
    "/h/repo/.claude/worktrees/w1:/h/repo/.claude/worktrees/w1:rw",
    "/h/repo/.git:/h/repo/.git:ro",
    "/h/repo/.git/worktrees/w1:/h/repo/.git/worktrees/w1:rw",
    "/h/repo/.git/objects:/h/repo/.git/objects:rw",
    "/h/repo/.git/logs:/h/repo/.git/logs:rw",
  ]);
  assert.deepEqual(pairs(containerRunArgs(base), "-w"), ["/h/repo/.claude/worktrees/w1"]);
});

test("a branch namespace, the ticket file and path grants add their own mounts; nothing else", () => {
  const v = pairs(containerRunArgs({ ...base, refsNamespace: "den", ticketFile: "/h/repo/.scratch/f/issues/01-x.md", grants: ["/h/data"] }), "-v");
  assert.ok(v.includes("/h/repo/.git/refs/heads/den:/h/repo/.git/refs/heads/den:rw"));
  assert.ok(v.includes("/h/repo/.scratch/f/issues/01-x.md:/h/repo/.scratch/f/issues/01-x.md:ro"));
  assert.ok(v.includes("/h/data:/h/data:rw"));
  assert.equal(v.length, 8);
});

test("the proxy env reaches the container as -e; no host env does", () => {
  const e = pairs(containerRunArgs(base), "-e");
  assert.deepEqual(e, ["HOME=/root", "ANTHROPIC_BASE_URL=http://den-proxy:8080"]);
});

test("a path or name that could add a mount option or a flag is refused", () => {
  for (const bad of [{ worktree: "/h/a:b" }, { mainGit: "/h/.git,ro" }, { name: "x --privileged" }, { image: "-v" }, { ticketFile: "/h/x/../y" }, { grants: ["/h/a b"] }, { refsNamespace: "../main" }]) {
    assert.throws(() => containerRunArgs({ ...base, ...bad }), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => containerRunArgs({ ...base, limits: { memoryMiB: 0, cpuPercent: 100, tasks: 8 } }), TypeError);
});

test("the CLI's own sandbox block is dropped inside the container, and Bash is allowed; the permission denies stay", () => {
  const settings = JSON.stringify({ disableAllHooks: true, permissions: { deny: ["Bash(git push:*)"], allow: ["Read(/x)"] }, sandbox: { enabled: true, failIfUnavailable: true } });
  const out = containerCliArgs(["-p", "--settings", settings]);
  assert.deepEqual(out.slice(0, 2), ["-p", "--settings"]);
  const s = JSON.parse(out[2]);
  assert.equal(s.sandbox, undefined);
  assert.equal(s.disableAllHooks, true);
  assert.deepEqual(s.permissions.deny, ["Bash(git push:*)"]);
  assert.deepEqual(s.permissions.allow, ["Read(/x)", "Bash"]);
  assert.throws(() => containerCliArgs(["-p"]), TypeError);
});

test("host-side git in an agent worktree runs with fsmonitor and hooks switched off", () => {
  assert.deepEqual([...SAFE_GIT], ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"]);
});

// hardening/10 fix round (security M1): the CLI sandbox's write denies (guardrail and CI paths) are dropped in the container, so
// they are mounted read-only over the rw worktree and grants instead: a Bash redirect into .claude/ then fails with EROFS.
test("readOnly paths are mounted ro after every rw mount, and only plain absolute paths are taken", () => {
  const ro = ["/h/repo/.claude/worktrees/w1/.claude", "/h/repo/.claude/worktrees/w1/.github/workflows"];
  const v = pairs(containerRunArgs({ ...base, grants: ["/h/notes"], readOnly: ro }), "-v");
  assert.deepEqual(v.slice(-2), ro.map((p) => `${p}:${p}:ro`));
  assert.throws(() => containerRunArgs({ ...base, readOnly: ["/h/a:/etc"] }), TypeError);
});

test("governedWrites: the sandbox's denyWrite paths under a rw mount, and nothing else", async () => {
  const { governedWrites } = await import("./container.mjs");
  const wt = base.worktree;
  const settings = { permissions: {}, sandbox: { filesystem: { denyWrite: [`${wt}/.claude`, `${wt}/.github/workflows`, "/h/notes/x", "/h/repo/.git/refs", ".claude"] } } };
  assert.deepEqual(governedWrites(["-p", "--settings", JSON.stringify(settings)], [wt, "/h/notes"]), [`${wt}/.claude`, `${wt}/.github/workflows`, "/h/notes/x"]);
});
