// organism-infra/34: acceptance tests for scripts/agent-start.mjs, per the
// "Mechanism" comment in .scratch/organism-infra/issues/34-worktrees-base-on-prior-hop.md:
//
//   node scripts/agent-start.mjs --base <sha> [--branch <name> | --detach]
//
// Run first in an agent's worktree. Refuses if the worktree is dirty or is the
// main checkout; otherwise switches to a new branch at <sha> (or detaches
// there), then runs `npm ci`.
//
// Fixtures are disposable repos: a "main checkout" with commit A on main, a
// side branch `prior` with commit B (the prior hop), and an Agent-tool-style
// worktree created detached at main. `npm` is a stub on PATH that records its
// argv and cwd, so no real install happens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync,
  realpathSync, chmodSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRoot } from "../apps/board/board-service.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, "scripts", "agent-start.mjs");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitFile(cwd, name, body, msg) {
  writeFileSync(path.join(cwd, name), body);
  git(cwd, ["add", name]);
  git(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function makeFixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-start-")));
  const main = path.join(dir, "main");
  mkdirSync(main);
  git(main, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(main, "package.json"), "{}");
  git(main, ["add", "package.json"]);
  const shaA = commitFile(main, "a.txt", "a", "A");
  git(main, ["switch", "-q", "-c", "prior"]);
  const shaB = commitFile(main, "tests.txt", "qa tests", "B qa tests");
  git(main, ["switch", "-q", "main"]);
  const wt = path.join(main, ".claude", "worktrees", "agent-x");
  git(main, ["worktree", "add", "-q", "--detach", wt, "main"]);

  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const log = path.join(dir, "npm.log");
  const stub = path.join(bin, "npm");
  writeFileSync(
    stub,
    `#!/bin/sh\necho "$PWD|$*" >> "${log}"\nexit 0\n`
  );
  chmodSync(stub, 0o755);
  return { dir, main, wt, shaA, shaB, log, bin };
}

