// team-and-den-ux/19: qa has no `specify` mode. The engineer writes the failing tests first on every code ticket, and qa
// `verify` maps every criterion to a test that fails without the change and gives a verdict on each test-guard hit.
// A grep pins the wording; team-protocol holds the definition ("Relay size").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

test("team-protocol defines the risk path and has the engineer write the failing tests first", () => {
  const s = read(".claude/skills/team-protocol/SKILL.md");
  assert.match(s, /^## Relay size/m);
  assert.match(s, /\*\*risk-path\*\*/);
  assert.match(s, /engineer writes the failing tests first/);
  assert.match(s, /test-guard/);
});

test("qa has no specify mode; the definition and the protocol never ask for one", () => {
  const qa = read(".claude/agents/qa.md");
  assert.doesNotMatch(qa, /specify/i);
  assert.doesNotMatch(read(".claude/skills/team-protocol/SKILL.md"), /qa `specify`|--mode specify|`specify` or `verify`/);
});

test("the qa verify brief requires a per-criterion map and a verdict on each test-guard hit", () => {
  const s = read(".claude/agents/qa.md");
  assert.match(s, /per-criterion map/);
  assert.match(s, /test-guard/);
  assert.match(s, /each hit/i);
  assert.match(s, /fail[s]? without the change/);
});

test("the developer writes the criterion-to-test map first, with no tests branch", () => {
  const s = read(".claude/agents/developer.md");
  assert.match(s, /Write the tests yourself, first/);
  assert.match(s, /each criterion with its test/);
  assert.doesNotMatch(s, /tests branch/i);
});

// den-mvp/90: the risk path names the wall's files, every guardrail risk-check knows is on it, and a doubt means the risk path.
const section = () => read(".claude/skills/team-protocol/SKILL.md").split(/^## /m).find((x) => x.startsWith("Relay size")) ?? "";

test("the risk path names .claude/, CLAUDE.md, docs/adr/ and the agents JSON files", () => {
  const s = section();
  for (const p of ["`.claude/`", "`CLAUDE.md`", "`docs/adr/`", "limits", "governance", "ceilings"]) assert.ok(s.includes(p), `Relay size does not name ${p}`);
});

test("every guardrail path risk-check hits is on the named risk path", () => {
  const src = read("scripts/risk-check.mjs");
  const paths = [...src.matchAll(/^\s*\["(apps\/[^"]+\.json)"/gm)].map((m) => m[1]);
  assert.ok(paths.length >= 3, `found ${paths.length} guardrail paths in risk-check`);
  for (const p of paths) assert.ok(section().includes(path.basename(p, ".json")), `Relay size does not name ${p}`);
});

test("the relay ends with security on a risk-check hit, and a doubt means the risk path", () => {
  const s = section();
  assert.match(s, /Then `risk-check`, and `security` on a hit/);
  assert.match(s, /When unsure whether a ticket is on the risk path, treat it as on it/);
});
