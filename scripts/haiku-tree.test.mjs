// den-mvp/90: a bounded Haiku tree and lighter role definitions. Root (Bao, the router) -> branch (Sonnet agents) -> leaf (Haiku).
// Only the root and the branch hold Agent; a branch starts only leaves. These tests pin the role definition shapes.
// Red until the gated patch .scratch/_handoffs/gated/90-haiku-tree.patch is applied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const AGENTS = readdirSync(path.join(ROOT, ".claude/agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));

function front(name) {
  const text = read(`.claude/agents/${name}.md`);
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  assert.ok(m, `${name}.md has no front matter`);
  const get = (k) => m[1].match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1].trim();
  const skills = m[1].match(/^skills:\r?\n((?:[ \t]+- .*\r?\n?)+)/m);
  return {
    model: get("model"),
    effort: get("effort"),
    // split on commas outside parentheses so Agent(a, b) stays one entry
    tools: (get("tools") ?? "").split(/,(?![^(]*\))/).map((t) => t.trim()).filter(Boolean),
    skills: skills ? [...skills[1].matchAll(/- (\S+)/g)].map((x) => x[1]) : [],
    body: m[2],
  };
}
// A plugin load names each role den:<role>; the allow-lists carry both spellings of the same role.
const agentTargets = (tools) => tools.filter((t) => /^Agent\(/.test(t)).flatMap((t) => t.slice(6, -1).split(",").map((x) => x.trim().replace(/^den:/, "")));

test("runner is a Haiku leaf: model haiku, no Agent tool", () => {
  assert.ok(existsSync(path.join(ROOT, ".claude/agents/runner.md")), "runner.md is missing");
  const r = front("runner");
  assert.equal(r.model, "haiku");
  assert.deepEqual(r.tools.filter((t) => /^Agent\b/.test(t)), []);
  for (const need of ["Read", "Grep", "Glob", "Edit", "Bash"]) assert.ok(r.tools.includes(need), `runner lacks ${need}`);
  assert.match(r.body, /result/);
  assert.match(r.body, /evidence/);
  assert.match(r.body, /failures/);
});

test("no leaf role definition (model: haiku) holds Agent", () => {
  const leaves = AGENTS.filter((a) => front(a).model === "haiku");
  assert.ok(leaves.includes("runner") && !leaves.includes("scout"), `leaves: ${leaves}`);
  for (const l of leaves) assert.deepEqual(front(l).tools.filter((t) => /^Agent\b/.test(t)), [], `${l} is a leaf and holds Agent`);
});

// ADR 0029 Amendment 1: the architect starts pstack leaves (how, why, arena) on any model the skills name; they start nothing.
const PSTACK_LEAVES = ["Explore", "general-purpose"];

test("the tree is three levels: only the orchestrator and the chief of staff start branch agents; a branch starts only leaves", () => {
  const leaves = AGENTS.filter((a) => front(a).model === "haiku");
  for (const a of AGENTS.filter((x) => x !== "orchestrator" && x !== "chief-of-staff")) {
    const allowed = a === "architect" ? [...leaves, ...PSTACK_LEAVES] : leaves;
    for (const t of agentTargets(front(a).tools)) assert.ok(allowed.includes(t), `${a} starts ${t}, which is not a leaf`);
  }
});

test("developer and qa can start runner and say when to", () => {
  for (const a of ["developer", "qa"]) {
    const g = front(a);
    assert.ok(agentTargets(g.tools).includes("runner"), `${a} cannot start runner`);
    assert.match(g.body, /`runner`[^\n]*\b(verify|check)/i, `${a} does not say when to use runner`);
  }
});

test("the chief of staff (Bao's desk, once the orchestrator) is on Sonnet and preloads only what every run uses", () => {
  const o = front("chief-of-staff");
  assert.equal(o.model, "sonnet");
  assert.equal(o.effort, "high");
  assert.deepEqual(o.skills, ["team-protocol", "grilling", "domain-modeling"]);
  assert.match(o.body, /node scripts\/usage\.mjs/);
  assert.doesNotMatch(o.body, /with `usage-watch`|from `usage-watch`/);
});

test("the architect reads codebase-design and domain-modeling when used, not preloaded", () => {
  const a = front("architect");
  assert.deepEqual(a.skills, ["team-protocol", "principle-laziness-protocol", "principle-subtract-before-you-add"]);
  assert.match(a.body, /codebase-design/);
  assert.match(a.body, /domain-modeling/);
});

test("runner's edit scope is pinned: fully specified changes; no board, commit, push or .claude/ edits", () => {
  const b = front("runner").body;
  assert.match(b, /never run `board`, `git commit`, `git push`, or edit anything under `\.claude\/` or `CLAUDE\.md`/);
  assert.match(b, /fully specified/i);
});

test("qa verify: runner makes no edit, so a leaf cannot weaken a test the guard step compares", () => {
  assert.match(read(".claude/agents/qa.md"), /runner[^\n]*(makes no edit|no edit)[^\n]*verify|verify[^\n]*runner[^\n]*makes no edit/i);
});

test("the chief of staff asks on a failed or stale usage reading, warns at 80% weekly, and passes the provider", () => {
  const b = front("chief-of-staff").body;
  assert.match(b, /usage\.mjs[^\n]*exits 1[^\n]*"stale": true[^\n]*ask the user/i);
  assert.match(b, /80% (of )?weekly|weekly[^\n]*80%/i);
  assert.match(b, /--provider/);
  assert.doesNotMatch(b, /;\)/);
});