function run(fx, cwd, args) {
  return spawnSync("node", [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`, DEN_ROOT: "", CLAUDE_CODE_SESSION_ID: "" },
  });
}

// A refusal must come from the helper, not from node failing to find it.
function assertRefused(r, label = "") {
  assert.notEqual(r.status, 0, label);
  assert.doesNotMatch(r.stderr, /Cannot find module|ERR_MODULE_NOT_FOUND/, `script missing: ${label}`);
  assert.ok(r.stderr.trim().length > 0, `refusal should explain itself on stderr: ${label}`);
}

function npmCalls(fx) {
  return existsSync(fx.log) ? readFileSync(fx.log, "utf8").trim().split("\n") : [];
}

function withFixture(fn) {
  const fx = makeFixture();
  try {
    return fn(fx);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
}

// Criterion 1: developer starts on qa's tests commit, no manual merge.
test("--branch: worktree switches to a new branch at the base sha and runs npm ci", () =>
  withFixture((fx) => {
    const r = run(fx, fx.wt, ["--base", fx.shaB, "--branch", "feature/dev-34"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(fx.wt, ["rev-parse", "HEAD"]), fx.shaB);
    assert.equal(git(fx.wt, ["symbolic-ref", "--short", "HEAD"]), "feature/dev-34");
    assert.equal(readFileSync(path.join(fx.wt, "tests.txt"), "utf8"), "qa tests");
    const calls = npmCalls(fx);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], `${fx.wt}|ci`);
  }));

// Criterion 2: reviewers start detached at the developer's commit.
test("--detach: worktree is detached at the base sha and runs npm ci", () =>
  withFixture((fx) => {
    const r = run(fx, fx.wt, ["--base", fx.shaB, "--detach"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(fx.wt, ["rev-parse", "HEAD"]), fx.shaB);
    const sym = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: fx.wt });
    assert.notEqual(sym.status, 0, "HEAD should be detached");
    assert.equal(npmCalls(fx).length, 1);
  }));

test("refuses to run in the main checkout and changes nothing", () =>
  withFixture((fx) => {
    const r = run(fx, fx.main, ["--base", fx.shaB, "--branch", "nope"]);
    assertRefused(r);
    assert.match(r.stderr, /main checkout/i);
    assert.equal(git(fx.main, ["symbolic-ref", "--short", "HEAD"]), "main");
    assert.equal(git(fx.main, ["rev-parse", "HEAD"]), fx.shaA);
    assert.equal(git(fx.main, ["branch", "--list", "nope"]), "");
    assert.equal(npmCalls(fx).length, 0);
  }));

test("refuses a worktree with a modified tracked file", () =>
  withFixture((fx) => {
    writeFileSync(path.join(fx.wt, "a.txt"), "edited");
    const r = run(fx, fx.wt, ["--base", fx.shaB, "--detach"]);
    assertRefused(r);
    assert.match(r.stderr, /dirty|uncommitted|clean/i);
    assert.equal(git(fx.wt, ["rev-parse", "HEAD"]), fx.shaA);
    assert.equal(readFileSync(path.join(fx.wt, "a.txt"), "utf8"), "edited");
    assert.equal(npmCalls(fx).length, 0);
  }));

test("refuses a worktree with an untracked file", () =>
  withFixture((fx) => {
    writeFileSync(path.join(fx.wt, "stray.txt"), "x");
    const r = run(fx, fx.wt, ["--base", fx.shaB, "--branch", "b1"]);
    assertRefused(r);
    assert.equal(git(fx.wt, ["rev-parse", "HEAD"]), fx.shaA);
    assert.equal(git(fx.wt, ["branch", "--list", "b1"]), "");
    assert.equal(npmCalls(fx).length, 0);
  }));

test("an unknown base sha fails without moving HEAD or running npm", () =>
  withFixture((fx) => {
    const r = run(fx, fx.wt, ["--base", "0".repeat(40), "--detach"]);
    assertRefused(r);
    assert.equal(git(fx.wt, ["rev-parse", "HEAD"]), fx.shaA);
    assert.equal(npmCalls(fx).length, 0);
  }));

// organism-infra/51: an existing branch is now reused when --base fast-forwards it
// (see agent-start.existing-branch.test.mjs); one that is ahead of --base is still refused.
test("an existing branch that is not a fast-forward to base is refused without moving HEAD", () =>
  withFixture((fx) => {
    const r = run(fx, fx.wt, ["--base", fx.shaA, "--branch", "prior"]);
    assertRefused(r);
    assert.equal(git(fx.wt, ["rev-parse", "HEAD"]), fx.shaA);
    assert.equal(npmCalls(fx).length, 0);
  }));

test("argument errors: missing --base, both modes, neither mode", () =>
  withFixture((fx) => {
    for (const args of [
      ["--detach"],
      ["--base", fx.shaB, "--branch", "x", "--detach"],
      ["--base", fx.shaB],
    ]) {
      const r = run(fx, fx.wt, args);
      assertRefused(r, args.join(" "));
      assert.equal(git(fx.wt, ["rev-parse", "HEAD"]), fx.shaA);
    }
    assert.equal(npmCalls(fx).length, 0);
  }));

test("a failing npm ci makes the helper exit non-zero", () =>
  withFixture((fx) => {
    writeFileSync(path.join(fx.bin, "npm"), "#!/bin/sh\nexit 3\n");
    const r = run(fx, fx.wt, ["--base", fx.shaB, "--detach"]);
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stderr, /Cannot find module|ERR_MODULE_NOT_FOUND/);
  }));

// Scope added (from 29): resolveRoot from a worktree with DEN_ROOT unset.
test("resolveRoot returns the main checkout from inside a worktree with DEN_ROOT unset", () =>
  withFixture((fx) => {
    assert.equal(resolveRoot(fx.wt, {}), fx.main);
  }));

// Criterion 3: the mechanism is documented in the orchestrator role definition or dispatch docs.
test("orchestrator role definition or dispatch docs describe scripts/agent-start.mjs", () => {
  const files = [path.join(REPO_ROOT, ".claude", "agents", "orchestrator.md")];
  const docs = path.join(REPO_ROOT, "docs", "agents");
  if (existsSync(docs)) {
    for (const f of readdirSync(docs)) if (f.endsWith(".md")) files.push(path.join(docs, f));
  }
  const hit = files.filter((f) => existsSync(f) && readFileSync(f, "utf8").includes("agent-start"));
  assert.ok(hit.length > 0, "no orchestrator role definition or docs/agents/*.md mentions agent-start");
});

// Security fix 1 (MEDIUM): npm ci must run in the worktree's toplevel, and a
// base without a root package.json is refused before switching (else npm walks
// up into the main checkout).
function bareCommit(fx) {
  git(fx.main, ["switch", "-q", "--orphan", "bare"]);
  const sha = commitFile(fx.main, "z.txt", "z", "no package.json");
  git(fx.main, ["switch", "-q", "main"]);
  return sha;
}

test("npm ci runs with cwd at the worktree toplevel, even from a subdirectory", () =>
  withFixture((fx) => {
    const sub = path.join(fx.wt, "sub");
    mkdirSync(sub);
    const r = run(fx, sub, ["--base", fx.shaB, "--detach"]);
    assert.equal(r.status, 0, r.stderr);
    const calls = npmCalls(fx);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].split("|")[0], fx.wt);
  }));

test("a base without a root package.json is refused before switching or installing", () =>
  withFixture((fx) => {
    const bare = bareCommit(fx);
    const before = git(fx.wt, ["rev-parse", "HEAD"]);
    const r = run(fx, fx.wt, ["--base", bare, "--detach"]);
    assertRefused(r);
    assert.match(r.stderr, /package\.json/);
    assert.equal(git(fx.wt, ["rev-parse", "HEAD"]), before);
    assert.equal(npmCalls(fx).length, 0);
  }));

// Security fix 2 (LOW): worktree list read with -z so unusual paths do not break the check.
test("main checkout is still refused when its path needs quoting in porcelain output", () => {
  const fx = makeFixture();
  try {
    const odd = path.join(fx.dir, "mäin \"q\"");
    git(fx.dir, ["clone", "-q", fx.main, odd]);
    const r = run(fx, odd, ["--base", "HEAD", "--detach"]);
    assertRefused(r);
    assert.match(r.stderr, /main checkout/);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("a worktree at a path that needs quoting works", () => {
  const fx = makeFixture();
  try {
    const odd = path.join(fx.main, ".claude", "worktrees", "agént \"q\"");
    git(fx.main, ["worktree", "add", "-q", "--detach", odd, "main"]);
    const r = run(fx, odd, ["--base", fx.shaB, "--detach"]);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
