// hardening/02: a ticket carries its why, its limits and (on a bug) the cause, so agents fix the cause rather than the
// symptom. A grep pins the wording in the Claude skills and role files, their .agents/.codex copies, and the tracker doc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const BOTH = (skill) => [`.claude/skills/${skill}/SKILL.md`, `.agents/skills/${skill}/SKILL.md`];

for (const rel of BOTH("to-tickets")) {
  test(`${rel}: the template has type, Why, Out of scope, Cause, Estimate and an advisory paths line`, () => {
    const s = read(rel);
    for (const f of ["Type", "Why", "Out of scope", "Cause", "Estimate"]) assert.match(s, new RegExp(`\\*\\*${f}:\\*\\*`), f);
    assert.match(s, /feature \| bug \| spike \| chore/);
    assert.match(s, /Paths \(advisory\)/);
    assert.doesNotMatch(s, /avoid specific file paths/i);
  });

  test(`${rel}: splits above 150k tokens, merges below 30k into a same-touch-set sibling`, () => {
    const s = read(rel);
    assert.match(s, /above 150k[^\n]*split/i);
    assert.match(s, /below 30k[^\n]*merge[^\n]*same touch set/i);
  });

  test(`${rel}: done-when is capped at about 5 checks, milestones only for more than one`, () => {
    const s = read(rel);
    assert.match(s, /about 5/);
    assert.match(s, /milestones? only when the work has more than one/i);
  });
}

test("docs/agents/issue-tracker.md describes the same ticket format", () => {
  const s = read("docs/agents/issue-tracker.md");
  for (const f of ["Type", "Why", "Out of scope", "Cause", "Estimate"]) assert.match(s, new RegExp(`\\*\\*${f}:\\*\\*`), f);
  assert.match(s, /about 5/);
});

test("developer.md routes a bug ticket to diagnosing-bugs and requires the cause note before the first test", () => {
  const s = read(".claude/agents/developer.md");
  assert.match(s, /bug[^\n]*ticket[^\n]*`diagnosing-bugs`[^\n]*first/i);
  assert.match(s, /cause note[^\n]*before[^\n]*(first )?test/i);
  for (const part of ["symptom", "repro", "hypotheses", "chosen cause", "where else", "target layer"]) assert.match(s, new RegExp(part, "i"), part);
  assert.match(read(".codex/agents/developer.toml"), /cause note/i);
});

test("the cause note lives in the ticket's comments everywhere; the Cause field stays empty", () => {
  for (const rel of [...BOTH("to-tickets"), "docs/agents/issue-tracker.md"]) assert.match(read(rel), /cause note in[^\n]*`## Comments`/i, rel);
  assert.match(read(".claude/agents/developer.md"), /cause note as a ticket comment[^\n]*field stays empty/i);
  assert.match(read(".claude/agents/code-reviewer.md"), /cause note \(look in the ticket's `## Comments`\)/);
  assert.match(read(".codex/agents/developer.toml"), /cause note as a ticket comment/i);
  assert.match(read(".codex/agents/code-reviewer.toml"), /cause note \(in the ticket's Comments\)/);
});

test("developer.md files discovered work as a new ticket, not a Comments note", () => {
  assert.match(read(".claude/agents/developer.md"), /new ticket/i);
  assert.doesNotMatch(read(".claude/agents/developer.md"), /add it to `## Comments` for the orchestrator/);
});

for (const rel of BOTH("diagnosing-bugs")) {
  test(`${rel} has a "where else does this cause exist" step`, () => {
    assert.match(read(rel), /where else does this cause exist/i);
  });
}

test("code-reviewer checks the cause note's layer and, on bug tickets, greps the cause pattern outside the diff", () => {
  for (const rel of [".claude/agents/code-reviewer.md", ".codex/agents/code-reviewer.toml"]) {
    const s = read(rel);
    assert.match(s, /cause note/i, rel);
    assert.match(s, /layer/i, rel);
    assert.match(s, /outside the diff/i, rel);
  }
});

test("team-protocol (Claude and Codex): file discovered work, wait for subagents, retry brief", () => {
  for (const rel of [...BOTH("team-protocol"), ".codex/team-protocol.md"]) {
    const s = read(rel);
    assert.match(s, /file[^\n]*discovered work[^\n]*new ticket[^\n]*(don't|do not|instead of) chas/i, rel);
    assert.match(s, /waits? for (their|its|every)[^\n]*reports? before[^\n]*(hand|end)/i, rel);
    assert.match(s, /retry brief[^\n]*cause note[^\n]*failure summary[^\n]*10 lines[^\n]*never transcript/i, rel);
  }
});

test("no skill, agent or tracker doc references /setup-matt-pocock-skills", () => {
  const walk = (d) => readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
  for (const rel of [...walk(".claude/skills"), ...walk(".agents/skills"), ...walk(".claude/agents"), "docs/agents/issue-tracker.md"]) {
    assert.doesNotMatch(read(rel), /setup-matt-pocock-skills/, rel);
  }
});

test("VENDORED.md marks each edited skill adapted with its change (Claude and .agents copies match)", () => {
  const s = read(".claude/skills/VENDORED.md");
  assert.equal(read(".agents/skills/VENDORED.md"), s);
  for (const skill of ["to-tickets", "diagnosing-bugs", "wayfinder", "grilling", "code-review", "to-spec"]) {
    assert.match(s, new RegExp(`^\\| ${skill}[^\\n]*\\*\\*adapted\\*\\*`, "m"), skill);
  }
});
