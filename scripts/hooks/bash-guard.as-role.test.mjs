// A worker signs board writes as its own role only: --as and a claim's role must match the
// subagent's agent_type. The board itself trusts --as, so this is where identity is checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { check } from "./bash-guard.mjs";

const bash = (command, agent_type) => ({ tool_name: "Bash", tool_input: { command }, ...(agent_type ? { agent_id: "a1", agent_type } : {}) });

test("a reviewer cannot sign a verdict as another role", () => {
  for (const cmd of [
    'npm run board -- comment f/01-x --as qa --verdict pass "ok"',
    'node apps/board/board.mjs comment f/01-x --as=qa --verdict pass "ok"',
    "node /home/u/den/apps/board/board.mjs claim f/01-x qa --mode verify",
  ]) {
    assert.match(check(bash(cmd, "security")) ?? "", /own role/, cmd);
  }
});

test("a worker signing as itself, and the main session, are allowed", () => {
  assert.equal(check(bash('npm run board -- comment f/01-x --as security --verdict pass "ok"', "security")), null);
  assert.equal(check(bash("node apps/board/board.mjs claim f/01-x security", "security")), null);
  assert.equal(check(bash('node apps/board/board.mjs comment f/01-x --as code-reviewer "relayed"')), null);
  assert.equal(check(bash('echo "--as qa" > note.txt', "security")), null);
});

test("an agent_type that is not a board role is not checked", () => {
  assert.equal(check(bash('npm run board -- comment f/01-x --as qa "x"', "general-purpose")), null);
});

test("the guard is wired as a PreToolUse Bash hook", () => {
  const settings = JSON.parse(readFileSync(new URL("../../.claude/settings.json", import.meta.url), "utf8"));
  const bashHooks = (settings.hooks?.PreToolUse ?? []).filter((h) => h.matcher === "Bash").flatMap((h) => h.hooks);
  assert.ok(bashHooks.some((h) => /scripts\/hooks\/bash-guard\.mjs/.test(h.command)), JSON.stringify(settings.hooks?.PreToolUse));
});
