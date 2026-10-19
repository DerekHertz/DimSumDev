// organism-infra/165: three hardenings of scripts/hooks/context-budget.mjs (the 162 security lows).
//
// Seam: the hook CLI (PreToolUse JSON on stdin, HOME=<fixture>), as in context-budget.test.mjs. The
// calls run as a security agent at 95k, which is over the stop limit for that role (80k) in any tiering.
//
// Contract pinned here:
//   1. A backslash outside single quotes makes a command chain-unsafe, so `git commit -m \"x; touch
//      /tmp/y; echo \"` is refused at the stop limit. Quoted text with a backslash inside single quotes
//      stays a simple command; plain double-quoted commit messages still pass.
//   2. A Write/Edit counts as a wrap-up write only under the main checkout's .scratch/ (and the session
//      scratchpad, unchanged). The main checkout is $DEN_ROOT when set, else the first entry of
//      `git worktree list` run from the call's cwd. A .scratch/ under src/, under the agent's own worktree,
//      or anywhere else is refused.
//   3. A session_id that fails /^[\w.-]+$/ is never handed to context.mjs: the hook reads no context
//      and allows the call (fails open).
//
// Criterion map:
//   AC1 backslash-hidden chain refused            -> "a backslash-escaped quote ..." tests, "backslash inside single quotes ..."
//   AC2 .scratch outside the main checkout refused -> "a .scratch/ outside the main checkout ..." tests
//   AC2 main .scratch and scratchpad still allowed -> "main checkout .scratch ... allowed" tests
//   AC3 bad session_id fails open                 -> "a session_id that fails ..." test
//   AC4 existing 162 tests still pass             -> the 162 test files (agent_type moved to security, see handoff)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.resolve(fileURLToPath(new URL("../..", import.meta.url))), "scripts", "hooks", "context-budget.mjs");
const SESSION = "orch-session-165";
const PAD = `/tmp/claude-1000/-fixture-project/${SESSION}/scratchpad`;

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const rec = (cwd, n) => JSON.stringify({ type: "assistant", cwd, message: { role: "assistant", usage: { input_tokens: n, output_tokens: 1 } } });

// A real git repo `main` with a linked worktree `wt` (the agent's cwd); the agent's transcript reports `tokens`.
// `sessionDirs` lists extra session dir names (relative to projects/) that also hold a 95k transcript.
function fixture(tokens = 95_000, { extraSessionDirs = [] } = {}) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "ctx-hard-")));
  const main = path.join(home, "main");
  mkdirSync(main, { recursive: true });
  git(main, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(main, "a.txt"), "a");
  git(main, ["add", "a.txt"]);
  git(main, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "A"]);
  const wt = path.join(home, "worktrees", "agent-a");
  git(main, ["worktree", "add", "-q", "--detach", wt, "main"]);
  const projects = path.join(home, ".claude", "projects");
  for (const dir of [path.join("-fixture-project", SESSION), ...extraSessionDirs]) {
    const sub = path.join(projects, dir, "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "agent-a.jsonl"), rec(wt, tokens) + "\n");
  }
  return { home, main, wt };
}

function hook(f, tool, toolInput, { sessionId = SESSION, denRoot = null } = {}) {
  const env = { ...process.env, HOME: f.home };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.DEN_ROOT;
  // organism-infra/220: mechanics at 70k/80k through the config seam (shipped numbers: tiers test).
  const cfg = path.join(f.home, "mechanics-budget.json");
  writeFileSync(cfg, JSON.stringify({ default: { warn: 70_000, stop: 80_000 }, roles: {}, orchestrator: { warn: 70_000, stop: 80_000 } }));
  env.CONTEXT_BUDGET_CONFIG = cfg;
  if (denRoot) env.DEN_ROOT = denRoot;
  const input = { session_id: sessionId, cwd: f.wt, hook_event_name: "PreToolUse", tool_name: tool, tool_input: toolInput, agent_id: "agent-a", agent_type: "security" };
  return spawnSync("node", [SCRIPT], { cwd: f.wt, env, input: JSON.stringify(input), encoding: "utf8", timeout: 15000 });
}

