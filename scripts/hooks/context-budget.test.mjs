// organism-infra/162: a PreToolUse hook enforces the agent context budget (80k stop) with code.
//
// Seam: the hook CLI scripts/hooks/context-budget.mjs, run the way Claude Code runs a command hook:
// the PreToolUse JSON on stdin ({session_id, cwd, tool_name, tool_input, agent_id, agent_type}),
// HOME=<fixture>, cwd=<the agent's worktree>. The hook reads the agent's own context the way
// `scripts/context.mjs --self` does: the subagent transcript
// $HOME/.claude/projects/<slug>/<session_id>/subagents/agent-*.jsonl whose records carry
// cwd == the worktree; its newest assistant usage is the context size. The test strips
// CLAUDE_CODE_SESSION_ID from the env, so the hook must take the session from the input's session_id.
//
// Contract pinned here:
//   allow, silent  -> exit 0, empty stdout, empty stderr
//   allow, warning -> exit 0, stdout is JSON {hookSpecificOutput:{hookEventName:"PreToolUse",
//                     additionalContext:"<text mentioning a checkpoint>"}}, no deny decision
//   refuse         -> exit 2, stderr (and stdout) carry the message, as scripts/hooks/bash-guard.mjs does
// Thresholds: below 70_000 silent, 70_000 to 79_999 warn, 80_000 and up refuse (except wrap-up calls).
// Agent session: the input carries agent_id (a subagent call). The orchestrator main session (no
// agent_id, or agent_type "orchestrator") is never gated here.
//
// Criterion map:
//   AC1 under 70k allows silently                   -> "under 70k ..." tests
//   AC2 70k to 80k allows with a checkpoint warning -> "70k to under 80k ..." tests
//   AC3 80k+ refuses Read/Grep/Bash, allows wrap-up -> "at 80k ..." tests (refuse), "wrap-up ..." tests (allow)
//   AC4 null context allows                         -> "null context ..." tests
//   AC5 not applied in the orchestrator session     -> "orchestrator ..." tests
//   AC6 settings.json edit is in the developer handoff -> human-verified (.claude/ is user-gated; not in this branch)
//   AC7 npm test passes                             -> the whole suite
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.resolve(fileURLToPath(new URL("../..", import.meta.url))), "scripts", "hooks", "context-budget.mjs");
const SESSION = "orch-session-162";

const usage = (n) => ({ input_tokens: n, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 7 });
const asst = (cwd, n) => JSON.stringify({ type: "assistant", cwd, message: { role: "assistant", usage: usage(n) } });
const user = (cwd) => JSON.stringify({ type: "user", cwd, message: { role: "user", content: "hi" } });

// A fixture HOME with one agent worktree whose subagent transcript reports `tokens` of context
// (null: no transcript at all). `other` adds a second agent's transcript in another worktree.
function fixture(tokens, { other = null } = {}) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "ctx-budget-")));
  const projDir = path.join(home, ".claude", "projects", "-fixture-project");
  const wt = path.join(home, "worktrees", "agent-a");
  const wtOther = path.join(home, "worktrees", "agent-b");
  mkdirSync(wt, { recursive: true });
  mkdirSync(wtOther, { recursive: true });
  const sub = path.join(projDir, SESSION, "subagents");
  mkdirSync(sub, { recursive: true });
  if (tokens !== null) {
    writeFileSync(path.join(sub, "agent-a.jsonl"), [user(wt), asst(wt, 1000), asst(wt, tokens)].join("\n") + "\n");
  }
  if (other !== null) {
    writeFileSync(path.join(sub, "agent-b.jsonl"), [user(wtOther), asst(wtOther, other)].join("\n") + "\n");
  }
  return { home, wt };
}

const ROLE = { agent_id: "agent-a", agent_type: "security" }; // organism-infra/145: 70k/80k tier (208: developer and qa are 70k/80k too)

function runHook(f, toolName, toolInput, who = ROLE, { rawStdin = null } = {}) {
  const env = { ...process.env, HOME: f.home, DEN_ROOT: path.join(f.home, "main") };
  delete env.CLAUDE_CODE_SESSION_ID;
  // organism-infra/220: the shipped agent numbers moved to 100k/150k. This file tests the hook's mechanics at
  // 70k/80k through the config seam; the shipped numbers are pinned in context-budget.tiers.test.mjs.
  const cfg = path.join(f.home, "mechanics-budget.json");
  writeFileSync(cfg, JSON.stringify({ default: { warn: 70_000, stop: 80_000 }, roles: {}, orchestrator: { warn: 70_000, stop: 80_000 } }));
  env.CONTEXT_BUDGET_CONFIG = cfg;
  const input = { session_id: SESSION, cwd: f.wt, hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, ...who };
  return spawnSync("node", [SCRIPT], {
    cwd: f.wt,
    env,
    input: rawStdin ?? JSON.stringify(input),
    encoding: "utf8",
    timeout: 15000,
  });
}

