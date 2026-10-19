// organism-infra/13 (qa finding): mutual exclusion of the per-ticket write
// lock while several processes reclaim a genuinely stale lock. Uses the
// env-gated test seam in board-service.mjs (BOARD_TEST_*) to force the exact
// A/B/C interleaving, and logs every hold to prove no two holds overlap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
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
    await sleep(20);
  }
  return false;
}

async function staleLock() {
  return JSON.stringify({
    pid: await deadPid(),
    host: os.hostname(),
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  });
}

// Every recorded hold of `lockName`, sorted by acquire time.
async function holds(dir, lockName) {
  const files = await readdir(dir);
  const records = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(path.join(dir, f), "utf8")))
  );
  return records.filter((r) => r.lock === lockName).sort((a, b) => a.acquiredAt - b.acquiredAt);
}

function assertNoOverlap(records) {
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1];
    const next = records[i];
    assert.ok(
      next.acquiredAt >= prev.releasedAt,
      `holds overlap: pid ${prev.pid} [${prev.acquiredAt}, ${prev.releasedAt}] and pid ${next.pid} acquired at ${next.acquiredAt}`
    );
  }
}

test("three-way stale reclaim: a reclaimer never takes a live lock, so holds never overlap", async () => {
  const fx = await makeBoardFixture();
  const hookDir = await mkdtemp(path.join(os.tmpdir(), "board-hooks-"));
  const holdDir = await mkdtemp(path.join(os.tmpdir(), "board-holds-"));
  const go = (point) => writeFile(path.join(hookDir, `${point}.go`), "");
  try {
    const stale = await staleLock();
    const stalePid = JSON.parse(stale).pid;
    await writeFile(fx.writeLockPath, stale);
    const run = (text, env) =>
      runBoard(["comment", fx.ticketRelPath, "--as", "qa", text], {
        cwd: fx.worktree,
        env: { BOARD_TEST_HOLD_LOG: holdDir, ...env },
        timeoutMs: 30000,
      });

    // A judges the lock stale, then pauses before acting on that judgment.
    const a = run("from A", {
      BOARD_TEST_HOOK_DIR: hookDir,
      BOARD_TEST_HOOKS: "stale-judged,reclaim-gap",
    });
    assert.ok(await waitUntil(() => exists(path.join(hookDir, "stale-judged.reached")), 10000));

    // B reclaims the same stale lock and holds its fresh live lock for 5s.
    const b = run("from B", { BOARD_TEST_HOLD_MS: "5000" });
    const bHolds = await waitUntil(async () => {
      const raw = await readFile(fx.writeLockPath, "utf8").catch(() => "");
      try {
        return JSON.parse(raw).pid !== stalePid;
      } catch {
        return false;
      }
    }, 10000);
    assert.ok(bHolds, "B should reclaim the stale lock");

    // A resumes on its stale judgment. If it can reach the point where B's
    // live lock is gone from the path, it pauses there while C arrives.
    await go("stale-judged");
    await waitUntil(() => exists(path.join(hookDir, "reclaim-gap.reached")), 1500);
    const c = await run("from C", { BOARD_TEST_HOLD_MS: "300" });
    await go("reclaim-gap");
    const [ra, rb] = await Promise.all([a, b]);

    assert.equal(rb.code, 0, rb.stderr);
    for (const [name, r] of [["A", ra], ["C", c]]) {
      assert.equal(r.timedOut, false, `${name} hung`);
      assert.ok([0, LOCK_TIMEOUT_EXIT].includes(r.code), `${name}: ${r.code} ${r.stderr}`);
    }
    assertNoOverlap(await holds(holdDir, path.basename(fx.writeLockPath)));
  } finally {
    await rm(hookDir, { recursive: true, force: true });
    await rm(holdDir, { recursive: true, force: true });
    await fx.cleanup();
  }
});

test("a reclaimer that crashed holding the reclaim mutex does not block reclaim forever", async () => {
  const fx = await makeBoardFixture();
  try {
    const stale = await staleLock();
    await writeFile(fx.writeLockPath, stale);
    const id = createHash("sha256").update(stale).digest("hex").slice(0, 16);
    const crashed = JSON.stringify({ pid: await deadPid(), host: os.hostname() });
    await writeFile(`${fx.writeLockPath}.reclaim-${id}-0`, crashed);
    const r = await runBoard(["comment", fx.ticketRelPath, "--as", "qa", "after crash"], { cwd: fx.worktree });
    assert.equal(r.code, 0, r.stderr);
    const leftovers = (await readdir(path.dirname(fx.ticketPath))).filter((f) => /write-lock/.test(f));
    assert.deepEqual(leftovers, [], "mutex files are cleaned up once the stale lock is gone");
  } finally {
    await fx.cleanup();
  }
});

test("stress: many processes reclaiming one stale lock hold it one at a time", async () => {
  const fx = await makeBoardFixture();
  const holdDir = await mkdtemp(path.join(os.tmpdir(), "board-holds-"));
  try {
    await writeFile(fx.writeLockPath, await staleLock());
    const N = 12;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        runBoard(["comment", fx.ticketRelPath, "--as", "qa", `stress ${i}`], {
          cwd: fx.worktree,
          env: { BOARD_TEST_HOLD_LOG: holdDir, BOARD_TEST_HOLD_MS: "40" },
          timeoutMs: 30000,
        })
      )
    );
    const ticket = await fx.readTicket();
    let succeeded = 0;
    results.forEach((r, i) => {
      assert.ok([0, LOCK_TIMEOUT_EXIT].includes(r.code), `op ${i}: ${r.code} ${r.stderr}`);
      const written = ticket.split(`stress ${i}\n`).length - 1;
      assert.equal(written, r.code === 0 ? 1 : 0, `op ${i} written ${written} times`);
      if (r.code === 0) succeeded++;
    });
    assert.ok(succeeded >= 1);

    const ticketHolds = await holds(holdDir, path.basename(fx.writeLockPath));
    assert.equal(ticketHolds.length, succeeded, "one logged hold per successful mutation");
    assertNoOverlap(ticketHolds);

    const leftovers = (await readdir(path.dirname(fx.ticketPath))).filter((f) =>
      /write-lock|\.tmp$/.test(f)
    );
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(holdDir, { recursive: true, force: true });
    await fx.cleanup();
  }
});
