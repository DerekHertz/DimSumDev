// Acceptance tests for organism-infra/60: agent-start --ticket claims the
// ticket before the agent starts work.
//
// Pinned contract (QA's reading of the ticket):
//   - `node scripts/agent-start.mjs ... --ticket <ref> --role <role>
//     [--mode <m>]` runs `board claim` after setting up the worktree and
//     exits non-zero if the claim fails (ticket already held or invalid ref).
//   - Without --ticket, behaviour is unchanged (no claim attempted, same
//     exit code and output as before).
//   - docs/agents/agent-start.md documents the flag (human-verified; the doc
//     edit is produced by the developer and checked by qa verify).
//
// Criterion map:
//   1 --ticket claims before exiting 0         -> "claims the ticket" tests
//   1b refused claim exits non-zero            -> "exits non-zero on claim failure" tests
//   2 without --ticket, unchanged              -> "without --ticket" tests
//   3 docs updated                             -> human-verified
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync,
  chmodSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, "scripts", "agent-start.mjs");
const CLI = path.join(REPO_ROOT, "apps", "board", "board.mjs");

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
  const dir = mkdtempSync(path.join(tmpdir(), "cs-ticket-"));
  const main = path.join(dir, "main");
  mkdirSync(main);
  git(main, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(main, "package.json"), "{}");
  git(main, ["add", "package.json"]);
  const shaA = commitFile(main, "a.txt", "a", "A");

  // Seed a real ticket on the board so board claim can find it.
  const issuesDir = path.join(main, ".scratch", "test-feature", "issues");
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(
    path.join(issuesDir, "01-do-thing.md"),
    "# 01-do-thing\n\nStatus: ready-for-agent\n\n- [ ] criterion\n\n## Comments\n"
  );
  git(main, ["add", ".scratch"]);
  const shaB = commitFile(main, "b.txt", "b", "B with ticket");

  const wt = path.join(main, ".claude", "worktrees", "agent-x");
  git(main, ["worktree", "add", "-q", "--detach", wt, "main"]);

  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const log = path.join(dir, "npm.log");
  const stub = path.join(bin, "npm");
  writeFileSync(stub, `#!/bin/sh\necho "$PWD|$*" >> "${log}"\nexit 0\n`);
  chmodSync(stub, 0o755);

  return { dir, main, wt, shaA, shaB, log, bin };
}

function run(fx, cwd, args) {
  return spawnSync("node", [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
      DEN_ROOT: fx.main,
      CLAUDE_CODE_SESSION_ID: "", // keep the live session's context out of the 119 gate
    },
  });
}

function boardStatus(fx, ref) {
  return spawnSync("node", [CLI, "status", ref], {
    cwd: fx.wt,
    encoding: "utf8",
    env: { ...process.env, DEN_ROOT: fx.main },
  });
}

function withFixture(fn) {
  const fx = makeFixture();
  try {
    return fn(fx);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
}

// --- Criterion 1: --ticket claims the ticket before exiting 0 ---

test("--ticket claims the ticket on success and exits 0", () =>
  withFixture((fx) => {
    const r = run(fx, fx.wt, [
      "--base", fx.shaB,
      "--detach",
      "--ticket", "test-feature/01-do-thing",
      "--role", "developer",
    ]);
    assert.equal(r.status, 0, `should exit 0:\n${r.stderr}`);
    const st = boardStatus(fx, "test-feature/01-do-thing");
    assert.match(st.stdout, /claimed/, "ticket should be claimed after agent-start");
  }));

test("exits non-zero when the claim fails (ticket already held)", () =>
  withFixture((fx) => {
    // Claim the ticket first so the second claim will fail.
    spawnSync("node", [CLI, "claim", "test-feature/01-do-thing", "developer"], {
      cwd: fx.wt,
      encoding: "utf8",
      env: { ...process.env, DEN_ROOT: fx.main },
    });

    const r = run(fx, fx.wt, [
      "--base", fx.shaB,
      "--detach",
      "--ticket", "test-feature/01-do-thing",
      "--role", "developer",
    ]);
    assert.notEqual(r.status, 0, "should exit non-zero when claim fails");
    assert.ok(r.stderr.trim().length > 0, "stderr should explain the failure");
  }));

test("exits non-zero when --ticket ref does not exist", () =>
  withFixture((fx) => {
    const r = run(fx, fx.wt, [
      "--base", fx.shaB,
      "--detach",
      "--ticket", "test-feature/99-nonexistent",
      "--role", "developer",
    ]);
    assert.notEqual(r.status, 0, "should exit non-zero for bad ref");
    assert.ok(r.stderr.trim().length > 0, "stderr should explain the failure");
  }));

// --- Criterion 2: without --ticket, behaviour is unchanged ---

test("without --ticket, agent-start succeeds without claiming any ticket", () =>
  withFixture((fx) => {
    const r = run(fx, fx.wt, ["--base", fx.shaB, "--detach"]);
    assert.equal(r.status, 0, r.stderr);
    // Ticket should remain unclaimed.
    const st = boardStatus(fx, "test-feature/01-do-thing");
    assert.match(st.stdout, /ready-for-agent/, "ticket should stay unclaimed");
  }));

test("without --ticket, agent-start fails the same as before for bad args", () =>
  withFixture((fx) => {
    const r = run(fx, fx.wt, ["--base", fx.shaB]);
    assert.notEqual(r.status, 0, "missing --branch/--detach should still fail");
  }));