const bash = (f, command) => hook(f, "Bash", { command });
const refused = (r, label) => assert.equal(r.status, 2, `${label}: expected refusal, got ${r.status}\n${r.stdout}${r.stderr}`);
const allowed = (r, label) => assert.equal(r.status, 0, `${label}: expected allow, got ${r.status}\n${r.stderr}`);

// AC1 ---------------------------------------------------------------------------------------

test("a backslash-escaped quote hiding a chain is refused at the stop limit", () => {
  const f = fixture();
  refused(bash(f, 'git commit -m \\"x; touch /tmp/y; echo \\"'), "escaped quotes hide the chain");
  refused(bash(f, 'git commit -m "x\\"; touch /tmp/y; echo \\""'), "backslash inside double quotes");
  refused(bash(f, "git add scripts/a\\ b.mjs"), "backslash outside any quotes");
});

test("plain wrap-up commands are still allowed: double-quoted message, and a backslash inside single quotes", () => {
  const f = fixture();
  allowed(bash(f, 'git commit -m "WIP: context budget; handoff next"'), "double-quoted message with ;");
  allowed(bash(f, "git commit -m 'WIP: a\\b'"), "backslash inside single quotes");
  allowed(bash(f, "git add scripts/hooks/context-budget.mjs"), "git add");
});

// AC2 ---------------------------------------------------------------------------------------

test("main checkout .scratch/ is an allowed wrap-up write (main found by git worktree list)", () => {
  const f = fixture();
  for (const tool of ["Write", "Edit"]) {
    allowed(hook(f, tool, { file_path: path.join(f.main, ".scratch", "org", "handoffs", "h.md"), content: "x", old_string: "a", new_string: "b" }), `${tool} main .scratch`);
  }
});

test("main checkout .scratch/ is allowed when DEN_ROOT names it (cwd is not a git repo)", () => {
  const f = fixture();
  const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), "ctx-hard-root-")));
  const r = hook({ ...f, wt: f.wt }, "Write", { file_path: path.join(elsewhere, ".scratch", "h.md"), content: "x" }, { denRoot: elsewhere });
  allowed(r, "DEN_ROOT .scratch");
});

test("a .scratch/ outside the main checkout is refused: under src/, the agent's own worktree, or elsewhere", () => {
  const f = fixture();
  const w = (p) => hook(f, "Write", { file_path: p, content: "x" });
  refused(w(path.join(f.main, "src", ".scratch", "a.md")), "main/src/.scratch");
  refused(w(path.join(f.wt, ".scratch", "org", "h.md")), "worktree's own .scratch");
  refused(w(path.join(f.wt, "src", ".scratch", "a.md")), "worktree/src/.scratch");
  refused(w("/x/src/.scratch/a"), "/x/src/.scratch/a");
  refused(hook(f, "Edit", { file_path: "/x/src/.scratch/a", old_string: "a", new_string: "b" }), "Edit /x/src/.scratch");
});

test("a path that climbs out of the main checkout's .scratch/ is still refused", () => {
  const f = fixture();
  refused(hook(f, "Write", { file_path: path.join(f.main, ".scratch", "..", "apps", "a.jsx"), content: "x" }), ".scratch/..");
});

test("the session scratchpad is still an allowed wrap-up write", () => {
  const f = fixture();
  allowed(hook(f, "Write", { file_path: `${PAD}/165-qa-specify.md`, content: "x" }), "scratchpad Write");
});

// AC3 ---------------------------------------------------------------------------------------

test("a session_id that fails /^[\\w.-]+$/ is not passed to context.mjs: the hook fails open", () => {
  // Each bad id resolves, if used unvalidated, to a directory holding a 95k transcript for this agent.
  const f = fixture(95_000, { extraSessionDirs: ["sess", "sess;x", "sess x"] });
  for (const bad of ["../sess", "sess;x", "sess x", "../../.claude/projects/sess", ""]) {
    const r = hook(f, "Read", { file_path: "/repo/big.jsx" }, { sessionId: bad });
    assert.equal(r.status, 0, `session_id ${JSON.stringify(bad)} must fail open, got ${r.status}\n${r.stderr}`);
    assert.equal(r.stdout, "", `session_id ${JSON.stringify(bad)}: no output`);
  }
  // control: the valid id over the same transcript is refused
  refused(hook(f, "Read", { file_path: "/repo/big.jsx" }), "valid session id");
});
