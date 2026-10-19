// organism-infra/26: acceptance tests for worktree-gc forgiving untracked
// files that are byte-identical to an uncommitted file on disk in the main
// checkout, and for silencing git's `fatal:` stderr on missing paths.
//
// Public interface: `node scripts/worktree-gc.mjs --root <main> [--apply]`,
// observed through exit code, stdout, stderr, and worktree existence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, "scripts", "worktree-gc.mjs");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo() {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "worktree-gc-26-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  writeFileSync(path.join(root, "README.md"), "hello\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "base"]);
  git(root, ["branch", "-m", "main"]);
  return root;
}

// A merged (branch == main tip), otherwise clean agent worktree.
function addMergedWorktree(root, name) {
  const wtDir = path.join(root, ".claude", "worktrees", name);
  mkdirSync(path.dirname(wtDir), { recursive: true });
  git(root, ["worktree", "add", "-q", "-b", name, wtDir, "main"]);
  return wtDir;
}

function writeUntracked(dir, relPath, content) {
  const full = path.join(dir, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function runGc(root, args = []) {
  const r = spawnSync("node", [SCRIPT, "--root", root, ...args], { cwd: root, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("--apply removes a merged worktree whose only dirty file matches an uncommitted file in the main checkout", () => {
  const root = initRepo();
  try {
    const wtDir = addMergedWorktree(root, "handoff-copy");
    // Main's copy is on disk but never committed (an agent's handoff).
    writeUntracked(root, ".scratch/handoffs/note.md", "handoff content\n");
    writeUntracked(wtDir, ".scratch/handoffs/note.md", "handoff content\n");

    const { code, stdout, stderr } = runGc(root, ["--apply"]);
    assert.equal(code, 0, stdout + stderr);
    assert.equal(existsSync(wtDir), false, "worktree with only a main-checkout copy should be removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--apply keeps a worktree whose untracked file differs from the main checkout's uncommitted copy", () => {
  const root = initRepo();
  try {
    const wtDir = addMergedWorktree(root, "handoff-differs");
    writeUntracked(root, ".scratch/handoffs/note.md", "main version\n");
    writeUntracked(wtDir, ".scratch/handoffs/note.md", "worktree version\n");

    const { code, stdout, stderr } = runGc(root, ["--apply"]);
    assert.equal(code, 0, stdout + stderr);
    assert.ok(existsSync(wtDir), "differing file must keep the worktree");
    assert.match(stdout, /handoff-differs: dirty/);
    assert.match(stdout, /note\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--apply keeps a worktree whose untracked file has no counterpart in the main checkout", () => {
  const root = initRepo();
  try {
    const wtDir = addMergedWorktree(root, "no-counterpart");
    writeUntracked(wtDir, ".scratch/handoffs/only-here.md", "unique\n");

    const { code, stdout, stderr } = runGc(root, ["--apply"]);
    assert.equal(code, 0, stdout + stderr);
    assert.ok(existsSync(wtDir), "file missing from main must keep the worktree");
    assert.match(stdout, /no-counterpart: dirty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dry run prints no git `fatal:` lines when a dirty path is missing from main", () => {
  const root = initRepo();
  try {
    const wtDir = addMergedWorktree(root, "missing-path");
    writeUntracked(wtDir, ".scratch/handoffs/only-here.md", "unique\n");

    const { code, stdout, stderr } = runGc(root);
    assert.equal(code, 0, stdout + stderr);
    assert.doesNotMatch(stderr, /fatal:/);
    assert.doesNotMatch(stdout, /fatal:/);
    assert.match(stdout, /missing-path: dirty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
