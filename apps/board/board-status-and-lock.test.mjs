// organism-infra/13 regression tests: the real `**Status:** <value>` format,
// header-only status parsing, bounded write-lock waits, and concurrent
// comment/release on one ticket. Seam: the `board` CLI as a child process
// plus the files it writes (same seam as board-cli.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, unlink, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeBoardFixture, runBoard, writeValidHandoff } from "./board-fixture.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
// Copied verbatim from .scratch/organism-infra/issues/ on 2026-09-27.
// 13 mentions `**Status:** <value>` inside body text above its real status
// line; 02 has a comment that contains `Status:`.
// Normalized to LF so a CRLF checkout (core.autocrlf) doesn't shift the bytes.
const loadFixture = async (name) =>
  (await readFile(path.join(FIXTURES, name), "utf8")).replace(/\r\n/g, "\n");
const REAL_13 = await loadFixture("real-ticket-13-board-status.md");
const REAL_02 = await loadFixture("real-ticket-02-board-cli.md");

// The distinct exit code for "write lock still held after the bounded wait".
const LOCK_TIMEOUT_EXIT = 75;

async function events(fx) {
  const raw = await readFile(fx.eventsPath, "utf8").catch(() => "");
  return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function liveLock() {
  return JSON.stringify({ pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString() });
}

// --- Status format ------------------------------------------------------------

test("status reads the real bold `**Status:** value` header line, not `**` or body text", async () => {
  const fx = await makeBoardFixture({ content: REAL_13 });
  try {
    const { code, stdout } = await runBoard(["status", fx.ticketRelPath], { cwd: fx.worktree });
    assert.equal(code, 0);
    assert.equal(stdout.trim(), "claimed");
  } finally {
    await fx.cleanup();
  }
});

test("release on a real bold-format ticket rewrites only the header status value, keeping the format", async () => {
  const fx = await makeBoardFixture({ content: REAL_13 });
  try {
    await writeFile(fx.claimLockPath, "developer 2026-09-27T00:00:00.000Z\n");
    await writeValidHandoff(fx);
    const { code, stderr } = await runBoard(["release", fx.ticketRelPath, "--status", "in-review"], {
      cwd: fx.worktree,
    });
    assert.equal(code, 0, stderr);
    const expected = REAL_13.replace("\n**Status:** claimed\n", "\n**Status:** in-review\n");
    assert.notEqual(expected, REAL_13, "fixture must contain the real status line");
    assert.equal(await fx.readTicket(), expected);
    const [ev] = await events(fx);
    assert.equal(ev.from_status, "claimed");
    assert.equal(ev.to_status, "in-review");
  } finally {
    await fx.cleanup();
  }
});

test("claim on a real ticket with `Status:` inside a comment changes only the header line", async () => {
  const fx = await makeBoardFixture({ content: REAL_02 });
  try {
    const { code, stderr } = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    assert.equal(code, 0, stderr);
    const expected = REAL_02.replace("\n**Status:** resolved\n", "\n**Status:** claimed\n");
    assert.notEqual(expected, REAL_02);
    assert.equal(await fx.readTicket(), expected);
    const [ev] = await events(fx);
    assert.equal(ev.from_status, "resolved");
    assert.equal(ev.to_status, "claimed");
  } finally {
    await fx.cleanup();
  }
});

test("list reports real statuses for bold-format tickets", async () => {
  const fx = await makeBoardFixture({ content: REAL_02 });
  try {
    const { code, stdout } = await runBoard(["list", "--feature", fx.feature], { cwd: fx.worktree });
    assert.equal(code, 0);
    assert.match(stdout, /01-do-thing\tresolved/);
  } finally {
    await fx.cleanup();
  }
});

test("a line-start `Status:` under ## Comments is never read or replaced", async () => {
  const content =
    "# 05: thing\n\nStatus: ready-for-agent\n\n- [ ] criterion\n\n## Comments\n\nStatus: blocked\n**Status:** resolved\n";
  const fx = await makeBoardFixture({ content });
  try {
    const status = await runBoard(["status", fx.ticketRelPath], { cwd: fx.worktree });
    assert.equal(status.stdout.trim(), "ready-for-agent");
    await writeFile(fx.claimLockPath, "developer 2026-09-27T00:00:00.000Z\n");
    await writeValidHandoff(fx);
    const { code } = await runBoard(["release", fx.ticketRelPath, "--status", "in-review"], { cwd: fx.worktree });
    assert.equal(code, 0);
    assert.equal(await fx.readTicket(), content.replace("Status: ready-for-agent", "Status: in-review"));
  } finally {
    await fx.cleanup();
  }
});

test("a ticket with no header status line is refused, not edited in its comments", async () => {
  const content = "# 05: thing\n\n- [ ] criterion\n\n## Comments\n\n**Status:** resolved\n";
  const fx = await makeBoardFixture({ content });
  try {
    const { code } = await runBoard(["release", fx.ticketRelPath, "--status", "in-review"], { cwd: fx.worktree });
    assert.notEqual(code, 0);
    assert.equal(await fx.readTicket(), content);
    assert.deepEqual(await events(fx), []);
  } finally {
    await fx.cleanup();
  }
});

// --- Write-lock wait -----------------------------------------------------------

test("a held live write lock fails in bounded time with the distinct lock-timeout exit code", async () => {
  const fx = await makeBoardFixture({ content: REAL_13 });
  try {
    await writeFile(fx.writeLockPath, liveLock());
    const started = Date.now();
    const result = await runBoard(["comment", fx.ticketRelPath, "--as", "qa", "blocked by lock"], {
      cwd: fx.worktree,
      timeoutMs: 10000,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, false, "must not hang");
    assert.equal(result.code, LOCK_TIMEOUT_EXIT, result.stderr);
    assert.match(result.stderr, /write lock/i);
    assert.ok(elapsed >= 1000, `should wait with backoff before giving up (took ${elapsed}ms)`);
    assert.ok(elapsed < 6000, `wait must be bounded to a few seconds (took ${elapsed}ms)`);
    assert.equal(await fx.readTicket(), REAL_13, "ticket untouched");
    assert.ok(await exists(fx.writeLockPath), "the live lock is never stolen");
  } finally {
    await unlink(fx.writeLockPath).catch(() => {});
    await fx.cleanup();
  }
});

test("a write lock released mid-wait lets the waiting command succeed", async () => {
  const fx = await makeBoardFixture({ content: REAL_13 });
  try {
    await writeFile(fx.writeLockPath, liveLock());
    const pending = runBoard(["comment", fx.ticketRelPath, "--as", "qa", "after the wait"], {
      cwd: fx.worktree,
      timeoutMs: 10000,
    });
    setTimeout(() => unlink(fx.writeLockPath).catch(() => {}), 700);
    const result = await pending;
    assert.equal(result.code, 0, result.stderr);
    assert.match(await fx.readTicket(), /after the wait/);
  } finally {
    await fx.cleanup();
  }
});

test("a held events lock times out release/comment with 75 and changes neither the ticket nor events.jsonl", async () => {
  const fx = await makeBoardFixture({ content: REAL_13 });
  const eventsLock = `${fx.eventsPath}.write-lock.json`;
  try {
    const seed = '{"seq":1,"ts":"2026-09-27T00:00:00.000Z","op":"seed"}\n';
    await writeFile(fx.eventsPath, seed);
    await writeFile(fx.claimLockPath, "developer 2026-09-27T00:00:00.000Z\n");
    await writeValidHandoff(fx);
    await writeFile(eventsLock, liveLock());
    for (const args of [
      ["release", fx.ticketRelPath, "--status", "in-review", "--reason", "should not land"],
      ["comment", fx.ticketRelPath, "--as", "developer", "should not land"],
    ]) {
      const r = await runBoard(args, { cwd: fx.worktree, timeoutMs: 10000 });
      assert.equal(r.code, LOCK_TIMEOUT_EXIT, `${args[0]}: ${r.stderr}`);
      assert.equal(await fx.readTicket(), REAL_13, `${args[0]} must not write the ticket`);
      assert.equal(await readFile(fx.eventsPath, "utf8"), seed, `${args[0]} must not append an event`);
    }
    assert.ok(await exists(eventsLock), "the live events lock is never stolen");
    assert.equal(await exists(fx.writeLockPath), false, "the ticket lock is released after the timeout");
  } finally {
    await unlink(eventsLock).catch(() => {});
    await fx.cleanup();
  }
});

test("a taken claim lock fails fast even while the write lock is held", async () => {
  const fx = await makeBoardFixture({ content: REAL_13 });
  try {
    await writeFile(fx.claimLockPath, "developer 2026-09-27T00:00:00.000Z\n");
    await writeFile(fx.writeLockPath, liveLock());
    // Determinism under load (organism-infra/104): a wall-clock bound on
    // process startup plus the claim flakes on a busy machine. Instead set the
    // write-lock wait to 60 s and the runner timeout to 20 s: a claim that
    // waited on the held write lock would be killed by the runner (timedOut),
    // so finishing with "already claimed" proves it failed fast, at any speed.
    const result = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], {
      cwd: fx.worktree,
      timeoutMs: 20000,
      env: { BOARD_TEST_WRITE_LOCK_WAIT_MS: "60000" },
    });
    assert.equal(result.timedOut, false, "claim-lock conflict must not wait on the held write lock");
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /already claimed/);
  } finally {
    await unlink(fx.writeLockPath).catch(() => {});
    await fx.cleanup();
  }
});

