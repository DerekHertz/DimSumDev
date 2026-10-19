// agent-os/04 (ADR 0021 decision 10): the role ceilings file is a guardrail path. A diff that touches
// apps/bridge/agents/ceilings.json is a risk-check hit, so `security` is dispatched. The content below is plain data with no
// word the code-risk patterns watch for, so the only thing that can fire is the path. A sibling data file stays clean.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.resolve(fileURLToPath(new URL("..", import.meta.url))), "scripts", "risk-check.mjs");

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });

function initRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "risk-ceilings-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["branch", "-m", "main"]);
  git(dir, ["checkout", "-q", "-b", "feature"]);
  return dir;
}

function commitChange(dir, relPath, content) {
  const full = path.join(dir, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  git(dir, ["add", "-f", relPath]);
  git(dir, ["commit", "-q", "-m", `change ${relPath}`]);
}

function runCheck(dir) {
  try {
    return { code: 0, stdout: execFileSync("node", [SCRIPT, "main...feature"], { cwd: dir, encoding: "utf8" }) };
  } catch (err) {
    return { code: err.status ?? 1, stdout: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

const CEILINGS = "apps/bridge/agents/ceilings.json";

test("a change to the ceilings file exits non-zero, names the file and calls it a guardrail", () => {
  const dir = initRepo();
  try {
    commitChange(dir, CEILINGS, '{ "scout": { "write": false } }\n');
    const { code, stdout } = runCheck(dir);
    assert.notEqual(code, 0, stdout);
    assert.ok(stdout.includes(CEILINGS), stdout);
    assert.match(stdout, /guardrail/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an edit to an existing ceilings file is a hit too, not only its creation", () => {
  const dir = initRepo();
  try {
    commitChange(dir, CEILINGS, '{ "scout": { "write": false } }\n');
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["merge", "-q", "--ff-only", "feature"]);
    git(dir, ["checkout", "-q", "-b", "edit"]);
    commitChange(dir, CEILINGS, '{ "scout": { "write": true } }\n');
    git(dir, ["branch", "-f", "feature", "edit"]);
    const { code, stdout } = runCheck(dir);
    assert.notEqual(code, 0, stdout);
    assert.ok(stdout.includes(CEILINGS), stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a data file elsewhere in the same folder is still clean (the rule is the path, not the folder)", () => {
  const dir = initRepo();
  try {
    commitChange(dir, "apps/bridge/agents/notes.json", '{ "note": "plain data" }\n');
    assert.equal(runCheck(dir).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
