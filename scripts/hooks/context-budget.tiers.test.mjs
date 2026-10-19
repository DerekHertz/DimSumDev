// organism-infra/145 (batch C): the 162 hook reads its thresholds from the shared config by the calling
// agent's agent_type, instead of the fixed 70k/80k.
//
// Seam: the hook CLI, as in context-budget.test.mjs (PreToolUse JSON on stdin, HOME=<fixture>).
// With the shipped config (CONTEXT_BUDGET_CONFIG unset): every agent role warns at 100k and refuses at
// 150k (organism-infra/220, superseding 210's 130k and 208's 70k/80k); the orchestrator keeps 70k/80k.
// With CONTEXT_BUDGET_CONFIG=<fixture file> the numbers come from that file, so none is hard-coded.
// The warning and refusal texts name the agent's own limits, not "80k".
//
// Criterion map:
//   hook reads thresholds by role (shipped numbers) -> "developer ...", "qa ...", "security ..." tests
//   hook reads the config value, not constants      -> "a fixture config ..." tests
//   messages carry the role's limits                -> "warning text ...", "refusal text ..." tests
//   fail open, wrap-up calls unchanged              -> "the wrap-up calls stay allowed ..." test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.resolve(fileURLToPath(new URL("../..", import.meta.url))), "scripts", "hooks", "context-budget.mjs");
const SESSION = "orch-session-145";

function fixture(tokens) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "ctx-tiers-")));
  const wt = path.join(home, "worktrees", "agent-a");
  mkdirSync(wt, { recursive: true });
  const sub = path.join(home, ".claude", "projects", "-fixture-project", SESSION, "subagents");
  mkdirSync(sub, { recursive: true });
  const rec = (n) => JSON.stringify({ type: "assistant", cwd: wt, message: { role: "assistant", usage: { input_tokens: n, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 } } });
  writeFileSync(path.join(sub, "agent-a.jsonl"), [rec(1000), rec(tokens)].join("\n") + "\n");
  return { home, wt };
}

function writeConfig(body) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ctx-tiers-cfg-")));
  const file = path.join(dir, "context-budget.json");
  writeFileSync(file, JSON.stringify(body));
  return file;
}

function run(tokens, agentType, { tool = "Read", toolInput = { file_path: "/repo/apps/ui/src/big.jsx" }, config = null } = {}) {
  const f = fixture(tokens);
  const env = { ...process.env, HOME: f.home };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CONTEXT_BUDGET_CONFIG;
  if (config) env.CONTEXT_BUDGET_CONFIG = config;
  const input = { session_id: SESSION, cwd: f.wt, hook_event_name: "PreToolUse", tool_name: tool, tool_input: toolInput, agent_id: "agent-a", agent_type: agentType };
  return spawnSync("node", [SCRIPT], { cwd: f.wt, env, input: JSON.stringify(input), encoding: "utf8", timeout: 15000 });
}

const silent = (r, label) => {
  assert.equal(r.status, 0, `${label}: exit ${r.status}\n${r.stderr}`);
  assert.equal(r.stdout, "", `${label}: no stdout`);
  assert.equal(r.stderr, "", `${label}: no stderr`);
};
const warns = (r, label) => {
  assert.equal(r.status, 0, `${label}: exit ${r.status}\n${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput?.additionalContext ?? "", /checkpoint/i, label);
  return out.hookSpecificOutput.additionalContext;
};
const refuses = (r, label) => {
  assert.equal(r.status, 2, `${label}: exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  return r.stderr;
};

for (const role of ["developer", "qa", "designer", "architect", "security", "scout", "product", "herald"]) {
  test(`${role}: 100k warn / 150k stop (organism-infra/220)`, () => {
    silent(run(99_999, role), `${role} 99,999`);
    warns(run(100_000, role), `${role} 100k`);
    warns(run(149_999, role), `${role} 149,999`);
    refuses(run(150_000, role), `${role} 150k`);
  });
}

test("an agent_type with no config entry gets 100k warn / 150k stop (organism-infra/220)", () => {
  silent(run(85_000, "some-future-agent"), "unknown 85k");
  warns(run(100_000, "some-future-agent"), "unknown 100k");
  refuses(run(150_000, "some-future-agent"), "unknown 150k");
});

test("an agent role is no longer stopped at the old 80k or 130k lines (organism-infra/220)", () => {
  warns(run(130_000, "developer"), "developer 130k");
  warns(run(125_000, "security"), "security 125k");
});

test("warning text names the agent's own limit, not 80k", () => {
  const config = writeConfig({ default: { warn: 70_000, stop: 80_000 }, roles: { developer: { warn: 100_000, stop: 120_000 } } });
  const text = warns(run(105_000, "developer", { config }), "developer 105k");
  assert.match(text, /105k/);
  assert.match(text, /120k/, "the warning names the developer's stop limit");
  assert.doesNotMatch(text, /80k/);
});

test("refusal text names the agent's own limit and still tells it how to wrap up", () => {
  const config = writeConfig({ default: { warn: 70_000, stop: 80_000 }, roles: { qa: { warn: 100_000, stop: 120_000 } } });
  const text = refuses(run(125_000, "qa", { config }), "qa 125k");
  assert.match(text, /125k/);
  assert.match(text, /120k/);
  assert.doesNotMatch(text, /80k/);
  assert.match(text, /WIP commit/i);
  assert.match(text, /outcome: partial/);
});

test("the wrap-up calls stay allowed at and above the developer's 150k stop", () => {
  for (const command of ["git add scripts/a.mjs", 'git commit -m "WIP: budget"', "npm run board -- release organism-infra/145-cell-context-hook --keep-status", "node scripts/context.mjs --self"]) {
    const r = run(160_000, "developer", { tool: "Bash", toolInput: { command } });
    assert.equal(r.status, 0, `${command}: exit ${r.status}\n${r.stderr}`);
  }
});

test("a fixture config sets the numbers: developer 30k warn / 40k stop", () => {
  const config = writeConfig({
    default: { warn: 70_000, stop: 80_000 },
    roles: { developer: { warn: 30_000, stop: 40_000 } },
    orchestrator: { warn: 70_000, stop: 80_000 },
  });
  silent(run(29_999, "developer", { config }), "29,999");
  const text = warns(run(30_000, "developer", { config }), "30k");
  assert.match(text, /40k/);
  refuses(run(40_000, "developer", { config }), "40k");
  // another role is untouched by the developer entry
  silent(run(50_000, "security", { config }), "security 50k");
});

test("a fixture config's default entry applies to roles it does not list", () => {
  const config = writeConfig({ default: { warn: 20_000, stop: 25_000 }, roles: {}, orchestrator: { warn: 70_000, stop: 80_000 } });
  silent(run(19_999, "security", { config }), "19,999");
  warns(run(20_000, "security", { config }), "20k");
  refuses(run(25_000, "security", { config }), "25k");
});

test("an invalid or missing config file leaves the hook on the built-in (agents 100k / 150k) and never crashes it", () => {
  const bad = writeConfig({ default: { warn: "x" }, roles: { developer: { warn: 5, stop: 1 } } });
  silent(run(90_000, "developer", { config: bad }), "bad config 90k");
  warns(run(120_000, "developer", { config: bad }), "bad config 120k");
  refuses(run(155_000, "developer", { config: bad }), "bad config 155k");
  const missing = path.join(tmpdir(), "no-such-dir-ctx-tiers", "context-budget.json");
  silent(run(90_000, "developer", { config: missing }), "missing config 90k");
  refuses(run(155_000, "developer", { config: missing }), "missing config 155k");
});
