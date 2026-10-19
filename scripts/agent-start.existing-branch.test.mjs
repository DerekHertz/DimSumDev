// organism-infra/51 criterion 3: agent-start with --branch <name> when the branch
// already exists (developer after qa specify): check it out and fast-forward
// to --base; refuse when that isn't a fast-forward.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.resolve(fileURLToPath(new URL("..", import.meta.url))), "scripts", "agent-start.mjs");
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function commitFile(cwd, name, body, msg) {
  writeFileSync(path.join(cwd, name), body);
  git(cwd, ["add", name]);
  git(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

// main: A. `ahead`: A -> B (qa tests). `other`: A -> C (diverged). Worktree detached at A.
function makeFixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-start-eb-")));
  const main = path.join(dir, "main");
  mkdirSync(main);
  git(main, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(main, "package.json"), "{}");
  git(main, ["add", "package.json"]);
  const shaA = commitFile(main, "a.txt", "a", "A");
  git(main, ["switch", "-q", "-c", "ahead"]);
  const shaB = commitFile(main, "tests.txt", "qa tests", "B");
  git(main, ["switch", "-q", "main"]);
  git(main, ["switch", "-q", "-c", "other"]);
  const shaC = commitFile(main, "c.txt", "c", "C");
  git(main, ["switch", "-q", "main"]);
  const wt = path.join(main, ".claude", "worktrees", "agent-x");
  git(main, ["worktree", "add", "-q", "--detach", wt, "main"]);
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const log = path.join(dir, "npm.log");
  writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho "$PWD|$*" >> "${log}"\nexit 0\n`);
  chmodSync(path.join(bin, "npm"), 0o755);
  return { dir, main, wt, shaA, shaB, shaC, log, bin };
}

const run = (fx, args) =>
  spawnSync("node", [SCRIPT, ...args], {
    cwd: fx.wt,
    encoding: "utf8",
    env: { ...process.env, PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`, DEN_ROOT: "", CLAUDE_CODE_SESSION_ID: "" },
  });
const npmCalls = (fx) => (existsSync(fx.log) ? readFileSync(fx.log, "utf8").trim().split("\n") : []);
function withFixture(fn) {
  const fx = makeFixture();
  try {
    return fn(fx);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
}
function assertRefused(r) {
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /Cannot find module|ERR_MODULE_NOT_FOUND/);
  assert.ok(r.stderr.trim().length > 0, "refusal should explain itself");
}

test("existing branch already at --base: checked out, npm ci runs", () =>
  withFixture((fx) => {
    const r = run(fx, ["--base", fx.shaB, "--branch", "ahead"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(fx.wt, ["symbolic-ref", "--short", "HEAD"]), "ahead");
    assert.equal(git(fx.wt, ["rev-parse", "HEAD"]), fx.shaB);
    assert.equal(readFileSync(path.join(fx.wt, "tests.txt"), "utf8"), "qa tests");
    assert.equal(npmCalls(fx).length, 1);
  }));

test("existing branch behind --base: checked out and fast-forwarded to base", () =>
  withFixture((fx) => {
    git(fx.main, ["branch", "behind", fx.shaA]);
    const r = run(fx, ["--base", fx.shaB, "--branch", "behind"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(fx.wt, ["symbolic-ref", "--short", "HEAD"]), "behind");
    assert.equal(git(fx.wt, ["rev-parse", "HEAD"]), fx.shaB);
    assert.equal(git(fx.main, ["rev-parse", "behind"]), fx.shaB, "the branch ref itself moves");
    assert.equal(npmCalls(fx).length, 1);
  }));

test("existing branch that diverged from --base is refused; nothing moves, no npm", () =>
  withFixture((fx) => {
    const r = run(fx, ["--base", fx.shaB, "--branch", "other"]);
    assertRefused(r);
    assert.match(r.stderr, /fast-forward/i);
    assert.equal(git(fx.wt, ["rev-parse", "HEAD"]), fx.shaA);
    assert.equal(git(fx.main, ["rev-parse", "other"]), fx.shaC);
    assert.equal(npmCalls(fx).length, 0);
  }));

test("existing branch ahead of --base is refused (not a fast-forward); nothing moves", () =>
  withFixture((fx) => {
    const r = run(fx, ["--base", fx.shaA, "--branch", "ahead"]);
    assertRefused(r);
    assert.match(r.stderr, /fast-forward/i);
    assert.equal(git(fx.wt, ["rev-parse", "HEAD"]), fx.shaA);
    assert.equal(git(fx.main, ["rev-parse", "ahead"]), fx.shaB);
    assert.equal(npmCalls(fx).length, 0);
  }));

test("a new branch name still works", () =>
  withFixture((fx) => {
    const r = run(fx, ["--base", fx.shaB, "--branch", "brand-new"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(fx.wt, ["symbolic-ref", "--short", "HEAD"]), "brand-new");
    assert.equal(git(fx.wt, ["rev-parse", "HEAD"]), fx.shaB);
  }));
