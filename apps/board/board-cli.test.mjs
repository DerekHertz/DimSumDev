// organism-infra/02: acceptance tests for the `board` CLI, pinning the
// interface from docs/adr/0008-board-service.md (claim, release, status,
// comment, list; subscribe is covered separately). Until the CLI exists these
// fail on ENOENT/MODULE_NOT_FOUND for apps/board/board.mjs, not on a
// logic bug in these tests.
//
// Every test runs the CLI as a real child process against a disposable git
// fixture (see board-fixture.mjs) and never touches this repo's own
// .scratch/. Fixtures are torn down in a `finally` so a failing assertion
// still cleans up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  makeBoardFixture,
  runBoard,
  deadPid,
  writeValidHandoff,
} from "./board-fixture.mjs";

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// --- Main-checkout writes -------------------------------------------------

test("board claim from a worktree writes only to the main checkout's board (resolved via git worktree list)", async () => {
  const fx = await makeBoardFixture();
  try {
    const { code } = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], {
      cwd: fx.worktree,
    });
    assert.equal(code, 0, "claim from a worktree should succeed");

    const mainTicket = await fx.readTicket();
    assert.match(mainTicket, /Status:\s*claimed/);

    // The worktree's own checked-out copy must be untouched: the CLI must
    // never write through the worktree's file tools.
    const worktreeTicket = await readFile(fx.ticketPathInWorktree, "utf8");
    assert.match(worktreeTicket, /Status:\s*ready-for-agent/);

    assert.ok(await exists(fx.claimLockPath), "claim lock should exist in the main checkout");
  } finally {
    await fx.cleanup();
  }
});

test("board claim resolves the main checkout via $DEN_ROOT even when cwd is not a worktree", async () => {
  const fx = await makeBoardFixture();
  try {
    const scratchCwd = os.tmpdir();
    const { code } = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], {
      cwd: scratchCwd,
      env: { DEN_ROOT: fx.root },
    });
    assert.equal(code, 0);
    const mainTicket = await fx.readTicket();
    assert.match(mainTicket, /Status:\s*claimed/);
  } finally {
    await fx.cleanup();
  }
});

// --- Concurrent claims -----------------------------------------------------

test("two concurrent claims of the same ticket: exactly one wins", async () => {
  const fx = await makeBoardFixture();
  try {
    const [a, b] = await Promise.all([
      runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], { cwd: fx.worktree }),
      runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree }),
    ]);
    const winners = [a, b].filter((r) => r.code === 0);
    const losers = [a, b].filter((r) => r.code !== 0);
    assert.equal(winners.length, 1, "exactly one claim should succeed");
    assert.equal(losers.length, 1, "exactly one claim should fail");

    const mainTicket = await fx.readTicket();
    assert.match(mainTicket, /Status:\s*claimed/);

    const lockContents = await readFile(fx.claimLockPath, "utf8");
    const winnerRole = winners[0] === a ? "qa" : "developer";
    assert.match(lockContents, new RegExp(winnerRole));
  } finally {
    await fx.cleanup();
  }
});

// --- Locking ----------------------------------------------------------------

test("a live write lock (same host, alive pid) is never stolen by a concurrent mutation", async () => {
  const fx = await makeBoardFixture();
  try {
    const liveLock = {
      pid: process.pid, // this test process: guaranteed alive throughout
      host: os.hostname(),
      createdAt: new Date().toISOString(),
    };
    await writeFile(fx.writeLockPath, JSON.stringify(liveLock));

    const result = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], {
      cwd: fx.worktree,
      timeoutMs: 5000,
    });

    if (!result.timedOut) {
      assert.notEqual(result.code, 0, "claim must not succeed while a live write lock is held");
    }
    const stillThere = JSON.parse(await readFile(fx.writeLockPath, "utf8"));
    assert.deepEqual(stillThere, liveLock, "a live write lock must never be modified or reclaimed");
    assert.equal(
      await exists(`${fx.writeLockPath}.tombstone`),
      false,
      "no tombstone should be created for a live lock"
    );
  } finally {
    await fx.cleanup();
  }
});

test("a stale write lock (dead pid, same host, past the age floor) is reclaimed via tombstone rename", async () => {
  const fx = await makeBoardFixture();
  try {
    const pid = await deadPid();
    const staleLock = {
      pid,
      host: os.hostname(),
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    };
    await writeFile(fx.writeLockPath, JSON.stringify(staleLock));

    const { code } = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], {
      cwd: fx.worktree,
    });
    assert.equal(code, 0, "claim should reclaim a stale write lock and succeed");

    const mainTicket = await fx.readTicket();
    assert.match(mainTicket, /Status:\s*claimed/);
  } finally {
    await fx.cleanup();
  }
});

