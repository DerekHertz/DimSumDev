// organism-infra/194: an agent at its context stop can still deliver its final report, so
// SubagentHandback joins the wrap-up allowlist of the 162 hook (scripts/hooks/context-budget.mjs).
//
// Seam: the hook CLI, as in context-budget.tiers.test.mjs (PreToolUse JSON on stdin, HOME=<fixture>,
// the agent's token reading comes from a fixture transcript).
//
// Criterion map:
//   at/above stop, SubagentHandback is allowed       -> "SubagentHandback is allowed at and above the stop ..." tests
//   at/above stop, non-wrap-up calls still refused   -> "Read and Grep are still refused ..." and
//                                                       "only the SubagentHandback tool itself ..." tests
//   below threshold / orchestrator unchanged         -> "below the stop threshold ...", "the orchestrator ..." tests
//   hook input fixtures cover the three cases        -> every test here builds its input with run()
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.resolve(fileURLToPath(new URL("../..", import.meta.url))), "scripts", "hooks", "context-budget.mjs");
const SESSION = "orch-session-194";
const REPORT = { message: "QA pass. outcome: partial. Handoff published." };

function fixture(tokens) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "ctx-handback-")));
  const wt = path.join(home, "worktrees", "agent-a");
  mkdirSync(wt, { recursive: true });
  const sub = path.join(home, ".claude", "projects", "-fixture-project", SESSION, "subagents");
  mkdirSync(sub, { recursive: true });
  const rec = (n) => JSON.stringify({ type: "assistant", cwd: wt, message: { role: "assistant", usage: { input_tokens: n, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 } } });
  writeFileSync(path.join(sub, "agent-a.jsonl"), [rec(1000), rec(tokens)].join("\n") + "\n");
  return { home, wt };
}

// agentType null builds the orchestrator main-session shape: no agent_id, no agent_type.
function run(tokens, agentType, { tool = "SubagentHandback", toolInput = REPORT, agentId = "agent-a" } = {}) {
  const f = fixture(tokens);
  const env = { ...process.env, HOME: f.home };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CONTEXT_BUDGET_CONFIG;
  const input = { session_id: SESSION, cwd: f.wt, hook_event_name: "PreToolUse", tool_name: tool, tool_input: toolInput };
  if (agentType !== null) {
    input.agent_id = agentId;
    input.agent_type = agentType;
  }
  return spawnSync("node", [SCRIPT], { cwd: f.wt, env, input: JSON.stringify(input), encoding: "utf8", timeout: 15000 });
}

const silent = (r, label) => {
  assert.equal(r.status, 0, `${label}: exit ${r.status}\n${r.stderr}`);
  assert.equal(r.stdout, "", `${label}: no stdout`);
  assert.equal(r.stderr, "", `${label}: no stderr`);
};
const warnsAndAllows = (r, label) => {
  assert.equal(r.status, 0, `${label}: exit ${r.status}\n${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput?.additionalContext ?? "", /checkpoint/i, label);
};
const refuses = (r, label) => {
  assert.equal(r.status, 2, `${label}: exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
};

// ---- Criterion 1: at or above the stop threshold, SubagentHandback is allowed ----

test("SubagentHandback is allowed at and above the stop threshold (architect: 150k, 170k)", () => {
  silent(run(150_000, "architect"), "architect 150k");
  silent(run(170_000, "architect"), "architect 170k");
});

test("SubagentHandback is allowed at and above the stop threshold of developer and qa", () => {
  for (const role of ["developer", "qa"]) {
    silent(run(150_000, role), `${role} 150k`);
    silent(run(170_000, role), `${role} 170k`);
  }
});

test("SubagentHandback is allowed at stop for the other roles too", () => {
  for (const role of ["security", "designer", "scout", "product", "herald"]) {
    silent(run(150_000, role), `${role} 150k`);
  }
});

// ---- Criterion 2: at or above stop, non-wrap-up calls are still refused ----

test("Read and Grep are still refused at and above the stop threshold", () => {
  refuses(run(150_000, "architect", { tool: "Read", toolInput: { file_path: "/repo/apps/ui/src/big.jsx" } }), "architect Read 150k");
  refuses(run(155_000, "architect", { tool: "Grep", toolInput: { pattern: "x" } }), "architect Grep 155k");
  refuses(run(150_000, "qa", { tool: "Read", toolInput: { file_path: "/repo/README.md" } }), "qa Read 150k");
  refuses(run(160_000, "developer", { tool: "Grep", toolInput: { pattern: "x" } }), "developer Grep 160k");
});

test("only the SubagentHandback tool itself is wrap-up: lookalike tool names are still refused at stop", () => {
  for (const tool of ["SubagentHandbackExtra", "subagenthandback", "mcp__x__SubagentHandback", "Agent", "SendMessage"]) {
    refuses(run(155_000, "architect", { tool, toolInput: REPORT }), `architect ${tool}`);
  }
});

test("the existing wrap-up calls and refusals still hold alongside the new allowance", () => {
  const ok = run(155_000, "architect", { tool: "Bash", toolInput: { command: "npm run board -- release organism-infra/194-handback-allowed-at-stop --keep-status" } });
  assert.equal(ok.status, 0, ok.stderr);
  refuses(run(155_000, "architect", { tool: "Bash", toolInput: { command: "npm test" } }), "architect npm test");
});

// ---- Criterion 3: below the threshold, and for the orchestrator, behaviour is unchanged ----

test("below the warn threshold, SubagentHandback and other calls pass silently", () => {
  silent(run(60_000, "architect"), "architect handback 60k");
  silent(run(99_999, "architect", { tool: "Read", toolInput: { file_path: "/repo/a.mjs" } }), "architect Read 99,999");
  silent(run(99_999, "qa"), "qa handback 99,999");
});

test("between warn and stop, calls (SubagentHandback included) are allowed with the checkpoint warning", () => {
  warnsAndAllows(run(105_000, "architect"), "architect handback 105k");
  warnsAndAllows(run(149_999, "architect", { tool: "Read", toolInput: { file_path: "/repo/a.mjs" } }), "architect Read 149,999");
  warnsAndAllows(run(110_000, "developer"), "developer handback 110k");
});

test("the orchestrator session is never gated, at any token count", () => {
  // main session: no agent_id
  silent(run(200_000, null, { tool: "Read", toolInput: { file_path: "/repo/a.mjs" } }), "main session Read 200k");
  silent(run(200_000, null), "main session handback 200k");
  // a call tagged agent_type orchestrator
  silent(run(200_000, "orchestrator", { tool: "Grep", toolInput: { pattern: "x" }, agentId: "orch-1" }), "orchestrator Grep 200k");
});
