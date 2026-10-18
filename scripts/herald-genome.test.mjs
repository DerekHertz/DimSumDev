// herald/02: the herald genome (.claude/agents/herald.md) must be a cell that
// cannot publish. Parses the front matter and checks the tool list: read-only
// on the repo, Write for the draft, Agent(scout) only to dispatch scout (no bare Agent), and no WebFetch
// (den-mvp/90: Bash only as `Bash(node scripts/draft-check.mjs:*)`, pinned in haiku-tree.test.mjs), or GitHub write tools. Also checks name, model and station basics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const GENOME = path.join(REPO_ROOT, ".claude", "agents", "herald.md");

function frontMatter() {
  assert.ok(existsSync(GENOME), `${GENOME} does not exist`);
  const text = readFileSync(GENOME, "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, "herald.md has no front matter");
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

function tools() {
  const fm = frontMatter();
  assert.ok(fm.tools, "herald.md front matter has no tools line");
  return fm.tools.split(",").map((t) => t.trim()).filter(Boolean);
}

test("herald genome front matter names the cell 'herald' on sonnet", () => {
  const fm = frontMatter();
  assert.equal(fm.name, "herald");
  assert.equal(fm.model, "sonnet");
});

test("herald tools include what it needs: Read, Grep, Glob, Write, Agent(scout), Skill", () => {
  const t = tools();
  for (const need of ["Read", "Grep", "Glob", "Write", "Agent(scout)", "Skill"]) {
    assert.ok(t.includes(need), `missing ${need} in ${t.join(", ")}`);
  }
});

test("herald may dispatch only scout: no bare Agent, any Agent(...) names only scout", () => {
  const t = tools();
  assert.ok(!t.includes("Agent"), `bare Agent must not be in herald tools: ${t.join(", ")}`);
  const agents = t.filter((x) => /^Agent\b/.test(x));
  assert.ok(agents.length > 0, "herald has no Agent(scout) entry");
  for (const a of agents) {
    assert.equal(a, "Agent(scout)", `${a} must be Agent(scout)`);
  }
});

test("herald tools exclude WebFetch and other ways out of the repo", () => {
  const t = tools();
  for (const banned of ["WebFetch", "WebSearch", "Edit", "NotebookEdit"]) {
    assert.ok(!t.includes(banned), `${banned} must not be in herald tools`);
  }
});

test("herald tools exclude every GitHub write tool", () => {
  const writeVerbs = /(create|update|push|merge|add|delete|fork|write|submit|assign|request|dismiss|close|reopen|lock|comment|rerun|cancel|trigger)/i;
  const bad = tools().filter((x) => /github/i.test(x) && writeVerbs.test(x));
  assert.deepEqual(bad, []);
});
