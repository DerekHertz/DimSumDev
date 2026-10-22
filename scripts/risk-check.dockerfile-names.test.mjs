// hardening/12 fix round: Dockerfile names other than the plain one are hits too (app.Dockerfile, lowercase dockerfile).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.resolve(fileURLToPath(new URL("..", import.meta.url))), "scripts", "risk-check.mjs");
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });

function run(rel) {
  const dir = mkdtempSync(path.join(tmpdir(), "risk-dockerfile-names-"));
  try {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@example.com"]);
    git(dir, ["config", "user.name", "T"]);
    writeFileSync(path.join(dir, "README.md"), "hello\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "base"]);
    git(dir, ["branch", "-m", "main"]);
    git(dir, ["checkout", "-q", "-b", "feature"]);
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), "# a comment\nFROM scratch\n");
    git(dir, ["add", "-f", rel]);
    git(dir, ["commit", "-q", "-m", "change"]);
    try {
      return { code: 0, stdout: execFileSync("node", [SCRIPT, "main...feature"], { cwd: dir, encoding: "utf8" }) };
    } catch (err) {
      return { code: err.status ?? 1, stdout: (err.stdout ?? "") + (err.stderr ?? "") };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const rel of ["images/app.Dockerfile", "images/dockerfile", "images/api.dockerfile", "images/dockerfile.prod"]) {
  test(`${rel} is a hit`, () => {
    const { code, stdout } = run(rel);
    assert.notEqual(code, 0, stdout);
    assert.ok(stdout.includes(`${rel}:`), stdout);
  });
}
