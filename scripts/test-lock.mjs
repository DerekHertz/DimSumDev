// Machine-wide lock around a full test run (organism-infra/168).
//
// Usage: node scripts/test-lock.mjs <cmd> [args...]
//
// Two agents running the whole suite at once starve each other (Playwright and
// smoke timeouts), so a full run takes a lock file first. A second run waits,
// printing one line that names the holder, then runs once the lock is free.
// Targeted runs (`node --test <file>`, `npm run test:path`) never come here.
//
// Env:
//   TEST_LOCK_PATH        lock file (default: <os.tmpdir()>/dim-sum-dev-test.lock,
//                         outside the repo's tracked files)
//   TEST_LOCK_TIMEOUT_MS  bound on waiting (default 15 minutes)
//   TEST_LOCK_POLL_MS     poll interval while waiting (default 500)
//
// The lock is a file holding {pid, cwd, token}. It is created by hard-linking a
// fully written temp file to the lock path, so it appears atomically with its
// content and the link fails if someone else holds it. A lock whose pid is gone
// is stale and is taken over.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_MS = 500;
const KILL_GRACE_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function numberFromEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 && process.env[name] !== "" && process.env[name] !== undefined ? n : fallback;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function readOwner(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    return owner && typeof owner === "object" ? owner : {};
  } catch (err) {
    if (err.code === "ENOENT") return null;
    return {}; // unreadable or malformed: treat as a lock with no live owner
  }
}

// Try once to take the lock. Returns "acquired", or { holder } when someone
// live holds it. A stale lock is moved aside and the attempt repeats.
function tryAcquire(lockPath, owner) {
  const tmp = `${lockPath}.${process.pid}.${owner.token}.tmp`;
  writeFileSync(tmp, JSON.stringify(owner));
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        linkSync(tmp, lockPath);
        return "acquired";
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      }
      const holder = readOwner(lockPath);
      if (holder === null) continue; // released between link and read: retry
      if (isAlive(holder.pid)) return { holder };
      // Stale: rename it away (only one taker wins the rename), then retry.
      const aside = `${lockPath}.stale.${process.pid}.${owner.token}`;
      try {
        renameSync(lockPath, aside);
      } catch (err) {
        if (err.code === "ENOENT") continue;
        throw err;
      }
      rmSync(aside, { force: true });
    }
    return { holder: readOwner(lockPath) ?? {} };
  } finally {
    rmSync(tmp, { force: true });
  }
}

function release(lockPath, token) {
  const owner = readOwner(lockPath);
  if (owner && owner.token === token) rmSync(lockPath, { force: true });
}

function describeHolder(holder) {
  const pid = holder.pid ?? "unknown";
  const cwd = holder.cwd ?? "unknown";
  return `pid ${pid}, worktree ${cwd}`;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    console.error("usage: node scripts/test-lock.mjs <cmd> [args...]");
    return 2;
  }
  const lockPath = process.env.TEST_LOCK_PATH || path.join(tmpdir(), "dim-sum-dev-test.lock");
  const timeoutMs = numberFromEnv("TEST_LOCK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const pollMs = Math.max(1, numberFromEnv("TEST_LOCK_POLL_MS", DEFAULT_POLL_MS));
  const owner = { pid: process.pid, cwd: process.cwd(), token: randomBytes(8).toString("hex") };

  let held = false;
  let child = null;
  let pendingSignal = null;

  const onSignal = (signal) => {
    if (pendingSignal) return;
    pendingSignal = signal;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => onSignal(signal));
  const signalExit = (signal) => 128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal] ?? 1);

  const deadline = Date.now() + timeoutMs;
  let announced = false;
  try {
    for (;;) {
      if (pendingSignal) return signalExit(pendingSignal);
      const got = tryAcquire(lockPath, owner);
      if (got === "acquired") {
        held = true;
        break;
      }
      if (!announced) {
        console.error(`test-lock: waiting for the test lock held by ${describeHolder(got.holder)}`);
        announced = true;
      }
      if (Date.now() >= deadline) {
        console.error(
          `test-lock: timed out after ${timeoutMs}ms waiting for the test lock held by ${describeHolder(got.holder)}`
        );
        return 1;
      }
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }

    if (pendingSignal) return signalExit(pendingSignal);
    const outcome = await new Promise((resolve) => {
      child = spawn(cmd, args, { stdio: "inherit" });
      child.on("error", (err) => {
        console.error(`test-lock: could not run ${cmd}: ${err.message}`);
        resolve({ code: 127, signal: null });
      });
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    if (pendingSignal) return signalExit(pendingSignal);
    if (outcome.signal) return signalExit(outcome.signal);
    return outcome.code ?? 1;
  } finally {
    if (held) release(lockPath, owner.token);
  }
}

process.exitCode = await main();