// --- Concurrency -----------------------------------------------------------------

test("concurrent mutations on different tickets never collide on seq or lose an event line", async () => {
  const fx = await makeBoardFixture({ content: REAL_02 });
  try {
    const N = 10;
    const refs = [];
    for (let i = 0; i < N; i++) {
      const ticket = `${String(20 + i)}-parallel`;
      await writeFile(path.join(path.dirname(fx.ticketPath), `${ticket}.md`), REAL_02);
      refs.push(`${fx.feature}/${ticket}`);
    }
    // organism-infra/18 fix-1: release now binds the handoff it reads to the
    // ticket being released (by filename prefix + State.ticket match), so
    // each of the 10 parallel tickets here needs its own matching handoff,
    // not the one shared fixture handoff this loop used to write once.
    for (const [i, ref] of refs.entries()) {
      if (i % 3 === 2) {
        await writeFile(path.join(path.dirname(fx.ticketPath), `${ref.split("/")[1]}.lock`), "developer 2026-09-27T00:00:00.000Z\n");
      }
      await writeValidHandoff(fx, { ticket: ref.split("/")[1] });
    }
    // Mix of ops so every mutating path appends under contention.
    const results = await Promise.all(
      refs.map((ref, i) => {
        const args =
          i % 3 === 0
            ? ["comment", ref, "--as", "qa", `cross-ticket ${i}`]
            : i % 3 === 1
              ? ["claim", ref, "developer"]
              : ["release", ref, "--status", "in-review", "--reason", `cross-ticket ${i}`];
        return runBoard(args, { cwd: fx.worktree, timeoutMs: 20000 });
      })
    );
    results.forEach((r, i) => assert.equal(r.code, 0, `op ${i}: ${r.stderr}`));

    const raw = await readFile(fx.eventsPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    assert.equal(lines.length, N, "one event line per mutation, none lost");
    const evs = lines.map((l) => JSON.parse(l)); // throws on a torn line
    assert.deepEqual(evs.map((e) => e.seq), Array.from({ length: N }, (_, i) => i + 1));
    assert.deepEqual(
      evs.map((e) => e.ticket).sort(),
      refs.map((r) => r.split("/")[1]).sort(),
      "exactly one event per ticket"
    );
    const leftovers = (await readdir(path.dirname(fx.eventsPath))).filter((f) => /\.tmp$|write-lock/.test(f));
    assert.deepEqual(leftovers, []);
  } finally {
    await fx.cleanup();
  }
});

test("concurrent comment and release on one ticket lose no updates and leave the file intact", async () => {
  const fx = await makeBoardFixture({ content: REAL_13.replace("**Status:** claimed", "**Status:** ready-for-agent") });
  try {
    const claimed = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    assert.equal(claimed.code, 0, claimed.stderr);
    await writeValidHandoff(fx);

    const ops = [];
    for (let i = 0; i < 6; i++) ops.push({ kind: "comment", text: `parallel comment ${i}`, args: ["comment", fx.ticketRelPath, "--as", "developer", `parallel comment ${i}`] });
    ops.push({ kind: "release", text: "parallel release A", args: ["release", fx.ticketRelPath, "--status", "in-review", "--reason", "parallel release A"] });
    ops.push({ kind: "release", text: "parallel release B", args: ["release", fx.ticketRelPath, "--status", "blocked", "--reason", "parallel release B"] });

    const results = await Promise.all(ops.map((op) => runBoard(op.args, { cwd: fx.worktree, timeoutMs: 20000 })));
    const ticket = await fx.readTicket();

    let succeeded = 0;
    results.forEach((r, i) => {
      assert.equal(r.timedOut, false);
      // organism-infra/45: release A (gated) is refused with 1 if release B
      // already freed the claim lock, so a clean refusal is allowed for it.
      const allowed = ops[i].kind === "release" ? [0, 1, LOCK_TIMEOUT_EXIT] : [0, LOCK_TIMEOUT_EXIT];
      assert.ok(allowed.includes(r.code),`op ${i} failed uncleanly: ${r.code} ${r.stderr}`);
      const occurrences = ticket.split(ops[i].text).length - 1;
      assert.equal(occurrences, r.code === 0 ? 1 : 0, `op ${i} (${ops[i].text}) written ${occurrences} times`);
      if (r.code === 0) succeeded++;
    });
    assert.ok(succeeded >= 1);

    // File intact: everything outside the header status line and the appended
    // comments is byte-identical to the original.
    const statusLines = ticket.split("\n").filter((l) => /^\*\*Status:\*\*/.test(l));
    assert.equal(statusLines.length, 1);
    assert.match(statusLines[0], /^\*\*Status:\*\* (claimed|in-review|blocked)$/);
    const original = REAL_13.trimEnd();
    const normalized = ticket.replace(statusLines[0], "**Status:** claimed");
    assert.ok(normalized.startsWith(original), "original content must be preserved as a prefix");

    const evs = await events(fx);
    assert.equal(evs.length, 1 + succeeded, "one event per successful mutation");
    evs.forEach((e, i) => assert.equal(e.seq, i + 1, "seq must be gapless and ordered"));
    for (const e of evs.filter((x) => x.op === "release")) {
      assert.match(e.from_status, /^(claimed|in-review|blocked)$/);
    }

    const leftovers = (await readdir(path.dirname(fx.ticketPath))).filter((f) => /\.tmp$|write-lock/.test(f));
    assert.deepEqual(leftovers, []);
  } finally {
    await fx.cleanup();
  }
});
