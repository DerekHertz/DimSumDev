// agent-os/02: the governance deny list is a guardrail path too (a change to it dispatches security).
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

const GOVERNANCE = "apps/bridge/agents/governance.json";

test("a change to the governance file exits non-zero, names the file and calls it a guardrail", () => {
  const dir = initRepo();
  try {
    commitChange(dir, GOVERNANCE, '{ "denyRun": [] }\n');
    const { code, stdout } = runCheck(dir);
    assert.notEqual(code, 0, stdout);
    assert.ok(stdout.includes(GOVERNANCE), stdout);
    assert.match(stdout, /guardrail/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