const bash = (f, command, who) => runHook(f, "Bash", { command }, who);
const READ = { file_path: "/repo/apps/ui/src/big-file.jsx" };

function assertSilentAllow(r, label) {
  assert.equal(r.status, 0, `${label}: expected exit 0, got ${r.status}\n${r.stderr}`);
  assert.equal(r.stdout, "", `${label}: expected no stdout`);
  assert.equal(r.stderr, "", `${label}: expected no stderr`);
}

function assertWarning(r, label) {
  assert.equal(r.status, 0, `${label}: expected exit 0, got ${r.status}\n${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput?.hookEventName, "PreToolUse");
  assert.match(out.hookSpecificOutput?.additionalContext ?? "", /checkpoint/i, `${label}: warning must tell the agent to checkpoint`);
  assert.notEqual(out.hookSpecificOutput?.permissionDecision, "deny", `${label}: a warning must not deny`);
}

function assertRefused(r, label) {
  assert.equal(r.status, 2, `${label}: expected exit 2, got ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.ok(r.stderr.length > 0, `${label}: the refusal message goes to stderr`);
}

// AC1 ---------------------------------------------------------------------------------------

test("under 70k the hook allows a Read silently", () => {
  assertSilentAllow(runHook(fixture(20_000), "Read", READ), "20k Read");
});

test("under 70k the hook allows Grep and Bash silently, right up to 69,999", () => {
  const f = fixture(69_999);
  assertSilentAllow(runHook(f, "Grep", { pattern: "foo" }), "69,999 Grep");
  assertSilentAllow(bash(f, "npm test"), "69,999 Bash");
});

// AC2 ---------------------------------------------------------------------------------------

test("at exactly 70k the hook allows the call and returns a checkpoint warning", () => {
  assertWarning(runHook(fixture(70_000), "Read", READ), "70,000 Read");
});

test("at 79,999 the hook still allows (Read, Grep, Bash) with a checkpoint warning", () => {
  const f = fixture(79_999);
  assertWarning(runHook(f, "Read", READ), "79,999 Read");
  // The warning is one-time (organism-infra/208): later calls in the window are allowed silently.
  assertSilentAllow(runHook(f, "Grep", { pattern: "foo" }), "79,999 Grep");
  assertSilentAllow(bash(f, "npm test"), "79,999 Bash");
});

test("counts input, cache creation and cache read tokens together (as context.mjs does)", () => {
  const f = fixture(0);
  const wt = f.wt;
  const sub = path.join(f.home, ".claude", "projects", "-fixture-project", SESSION, "subagents", "agent-a.jsonl");
  const rec = { type: "assistant", cwd: wt, message: { role: "assistant", usage: { input_tokens: 5_000, cache_creation_input_tokens: 25_000, cache_read_input_tokens: 52_000, output_tokens: 9 } } };
  writeFileSync(sub, JSON.stringify(rec) + "\n");
  assertRefused(runHook(f, "Read", READ), "82k split across the three counters");
});

// AC3: refusals -----------------------------------------------------------------------------

test("at exactly 80k the hook refuses a Read", () => {
  assertRefused(runHook(fixture(80_000), "Read", READ), "80,000 Read");
});

test("at 80k the hook refuses a Grep, a Glob and a non-wrap-up Bash call", () => {
  const f = fixture(95_000);
  assertRefused(runHook(f, "Grep", { pattern: "foo" }), "Grep");
  assertRefused(runHook(f, "Glob", { pattern: "**/*.mjs" }), "Glob");
  assertRefused(bash(f, "cat apps/ui/src/big-file.jsx"), "cat");
  assertRefused(bash(f, "npm test"), "npm test");
});

test("the refusal message says how to wrap up: WIP commit, handoff, release, outcome: partial", () => {
  const r = runHook(fixture(85_000), "Read", READ);
  assertRefused(r, "85k Read");
  assert.match(r.stderr, /WIP commit/i);
  assert.match(r.stderr, /handoff/i);
  assert.match(r.stderr, /release/i);
  assert.match(r.stderr, /outcome: partial/);
});

test("at 80k the hook refuses a Write or Edit outside .scratch/", () => {
  const f = fixture(90_000);
  assertRefused(runHook(f, "Write", { file_path: path.join(f.wt, "scripts", "new-feature.mjs"), content: "x" }), "Write src");
  assertRefused(runHook(f, "Edit", { file_path: path.join(f.wt, "apps", "ui", "src", "a.jsx"), old_string: "a", new_string: "b" }), "Edit src");
});

test("at 80k a Write that climbs out of .scratch/ with .. is refused", () => {
  const f = fixture(90_000);
  assertRefused(runHook(f, "Write", { file_path: path.join(f.wt, ".scratch", "..", "apps", "ui", "a.jsx"), content: "x" }), "Write .scratch/../apps");
});

test("at 80k a chained command is refused even when it starts with a wrap-up call", () => {
  const f = fixture(90_000);
  assertRefused(bash(f, "git commit -m wip && npm test"), "commit && npm test");
  assertRefused(bash(f, "git add -A; cat apps/ui/src/big-file.jsx"), "add ; cat");
  assertRefused(bash(f, "node scripts/context.mjs --self | cat apps/ui/src/big-file.jsx"), "context | cat");
});

test("at 80k board commands other than handoff, release and comment are refused", () => {
  const f = fixture(90_000);
  assertRefused(bash(f, "npm run board -- claim organism-infra/162-context-budget-hook qa"), "board claim");
});

// AC3: the wrap-up calls stay allowed at 80k and beyond -------------------------------------

const WRAP_UP = [
  ["git add of explicit paths", "git add scripts/hooks/context-budget.test.mjs"],
  ["git commit", 'git commit -m "WIP: context budget reached"'],
  ["board handoff", "npm run board -- handoff organism-infra/162-context-budget-hook --from /tmp/h.md --name 162-qa-specify.md"],
  ["board release", "npm run board -- release organism-infra/162-context-budget-hook --keep-status --reason partial"],
  ["board comment", 'npm run board -- comment organism-infra/162-context-budget-hook "partial: context budget"'],
  ["context.mjs --self", "node scripts/context.mjs --self"],
  ["context.mjs", "node scripts/context.mjs"],
];

for (const [name, command] of WRAP_UP) {
  test(`wrap-up at 95k: ${name} is allowed`, () => {
    const r = bash(fixture(95_000), command);
    assert.equal(r.status, 0, `${command} must be allowed at 95k, got exit ${r.status}\n${r.stderr}`);
    assert.doesNotMatch(r.stdout + r.stderr, /outcome: partial/, "an allowed wrap-up call is not told to wrap up");
  });
}

test("wrap-up at 95k: a Write or Edit under .scratch/ is allowed", () => {
  const f = fixture(95_000);
  const handoff = path.join(f.home, "main", ".scratch", "organism-infra", "handoffs", "162-qa-specify.md") /* organism-infra/165: the main checkout (DEN_ROOT) */;
  for (const tool of ["Write", "Edit"]) {
    const r = runHook(f, tool, { file_path: handoff, content: "x", old_string: "a", new_string: "b" });
    assert.equal(r.status, 0, `${tool} under .scratch/ must be allowed at 95k, got exit ${r.status}\n${r.stderr}`);
  }
});

// AC4 ---------------------------------------------------------------------------------------

test("null context (no matching transcript) allows every call silently", () => {
  const f = fixture(null);
  assertSilentAllow(runHook(f, "Read", READ), "Read");
  assertSilentAllow(bash(f, "npm test"), "Bash");
});

test("null context (transcript with no usage record yet) allows the call", () => {
  const f = fixture(null);
  const sub = path.join(f.home, ".claude", "projects", "-fixture-project", SESSION, "subagents", "agent-a.jsonl");
  writeFileSync(sub, user(f.wt) + "\n");
  assertSilentAllow(runHook(f, "Read", READ), "Read");
});

test("unreadable or empty hook input allows the call (the hook fails open)", () => {
  const f = fixture(95_000);
  assert.equal(runHook(f, "Read", READ, ROLE, { rawStdin: "not json" }).status, 0);
  assert.equal(runHook(f, "Read", READ, ROLE, { rawStdin: "" }).status, 0);
});

test("only this agent's own context counts: another agent over 80k in a different worktree is ignored", () => {
  assertSilentAllow(runHook(fixture(10_000, { other: 95_000 }), "Read", READ), "Read");
});

// AC5 ---------------------------------------------------------------------------------------

test("the orchestrator main session (no agent fields) is never gated, even over 80k", () => {
  const f = fixture(95_000);
  assertSilentAllow(runHook(f, "Read", READ, {}), "Read");
  assertSilentAllow(bash(f, "npm test", {}), "Bash");
});

test("an agent_type of orchestrator is never gated, even over 80k", () => {
  const f = fixture(95_000);
  assertSilentAllow(runHook(f, "Read", READ, { agent_type: "orchestrator" }), "Read");
  assertSilentAllow(runHook(f, "Read", READ, { agent_id: "agent-a", agent_type: "orchestrator" }), "Read with agent_id");
});

test("the orchestrator gets no 70k warning either", () => {
  assertSilentAllow(runHook(fixture(75_000), "Read", READ, {}), "75k orchestrator Read");
});