test("a fresh write lock with a dead pid is not reclaimed before the age floor", async () => {
  const fx = await makeBoardFixture();
  try {
    const pid = await deadPid();
    const freshLock = {
      pid,
      host: os.hostname(),
      createdAt: new Date().toISOString(), // just created
    };
    await writeFile(fx.writeLockPath, JSON.stringify(freshLock));

    // Determinism under load (organism-infra/104): the lock's age when the
    // claim looks at it includes node startup, which can exceed the real 5 s
    // floor on a busy machine and make the lock legitimately reclaimable. The
    // test-only floor override pins the floor at 10 minutes and the wait at
    // 500 ms, so "younger than the floor" holds however slow the process is.
    const result = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], {
      cwd: fx.worktree,
      timeoutMs: 20000,
      env: {
        BOARD_TEST_WRITE_LOCK_AGE_FLOOR_MS: "600000",
        BOARD_TEST_WRITE_LOCK_WAIT_MS: "500",
      },
    });
    if (!result.timedOut) {
      assert.notEqual(result.code, 0, "a lock younger than the age floor must not be reclaimed yet");
    }
    assert.deepEqual(
      JSON.parse(await readFile(fx.writeLockPath, "utf8")),
      freshLock,
      "the young dead-pid lock is left exactly as it was"
    );
  } finally {
    await fx.cleanup();
  }
});

test("a write lock from a different host is never auto-reclaimed", async () => {
  const fx = await makeBoardFixture();
  try {
    const pid = await deadPid();
    const otherHostLock = {
      pid,
      host: `not-${os.hostname()}`,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    };
    await writeFile(fx.writeLockPath, JSON.stringify(otherHostLock));

    const result = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], {
      cwd: fx.worktree,
      timeoutMs: 5000,
    });
    if (!result.timedOut) {
      assert.notEqual(result.code, 0, "a different-host lock must never be reclaimed");
    }
    const stillThere = JSON.parse(await readFile(fx.writeLockPath, "utf8"));
    assert.deepEqual(stillThere, otherHostLock);
  } finally {
    await fx.cleanup();
  }
});

test("claim locks never auto-expire, regardless of age", async () => {
  const fx = await makeBoardFixture({ status: "claimed" });
  try {
    await writeFile(fx.claimLockPath, "developer 2000-01-01T00:00:00Z\n");

    const { code } = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], {
      cwd: fx.worktree,
    });
    assert.notEqual(code, 0, "an old claim lock must still block a new claim");

    const lockContents = await readFile(fx.claimLockPath, "utf8");
    assert.match(lockContents, /^developer /, "claim lock must be untouched");
  } finally {
    await fx.cleanup();
  }
});

// --- Writes and events -------------------------------------------------------

test("release is one atomic call: sets status and deletes the claim lock together", async () => {
  const fx = await makeBoardFixture();
  try {
    await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], { cwd: fx.worktree });
    await writeValidHandoff(fx);
    const { code } = await runBoard(
      ["release", fx.ticketRelPath, "--status", "in-review"],
      { cwd: fx.worktree }
    );
    assert.equal(code, 0);
    const ticket = await fx.readTicket();
    assert.match(ticket, /Status:\s*in-review/);
    assert.equal(await exists(fx.claimLockPath), false, "release must delete the claim lock");
  } finally {
    await fx.cleanup();
  }
});

test("release rejects a status not in docs/agents/issue-tracker.md's set", async () => {
  const fx = await makeBoardFixture();
  try {
    await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], { cwd: fx.worktree });
    const { code } = await runBoard(
      ["release", fx.ticketRelPath, "--status", "bogus-status"],
      { cwd: fx.worktree }
    );
    assert.notEqual(code, 0);
    const ticket = await fx.readTicket();
    assert.match(ticket, /Status:\s*claimed/, "ticket status must not change on invalid input");
    assert.ok(await exists(fx.claimLockPath), "claim lock must survive a rejected release");
  } finally {
    await fx.cleanup();
  }
});

test("every mutating call appends exactly one events.jsonl line matching the ADR schema", async () => {
  const fx = await makeBoardFixture();
  try {
    await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], { cwd: fx.worktree });
    let lines = (await readFile(fx.eventsPath, "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    let event = JSON.parse(lines[0]);
    assert.equal(typeof event.seq, "number");
    assert.equal(typeof event.ts, "string");
    assert.equal(event.feature, fx.feature);
    assert.match(String(event.ticket), new RegExp(fx.ticket));
    assert.match(String(event.role), /qa/);
    assert.equal(event.op, "claim");

    await writeValidHandoff(fx);
    await runBoard(["release", fx.ticketRelPath, "--status", "in-review"], {
      cwd: fx.worktree,
    });
    lines = (await readFile(fx.eventsPath, "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    const releaseEvent = JSON.parse(lines[1]);
    assert.equal(releaseEvent.op, "release");
    assert.equal(releaseEvent.seq, event.seq + 1, "seq must be monotonic across calls");
    assert.equal(releaseEvent.to_status, "in-review");
  } finally {
    await fx.cleanup();
  }
});

test("board claim does not leave temp files behind after an atomic write", async () => {
  const fx = await makeBoardFixture();
  try {
    await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], { cwd: fx.worktree });
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(path.dirname(fx.ticketPath));
    const leftoverTemp = files.filter((f) => /\.tmp$|~$/.test(f));
    assert.deepEqual(leftoverTemp, [], "no temp files should remain after a claim");
  } finally {
    await fx.cleanup();
  }
});

