// portable-den/13: four pstack methods adopted (tdd rules, architect process, figure-it-out, statechart).
// Reads .claude/ and the generated .agents/ mirror; passes once the gated patch 13-adopt-pstack-methods is applied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const NEW_SKILLS = ["how", "why", "arena", "architect", "figure-it-out", "statechart"];
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const portedFiles = (ext) => NEW_SKILLS.flatMap((n) => walk(path.join(ROOT, ".claude/skills", n))).filter((p) => ext.test(p));
const relOf = (p) => path.relative(ROOT, p);
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

test("every file of the six ported skills names no Cursor-only tool or path, and nothing but VENDORED mentions wayfinder", () => {
  for (const p of portedFiles(/\.(md|ts|mjs|json)$/)) {
    const s = readFileSync(p, "utf8");
    assert.doesNotMatch(s, CURSOR_ONLY, relOf(p));
    assert.doesNotMatch(s, /wayfinder/i, relOf(p));
    assert.doesNotMatch(s, /docs\/harness\/claude-code\.md|Cursor/, relOf(p));
  }
});

test("every relative link and reference path in the ported skills resolves, and none is a repo-relative .claude/ path", () => {
  for (const p of portedFiles(/\.md$/)) {
    const s = readFileSync(p, "utf8");
    assert.doesNotMatch(s, /(^|[^~\w])\.claude\/(skills|agents)\//, `${relOf(p)} names a repo-relative .claude/ path; link relative to the skill's own folder`);
    const skillRoot = path.join(ROOT, ".claude/skills", relOf(p).split(path.sep)[2]);
    const targets = [...s.matchAll(/\]\(([^)#\s]+)/g)].map((m) => m[1]).filter((t) => t !== "url" && !/^[a-z]+:/i.test(t));
    for (const m of s.matchAll(/`((?:\.\.?\/|references\/|sources\/)[^`\s<]*\.md)`/g)) targets.push(m[1]);
    for (const t of targets) {
      const ok = [path.dirname(p), skillRoot].some((base) => existsSync(path.resolve(base, t)));
      assert.ok(ok, `${relOf(p)} points at ${t}, which does not exist`);
    }
  }
});

test("statechart runs on Node alone: a .mjs launcher, no /bin/sh, kill by pid or taskkill, and the Platforms section says so", () => {
  const dir = ".claude/skills/statechart/scripts";
  const s = read(".claude/skills/statechart/SKILL.md");
  assert.ok(statSync(path.join(ROOT, `${dir}/statechart.ts`)).size > 0);
  assert.ok(statSync(path.join(ROOT, `${dir}/statechart.mjs`)).size > 0);
  assert.equal(existsSync(path.join(ROOT, `${dir}/statechart`)), false, "the /bin/sh shim is gone");
  for (const f of ["statechart.ts", "run.ts", "statechart.mjs", "kill.ts"]) assert.doesNotMatch(read(`${dir}/${f}`), /\/bin\/sh|killGroup/, f);
  assert.match(read(`${dir}/kill.ts`), /taskkill/);
  assert.match(read(`${dir}/kill.ts`), /process\.kill\(-pid, "SIGKILL"\)/);
  assert.match(read(`${dir}/statechart.ts`), /TEMP: tmp, TMP: tmp/);
  assert.match(read(`${dir}/run.ts`), /process\.platform === "linux" \? \{ \.\.\.process\.env, LC_ALL/);
  assert.match(read(`${dir}/run.ts`), /936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88/);
  assert.equal(JSON.parse(read(`${dir}/package.json`)).name, "statechart");
  assert.match(s, /Linux, macOS, WSL and native Windows/);
  assert.match(s, /TLA2TOOLS/);
  assert.doesNotMatch(s, /curl [^\n]*\| *sh/);
});

test("the architect's tools let it start every subagent type its pstack skills start (ADR 0029 Amendment 1)", () => {
  const tools = read(".claude/agents/architect.md").match(/^tools:\s*(.*)$/m)[1];
  const allowed = tools.match(/Agent\(([^)]*)\)/)[1].split(",").map((x) => x.trim().replace(/^den:/, ""));
  const started = new Set(["runner"]);
  for (const name of ["how", "why", "arena", "architect"])
    for (const p of walk(path.join(ROOT, ".claude/skills", name)).filter((f) => f.endsWith(".md")))
      for (const m of readFileSync(p, "utf8").matchAll(/subagent_type: "([^"]+)"/g)) started.add(m[1]);
  assert.deepEqual([...started].sort(), ["Explore", "general-purpose", "runner"]);
  for (const t of started) assert.ok(allowed.includes(t), `architect cannot start ${t}`);
  assert.match(read("docs/adr/0029-team-charter-and-the-task-tree.md"), /## Amendment 1 \(2026-10-31[^\n]*leaves may run on any model/);
  assert.match(read(".claude/skills/team-protocol/SKILL.md"), /leaf may run on any model a pstack skill names/);
  assert.match(read("CLAUDE.md"), /leaves start nothing and may run on any model a pstack skill names/);
});

test("tdd's no-bad-test rule limits extra tests only, never a criterion's test", () => {
  assert.match(read(".claude/skills/tdd/SKILL.md"), /limits extra tests only\. Each acceptance criterion keeps a test that fails without the change/);
});

test("VENDORED.md records each port at pin 0.15.36", () => {
  const s = read(".claude/skills/VENDORED.md");
  for (const row of ["how, why", "arena", "architect", "figure-it-out", "statechart"]) assert.match(s, new RegExp(`^\\| ${row} [^\\n]*\\(0\\.15\\.36\\)`, "m"), row);
});
