// organism-infra/12: security bounce 1 -- the three scope items the ticket's
// Comments listed but the first pass did not implement:
//   1. deadline enforcement after a successful self-reclaim
//   2. EPERM/EBUSY/EACCES retry on the reclaim unlink
//   3. gating the BOARD_TEST_* seam on NODE_ENV
// See .scratch/organism-infra/issues/12-board-comment-hardening.md and
// .scratch/organism-infra/handoffs/12-security.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { deadPid, makeBoardFixture, runBoard } from "./board-fixture.mjs";

const LOCK_TIMEOUT_EXIT = 75;

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(15);
  }
  return false;
}

function staleLockJson(pid) {
  return JSON.stringify({
    pid,
    host: os.hostname(),
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  });
}

// --- Criterion: deadline enforced after a successful self-reclaim -----------

test("acquireWriteLock's deadline still bounds the wait after a successful self-reclaim", async () => {
  const fx = await makeBoardFixture();
  const hookDir = await mkdtemp(path.join(os.tmpdir(), "board-hooks-"));
  const goPath = path.join(hookDir, "post-reclaim.go");
  try {
    const dead = await deadPid();
    await writeFile(fx.writeLockPath, staleLockJson(dead));

    const start = Date.now();
    // BOARD_TEST_WRITE_LOCK_WAIT_MS shrinks the deadline so the test doesn't
    // need to wait out the real 2500ms bound. The "post-reclaim" hook pauses
    // the child right after it has reclaimed the stale lock (removed it) but
    // before it re-checks the deadline; while paused, put a fresh "stale"
    // lock back so the next tryCreateLock fails and the reclaim path is the
    // only one exercised. By the time we release the pause, more than the
    // (shrunk) deadline has already elapsed: a client that only checks the
    // deadline on the sleep/backoff path -- not after a self-reclaim -- would
    // ignore that and keep going instead of giving up.
    const child = runBoard(["comment", fx.ticketRelPath, "--as", "qa", "attempt"], {
      cwd: fx.worktree,
      env: {
        BOARD_TEST_HOOK_DIR: hookDir,
        BOARD_TEST_HOOKS: "post-reclaim",
        BOARD_TEST_WRITE_LOCK_WAIT_MS: "50",
      },
      timeoutMs: 15000,
    });

    await waitUntil(() => exists(path.join(hookDir, "post-reclaim.reached")), 5000);
    await writeFile(fx.writeLockPath, staleLockJson(dead));
    await sleep(150); // comfortably past the 50ms shrunk deadline
    await writeFile(goPath, "");

    const r = await child;
    const elapsed = Date.now() - start;

    assert.equal(r.timedOut, false, "the child must not hang past its own bounded wait");
    assert.equal(
      r.code,
      LOCK_TIMEOUT_EXIT,
      `expected LockTimeoutError (${LOCK_TIMEOUT_EXIT}) once the deadline had passed, got ${r.code}: ${r.stderr}`
    );
    assert.ok(elapsed < 5000, `the deadline check should fire promptly after resuming; took ${elapsed}ms`);
  } finally {
    await rm(hookDir, { recursive: true, force: true });
    await fx.cleanup();
  }
});

// --- Criterion: EPERM/EBUSY/EACCES retried on the reclaim unlink ------------

for (const code of ["EPERM", "EBUSY", "EACCES"]) {
  test(`a stale lock is still reclaimed after a transient ${code} on its unlink`, async () => {
    const fx = await makeBoardFixture();
    try {
      const dead = await deadPid();
      await writeFile(fx.writeLockPath, staleLockJson(dead));

      const r = await runBoard(["comment", fx.ticketRelPath, "--as", "qa", `after ${code}`], {
        cwd: fx.worktree,
        env: { BOARD_TEST_FORCE_UNLINK_ERR: code, BOARD_TEST_FORCE_UNLINK_COUNT: "2" },
      });

      assert.equal(r.code, 0, `expected the retry to ride out ${code} and succeed: ${r.stderr}`);
      const ticket = await fx.readTicket();
      assert.ok(ticket.includes(`after ${code}`), "the comment should have landed once reclaim succeeded");
    } finally {
      await fx.cleanup();
    }
  });
}

test("the reclaim unlink still fails once a non-retryable error is injected", async () => {
  const fx = await makeBoardFixture();
  try {
    const dead = await deadPid();
    await writeFile(fx.writeLockPath, staleLockJson(dead));

    const r = await runBoard(["comment", fx.ticketRelPath, "--as", "qa", "should not land"], {
      cwd: fx.worktree,
      env: { BOARD_TEST_FORCE_UNLINK_ERR: "ENOTDIR", BOARD_TEST_FORCE_UNLINK_COUNT: "1" },
    });

    assert.notEqual(r.code, 0, "a non-retryable error must still surface, not be swallowed");
    const ticket = await fx.readTicket();
    assert.equal(ticket.includes("should not land"), false);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion: BOARD_TEST_* gated on NODE_ENV ------------------------------

test("BOARD_TEST_HOLD_LOG is ignored when NODE_ENV is production", async () => {
  const fx = await makeBoardFixture();
  const holdDir = await mkdtemp(path.join(os.tmpdir(), "board-holds-"));
  try {
    const r = await runBoard(["comment", fx.ticketRelPath, "--as", "qa", "prod run"], {
      cwd: fx.worktree,
      env: { BOARD_TEST_HOLD_LOG: holdDir, NODE_ENV: "production" },
    });
    assert.equal(r.code, 0, r.stderr);

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(holdDir);
    assert.deepEqual(entries, [], "no hold should be logged once NODE_ENV=production disables the seam");
  } finally {
    await rm(holdDir, { recursive: true, force: true });
    await fx.cleanup();
  }
});

test("BOARD_TEST_HOLD_LOG still works outside production (control)", async () => {
  const fx = await makeBoardFixture();
  const holdDir = await mkdtemp(path.join(os.tmpdir(), "board-holds-"));
  try {
    const r = await runBoard(["comment", fx.ticketRelPath, "--as", "qa", "dev run"], {
      cwd: fx.worktree,
      env: { BOARD_TEST_HOLD_LOG: holdDir },
    });
    assert.equal(r.code, 0, r.stderr);

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(holdDir);
    assert.notEqual(entries.length, 0, "the hold seam should still work when NODE_ENV isn't production");
  } finally {
    await rm(holdDir, { recursive: true, force: true });
    await fx.cleanup();
  }
});