// --- Comments -----------------------------------------------------------------

test("board comment is stamped with the claiming agent's type and today's date", async () => {
  const fx = await makeBoardFixture();
  try {
    await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], { cwd: fx.worktree });
    const { code } = await runBoard(
      ["comment", fx.ticketRelPath, "hello from qa"],
      { cwd: fx.worktree }
    );
    assert.equal(code, 0);
    const ticket = await fx.readTicket();
    assert.match(ticket, /hello from qa/);
    assert.match(ticket, /qa/);
    assert.match(ticket, new RegExp(todayUTC()));

    const lines = (await readFile(fx.eventsPath, "utf8")).trim().split("\n").filter(Boolean);
    const commentEvent = JSON.parse(lines[lines.length - 1]);
    assert.equal(commentEvent.op, "comment");
    assert.equal(commentEvent.text, "hello from qa");
  } finally {
    await fx.cleanup();
  }
});

// --- Validation -----------------------------------------------------------------

test("path-traversal ticket ids are rejected before any file access", async () => {
  const fx = await makeBoardFixture();
  try {
    const outside = path.resolve(fx.root, "..", "escaped.md");
    const { code } = await runBoard(
      ["claim", "../../escaped", "qa"],
      { cwd: fx.worktree }
    );
    assert.notEqual(code, 0);
    assert.equal(await exists(outside), false, "no file should be created outside the board root");
  } finally {
    await fx.cleanup();
  }
});

test("path-traversal in the feature segment is rejected before any file access", async () => {
  const fx = await makeBoardFixture();
  try {
    const { code } = await runBoard(
      ["claim", "..%2F..%2Fescaped/01-x", "qa"],
      { cwd: fx.worktree }
    );
    assert.notEqual(code, 0);
  } finally {
    await fx.cleanup();
  }
});

test("oversized comment args are rejected without hanging or partial writes", async () => {
  const fx = await makeBoardFixture();
  try {
    await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], { cwd: fx.worktree });
    // Large enough to trip any reasonable arg-size cap, but still under the
    // OS's own command-line length limit so the failure comes from the CLI's
    // own validation, not from the shell/OS refusing to spawn the process.
    const huge = "x".repeat(20_000);
    const { code } = await runBoard(["comment", fx.ticketRelPath, "--as", "qa", huge], {
      cwd: fx.worktree,
      timeoutMs: 10000,
    });
    assert.notEqual(code, 0);
    const ticket = await fx.readTicket();
    assert.equal(ticket.includes(huge), false, "an oversized comment must not be written");
  } finally {
    await fx.cleanup();
  }
});

test("a symlink under .scratch that escapes the board root is rejected", async () => {
  const fx = await makeBoardFixture();
  try {
    const escapeTarget = path.resolve(fx.root, "..");
    const linkPath = path.join(fx.root, ".scratch", "escape-link");
    try {
      await symlink(escapeTarget, linkPath, "dir");
    } catch (err) {
      // Creating symlinks can require elevated privilege on Windows; if this
      // sandbox can't grant it, skip rather than fail on an environment gap.
      return;
    }
    const { code } = await runBoard(
      ["claim", "escape-link/01-x", "qa"],
      { cwd: fx.worktree }
    );
    assert.notEqual(code, 0);
  } finally {
    await fx.cleanup();
  }
});

// --- status / list --------------------------------------------------------------

test("board status prints the ticket's current status", async () => {
  const fx = await makeBoardFixture();
  try {
    await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], { cwd: fx.worktree });
    const { code, stdout } = await runBoard(["status", fx.ticketRelPath], {
      cwd: fx.worktree,
    });
    assert.equal(code, 0);
    assert.match(stdout, /claimed/);
  } finally {
    await fx.cleanup();
  }
});

test("board list filters by feature and status", async () => {
  const fx = await makeBoardFixture({ feature: "alpha", ticket: "01-a" });
  try {
    const { code, stdout } = await runBoard(
      ["list", "--feature", "alpha", "--status", "ready-for-agent"],
      { cwd: fx.worktree }
    );
    assert.equal(code, 0);
    assert.match(stdout, /01-a/);
  } finally {
    await fx.cleanup();
  }
});
