// organism-infra/53: acceptance tests for the organ -> station rename (and Brain gate -> Pass gate).
// See .scratch/organism-infra/issues/53-organ-to-station-rename.md.
//
// Seams: the repo's text surface (role definitions, skills, docs/agents, CLAUDE.md, apps/, scripts/) and the
// role definition frontmatter under .claude/agents/. No code in apps/ parses `organism.organ:` today
// (schemas.mjs has no role definition schema), so "the schema accepts station:" is tested as: every role definition
// carries a valid `station:` value and no `organ:` key.
//
// Not testable automatically (human-verified): that the prose reads well after the rename.
// Fixtures under apps/board/fixtures/ are frozen historical ticket copies and are skipped.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = path.join(ROOT, "scripts", "organ-to-station.test.mjs");
const TEXT_EXT = new Set([".md", ".mjs", ".js", ".jsx", ".ts", ".tsx", ".py", ".json", ".css", ".html"]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "fixtures") continue;
    const p = path.join(dir, e.name);
    // .claude/worktrees/ is git-ignored and holds whole checkouts (a den-started agent's worktree is kept after its
    // run); each one is this repository again at some commit, its board history included, and not in scope.
    if (p === path.join(ROOT, ".claude", "worktrees")) continue;
    if (e.isDirectory()) walk(p, out);
    else if (TEXT_EXT.has(path.extname(e.name)) && p !== SELF) out.push(p);
  }
  return out;
}

const scope = [
  ...walk(path.join(ROOT, ".claude")),
  ...walk(path.join(ROOT, "docs", "agents")),
  ...walk(path.join(ROOT, "apps")),
  ...walk(path.join(ROOT, "scripts")),
  path.join(ROOT, "CLAUDE.md"),
];
const rel = (p) => path.relative(ROOT, p);
const isNote = (line) => /was:\s*organ|was \(organ\)|the old name/i.test(line);

function hits(re, { allowNotes = false } = {}) {
  const found = [];
  for (const f of scope) {
    fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (re.test(line) && !(allowNotes && isNote(line))) found.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  return found;
}

const STATION_OF = {
  orchestrator: "pass", product: "pass", architect: "pass",
  developer: "steamers", scout: "steamers",
  qa: "tea-pantry", security: "tea-pantry",
  designer: "front-of-house",
};

function frontmatter(name) {
  const text = fs.readFileSync(path.join(ROOT, ".claude", "agents", `${name}.md`), "utf8");
  return text.split(/\n---\s*\n/)[0];
}

test("no bare word 'organ'/'organs' remains in scope except 'was: organ' notes (criterion 1)", () => {
  assert.deepEqual(hits(/\borgans?\b/i, { allowNotes: true }), []);
});

test("every role definition declares org.team with its team value (criterion 2; ADR 0028 renamed org.station)", () => {
  for (const [name, station] of Object.entries(STATION_OF)) {
    const fm = frontmatter(name);
    assert.match(fm, new RegExp(`^\\s+team:\\s*${station}\\s*$`, "m"), `${name}.md team: ${station}`);
  }
});

test("no role definition frontmatter keeps an 'organ:' key (criterion 2)", () => {
  for (const name of Object.keys(STATION_OF)) {
    assert.doesNotMatch(frontmatter(name), /^\s+organ:/m, `${name}.md still has organ:`);
  }
});

test("agent prose uses team names, not Brain/Muscles/Immune/Skin agent (criterion 1)", () => {
  assert.deepEqual(hits(/\b(Brain|Muscles|Immune|Skin) (role|organ)\b|\((Brain|Muscles|Immune|Skin)\)/), []);
  const qa = fs.readFileSync(path.join(ROOT, ".claude", "agents", "qa.md"), "utf8");
  assert.match(qa, /\*\*qa\*\* agent of the Tea (&|and) Pantry team/i);
  const orch = fs.readFileSync(path.join(ROOT, ".claude", "agents", "orchestrator.md"), "utf8");
  assert.match(orch, /agent of the (Pass|The Pass) team/i);
});

test("'Brain gate' is renamed to 'Pass gate' everywhere in scope (criterion 3)", () => {
  assert.deepEqual(hits(/brain gates?/i), []);
  const proto = fs.readFileSync(path.join(ROOT, ".claude", "skills", "team-protocol", "SKILL.md"), "utf8");
  assert.match(proto, /## Pass gates/);
});

test("CLAUDE.md Agents section names the teams", () => {
  const md = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
  assert.match(md, /\(Pass\)/);
  assert.match(md, /\(Steamers\)/);
  assert.match(md, /\(Tea & Pantry\)/);
  assert.match(md, /\(Front of House\)/);
  assert.match(md, /stop at pass gates/);
});

test("the rename and the Pass gate decision are recorded in an ADR (criterion 3)", () => {
  const dir = path.join(ROOT, "docs", "adr");
  const recorded = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).filter((f) => {
    const t = fs.readFileSync(path.join(dir, f), "utf8");
    return /organ/i.test(t) && /station/i.test(t) && /pass gate/i.test(t) && /renam/i.test(t);
  });
  assert.ok(recorded.length > 0, "no ADR or ADR index line records organ -> station and Brain -> Pass gate");
});
