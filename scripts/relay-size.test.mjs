// den-mvp/71: the relay is sized to risk, and every file that describes the relay says so the same way. A risk-path
// ticket runs qa `specify`; any other ticket goes straight to the developer, and qa `verify` maps every criterion to a test
// and gives a verdict on each test-guard hit. A grep pins the wording; organism-protocol holds the definition ("Relay size").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const FILES = ["CLAUDE.md", ".claude/skills/organism-protocol/SKILL.md", ".claude/agents/orchestrator.md", ".claude/agents/qa.md", ".claude/agents/developer.md"];

test("organism-protocol defines the relay size: risk path, light path, no specify off the risk path", () => {
  const s = read(".claude/skills/organism-protocol/SKILL.md");
  assert.match(s, /^## Relay size/m);
  assert.match(s, /\*\*risk-path\*\*/);
  assert.match(s, /light path/i);
  assert.match(s, /test-guard/);
});

for (const rel of FILES) {
  test(`${rel} names the relay size and the risk path`, () => {
    const s = read(rel);
    assert.match(s, /Relay size/);
    assert.match(s, /risk[- ]path/i);
  });
}

test("the orchestrator dispatches qa specify only for a risk-path ticket, and the developer directly otherwise", () => {
  const s = read(".claude/agents/orchestrator.md");
  assert.match(s, /risk-path ticket[^\n]*`specify`/);
  assert.match(s, /dispatch the developer directly/i);
  assert.doesNotMatch(s, /\n1\. `qa` in `specify` mode writes failing acceptance tests on a tests branch\./);
});

test("the qa verify brief requires a per-criterion map and a verdict on each test-guard hit", () => {
  const s = read(".claude/agents/qa.md");
  assert.match(s, /per-criterion map/);
  assert.match(s, /test-guard/);
  assert.match(s, /each hit/i);
  assert.match(s, /fail[s]? without the change/);
});

test("the developer writes the criterion-to-test map when no tests branch exists", () => {
  const s = read(".claude/agents/developer.md");
  assert.match(s, /criterion/i);
  assert.match(s, /no tests branch/i);
});

test("no file still says every ticket is specified first", () => {
  assert.doesNotMatch(read(".claude/agents/qa.md"), /Make every ticket test-first/);
  assert.doesNotMatch(read("CLAUDE.md"), /Code tickets run a relay: qa `specify` writes failing tests/);
});

// den-mvp/90: the risk path names the wall's files, every guardrail risk-check knows is on it, and a doubt means the full relay.
const section = () => read(".claude/skills/organism-protocol/SKILL.md").split(/^## /m).find((x) => x.startsWith("Relay size")) ?? "";

test("the risk path names .claude/, CLAUDE.md, docs/adr/ and the cells JSON files", () => {
  const s = section();
  for (const p of ["`.claude/`", "`CLAUDE.md`", "`docs/adr/`", "limits", "governance", "ceilings"]) assert.ok(s.includes(p), `Relay size does not name ${p}`);
});

test("every guardrail path risk-check hits is on the named risk path", () => {
  const src = read("scripts/risk-check.mjs");
  const paths = [...src.matchAll(/^\s*\["(apps\/[^"]+\.json)"/gm)].map((m) => m[1]);
  assert.ok(paths.length >= 3, `found ${paths.length} guardrail paths in risk-check`);
  for (const p of paths) assert.ok(section().includes(path.basename(p, ".json")), `Relay size does not name ${p}`);
});

test("the light path ends with security on a hit, and a doubt takes the full relay", () => {
  const s = section();
  assert.match(s, /Then `risk-check`, and `security` on a hit/);
  assert.match(s, /When unsure, [^.]*full relay/);
});
