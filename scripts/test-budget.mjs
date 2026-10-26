// ci-cd/15: the CPU every `node --test` run started by our scripts may take, from one file:
// scripts/test-budget.json in the MAIN checkout (cpuPercent is percent of one core; 500 is five of this
// 8-core box's cores). A worktree's own copy is read only when the main checkout has none, so a run
// cannot raise the cap by editing its copy. `npm test`, `test:rest`, `test:browser` and `test:path`
// all start their tests here.
//
// How the budget is held, best first:
//   slice  a systemd user slice carries CPUQuota=cpuPercent and each run joins it in its own scope, so
//          runs started together share ONE quota (two relays stay inside the budget together). The
//          slice is named den-tests.slice, so systemd nests it under den.slice: test runs count toward
//          the den's memory bound and OOM order.
//   nice   no usable systemd user manager (macOS, a container, a cloud box), or we already run inside a
//          den slice (a worker's own cgroup bounds it): the run is niced and takes half the file
//          concurrency, so two runs together fit. Not a hard cap.
//   none   GitHub Actions only (GITHUB_ACTIONS=true): the runner is dedicated, so node's defaults stay.
//          CI=1 does not lift the cap. A process can still set GITHUB_ACTIONS itself; the bound that
//          holds is the cap on every normal run plus the test-run-guard hook, not this check.
// An env value (BROWSER_FILE_CONCURRENCY) can lower the file concurrency, never raise it.
//
// A bare `node --test <file>` typed by hand does not come through here and cannot be capped by a
// script. What bounds it: one file is one process (about 1.2 cores for the heaviest scene file), the
// test-run-guard hook blocks an uncapped run over a glob, a directory or more than 3 files, and a den
// worker runs inside its own cgroup (apps/bridge/agents/limits.json). Prefer `npm run test:path`.
//
// On SIGINT, SIGTERM or SIGHUP the run's whole process group gets the signal (SIGKILL after a grace),
// so `timeout 300 npm run test:path` leaves no test file or browser behind.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_BUDGET = new URL("./test-budget.json", import.meta.url);

function mainCheckout(env, git) {
  if (env.DEN_ROOT) return env.DEN_ROOT;
  const listed = git("git", ["worktree", "list", "--porcelain"], { encoding: "utf8", timeout: 5000, cwd: fileURLToPath(new URL(".", import.meta.url)) });
  const first = listed.status === 0 ? String(listed.stdout).split("\n")[0] : "";
  return first.startsWith("worktree ") ? first.slice("worktree ".length) : null;
}

export function loadBudget({ env = process.env, local = LOCAL_BUDGET, git = spawnSync } = {}) {
  const main = mainCheckout(env, git);
  if (main) {
    try {
      return JSON.parse(readFileSync(path.join(main, "scripts/test-budget.json"), "utf8"));
    } catch {}
  }
  return JSON.parse(readFileSync(local, "utf8"));
}

export const BUDGET = loadBudget();
const KILL_GRACE_MS = 5000;
const DEN_SLICE = /\bden-[a-z]+\.slice\b/;

function readCgroup() {
  try {
    return readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return "";
  }
}

export function limiterFor({ env = process.env, cgroup = readCgroup(), run = spawnSync } = {}) {
  if (env.GITHUB_ACTIONS === "true") return "none";
  if (DEN_SLICE.test(cgroup)) return "nice";
  const set = run("systemctl", ["--user", "set-property", "--runtime", BUDGET.slice, `CPUQuota=${BUDGET.cpuPercent}%`], { stdio: "ignore", timeout: 5000 });
  return set.status === 0 ? "slice" : "nice";
}

// Each browser file loads the complete garden (ci-cd/08), so browser runs start 3 files at a time.
export function nodeTestArgs(mode, env = process.env, limiter = "slice") {
  const n = Number(env.BROWSER_FILE_CONCURRENCY);
  const want = mode === "browser" ? (Number.isInteger(n) && n > 0 ? n : 3) : Infinity;
  if (limiter === "none") return mode === "browser" ? [`--test-concurrency=${want}`] : [];
  const share = Math.max(1, Math.floor(BUDGET.cpuPercent / (limiter === "nice" ? 200 : 100)));
  return [`--test-concurrency=${Math.min(want, share)}`];
}

// Runs argv in its own process group, forwards termination signals to the group, resolves to an exit code.
export function runForwarded(argv, options = {}) {
  return new Promise((resolve) => {
    const group = process.platform !== "win32";
    const child = spawn(argv[0], argv.slice(1), { ...options, stdio: "inherit", detached: group });
    const send = (signal) => {
      try {
        process.kill(group ? -child.pid : child.pid, signal);
      } catch {}
    };
    let signalled = null;
    const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
      const handler = () => {
        if (signalled) return;
        signalled = signal;
        send(signal);
        setTimeout(() => send("SIGKILL"), KILL_GRACE_MS).unref();
      };
      process.on(signal, handler);
      return [signal, handler];
    });
    const finish = (code) => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      if (signalled) send("SIGKILL");
      resolve(code);
    };
    child.on("error", (err) => {
      console.error(`test-budget: could not run ${argv[0]}: ${err.message}`);
      finish(127);
    });
    child.on("exit", (code, signal) => finish(signalled || signal ? 128 + (os.constants.signals[signalled ?? signal] ?? 1) : (code ?? 1)));
  });
}

export function runNodeTests(files, { mode = "rest", env = process.env, cwd } = {}) {
  const limiter = limiterFor({ env });
  if (limiter !== "none") {
    try {
      os.setPriority(0, Math.max(os.getPriority(0), BUDGET.niceness));
    } catch {}
  }
  const test = [process.execPath, "--test", ...nodeTestArgs(mode, env, limiter), ...files];
  const argv = limiter === "slice" ? ["systemd-run", "--user", "--scope", "--quiet", `--slice=${BUDGET.slice}`, ...test] : test;
  return runForwarded(argv, { cwd, env });
}
