// portable-den/13: four pstack methods adopted (tdd rules, architect process, figure-it-out, statechart).
// Reads .claude/ and the generated .agents/ mirror; passes once the gated patch 13-adopt-pstack-methods is applied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const NEW_SKILLS = ["how", "why", "arena", "architect", "figure-it-out", "statechart"];
const CURSOR_ONLY = /generalPurpose|pstack-models\.mdc|~\/\.cursor|disable-model-invocation|Task tool|grok-|composer-/;

test("tdd keeps the loop and carries pstack's no-bad-test rule and failing-before/passing-after report", () => {
  const s = read(".claude/skills/tdd/SKILL.md");
  assert.match(s, /Red before green/);
  assert.match(s, /Prefer no new test over a bad test/);
  assert.match(s, /failed before the change[^\n]*passes after/i);
});

test("the six pstack skills exist, are model-invocable, and name no Cursor-only tool or path", () => {
  for (const name of NEW_SKILLS) {
    const rel = `.claude/skills/${name}/SKILL.md`;
    assert.ok(existsSync(path.join(ROOT, rel)), rel);
    const s = read(rel);
    assert.match(s, new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`), rel);
    assert.doesNotMatch(s, CURSOR_ONLY, rel);
    assert.equal(read(`.agents/skills/${name}/SKILL.md`).includes("disable-model-invocation"), false, `${name} mirror`);
  }
});

test("the architect role runs the architect process and names how, arena, statechart and figure-it-out", () => {
  const s = read(".claude/agents/architect.md");
  for (const w of ["`architect`", "`how`", "`arena`", "`statechart`", "`figure-it-out`", "codebase-design", "pstack-models.md"]) assert.ok(s.includes(w), w);
  for (const ref of ["design-red-flags", "rationale-template", "runner-prompt", "principles"]) assert.ok(existsSync(path.join(ROOT, `.claude/skills/architect/references/${ref}.md`)), ref);
});

test("wayfinder is retired: no skill folder, no reference outside the VENDORED history, grilling hands off to figure-it-out", () => {
  assert.equal(existsSync(path.join(ROOT, ".claude/skills/wayfinder")), false);
  assert.equal(existsSync(path.join(ROOT, ".agents/skills/wayfinder")), false);
  assert.match(read(".claude/skills/grilling/SKILL.md"), /hand off to figure-it-out/);
  for (const rel of [".claude/skills/grilling/SKILL.md", ".claude/agents/architect.md", "docs/agents/issue-tracker.md"]) assert.doesNotMatch(read(rel), /wayfinder/i, rel);
});

test("statechart ships its tool and says plainly where it does not run", () => {
  const s = read(".claude/skills/statechart/SKILL.md");
  assert.ok(statSync(path.join(ROOT, ".claude/skills/statechart/scripts/statechart.ts")).size > 0);
  assert.match(s, /Linux, macOS and WSL/);
  assert.match(s, /does not run on native Windows/);
  assert.match(s, /TLA2TOOLS/);
});

test("VENDORED.md records each port at pin 0.15.36", () => {
  const s = read(".claude/skills/VENDORED.md");
  for (const row of ["how, why", "arena", "architect", "figure-it-out", "statechart"]) assert.match(s, new RegExp(`^\\| ${row} [^\\n]*\\(0\\.15\\.36\\)`, "m"), row);
});
