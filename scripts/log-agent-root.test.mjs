// organism-infra/126: log-agent.mjs finds the main checkout the way `board` does
// (git worktree list, first entry) and takes short refs. $DEN_ROOT still wins.
// Seam: the log-agent CLI, run for real from a linked worktree of a throwaway repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeBoardFixture, validStateJson, REPO_ROOT } from "../apps/board/board-fixture.mjs";

const LOG_AGENT = path.join(REPO_ROOT, "scripts", "log-agent.mjs");
const usagePath = (root) => path.join(root, ".scratch", "usage.jsonl");
const rows = (root) => readFileSync(usagePath(root), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Runs log-agent from `cwd`; `root` sets $DEN_ROOT, and null leaves it unset.
function logFrom(cwd, root, ticket) {
  const env = { ...process.env };
  delete env.DEN_ROOT;
  if (root) env.DEN_ROOT = root;
  return spawnSync(
    process.execPath,
    [LOG_AGENT, "--ticket", ticket, "--role", "qa", "--mode", "specify", "--tokens", "10", "--ms", "20", "--outcome", "ok"],
    { cwd, env, encoding: "utf8", timeout: 15000 },
  );
}

async function publishHandoff(fx) {
  const dir = path.join(fx.root, ".scratch", fx.feature, "handoffs");
  await mkdir(dir, { recursive: true });
  const state = validStateJson({ ticket: fx.ticketRelPath, role: "qa", mode: "specify" });
  await writeFile(path.join(dir, "01-qa-specify.md"), "```json\n" + JSON.stringify(state) + "\n```\n\n## Summary\n\nx\n");
}

async function withFx(fn) {
  const fx = await makeBoardFixture();
  try {
    await fn(fx);
  } finally {
    await fx.cleanup();
  }
}

test("126 criterion 1: from a worktree with no $DEN_ROOT, finds the main checkout's handoff and appends to its usage.jsonl", () =>
  withFx(async (fx) => {
    await publishHandoff(fx); // published in the main checkout only, never in the worktree
    const r = logFrom(fx.worktree, null, fx.ticketRelPath);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(rows(fx.root).length, 1);
    assert.equal(rows(fx.root)[0].ticket, fx.ticketRelPath);
    assert.equal(rows(fx.root)[0].role, "qa");
    assert.equal(existsSync(usagePath(fx.worktree)), false, "nothing is written into the worktree's own .scratch");
  }));

test("126 criterion 1: from a worktree with no handoff anywhere, it is still refused and writes nothing", () =>
  withFx(async (fx) => {
    const r = logFrom(fx.worktree, null, fx.ticketRelPath);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /handoff/i);
    assert.equal(existsSync(usagePath(fx.root)), false);
    assert.equal(existsSync(usagePath(fx.worktree)), false);
  }));

test("126 criterion 3: $DEN_ROOT overrides the git-derived root", () =>
  withFx(async (a) =>
    withFx(async (b) => {
      // b is the board named by $DEN_ROOT; the cwd sits in a's worktree, whose main checkout is a.
      await publishHandoff(b);
      const r = logFrom(a.worktree, b.root, b.ticketRelPath);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(rows(b.root).length, 1);
      assert.equal(existsSync(usagePath(a.root)), false, "the cwd's own main checkout is left alone");
      assert.equal(existsSync(usagePath(a.worktree)), false);
    })));

test("126 body: a short ref resolves to the full slug in the row (same refs as board)", () =>
  withFx(async (fx) => {
    await publishHandoff(fx);
    const r = logFrom(fx.worktree, null, `${fx.feature}/01`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(rows(fx.root)[0].ticket, fx.ticketRelPath);
  }));

test("126 body: a short ref naming no ticket is refused and writes nothing", () =>
  withFx(async (fx) => {
    await publishHandoff(fx);
    const r = logFrom(fx.worktree, null, `${fx.feature}/99`);
    assert.equal(r.status, 1);
    assert.equal(existsSync(usagePath(fx.root)), false);
  }));
