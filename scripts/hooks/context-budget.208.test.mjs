// organism-infra/208: gaps between the 208 ticket and the 162/145/165/194 context-budget hook.
// The hook (scripts/hooks/context-budget.mjs) already refuses at the stop limit and allows the wrap-up calls.
// Three ticket requirements are not met yet, and are pinned here:
//   1. the 70k-80k warning is ONE-TIME per agent (today it repeats on every call in the window)
//   2. `node scripts/log-agent.mjs` is a wrap-up command at the stop limit
//   3. a Write/Edit under /tmp (the handoff draft) is a wrap-up write at the stop limit
// Seam: the hook CLI, PreToolUse JSON on stdin, HOME=<fixture>, as context-budget.test.mjs does.
// Each test uses its own session id, so any "warned already" state the hook keeps cannot leak between tests.
//
// Criterion map (ticket AC order):
//   AC1 refuses Edit, Write outside /tmp, Read, general Bash, message names the partial-return steps
//        -> context-budget.test.mjs ("at exactly 80k the hook refuses a Read", "... Grep, a Glob and a non-wrap-up Bash",
//           "the refusal message says how to wrap up", "... refuses a Write or Edit outside .scratch/")
//        -> here: "a Write outside /tmp ..." boundary tests
//   AC2 wrap-up commands still run at 80k+ -> context-budget.test.mjs WRAP_UP table; here: log-agent, Write/Edit under /tmp
//   AC3 70k-80k: one warning, not refused -> here: the "one-time" tests; context-budget.test.mjs for the warning itself
//   AC4 orchestrator never refused        -> context-budget.test.mjs ("orchestrator ..." tests), handback.test.mjs
//   AC5 fails open when unreadable        -> context-budget.test.mjs ("null context ...", "unreadable ... input")
//   AC6 settings.json diff in the developer handoff -> human-verified (.claude/ is user-gated)
//   AC7 npm test green                    -> whole suite
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.resolve(fileURLToPath(new URL("../..", import.meta.url))), "scripts", "hooks", "context-budget.mjs");
const ROLE = { agent_id: "agent-a", agent_type: "security" }; // default 70k / 80k tier

let counter = 0;
const uniqueSession = () => `s208-${process.pid}-${Date.now()}-${counter++}`;

// A fixture HOME with one agent worktree whose subagent transcript reports `tokens` of context.
function fixture(tokens, session = uniqueSession()) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "ctx-budget-208-")));
  const wt = path.join(home, "worktrees", "agent-a");
  mkdirSync(wt, { recursive: true });
  const sub = path.join(home, ".claude", "projects", "-fixture-project", session, "subagents");
  mkdirSync(sub, { recursive: true });
  const transcript = path.join(sub, "agent-a.jsonl");
  const set = (n) => writeFileSync(transcript, JSON.stringify({ type: "assistant", cwd: wt, message: { role: "assistant", usage: { input_tokens: n, output_tokens: 1 } } }) + "\n");
  set(tokens);
  return { home, wt, session, set };
}

function runHook(f, toolName, toolInput, who = ROLE) {
  const env = { ...process.env, HOME: f.home, DEN_ROOT: path.join(f.home, "main") };
  delete env.CLAUDE_CODE_SESSION_ID;
  // organism-infra/220: mechanics at 70k/80k through the config seam (shipped numbers: tiers test).
  const cfg = path.join(f.home, "mechanics-budget.json");
  writeFileSync(cfg, JSON.stringify({ default: { warn: 70_000, stop: 80_000 }, roles: {}, orchestrator: { warn: 70_000, stop: 80_000 } }));
  env.CONTEXT_BUDGET_CONFIG = cfg;
  const input = { session_id: f.session, cwd: f.wt, hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, ...who };
  return spawnSync("node", [SCRIPT], { cwd: f.wt, env, input: JSON.stringify(input), encoding: "utf8", timeout: 15000 });
}

const bash = (f, command, who) => runHook(f, "Bash", { command }, who);
const READ = { file_path: "/repo/apps/ui/src/big-file.jsx" };

const isWarning = (r) => {
  if (r.status !== 0 || r.stdout.trim() === "") return false;
  try {
    return /checkpoint/i.test(JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? "");
  } catch {
    return false;
  }
};

function assertSilentAllow(r, label) {
  assert.equal(r.status, 0, `${label}: expected exit 0, got ${r.status}\n${r.stderr}`);
  assert.equal(r.stdout, "", `${label}: expected no stdout (no repeat warning)`);
  assert.equal(r.stderr, "", `${label}: expected no stderr`);
}

