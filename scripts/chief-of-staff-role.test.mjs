// team-and-den-ux/19: one chief-of-staff role, with a Claude and a Codex definition. Bao and Jiao are its two instances,
// not two roles named after themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const claude = readFileSync(path.join(ROOT, ".claude", "agents", "chief-of-staff.md"), "utf8");

test("the Claude definition is the chief of staff, with the scope of one", () => {
  assert.match(claude, /^name: chief-of-staff$/m);
  assert.match(claude, /Bao is your Claude instance and Jiao your Codex instance/);
  for (const duty of [/plan/i, /rundowns and decision briefs/i, /board/i, /children/i, /last review/i]) assert.match(claude, duty);
  assert.match(claude, /second in command to the user/);
  assert.match(claude, /## Oversight/);
  for (const watch of [/Events:/, /Rhythm:/, /rundown each morning/, /weekly review/]) assert.match(claude, watch);
  assert.match(claude, /merge green pull requests off the risk path/);
  assert.match(claude, /merge nothing on the user-merge list/);
  assert.doesNotMatch(claude, /You do not merge/);
});

test("there is one definition, not one per instance", () => {
  for (const name of ["bao", "jiao"]) {
    assert.equal(existsSync(path.join(ROOT, ".claude", "agents", `${name}.md`)), false);
    assert.equal(existsSync(path.join(ROOT, ".codex", "agents", `${name}.toml`)), false);
  }
});

test("the Codex mirror exists and is the same role", () => {
  const toml = readFileSync(path.join(ROOT, ".codex", "agents", "chief-of-staff.toml"), "utf8");
  assert.match(toml, /^name = "chief-of-staff"$/m);
});

test("CONTEXT.md defines the chief of staff and Bao as its Claude instance", () => {
  const context = readFileSync(path.join(ROOT, "CONTEXT.md"), "utf8");
  assert.match(context, /^\*\*Chief of staff\*\*:/m);
  assert.match(context, /Bao is its Claude instance and Jiao its Codex instance/);
  assert.doesNotMatch(context, /The orchestrator's on-screen body/);
  assert.match(context, /\*\*Owner\*\*:\nThe chief of staff, Bao \(Claude\) or Jiao \(Codex\)/);
});
