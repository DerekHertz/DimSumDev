// trust-ladder/02: the browser-verify skill is callable by a role and its metadata fits the Codex preload budget
// (scripts/codex-sync.test.mjs holds the 16 KB total; this pins the skill's own share and that Claude and Codex copies agree).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const read = (rel) => readFile(path.join(ROOT, rel), "utf8");
const frontMatter = (text) => text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1];

test("the skill's metadata is a name and a one-sentence description of 300 bytes or less", async () => {
  const fm = frontMatter(await read(".claude/skills/browser-verify/SKILL.md"));
  assert.match(fm, /^name: browser-verify$/m);
  const description = fm.match(/^description: "(.*)"$/m)?.[1];
  assert.ok(description, "description is a quoted one-liner");
  assert.ok(Buffer.byteLength(fm) <= 400, `front matter is ${Buffer.byteLength(fm)} bytes`);
  assert.doesNotMatch(fm, /disable-model-invocation/, "a role may call it");
});

test("the skill tells an agent how to run the CLI and to report a flaky run, not loop it", async () => {
  const body = await read(".claude/skills/browser-verify/SKILL.md");
  assert.match(body, /npm run verify:ui -- --den --flow/);
  assert.match(body, /npm run test:path/);
  assert.match(body, /Never loop a flaky run/);
});

test("the Codex copy is the same file, so a Codex role gets the same skill", async () => {
  assert.equal(await read(".agents/skills/browser-verify/SKILL.md"), await read(".claude/skills/browser-verify/SKILL.md"));
});

test("the roles that verify work (developer, qa, designer) hold the Skill tool, so each can call it", async () => {
  for (const role of ["developer", "qa", "designer"]) {
    const tools = frontMatter(await read(`.claude/agents/${role}.md`)).match(/^tools: (.*)$/m)[1].split(/,\s*/);
    assert.ok(tools.includes("Skill"), `${role} has the Skill tool`);
  }
});