function assertRefused(r, label) {
  assert.equal(r.status, 2, `${label}: expected exit 2, got ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.ok(r.stderr.length > 0, `${label}: the refusal message goes to stderr`);
}

function assertAllowed(r, label) {
  assert.equal(r.status, 0, `${label}: expected exit 0, got ${r.status}\n${r.stderr}`);
}

// AC3: the warning is one-time ----------------------------------------------------------------

test("between 70k and 80k the first call gets the checkpoint warning and the second call is silent", () => {
  const f = fixture(75_000);
  assert.ok(isWarning(runHook(f, "Read", READ)), "first call in the window warns");
  assertSilentAllow(runHook(f, "Read", READ), "second call, same tokens");
  assertSilentAllow(bash(f, "npm test"), "third call (Bash)");
});

test("the one-time warning is not re-sent when context grows within the 70k-80k window", () => {
  const f = fixture(70_500);
  assert.ok(isWarning(runHook(f, "Read", READ)), "first call warns");
  f.set(78_900);
  assertSilentAllow(runHook(f, "Grep", { pattern: "foo" }), "call after context grew to 78,900");
});

test("an agent that was warned is still refused once it crosses 80k, and the wrap-up calls still pass", () => {
  const f = fixture(75_000);
  assert.ok(isWarning(runHook(f, "Read", READ)), "first call warns");
  f.set(81_000);
  assertRefused(runHook(f, "Read", READ), "Read at 81k after the warning");
  assertAllowed(bash(f, "git commit -m wip"), "git commit at 81k after the warning");
});

test("each agent gets its own one-time warning: a second agent in another session is warned too", () => {
  const a = fixture(75_000);
  const b = fixture(75_000);
  assert.ok(isWarning(runHook(a, "Read", READ)), "agent a warned");
  assert.ok(isWarning(runHook(b, "Read", READ)), "agent b warned despite agent a having been warned");
});

test("under 70k there is no warning to use up: the warning still comes at 70k after earlier silent calls", () => {
  const f = fixture(20_000);
  assertSilentAllow(runHook(f, "Read", READ), "20k call");
  f.set(72_000);
  assert.ok(isWarning(runHook(f, "Read", READ)), "first call at 72k warns");
});

// AC2: log-agent is a wrap-up command ------------------------------------------------------------

test("at 95k node scripts/log-agent.mjs is allowed", () => {
  const f = fixture(95_000);
  const cmd = 'node scripts/log-agent.mjs --ticket organism-infra/208-cell-context-hook --role developer --tokens 1000 --ms 1000 --outcome "partial" --context 95000';
  assertAllowed(bash(f, cmd), "log-agent at 95k");
});

test("at 95k log-agent chained with another command is still refused", () => {
  const f = fixture(95_000);
  assertRefused(bash(f, "node scripts/log-agent.mjs --role developer && npm test"), "log-agent && npm test");
  assertRefused(bash(f, "node scripts/log-agent.mjs --role developer; cat apps/ui/src/big-file.jsx"), "log-agent ; cat");
});

test("at 95k other scripts under scripts/ are refused (only log-agent joins the wrap-up list)", () => {
  const f = fixture(95_000);
  assertRefused(bash(f, "node scripts/usage.mjs"), "usage.mjs");
  assertRefused(bash(f, "node scripts/log-agent.mjs.evil"), "look-alike name");
});

// AC2 / AC1: Write under /tmp ---------------------------------------------------------------------

test("at 95k a Write or Edit of a handoff draft under /tmp is allowed", () => {
  const f = fixture(95_000);
  for (const tool of ["Write", "Edit"]) {
    const r = runHook(f, tool, { file_path: "/tmp/208-qa-specify-draft.md", content: "x", old_string: "a", new_string: "b" });
    assertAllowed(r, `${tool} /tmp/208-qa-specify-draft.md`);
  }
});

test("at 95k a Write outside /tmp is refused: the worktree, home, and a look-alike /tmpfoo prefix", () => {
  const f = fixture(95_000);
  assertRefused(runHook(f, "Write", { file_path: path.join(f.wt, "scripts", "new.mjs"), content: "x" }), "Write in the worktree");
  assertRefused(runHook(f, "Write", { file_path: path.join(f.home, "notes.md"), content: "x" }), "Write in HOME");
  assertRefused(runHook(f, "Write", { file_path: "/tmpfoo/draft.md", content: "x" }), "Write /tmpfoo");
});

test("at 95k a path that climbs out of /tmp with .. is refused", () => {
  const f = fixture(95_000);
  assertRefused(runHook(f, "Write", { file_path: "/tmp/../etc/draft.md", content: "x" }), "Write /tmp/../etc");
  assertRefused(runHook(f, "Edit", { file_path: path.join(f.wt, "..", "..", "x.md"), old_string: "a", new_string: "b" }), "relative climb");
});

test("at 95k a Read of a /tmp file is still refused (only Write and Edit are wrap-up calls)", () => {
  const f = fixture(95_000);
  assertRefused(runHook(f, "Read", { file_path: "/tmp/208-qa-specify-draft.md" }), "Read /tmp");
});

test("a Write under /tmp is also fine below the stop limit (no refusal, no repeat warning at 60k)", () => {
  const f = fixture(60_000);
  assertSilentAllow(runHook(f, "Write", { file_path: "/tmp/208-draft.md", content: "x" }), "60k Write /tmp");
});