test("no genome mentions a Blender probe", () => {
  for (const a of AGENTS) assert.doesNotMatch(front(a).body, /Blender probe|probes its tools/i, a);
  assert.doesNotMatch(front("chief-of-staff").body, /Blender/i);
});

// mcp__socket stays on developer: the connections catalog grants it and catalog.test.mjs (den-mvp/36) pins that; the user decides.
test("developer and designer list no Blender tools, and designer no socket", () => {
  for (const a of ["developer", "designer"]) assert.deepEqual(front(a).tools.filter((t) => /^mcp__blender/.test(t)), [], a);
  assert.deepEqual(front("designer").tools.filter((t) => /^mcp__socket/.test(t)), []);
  assert.doesNotMatch(front("developer").body, /mcp__blender/);
  assert.doesNotMatch(front("designer").body, /with the Blender tools/);
});

test("grill-me and grill-with-docs are gone and nothing names them", () => {
  for (const n of ["grill-me", "grill-with-docs"]) assert.ok(!existsSync(path.join(ROOT, ".claude/skills", n)), `${n} still exists`);
  const walk = (d) => readdirSync(d).flatMap((n) => {
    const p = path.join(d, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".md") ? [p] : [];
  });
  const files = [...walk(path.join(ROOT, ".claude")), ...walk(path.join(ROOT, "docs/agents")), path.join(ROOT, "CLAUDE.md")];
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), /grill-me|grill-with-docs/, path.relative(ROOT, f));
});

test("team-protocol carries the pstack lines and did not grow", () => {
  const s = read(".claude/skills/team-protocol/SKILL.md");
  assert.match(s, /fresh subagent/i);
  assert.match(s, /resume[^\n]*(local state|costly)/i);
  assert.match(s, /idempotent/i);
  assert.match(s, /prove[^\n]*by running/i);
  assert.ok(s.split("\n").length - 1 < 104, "team-protocol is preloaded into every agent; it must stay under its old 104 lines");
});

test("qa verify has a blast-radius step: what the change breaks beyond the diff, proved by running code", () => {
  const s = read(".claude/agents/qa.md");
  assert.match(s, /blast radius/i);
  assert.match(s, /beyond the diff/i);
  assert.match(s, /callers/i);
  assert.match(s, /entry points?/i);
  assert.match(s, /blast radius[^\n]*\b(run|running)\b/i);
});
