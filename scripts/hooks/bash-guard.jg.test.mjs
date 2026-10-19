// organism-infra/80: bash-guard.mjs jg rule — specify tests.
//
// bash-guard.mjs is a PreToolUse Claude Code hook for "Bash".
// Contract: reads one JSON line from stdin, exits 0 (allow) or exits 2 (block)
// and prints the block reason to stdout.
//
// Input shape: { tool_name: "Bash", tool_input: { command: string },
//                session_info?: { cwd?: string } }
//
// AC2: bash-guard blocks a raw `jg` call; allows calls through the wrapper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GUARD = path.join(REPO_ROOT, "scripts", "hooks", "bash-guard.mjs");

// ── helpers ───────────────────────────────────────────────────────────────────

// A worktree-like cwd (outside .claude/worktrees for simplicity; the cwd rule
// applies within worktrees, but the jg rule must apply everywhere).
const WORKTREE_CWD = mkdtempSync(path.join(tmpdir(), "guard80-wt-"));

function run(command, cwd = WORKTREE_CWD) {
  const input = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
    session_info: { cwd },
  });
  return spawnSync(process.execPath, [GUARD], {
    input,
    encoding: "utf8",
    timeout: 10000,
  });
}

// ── AC2: direct jg calls are blocked ─────────────────────────────────────────

test("bash-guard blocks a direct `jg` call (raw binary)", () => {
  const r = run('jg "what is the board?" .');
  assert.equal(r.status, 2, `expected exit 2 (block); got ${r.status}. stdout: ${r.stdout}`);
  assert.match(r.stdout, /jg|wrapper|scripts\/jg/i, "block reason must mention jg or the wrapper");
});

test("bash-guard blocks `jg` with a subpath root", () => {
  const r = run('jg "find the relay" apps/');
  assert.equal(r.status, 2, `expected exit 2 (block); got ${r.status}`);
});

test("bash-guard blocks `jg` with --hidden flag (doubly forbidden: raw call)", () => {
  const r = run('jg --hidden "secret stuff" .');
  assert.equal(r.status, 2, `expected exit 2 (block); got ${r.status}`);
});

test("bash-guard blocks `jg` run through npx", () => {
  const r = run('npx jg "find the relay" .');
  assert.equal(r.status, 2, `expected exit 2 (block); got ${r.status}. stdout: ${r.stdout}`);
});

// ── AC2: wrapper calls are allowed ───────────────────────────────────────────

test("bash-guard allows `node scripts/jg.mjs` (the approved wrapper)", () => {
  const r = run('node scripts/jg.mjs "what is the board?" .');
  // Exit 0 = allowed. Exit 2 = blocked. Anything else = error in the guard itself.
  assert.equal(r.status, 0, `expected exit 0 (allow); got ${r.status}. stdout: ${r.stdout}`);
});

test("bash-guard allows `node scripts/jg.mjs` with a subdirectory root", () => {
  const r = run('node scripts/jg.mjs "find the relay" apps/board');
  assert.equal(r.status, 0, `expected exit 0 (allow); got ${r.status}. stdout: ${r.stdout}`);
});

// ── Non-jg commands are unaffected by the jg rule ────────────────────────────

test("bash-guard exits 0 (allow) for an unrelated single command (rg search)", () => {
  // A plain rg call must pass through the guard with exit 0.
  const r = run('rg "runJg" scripts/');
  assert.equal(r.status, 0, `rg must be allowed (exit 0); got ${r.status}. stdout: ${r.stdout}`);
});
