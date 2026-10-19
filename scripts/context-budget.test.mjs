// organism-infra/145 (batch C): the context budget thresholds live in one config value.
//
// Seam: scripts/context-budget.mjs exports budgetFor(role) -> {warn, stop} (token counts), reading
// scripts/context-budget.json, or the file named by the CONTEXT_BUDGET_CONFIG env var (the test seam).
// The tests call it in a child node process so the env override works whether the module reads it at
// import time or at call time.
//
// Config shape (architect proposal, approved by the user 2026-10-06):
//   {"default":{"warn":70000,"stop":80000},
//    "cells":{"developer":{"warn":70000,"stop":80000},"qa":{...}},
//    "orchestrator":{"warn":70000,"stop":80000}}
// Fallback rules: unknown role (or none) -> `default`; an entry whose warn/stop are not finite numbers
// or where warn >= stop is invalid and falls back to `default`; a missing, unparseable or invalid
// config file falls back to the built-in (cell roles 100000/150000, the orchestrator 70000/80000; 220), so every caller still fails open.
//
// Criterion map (145 rescoped scope, comment "orchestrator, 2026-10-06 (user yes)"):
//   one config value, approved numbers   -> "shipped config ..." tests
//   budgetFor fallbacks and validation   -> "unknown role ...", "invalid entry ...", "missing/unparseable file ..." tests
//   hook, cell-start, context.mjs share it -> context-budget.tiers.test.mjs, cell-start-context-config.test.mjs,
//                                            context-cell-state.test.mjs
//   team-protocol "Context budget" gated edit, thresholds re-evaluation -> human-verified
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE = path.join(path.resolve(fileURLToPath(new URL("..", import.meta.url))), "scripts", "context-budget.mjs");

function budgetFor(role, configPath) {
  const env = { ...process.env };
  delete env.CONTEXT_BUDGET_CONFIG;
  if (configPath !== undefined) env.CONTEXT_BUDGET_CONFIG = configPath;
  const code = `import { budgetFor } from ${JSON.stringify(MODULE)}; console.log(JSON.stringify(budgetFor(${JSON.stringify(role)})));`;
  const r = spawnSync("node", ["--input-type=module", "-e", code], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 0, `budgetFor(${role}) must not throw: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function writeConfig(body) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ctx-budget-cfg-")));
  const file = path.join(dir, "context-budget.json");
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
}

const FIXTURE = {
  default: { warn: 60_000, stop: 75_000 },
  cells: { developer: { warn: 30_000, stop: 40_000 }, qa: { warn: 31_000, stop: 41_000 } },
  orchestrator: { warn: 20_000, stop: 25_000 },
};

// organism-infra/220 (user, 2026-10-11): every cell role warns at 100k and stops at 150k; the orchestrator
// keeps 70k / 80k. (Supersedes 210's 130k for developer, qa, designer and 208's 70k/80k for the rest.)
test("shipped config: every cell role gets 100k warn / 150k stop", () => {
  for (const role of ["developer", "qa", "designer", "architect", "security", "scout", "product", "herald"]) {
    assert.deepEqual(budgetFor(role), { warn: 100_000, stop: 150_000 }, role);
  }
});

test("shipped config: the orchestrator stays at 70k / 80k", () => {
  assert.deepEqual(budgetFor("orchestrator"), { warn: 70_000, stop: 80_000 });
});

test("shipped config: an unknown role and no role get 100k / 150k", () => {
  assert.deepEqual(budgetFor("some-future-cell"), { warn: 100_000, stop: 150_000 });
  assert.deepEqual(budgetFor(undefined), { warn: 100_000, stop: 150_000 });
});

test("the config file is the single source: CONTEXT_BUDGET_CONFIG changes every role's numbers", () => {
  const cfg = writeConfig(FIXTURE);
  assert.deepEqual(budgetFor("developer", cfg), { warn: 30_000, stop: 40_000 });
  assert.deepEqual(budgetFor("qa", cfg), { warn: 31_000, stop: 41_000 });
  assert.deepEqual(budgetFor("orchestrator", cfg), { warn: 20_000, stop: 25_000 });
});

test("unknown role falls back to the config's default entry", () => {
  const cfg = writeConfig(FIXTURE);
  assert.deepEqual(budgetFor("security", cfg), { warn: 60_000, stop: 75_000 });
  assert.deepEqual(budgetFor(undefined, cfg), { warn: 60_000, stop: 75_000 });
});

test("a config without an orchestrator key gives the orchestrator the default entry", () => {
  const cfg = writeConfig({ default: FIXTURE.default, cells: FIXTURE.cells });
  assert.deepEqual(budgetFor("orchestrator", cfg), { warn: 60_000, stop: 75_000 });
});

test("invalid entry (warn >= stop, or non-numbers) falls back to default", () => {
  const cfg = writeConfig({
    default: FIXTURE.default,
    cells: {
      developer: { warn: 90_000, stop: 90_000 },
      qa: { warn: "100k", stop: "120k" },
      security: { warn: 50_000 },
    },
    orchestrator: { warn: 95_000, stop: 80_000 },
  });
  for (const role of ["developer", "qa", "security", "orchestrator"]) {
    assert.deepEqual(budgetFor(role, cfg), { warn: 60_000, stop: 75_000 }, role);
  }
});

test("missing file falls back to the built-in: cell roles 100k / 150k, the orchestrator 70k / 80k", () => {
  const missing = path.join(tmpdir(), "no-such-dir-ctx-budget", "context-budget.json");
  for (const role of ["developer", "qa", "scout", "some-future-cell", undefined]) {
    assert.deepEqual(budgetFor(role, missing), { warn: 100_000, stop: 150_000 }, String(role));
  }
  assert.deepEqual(budgetFor("orchestrator", missing), { warn: 70_000, stop: 80_000 });
});

test("unparseable file, or an invalid default entry, falls back to the built-in (cells 100k / 150k, orchestrator 70k / 80k)", () => {
  assert.deepEqual(budgetFor("developer", writeConfig("{ not json")), { warn: 100_000, stop: 150_000 });
  assert.deepEqual(budgetFor("developer", writeConfig({ default: { warn: 5, stop: 1 }, cells: {} })), { warn: 100_000, stop: 150_000 });
  assert.deepEqual(budgetFor("orchestrator", writeConfig("{ not json")), { warn: 70_000, stop: 80_000 });
  assert.deepEqual(budgetFor("orchestrator", writeConfig({ default: { warn: 5, stop: 1 }, cells: {} })), { warn: 70_000, stop: 80_000 });
});
