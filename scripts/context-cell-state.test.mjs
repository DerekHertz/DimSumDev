// organism-infra/145 (batch C): `node scripts/context.mjs [--self] --cell <type>` adds the shared
// budget to the JSON, so team-protocol can say "follow `state`" instead of repeating numbers.
//
// Seam: the context.mjs CLI. With --cell <type> the output keeps its existing keys and gains
//   warn  (number: the role's warn threshold from the shared config, via budgetFor(type))
//   stop  (number: the role's stop threshold)
//   state ("ok" below warn, "warn" from warn up to stop, "stop" at stop and above; null when
//          context_tokens is null)
// "--cell orchestrator" uses the orchestrator key. Without --cell the output is unchanged
// (context-self.test.mjs pins that). CONTEXT_BUDGET_CONFIG overrides the config file.
//
// Criterion map:
//   context.mjs reads the shared config -> every test below
//   state thresholds per role           -> "developer ... ok/warn/stop" tests
//   orchestrator key, non --self mode   -> "--cell orchestrator ..." test
//   null reading                        -> "null reading ..." test
//   config is the source                -> "a fixture config ..." test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.resolve(fileURLToPath(new URL("..", import.meta.url))), "scripts", "context.mjs");
const SESSION = "orch-session-145c";

const usage = (n) => ({ input_tokens: n, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 7 });
const asst = (cwd, n) => JSON.stringify({ type: "assistant", cwd, message: { role: "assistant", usage: usage(n) } });

// subagentTokens: the cell's reading (null: no transcript); orchTokens: the orchestrator's transcript.
function fixture({ subagentTokens = null, orchTokens = null } = {}) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "ctx-cell-")));
  const projDir = path.join(home, ".claude", "projects", "-fixture-project");
  const wt = path.join(home, "worktrees", "agent-a");
  mkdirSync(wt, { recursive: true });
  mkdirSync(path.join(projDir, SESSION, "subagents"), { recursive: true });
  if (subagentTokens !== null) {
    writeFileSync(path.join(projDir, SESSION, "subagents", "agent-a.jsonl"), asst(wt, subagentTokens) + "\n");
  }
  if (orchTokens !== null) writeFileSync(path.join(projDir, `${SESSION}.jsonl`), asst(home, orchTokens) + "\n");
  return { home, wt };
}

function run(f, args, env = {}) {
  const e = { ...process.env, HOME: f.home, CLAUDE_CODE_SESSION_ID: SESSION, ...env };
  delete e.CONTEXT_BUDGET_CONFIG;
  if (env.CONTEXT_BUDGET_CONFIG) e.CONTEXT_BUDGET_CONFIG = env.CONTEXT_BUDGET_CONFIG;
  const r = spawnSync("node", [SCRIPT, ...args], { cwd: f.wt, env: e, encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const self = (tokens, cell, env) => run(fixture({ subagentTokens: tokens }), ["--self", "--cell", cell], env);

test("developer: 65k is ok, with the shipped 100k / 150k numbers in the output", () => {
  const j = self(65_000, "developer");
  assert.equal(j.context_tokens, 65_000);
  assert.equal(j.warn, 100_000);
  assert.equal(j.stop, 150_000);
  assert.equal(j.state, "ok");
  assert.equal(j.scope, "self");
});

test("developer: warn from 100k, stop from 150k", () => {
  assert.equal(self(99_999, "developer").state, "ok");
  assert.equal(self(100_000, "developer").state, "warn");
  assert.equal(self(149_999, "developer").state, "warn");
  assert.equal(self(150_000, "developer").state, "stop");
});

test("security: 100k / 150k like every cell, so 85k is ok, 105k warns and 150k stops", () => {
  const j = self(105_000, "security");
  assert.equal(j.warn, 100_000);
  assert.equal(j.stop, 150_000);
  assert.equal(j.state, "warn");
  assert.equal(self(85_000, "security").state, "ok");
  assert.equal(self(150_000, "security").state, "stop");
});

test("every cell role reports 100k / 150k (organism-infra/220)", () => {
  for (const role of ["developer", "qa", "designer", "architect", "security", "scout", "product", "herald"]) {
    const j = self(65_000, role);
    assert.deepEqual([j.warn, j.stop, j.state], [100_000, 150_000, "ok"], role);
  }
});

test("an unknown cell type gets 100k / 150k", () => {
  const j = self(65_000, "some-future-cell");
  assert.deepEqual([j.warn, j.stop, j.state], [100_000, 150_000, "ok"]);
});

test("--self --cell keeps the existing keys", () => {
  const j = self(52_000, "qa");
  for (const key of ["session", "context_tokens", "percent", "scope", "warn", "stop", "state"]) assert.ok(key in j, `missing ${key}`);
});

test("--cell orchestrator without --self reads the orchestrator transcript against the orchestrator key", () => {
  const f = fixture({ orchTokens: 75_000 });
  const j = run(f, ["--cell", "orchestrator"]);
  assert.equal(j.context_tokens, 75_000);
  assert.equal(j.warn, 70_000);
  assert.equal(j.stop, 80_000);
  assert.equal(j.state, "warn");
});

test("null reading: state is null, the thresholds are still reported, exit 0", () => {
  const j = run(fixture(), ["--self", "--cell", "developer"]);
  assert.equal(j.context_tokens, null);
  assert.equal(j.state, null);
  assert.equal(j.warn, 100_000);
  assert.equal(j.stop, 150_000);
});

test("a fixture config sets warn, stop and state", () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ctx-cell-cfg-")));
  const config = path.join(dir, "context-budget.json");
  writeFileSync(config, JSON.stringify({ default: { warn: 70_000, stop: 80_000 }, cells: { developer: { warn: 30_000, stop: 40_000 } }, orchestrator: { warn: 70_000, stop: 80_000 } }));
  const j = self(35_000, "developer", { CONTEXT_BUDGET_CONFIG: config });
  assert.deepEqual([j.warn, j.stop, j.state], [30_000, 40_000, "warn"]);
  assert.equal(self(40_000, "developer", { CONTEXT_BUDGET_CONFIG: config }).state, "stop");
});
