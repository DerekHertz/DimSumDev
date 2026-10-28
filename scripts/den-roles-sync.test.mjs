// The den-roles plugin is generated; a role edited in .claude/agents without a resync ships stale to CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROLES, renderRole } from "./den-roles-sync.mjs";

const root = join(import.meta.dirname, "..");
const agents = join(root, "plugins", "den-roles", "agents");

test("plugins/den-roles matches .claude/agents", () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, [join(root, "scripts", "den-roles-sync.mjs"), "--check"], { encoding: "utf8" }));
});

test("the plugin ships role files only, one per listed role", () => {
  assert.deepEqual(readdirSync(agents).sort(), ROLES.map((r) => `${r}.md`).sort());
  assert.deepEqual(readdirSync(join(root, "plugins", "den-roles")).sort(), [".claude-plugin", "agents"]);
});

test("a role drops board skills, worktree isolation and den-only tools, and opens with the GitHub protocol", () => {
  const src = "---\nname: qa\ndescription: x\ntools: Read, Bash, Agent(runner, den:runner), Skill, mcp__github\nmodel: sonnet\nisolation: worktree\nskills:\n  - team-protocol\norg:\n  team: tea\n---\nRun `npm run board -- claim`.\n";
  const out = renderRole(src, "## GitHub dispatch\nP");
  assert.match(out, /^---\nname: qa\ndescription: x\ntools: Read, Bash, mcp__github_comment__update_claude_comment\nmodel: sonnet\n---\n\n## GitHub dispatch/);
  assert.doesNotMatch(out, /isolation|skills:|team-protocol|org:|Skill/);
  assert.ok(out.indexOf("GitHub dispatch") < out.indexOf("npm run board"), "the protocol comes before the den role text");
});

test("every generated role names itself and keeps a model", () => {
  for (const role of ROLES) {
    const text = readFileSync(join(agents, `${role}.md`), "utf8");
    assert.match(text, new RegExp(`^---\\nname: ${role}\\n`));
    assert.match(text, /\nmodel: \w+\n/);
  }
});
