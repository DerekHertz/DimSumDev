// Acceptance tests for organism-infra/54: scripts/board.mjs shim.
//
// Pinned contract (QA's reading of the ticket):
//   - `node scripts/board.mjs <args>` forwards its arguments and exit code to
//     apps/board/board.mjs, behaving exactly like
//     `npm run board -- <args>` for every tested command.
//   - The shim passes through stdout, stderr, and exit codes unchanged.
//
// Criterion map:
//   1 shim behaves like board CLI  -> "shim forwards" tests
//   2 test:path                    -> see scripts/test-path.test.mjs (separate file)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SHIM = path.join(REPO_ROOT, "scripts", "board.mjs");
const CLI = path.join(REPO_ROOT, "apps", "board", "board.mjs");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "board-shim-"));
  const main = path.join(dir, "main");
  mkdirSync(main);
  git(main, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(main, "package.json"), "{}");
  git(main, ["add", "package.json"]);
  git(main, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);

  const issuesDir = path.join(main, ".scratch", "sample", "issues");
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(
    path.join(issuesDir, "01-do-thing.md"),
    "# 01-do-thing\n\nStatus: ready-for-agent\n\n- [ ] criterion\n\n## Comments\n"
  );
  git(main, ["add", ".scratch"]);
  git(main, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed ticket"]);

  const wt = path.join(dir, "wt");
  git(main, ["worktree", "add", "-q", "--detach", wt, "main"]);

  return {
    dir,
    main,
    wt,
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

function runShim(fx, args) {
  return spawnSync("node", [SHIM, ...args], {
    cwd: fx.wt,
    encoding: "utf8",
    env: { ...process.env, DEN_ROOT: fx.main },
  });
}

function runCLI(fx, args) {
  return spawnSync("node", [CLI, ...args], {
    cwd: fx.wt,
    encoding: "utf8",
    env: { ...process.env, DEN_ROOT: fx.main },
  });
}

// --- Criterion 1: shim forwards args and exit code ---

test("shim forwards a successful 'status' command identically to the CLI", () => {
  const fx = makeFixture();
  try {
    const shim = runShim(fx, ["status", "sample/01-do-thing"]);
    const cli = runCLI(fx, ["status", "sample/01-do-thing"]);
    assert.equal(shim.status, cli.status, "exit codes must match");
    assert.equal(shim.stdout, cli.stdout, "stdout must match");
  } finally {
    fx.cleanup();
  }
});

test("shim exits non-zero for an unknown command, same as the CLI", () => {
  const fx = makeFixture();
  try {
    const shim = runShim(fx, ["no-such-command"]);
    const cli = runCLI(fx, ["no-such-command"]);
    assert.notEqual(shim.status, 0);
    assert.equal(shim.status, cli.status, "exit codes must match for errors");
  } finally {
    fx.cleanup();
  }
});

test("shim forwards a successful 'claim' and its stdout", () => {
  const fx = makeFixture();
  try {
    const shim = runShim(fx, ["claim", "sample/01-do-thing", "developer"]);
    assert.equal(shim.status, 0, `shim claim failed:\n${shim.stderr}`);
    assert.match(shim.stdout, /claimed sample\/01-do-thing/);
  } finally {
    fx.cleanup();
  }
});

test("shim forwards a failed 'claim' exit code (ticket already held)", () => {
  const fx = makeFixture();
  try {
    runCLI(fx, ["claim", "sample/01-do-thing", "developer"]);
    const shim = runShim(fx, ["claim", "sample/01-do-thing", "qa"]);
    assert.notEqual(shim.status, 0, "second claim should fail");
  } finally {
    fx.cleanup();
  }
});

test("shim exists as scripts/board.mjs", () => {
  // The shim file must exist (the developer creates it).
  assert.ok(existsSync(SHIM), `scripts/board.mjs does not exist at ${SHIM}`);
});
