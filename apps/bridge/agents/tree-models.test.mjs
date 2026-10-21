import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTreeRole, assertTreeRuntimeModel } from "./tree-models.mjs";
import { MODEL_MAP } from "../../../scripts/codex-sync.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const temporary = [];
afterEach(() => temporary.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture({ role = "developer", model = "sonnet", effort = "high", codexModel = MODEL_MAP[model], codexEffort = effort } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "den-tree-model-"));
  temporary.push(root);
  const write = (file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  write(`.claude/agents/${role}.md`, `---\nname: ${role}\ntools: Read, Bash, Agent(runner), Skill\nmodel: ${model}\neffort: ${effort}\n---\nRole body.\n`);
  write(`.codex/agents/${role}.toml`, `name = "${role}"\nmodel = "${codexModel}"\nmodel_reasoning_effort = "${codexEffort}"\ndeveloper_instructions = '''\nmodel = "untrusted-body-text"\n'''\n`);
  return { root, write, selection: (runtime = "claude") => resolveTreeRole({ controlRoot: root, role, runtime }) };
}

test("tree routing preserves configured manager and cheaper leaf models for both runtime identities", () => {
  for (const [role, model, effort] of [["orchestrator", "sonnet", "high"], ["developer", "sonnet", "high"], ["code-reviewer", "sonnet", "high"], ["qa", "sonnet", "high"], ["runner", "haiku", "low"]]) {
    for (const runtime of ["claude", "codex"]) {
      const selected = resolveTreeRole({ controlRoot: ROOT, role, runtime });
      assert.equal(selected.model, runtime === "claude" ? model : MODEL_MAP[model]);
      assert.equal(selected.effort, effort);
      assert.equal(selected.canDelegate, role !== "runner");
      if (role === "runner") assert.deepEqual(selected.delegateRoles, []);
    }
  }
  assert.equal(MODEL_MAP.opus, "gpt-6-astra");
});

test("tree routing refuses unknown models, effort, recipe drift and path-like roles", () => {
  for (const options of [{ model: "invented" }, { effort: "ultra" }, { codexModel: "gpt-6-luna" }, { codexEffort: "low" }]) {
    const f = fixture(options);
    for (const runtime of ["claude", "codex"]) assert.throws(() => f.selection(runtime), /unsupported|drifted/);
  }
  const f = fixture();
  assert.throws(() => resolveTreeRole({ controlRoot: f.root, role: "../developer", runtime: "claude" }), /unknown tree role/);
  assert.throws(() => resolveTreeRole({ controlRoot: f.root, role: "developer", runtime: "unknown" }), /unknown tree runtime/);
  f.write(".claude/agents/developer.md", "---\nname: developer\ntools: Read\nmodel: sonnet\nmodel: haiku\neffort: high\n---\n");
  assert.throws(() => f.selection(), /exactly one model/);
});

test("tree delegation authority comes from the trusted role tools and never from a caller's role claim", () => {
  const f = fixture();
  assert.deepEqual(f.selection().delegateRoles, ["runner"]);
  f.write(".claude/agents/developer.md", "---\nname: developer\ntools: Read, Bash\nmodel: sonnet\neffort: high\n---\nAgent(runner) mentioned in prose is no authority.\n");
  assert.equal(f.selection().canDelegate, false);
  assert.deepEqual(f.selection().delegateRoles, []);
  assert.equal(resolveTreeRole({ controlRoot: ROOT, role: "security", runtime: "codex" }).canDelegate, false);
  assert.equal(resolveTreeRole({ controlRoot: ROOT, role: "designer", runtime: "claude" }).canDelegate, false);
});

test("a tree runtime must explicitly enforce delegation and accept the selected model with no fallback", async () => {
  const selection = { role: "code-reviewer", model: "gpt-6.1-sol", effort: "high" };
  for (const adapter of [undefined, {}, { capabilities: { treeDelegation: true } }, { capabilities: {}, validateModel: () => true }]) {
    await assert.rejects(assertTreeRuntimeModel(adapter, selection), /cannot enforce/);
  }
  for (const response of [false, undefined, "yes"]) await assert.rejects(assertTreeRuntimeModel({ capabilities: { treeDelegation: true }, validateModel: () => response }, selection), /unavailable/);
  let checked;
  await assertTreeRuntimeModel({ capabilities: { treeDelegation: true }, validateModel: async (s) => (checked = s, true) }, selection);
  assert.equal(checked, selection);
  await assert.rejects(assertTreeRuntimeModel({ capabilities: { treeDelegation: true }, validateModel: () => { throw new Error("model catalog unreachable"); } }, selection), /model catalog unreachable/);
});
