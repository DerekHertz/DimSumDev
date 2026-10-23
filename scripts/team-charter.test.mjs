// team-and-den-ux/02 (ADR 0029): the team charter, the four new roles and the code reviewer in the relay.
//   criterion 2 (every role has inputs, outputs, authority and hand-offs) -> "the charter has a row ..."
//   criterion 3 (independent review; the user's approval points listed)   -> "the charter keeps review independent ...", "the developer does not review ..."
//   criterion 4 (four role definitions exist)                             -> "the four new roles ..."
//   criterion 6 (CLAUDE.md's relay summary matches the ADR)               -> "every file that describes the relay names the code reviewer ..."
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const ROLES = readdirSync(path.join(ROOT, ".claude/agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
const CHARTER = read("docs/agents/team-charter.md");

function front(name) {
  const m = read(`.claude/agents/${name}.md`).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  assert.ok(m, `${name}.md has no front matter`);
  const get = (k) => m[1].match(new RegExp(`^\\s*${k}:\\s*(.*)$`, "m"))?.[1].trim();
  return { model: get("model"), team: get("team"), tools: get("tools") ?? "", body: m[2] };
}

const NEW = { "code-reviewer": ["sonnet", "tea-pantry"], "release-manager": ["sonnet", "pass"], sre: ["haiku", "tea-pantry"], "technical-writer": ["sonnet", "front-of-house"] };

test("the four new roles have role definitions on the model and team the user chose", () => {
  for (const [role, [model, team]] of Object.entries(NEW)) {
    const f = front(role);
    assert.equal(f.model, model, `${role} model`);
    assert.equal(f.team, team, `${role} team`);
    assert.match(f.body, /ADR 0029/, `${role} names its ADR`);
  }
});

test("the charter has a row for every role definition, with inputs, outputs, authority and hand-offs", () => {
  const header = CHARTER.split("\n").find((l) => l.startsWith("| Role |"));
  for (const col of ["Inputs", "Outputs", "Authority", "Hands to"]) assert.ok(header?.includes(col), `charter table lacks ${col}`);
  const label = { "chief-of-staff": "Chief of staff (Bao, Jiao)", developer: "Engineer (`developer`)", "code-reviewer": "Code reviewer", "release-manager": "Release manager", sre: "SRE", "technical-writer": "Technical writer", qa: "qa" };
  for (const role of ROLES) {
    const name = label[role] ?? role[0].toUpperCase() + role.slice(1);
    assert.ok(CHARTER.split("\n").some((l) => l.startsWith(`| ${name} |`)), `charter has no row for ${role}`);
  }
});

test("the charter keeps review independent and lists the user's approval points", () => {
  assert.match(CHARTER, /Nobody reviews their own work/);
  assert.match(CHARTER, /^## The user's approval points/m);
  for (const point of [/user-merge list/, /visual verdicts/, /dependency/, /accepting an ADR/, /den update proposals/, /restart, rollback and limit proposals/]) assert.match(CHARTER, point);
});

test("the developer does not review its own work; the code reviewer writes no code", () => {
  const dev = front("developer");
  assert.match(dev.body, /Skip its `\/code-review` step/);
  assert.match(dev.body, /never review your own work/);
  const cr = front("code-reviewer");
  assert.doesNotMatch(cr.tools, /\bEdit\b/);
  assert.match(cr.body, /never review a commit you wrote/);
  assert.match(cr.body, /VERDICT: pass/);
});

test("the release manager and SRE propose; neither pushes, merges or restarts", () => {
  assert.match(front("release-manager").body, /You change nothing on the git host and nothing in the running den/);
  assert.match(front("sre").body, /You measure; you do not fix/);
  assert.match(front("sre").body, /never start it/);
});

test("every file that describes the relay names the code reviewer beside qa", () => {
  for (const rel of ["CLAUDE.md", ".claude/skills/team-protocol/SKILL.md", ".claude/agents/orchestrator.md"]) assert.match(read(rel), /code-reviewer/, rel);
  assert.match(read("CLAUDE.md"), /release manager's steps/);
  assert.match(read("CLAUDE.md"), /docs\/agents\/team-charter\.md/);
  assert.match(front("orchestrator").tools, /code-reviewer/);
});

test("the retiring roles name their successors", () => {
  for (const [role, successor] of [["orchestrator", /Bao and Jiao/], ["herald", /technical writer/], ["scout", /runner/]]) {
    assert.match(front(role).body, /retiring \(ADR 0029/, role);
    assert.match(front(role).body, successor, role);
  }
});
