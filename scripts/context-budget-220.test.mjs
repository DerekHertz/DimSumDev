// organism-infra/220: one context budget for every agent role: warn 100k, stop 150k. The orchestrator keeps 70k / 80k.
//
// The per-role numbers are pinned where each reader is tested:
//   budgetFor(role) with the shipped config   -> scripts/context-budget.test.mjs
//   the PreToolUse hook by agent_type         -> scripts/hooks/context-budget.tiers.test.mjs (+ handback test)
//   context.mjs --self --role <role>          -> scripts/context-agent-state.test.mjs
//   agent-start refuses at 80k orchestrator    -> scripts/agent-start-context-gate.test.mjs (unchanged, still green)
// This file covers what those do not: the shipped JSON itself, "no reader holds a budget number of its own"
// (statusline follows the config; no budget literal in the readers' code), and the agent-start doc.
//
// Criterion map:
//   AC3 (orchestrator unchanged)        -> "the shipped config gives the orchestrator 70k / 80k and every other key 100k / 150k"
//   AC5 (no reader holds its own number) -> "statusline ..." tests, "no reader's code holds a budget literal"
//   AC6 (docs state the new numbers)     -> "docs/agents/agent-start.md states ..."
//   human-verified: .claude/ edit in the developer handoff, applied by the user; the post-merge config row in
//   usage.jsonl (orchestrator); `npm test` / risk-check green (the suite itself).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

test("the shipped config gives the orchestrator 70k / 80k and every other key 100k / 150k", () => {
  const cfg = JSON.parse(read("scripts/context-budget.json"));
  assert.deepEqual(cfg.orchestrator, { warn: 70_000, stop: 80_000 });
  assert.deepEqual(cfg.default, { warn: 100_000, stop: 150_000 });
  for (const [role, entry] of Object.entries(cfg.roles ?? {})) {
    assert.deepEqual(entry, { warn: 100_000, stop: 150_000 }, `agents.${role}`);
  }
});

// ---- statusline follows the config's orchestrator key ----

function statusline(tokens, config) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "statusline-220-")));
  const home = path.join(dir, "home");
  const root = path.join(dir, "root");
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(root, ".scratch", "organism-infra", "issues"), { recursive: true });
  const usageScript = path.join(dir, "fake-usage.mjs");
  writeFileSync(usageScript, `console.log(JSON.stringify({ "5-hour": { percent: 1, resets_at: "2026-10-02T19:59:00.000Z" }, weekly: { percent: 1, resets_at: "2026-10-06T00:00:00.000Z" } }));\n`);
  const cfgFile = path.join(dir, "context-budget.json");
  writeFileSync(cfgFile, JSON.stringify(config));
  const env = { ...process.env, HOME: home, DEN_ROOT: root, STATUSLINE_USAGE_SCRIPT: usageScript, STATUSLINE_CACHE: path.join(dir, "cache.json"), CONTEXT_BUDGET_CONFIG: cfgFile };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CODE_REMOTE;
  const stdin = {
    session_id: "sess-220",
    cwd: "/tmp/x",
    context_window: { context_window_size: 200000, current_usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 10 } },
  };
  const r = spawnSync("node", [path.join(ROOT, "scripts", "statusline.mjs")], { cwd: root, env, input: JSON.stringify(stdin), encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  return { raw: r.stdout, text: r.stdout.replace(/\x1b\[[0-9;]*m/g, "") };
}

const FIXTURE = { default: { warn: 100_000, stop: 150_000 }, roles: {}, orchestrator: { warn: 20_000, stop: 30_000 } };

test("statusline: the context limit shown is the config's orchestrator stop, not a constant", () => {
  const r = statusline(12_000, FIXTURE);
  assert.ok(r.text.includes("ctx 12k/30k"), r.text);
  assert.ok(!/\x1b\[(33|31)m[^\x1b]*ctx/.test(r.raw), "below the configured warn: no colour on ctx");
});

test("statusline: yellow from the config's orchestrator warn, red with '/compact' from its stop", () => {
  const warn = statusline(20_000, FIXTURE);
  assert.match(warn.raw, /\x1b\[33m[^\x1b]*ctx 20k\/30k/);
  assert.ok(!warn.text.includes("/compact"), warn.text);
  const stop = statusline(30_000, FIXTURE);
  assert.match(stop.raw, /\x1b\[31m[^\x1b]*ctx 30k\/30k/);
  assert.ok(stop.text.includes("→ /compact"), stop.text);
});

test("statusline: the default entry (100k / 150k) does not move the orchestrator's line", () => {
  const r = statusline(85_000, { default: { warn: 100_000, stop: 150_000 }, roles: {}, orchestrator: { warn: 70_000, stop: 80_000 } });
  assert.match(r.raw, /\x1b\[31m[^\x1b]*ctx 85k\/80k/);
  assert.ok(r.text.includes("→ /compact"), r.text);
});

// ---- no reader holds a budget number of its own ----

// Strip // and /* */ comments so prose such as "70k" in a comment is not a budget literal.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const BUDGET_LITERAL = /\b(?:70|80|100|130|150)_?000\b/;
const BUDGET_TEXT = /["'`][^"'`\n]*\b(?:70|80|100|130|150)k\b/;

test("no reader's code holds a budget literal (statusline, context.mjs, agent-start, the hook)", () => {
  for (const rel of ["scripts/statusline.mjs", "scripts/context.mjs", "scripts/agent-start.mjs", "scripts/hooks/context-budget.mjs"]) {
    const code = stripComments(read(rel));
    assert.doesNotMatch(code, BUDGET_LITERAL, `${rel} holds a budget number`);
    assert.doesNotMatch(code, BUDGET_TEXT, `${rel} holds a budget number in a string`);
  }
});

test("context-budget.mjs holds only its fail-open built-in (agents 100k / 150k, orchestrator 70k / 80k)", () => {
  const code = stripComments(read("scripts/context-budget.mjs"));
  const hits = (code.match(new RegExp(BUDGET_LITERAL.source, "g")) ?? []).map((h) => h.replace("_", "")).sort();
  assert.deepEqual(hits, ["100000", "150000", "70000", "80000"], "only the built-in pairs, no 130k");
});

// ---- docs ----

test("docs/agents/agent-start.md states the new numbers: 100k warn / 150k stop for agents, 70k / 80k for the orchestrator", () => {
  const doc = read("docs/agents/agent-start.md");
  assert.match(doc, /100k/);
  assert.match(doc, /150k/);
  assert.match(doc, /80k/);
  assert.doesNotMatch(doc, /130k/);
});
