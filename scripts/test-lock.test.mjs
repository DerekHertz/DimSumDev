// Acceptance tests for organism-infra/168: serialize full `npm test` runs with
// a machine-wide lock, so two agents running the suite at once stop producing
// flaky failures.
//
// Pinned contract (QA's reading of the ticket; the developer may choose
// everything not listed here):
//   - Wrapper: `node scripts/test-lock.mjs <cmd> [args...]` takes the lock,
//     runs <cmd> with inherited stdio, releases the lock, and exits with the
//     command's exit code. The command follows the script name directly.
//   - Env knobs (so tests use a stub suite and a private lock, never the real
//     machine-wide one):
//       TEST_LOCK_PATH        where the lock lives (a file or a directory path
//                             the wrapper owns; tests never read its contents)
//       TEST_LOCK_TIMEOUT_MS  bound on waiting for the lock
//       TEST_LOCK_POLL_MS     how often a waiter re-checks the lock
//   - A waiter prints exactly one line containing "wait" (case-insensitive)
//     that names the holder: its pid (the wrapper's pid or the pid of the
//     command it runs) and its worktree path (the holder's cwd), on stdout or
//     stderr.
//   - On timeout the wrapper exits non-zero, prints a message containing
//     "timed out" or "timeout", and never runs the command.
//   - package.json's `test` script goes through scripts/test-lock.mjs; the
//     targeted `test:path` script does not.
//
// Criterion map:
//   1 Two full runs run one after the other; waiter names the holder
//       -> "two runs started together never overlap", "a waiting run prints one line naming the holder's pid and worktree"
//   2 Lock released on normal exit, failure, SIGTERM (and SIGINT per body text)
//       -> "lock is released after a normal exit", "... after a failing command (exit code passes through)",
//          "... on SIGTERM", "... on SIGINT"
//   3 Stale lock with a dead pid is taken over
//       -> "a stale lock left by a SIGKILLed holder is taken over"
//   4 Bounded wait exits non-zero with a message
//       -> "wait is bounded: exits non-zero with a timeout message and does not run the command"
//   5 `node --test <file>` unaffected
//       -> "targeted runs take no lock" (test:path and plain node --test while the lock is held),
//          "package.json test script goes through the lock wrapper; test:path does not"
//   6 Existing tests still pass -> `npm test` as a whole (verify step)
//
// Not automatable here (reviewer check): the default lock location, used when
// TEST_LOCK_PATH is unset, lies outside the repo's tracked files (for example
// under os.tmpdir()). Marked human-verified.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const WRAPPER = path.join(REPO_ROOT, "scripts", "test-lock.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(25);
  }
  assert.fail(`timed out after ${ms}ms waiting for ${what}`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A sandbox per test: a private lock path, a stub suite, and a log the stub writes.
function sandbox() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "test-lock-")));
  const stub = path.join(dir, "stub-suite.mjs");
  // Stub suite: logs "start <pid>", sleeps argv[3] ms, logs "end <pid>", exits argv[4].
  writeFileSync(
    stub,
    [
      "import { appendFileSync } from 'node:fs';",
      "const [log, sleepMs, code] = process.argv.slice(2);",
      "appendFileSync(log, `start ${process.pid}\\n`);",
      "setTimeout(() => {",
      "  appendFileSync(log, `end ${process.pid}\\n`);",
      "  process.exit(Number(code || 0));",
      "}, Number(sleepMs || 0));",
      "",
    ].join("\n")
  );
  const env = {
    ...process.env,
    TEST_LOCK_PATH: path.join(dir, "machine.lock"),
    TEST_LOCK_TIMEOUT_MS: "20000",
    TEST_LOCK_POLL_MS: "50",
  };
  delete env.NODE_TEST_CONTEXT;
  const children = [];
  return {
    dir,
    env,
    log: (name = "suite.log") => path.join(dir, name),
    readLog: (name = "suite.log") => {
      const f = path.join(dir, name);
      return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
    },
    // Start `wrapper <stub> <log> <sleepMs> <exitCode>` in the background.
    start({ log = "suite.log", sleepMs = 0, exitCode = 0, cwd = dir, env: extra = {} } = {}) {
      const child = spawn(
        process.execPath,
        [WRAPPER, process.execPath, stub, path.join(dir, log), String(sleepMs), String(exitCode)],
        { cwd, env: { ...env, ...extra }, detached: true, stdio: ["ignore", "pipe", "pipe"] }
      );
      const run = { child, out: "", exited: null };
      child.stdout.on("data", (d) => (run.out += d));
      child.stderr.on("data", (d) => (run.out += d));
      run.done = new Promise((resolve) =>
        child.on("exit", (code, signal) => {
          run.exited = { code, signal };
          resolve(run.exited);
        })
      );
      children.push(child);
      return run;
    },
    cleanup() {
      for (const c of children) {
        try {
          process.kill(-c.pid, "SIGKILL");
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Wait until the stub of `log` has started; returns its pid.
async function stubStarted(sb, log = "suite.log", nth = 1) {
  await waitFor(() => sb.readLog(log).filter((l) => l.startsWith("start ")).length >= nth, "the stub suite to start");
  return Number(sb.readLog(log).filter((l) => l.startsWith("start "))[nth - 1].split(" ")[1]);
}

// After a holder is gone, a fresh run must get the lock promptly (no waiting).
async function assertLockFree(sb, label) {
  const run = sb.start({ log: "after.log", env: { TEST_LOCK_TIMEOUT_MS: "3000" } });
  const { code } = await run.done;
  assert.equal(code, 0, `${label}: a new run should get the lock; output:\n${run.out}`);
  assert.ok(
    sb.readLog("after.log").some((l) => l.startsWith("end ")),
    `${label}: the stub suite should have run to completion`
  );
}

test("scripts/test-lock.mjs exists", () => {
  assert.ok(existsSync(WRAPPER), "scripts/test-lock.mjs must exist");
});

// --- Criterion 1: serialization and the waiting line ---

test("two runs started together never overlap", async () => {
  const sb = sandbox();
  try {
    const a = sb.start({ sleepMs: 500 });
    const b = sb.start({ sleepMs: 500 });
    const [ra, rb] = await Promise.all([a.done, b.done]);
    assert.equal(ra.code, 0, `run A output:\n${a.out}`);
    assert.equal(rb.code, 0, `run B output:\n${b.out}`);
    const events = sb.readLog().map((l) => l.split(" ")[0]);
    assert.deepEqual(events, ["start", "end", "start", "end"], "the second run must start only after the first ends");
  } finally {
    sb.cleanup();
  }
});

test("a waiting run prints one line naming the holder's pid and worktree", async () => {
  const sb = sandbox();
  const holderCwd = path.join(sb.dir, "holder-worktree");
  const waiterCwd = path.join(sb.dir, "waiter-worktree");
  for (const d of [holderCwd, waiterCwd]) {
    mkdirSync(d);
  }
  try {
    const holder = sb.start({ log: "holder.log", sleepMs: 1500, cwd: holderCwd });
    const stubPid = await stubStarted(sb, "holder.log");
    const waiter = sb.start({ log: "waiter.log", sleepMs: 0, cwd: waiterCwd });
    await waitFor(() => /wait/i.test(waiter.out), "the waiter to print a waiting line");
    // Let several polls pass: the line must not repeat.
    await sleep(400);
    const waitLines = waiter.out.split("\n").filter((l) => /wait/i.test(l));
    assert.equal(waitLines.length, 1, `expected exactly one waiting line, got:\n${waiter.out}`);
    const line = waitLines[0];
    assert.ok(
      line.includes(String(holder.child.pid)) || line.includes(String(stubPid)),
      `waiting line should name the holder's pid (${holder.child.pid} or ${stubPid}): ${line}`
    );
    assert.ok(line.includes(holderCwd), `waiting line should name the holder's worktree ${holderCwd}: ${line}`);
    assert.deepEqual(sb.readLog("waiter.log"), [], "the waiter must not run its suite while the holder runs");
    const [rh, rw] = await Promise.all([holder.done, waiter.done]);
    assert.equal(rh.code, 0);
    assert.equal(rw.code, 0, `waiter should exit 0 once it gets the lock; output:\n${waiter.out}`);
    assert.ok(sb.readLog("waiter.log").some((l) => l.startsWith("end ")), "the waiter runs after the holder ends");
  } finally {
    sb.cleanup();
  }
});

// --- Criterion 2: release on every way out ---

test("lock is released after a normal exit", async () => {
  const sb = sandbox();
  try {
    const run = sb.start({ log: "first.log", sleepMs: 0, exitCode: 0 });
    assert.equal((await run.done).code, 0, run.out);
    await assertLockFree(sb, "after normal exit");
  } finally {
    sb.cleanup();
  }
});

test("lock is released after a failing command (exit code passes through)", async () => {
  const sb = sandbox();
  try {
    const run = sb.start({ log: "first.log", sleepMs: 0, exitCode: 3 });
    assert.equal((await run.done).code, 3, `wrapper should exit with the command's code; output:\n${run.out}`);
    await assertLockFree(sb, "after failing command");
  } finally {
    sb.cleanup();
  }
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`lock is released on ${signal}`, async () => {
    const sb = sandbox();
    try {
      const holder = sb.start({ log: "holder.log", sleepMs: 60000 });
      const stubPid = await stubStarted(sb, "holder.log");
      holder.child.kill(signal);
      const { code, signal: sig } = await holder.done;
      assert.ok(code !== 0 || sig !== null, `wrapper should not exit 0 after ${signal}`);
      await waitFor(() => !isAlive(stubPid), "the running suite to be stopped with the wrapper", 5000);
      await assertLockFree(sb, `after ${signal}`);
    } finally {
      sb.cleanup();
    }
  });
}

// --- Criterion 3: stale lock takeover ---

test("a stale lock left by a SIGKILLed holder is taken over", async () => {
  const sb = sandbox();
  try {
    const holder = sb.start({ log: "holder.log", sleepMs: 60000 });
    await stubStarted(sb, "holder.log");
    // SIGKILL the whole group: the wrapper cannot clean up, so its lock stays behind.
    process.kill(-holder.child.pid, "SIGKILL");
    await holder.done;
    await waitFor(() => !isAlive(holder.child.pid), "the holder to be gone", 5000);
    const run = sb.start({ log: "taker.log", env: { TEST_LOCK_TIMEOUT_MS: "5000" } });
    const { code } = await run.done;
    assert.equal(code, 0, `a stale lock must be taken over, not waited on; output:\n${run.out}`);
    assert.ok(sb.readLog("taker.log").some((l) => l.startsWith("end ")), "the taker's suite should run");
  } finally {
    sb.cleanup();
  }
});

// --- Criterion 4: bounded wait ---

test("wait is bounded: exits non-zero with a timeout message and does not run the command", async () => {
  const sb = sandbox();
  try {
    const holder = sb.start({ log: "holder.log", sleepMs: 60000 });
    await stubStarted(sb, "holder.log");
    const t0 = Date.now();
    const waiter = sb.start({ log: "waiter.log", env: { TEST_LOCK_TIMEOUT_MS: "600" } });
    const { code } = await waiter.done;
    const elapsed = Date.now() - t0;
    assert.notEqual(code, 0, `a timed-out wait must exit non-zero; output:\n${waiter.out}`);
    assert.match(waiter.out, /timed out|timeout/i, `expected a clear timeout message, got:\n${waiter.out}`);
    assert.ok(elapsed < 10000, `the wait should end near the bound, took ${elapsed}ms`);
    assert.deepEqual(sb.readLog("waiter.log"), [], "the command must not run when the lock was never acquired");
    assert.ok(isAlive(holder.child.pid), "the holder must be unaffected by a waiter timing out");
  } finally {
    sb.cleanup();
  }
});

// --- Criterion 5: targeted runs take no lock ---

test("targeted runs take no lock (test:path and node --test run while the lock is held)", async () => {
  const sb = sandbox();
  try {
    const holder = sb.start({ log: "holder.log", sleepMs: 60000 });
    await stubStarted(sb, "holder.log");
    const quick = path.join(sb.dir, "quick.test.mjs");
    writeFileSync(
      quick,
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('passes', () => assert.ok(true));\n"
    );
    // The lock is held; a waiting run would hit this 1s bound and fail.
    const env = { ...sb.env, TEST_LOCK_TIMEOUT_MS: "1000" };
    const viaNode = spawnSync(process.execPath, ["--test", quick], { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 60000 });
    assert.equal(viaNode.status, 0, `node --test <file> should be unaffected:\n${viaNode.stdout}${viaNode.stderr}`);
    const viaNpm = spawnSync("npm", ["run", "test:path", "--", quick], { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 60000 });
    assert.equal(viaNpm.status, 0, `test:path should take no lock:\n${viaNpm.stdout}${viaNpm.stderr}`);
    assert.doesNotMatch(viaNpm.stdout + viaNpm.stderr, /waiting for/i, "test:path must not print a waiting line");
    assert.ok(isAlive(holder.child.pid), "the holder is still running");
  } finally {
    sb.cleanup();
  }
});

test("package.json test script goes through the lock wrapper; test:path does not", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const testScript = pkg.scripts.test;
  assert.match(testScript, /scripts\/test-lock\.mjs/, "`test` must run through scripts/test-lock.mjs");
  // fix/orphan-browsers: the full run goes through test-split `all`, which covers apps, packages
  // and scripts and caps the browser files' concurrency.
  assert.match(testScript, /scripts\/test-split\.mjs all/, "`test` must run test-split all");
  assert.equal(pkg.scripts.pretest, "npm run check:bom", "pretest BOM check must stay");
  assert.doesNotMatch(pkg.scripts["test:path"], /test-lock/, "test:path must not take the lock");
});
