// hardening/12 (ADR 0031): the agent image is what every agent runs inside, so any change to a Dockerfile is a risk-check hit and goes
// to `security`, whatever the content says. Same harness as risk-check.claude-dir.test.mjs.
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
  const dir = mkdtempSync(path.join(tmpdir(), "risk-dockerfile-"));
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

// Content that trips no other pattern (no secret, no shelling out), so only the file name can be the reason for the hit.
const PLAIN = "# a comment\nFROM scratch\n";

for (const rel of ["apps/bridge/agents/image/Dockerfile", "Dockerfile", "tools/Dockerfile", "apps/bridge/agents/image/Dockerfile.dev"]) {
  test(`a change to ${rel} exits non-zero and names the file`, () => {
    const dir = initRepo();
    try {
      commitChange(dir, rel, PLAIN);
      const { code, stdout } = runCheck(dir);
      assert.notEqual(code, 0, stdout);
      assert.ok(stdout.includes(`${rel}:`), stdout);
      assert.match(stdout, /dockerfile|image/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a file that only mentions a Dockerfile in its name or text is not a hit", () => {
  const dir = initRepo();
  try {
    commitChange(dir, "docs/about-dockerfiles.md", "The Dockerfile lives under the image folder.\n");
    const { code, stdout } = runCheck(dir);
    assert.equal(code, 0, stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
