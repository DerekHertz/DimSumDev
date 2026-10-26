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

test("claim and identity flags in every spelling are checked (security review, PR 438)", () => {
  for (const cmd of [
    "npm run board -- claim f/01-x --role qa",
    "npm run board -- claim f/01-x --cell qa",
    "npm run board -- claim f/01-x --role=qa",
    "npm run board -- claim f/01-x --mode verify qa",
    "npm run board -- reclaim f/01-x qa",
    "node scripts/agent-start.mjs --ticket f/01-x --role qa",
    "npm  run board -- comment f/01-x --as qa x",
    "npm run -s board -- comment f/01-x --as qa x",
    "npm run-script board -- comment f/01-x --as qa x",
    "npm --silent run board -- comment f/01-x --as qa x",
  ]) {
    assert.match(check(bash(cmd, "security")) ?? "", /own role/, cmd);
  }
});

test("quoted text and later commands are not read as roles", () => {
  for (const cmd of [
    'npm run board -- comment f/01-x --as security "claim this ticket now"',
    'npm run board -- comment f/01-x --as security "pass --as qa to sign"',
    'npm run board -- release f/01-x --status in-review && git commit -m "fix --as qa bug"',
    'git add apps/board/board.mjs && git commit -m "x --as qa"',
    "npm run board -- claim f/01-x security; echo done",
  ]) {
    assert.equal(check(bash(cmd, "security")), null, cmd);
  }
});

test("jg is blocked only in command position", () => {
  for (const cmd of ['git commit -m "fix jg wrapper"', "rg jg scripts", "grep -rn jg docs", "ls .agents/skills/jevgrep", "node scripts/jg.mjs \"where\""]) {
    assert.equal(check(bash(cmd)), null, cmd);
  }
  for (const cmd of ["jg where", "cd x && jg where", "echo a | ~/.local/bin/jevgrep q", "(jg q)"]) {
    assert.match(check(bash(cmd)) ?? "", /raw jg/, cmd);
  }
});

test("line continuations, quoted words and launchers do not hide a board call (security re-check, PR 438)", () => {
  for (const cmd of [
    "node apps/board/board.mjs \\\ncomment f/01-x --as qa x",
    'node "apps/board/board.mjs" comment f/01-x --as qa x',
    'npm run "board" -- comment f/01-x --as qa x',
    '"npm" run board -- comment f/01-x --as qa x',
    'npm run board -- comment f/01-x "--as" qa x',
    "env X=1 npm run board -- comment f/01-x --as qa x",
    "timeout 5 npm run board -- comment f/01-x --as qa x",
  ]) {
    assert.match(check(bash(cmd, "security")) ?? "", /own role/, JSON.stringify(cmd));
  }
  assert.match(check(bash("timeout 5 jg q")) ?? "", /raw jg/);
});
