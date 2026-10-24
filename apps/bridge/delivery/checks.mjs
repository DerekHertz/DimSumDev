// den-mvp/34: the den runs the checks itself. For a delivery candidate (and on demand for an open pull request) the bridge
// runs the commands of .github/workflows/ci.yml from a clean worktree at the commit, each in a box (bubblewrap, started
// through the resource-group launcher an agent run uses), with a time limit; ending the group ends every browser it
// started. Every run writes a record under <recordDir>/<sha>/: the exact commands, the environment facts that differ from
// GitHub's runner, each job's exit and failing tests with their output, and a flake mark for a test that failed and then
// passed on the same commit. GitHub CI stays the merge gate; this run is the earlier, readable one.
//   createChecks({ repo, launcher, recordDir, ... }) -> { run({ sha, why?, signal? }), latest(sha), recent(n), running() }
//   run(...) -> record      record.state: "green" | "flaky" | "red" | "skipped" | "error"
// "flaky": every failing test passed when it was run again. "skipped": the commit changes the lockfile, so the installed
// packages do not match it. "error": the box could not be made or run here (the reason says what).
// The commit's code is not trusted: inside the box it sees its own worktree (writable), the repository's .git and
// node_modules (read-only), /usr, the few /etc files a test or a browser needs, Node and the Playwright browsers, and
// nothing else of the home folder. The test jobs have no network. The audit job has, so it gets a box of its own holding
// only the commit's package.json and package-lock.json, with npm's config files and registry fixed by the bridge.
// The results are advisory: the commit's own test scripts produce them. GitHub CI is the merge gate.
import { execFile } from "node:child_process";
import { createWriteStream, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { findBwrap } from "../build/box.mjs";
import { lockHash } from "../build/releases.mjs";
import { EnforcementError, LIMITS } from "../agents/resource-group.mjs";
import { WORKTREES_DIR } from "../agents/policy.mjs";
import { EMPTY_TREE } from "../agents/workspace.mjs";

const execFileP = promisify(execFile);
const SHA_RE = /^[0-9a-f]{40}$/;
export const JOB_TIMEOUT_MS = 15 * 60 * 1000; // ci.yml: timeout-minutes 15 for each test job
const AUDIT_TIMEOUT_MS = 5 * 60 * 1000;
const LOG_MAX_BYTES = 4 * 1024 * 1024; // a job's log on disk; the rest is cut
const OUTPUT_MAX = 4000; // one failing test's output in the record
const FAILURES_MAX = 50;
const KEPT_RECORDS = 10; // per commit
const KEPT_COMMITS = 30; // commits with records; older ones are removed
const OUTPUT_KEPT = 8 * 1024 * 1024; // a job's output held in memory for parsing; older chunks go first
export const RUN_DEADLINE_MS = 40 * 60 * 1000; // one record, every job and re-run included
const REGISTRY = "https://registry.npmjs.org/";
// The /etc files the box gets: users and names, resolver and certificates (audit), fonts (Chromium), the linker cache,
// time zone and git's system config. Everything else under /etc stays out.
const ETC = ["passwd", "group", "hosts", "nsswitch.conf", "resolv.conf", "localtime", "ssl", "ca-certificates", "fonts", "alternatives", "ld.so.cache", "ld.so.conf", "ld.so.conf.d", "gitconfig", "mime.types"];
const etcArgs = () => ETC.flatMap((f) => ["--ro-bind-try", `/etc/${f}`, `/etc/${f}`]);
const systemArgs = () => ["--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/sbin", "/sbin", "--dir", "/etc", ...etcArgs()];
const SLOT_CLASS = "worker";

// What GitHub's runner is (ci.yml: ubuntu-latest, setup-node 22). Compared fact by fact with this machine's box.
export const GITHUB_ENV = Object.freeze({ os: "ubuntu-latest", node: "22.x", cores: 4, memoryMiB: 16384, network: "yes", gpu: "software GL", bwrap: "absent", cgroups: "mounted" });

// The box has the checks group's limits (limits.json "checks": four CPUs). Node's default runs a test file per host core
// at once, which starts more Chromiums than the memory and task caps allow and starves timing-sensitive files until they
// hang. So the files run a few at a time, browser files two at a time.
// The file lists are the commit's own scripts/test-split.mjs, read inside the box; the rest job runs its BOM check first,
// as test-split does.
export const REST_CONCURRENCY = 4;
export const BROWSER_CONCURRENCY = 2;
const splitRun = (group, concurrency) => "const cp = await import('node:child_process');"
  + " const { split } = await import(new URL('scripts/test-split.mjs', 'file://' + process.cwd() + '/'));"
  + (group === "rest" ? " const bom = cp.spawnSync(process.execPath, ['scripts/bom-check.mjs'], { stdio: 'inherit' }); if (bom.status !== 0) process.exit(bom.status ?? 1);" : "")
  + ` const r = cp.spawnSync(process.execPath, ['--test', '--test-concurrency=${concurrency}', ...split().${group}], { stdio: 'inherit' });`
  + " process.exit(r.status ?? 1);";

// The jobs of ci.yml, as the box runs them. `args` follow the Node binary; the commands GitHub runs are named beside them.
export const JOBS = Object.freeze([
  { name: "test", ci: "npm run test:rest", args: ["--input-type=module", "-e", splitRun("rest", REST_CONCURRENCY)], shown: `node scripts/bom-check.mjs && node --test --test-concurrency=${REST_CONCURRENCY} <the rest files of scripts/test-split.mjs>`, timeoutMs: JOB_TIMEOUT_MS, tests: true },
  { name: "test-browser", ci: "npm run test:browser", args: ["--input-type=module", "-e", splitRun("browser", BROWSER_CONCURRENCY)], shown: `node --test --test-concurrency=${BROWSER_CONCURRENCY} <the browser files of scripts/test-split.mjs>`, timeoutMs: JOB_TIMEOUT_MS, tests: true },
  { name: "audit", ci: "npm audit --audit-level=high", npm: ["audit", "--audit-level=high", `--registry=${REGISTRY}`, "--userconfig=/audit/npmrc", "--globalconfig=/dev/null"], timeoutMs: AUDIT_TIMEOUT_MS, network: true },
]);

const kind = (file) => {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
};

/**
 * The bubblewrap argv (no binary name) of one command in the box. Every path is absolute and already resolved.
 * `worktree` is writable; `gitDir` (the worktree's own folder under .git/worktrees) is writable so git can keep its index.
 */
export function checkBoxArgv({ repo, worktree, gitDir, nodeDir, browsers, command, home = "/tmp/home", packages = path.join(repo, "node_modules") }) {
  for (const [name, value] of Object.entries({ repo, worktree, gitDir, nodeDir, packages })) {
    if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new TypeError(`checkBoxArgv: ${name} must be an absolute path`);
  }
  if (!Array.isArray(command) || command.length === 0 || !command.every((a) => typeof a === "string")) throw new TypeError("checkBoxArgv: bad command");
  const modules = path.join(worktree, "node_modules");
  return [
    "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--clearenv", "--setenv", "HOME", home, "--setenv", "TMPDIR", "/tmp", "--setenv", "CI", "true",
    "--setenv", "PATH", `${path.join(nodeDir, "bin")}:/usr/bin:/bin`,
    ...(browsers ? ["--setenv", "PLAYWRIGHT_BROWSERS_PATH", browsers] : []),
    ...systemArgs(), "--ro-bind-try", "/opt", "/opt",
    "--ro-bind", "/sys/fs/cgroup", "/sys/fs/cgroup",
    "--ro-bind", nodeDir, nodeDir,
    ...(browsers ? ["--ro-bind", browsers, browsers] : []),
    "--ro-bind", path.join(repo, ".git"), path.join(repo, ".git"),
    "--bind", gitDir, gitDir,
    "--bind", worktree, worktree,
    "--ro-bind", packages, modules,
    // Vite keeps its dependency cache under node_modules/.vite: a private one per run, never the shared folder.
    "--tmpfs", path.join(modules, ".vite"),
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", home,
    "--chdir", worktree,
    "--", ...command,
  ];
}

/**
 * The audit job's box: the network, and nothing of the commit but its package.json and package-lock.json, copied into
 * `dir` by the bridge. No .git, no worktree, no .npmrc; npm's config files are /dev/null and its registry is fixed.
 */
export function auditBoxArgv({ dir, nodeDir, command, home = "/tmp/home" }) {
  for (const [name, value] of Object.entries({ dir, nodeDir })) {
    if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new TypeError(`auditBoxArgv: ${name} must be an absolute path`);
  }
  if (!Array.isArray(command) || command.length === 0 || !command.every((a) => typeof a === "string")) throw new TypeError("auditBoxArgv: bad command");
  return [
    "--unshare-all", "--share-net", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--clearenv", "--setenv", "HOME", home, "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", `${path.join(nodeDir, "bin")}:/usr/bin:/bin`,
    ...systemArgs(),
    "--ro-bind", nodeDir, nodeDir,
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", home,
    // At a fixed place of its own, so the bridge's folder for it (wherever records are kept) is never hidden by /tmp.
    "--ro-bind", dir, "/audit",
    "--chdir", "/audit",
    "--", ...command,
  ];
}

/**
 * The failing tests in Node's TAP output: the innermost failures only (a suite that failed because a test in it did is
 * not listed again). -> [{ name, file, location, output }]
 */
export function parseTap(text, worktree = "") {
  const lines = String(text ?? "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1];
    const block = [];
    if (lines[i + 1]?.trim() === "---") {
      for (i += 2; i < lines.length && lines[i].trim() !== "..."; i += 1) block.push(lines[i].slice(indent.length + 2));
    }
    const yaml = block.join("\n");
    if (/^failureType: '?subtestsFailed'?$/m.test(yaml)) continue;
    const location = /^location: '?(.*?)'?$/m.exec(yaml)?.[1] ?? "";
    const where = /^(.*):\d+:\d+$/.exec(location)?.[1] ?? location;
    const file = worktree && where.startsWith(`${worktree}/`) ? where.slice(worktree.length + 1) : where;
    out.push({ name: m[2].replace(/\\#/g, "#").trim(), file, location: file && location ? location.replace(where, file) : location, output: yaml.slice(0, OUTPUT_MAX) });
  }
  return out;
}

/** The facts of this machine's box that differ from GitHub's runner. -> [{ fact, here, github }] */
export function envDifferences(env, github = GITHUB_ENV) {
  return Object.keys(github).filter((k) => env[k] !== undefined && String(env[k]) !== String(github[k]) && !(k === "node" && String(env.node).startsWith("22."))).map((fact) => ({ fact, here: String(env[fact]), github: String(github[fact]) }));
}

/** The state of a whole run from its jobs. */
export const runState = (jobs) => {
  if (jobs.some((j) => j.state === "error")) return "error";
  if (jobs.some((j) => j.state === "red")) return "red";
  if (jobs.some((j) => j.state === "flaky")) return "flaky";
  return "green";
};

/** A record as the den shows it: no paths, no outputs; the failing and flaky tests by name. */
export const summarize = (rec) => rec && ({
  sha: rec.sha, id: rec.id, why: rec.why, state: rec.state, reason: rec.reason, startedAt: rec.startedAt, endedAt: rec.endedAt,
  commands: (rec.jobs ?? []).map((j) => ({ name: j.name, command: j.command, ci: j.ci, box: j.box, state: j.state, exit: j.exit, durationMs: j.durationMs, reason: j.reason })),
  environment: rec.environment, differences: rec.differences ?? [],
  failed: (rec.jobs ?? []).flatMap((j) => (j.failures ?? []).map((f) => ({ job: j.name, name: f.name, location: f.location }))).slice(0, 20),
  flaky: [...(rec.jobs ?? []).flatMap((j) => (j.flaky ?? []).map((f) => ({ job: j.name, name: f.name }))), ...(rec.flaky ?? []).map((f) => ({ job: f.job, name: f.name }))].slice(0, 20),
});

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const tail = (text, n) => (text.length > n ? text.slice(-n) : text);

export function createChecks({ repo, launcher, recordDir, depsDir, bwrap = findBwrap(), node = process.execPath, browsers = path.join(os.homedir(), ".cache", "ms-playwright"), exec = execFileP, jobs = JOBS, now = () => new Date(), deadlineMs = RUN_DEADLINE_MS } = {}) {
  if (typeof repo !== "string" || !path.isAbsolute(repo)) throw new TypeError("createChecks: repo must be an absolute path");
  if (typeof recordDir !== "string" || !path.isAbsolute(recordDir)) throw new TypeError("createChecks: recordDir must be an absolute path");
  if (depsDir !== undefined && (typeof depsDir !== "string" || !path.isAbsolute(depsDir))) throw new TypeError("createChecks: depsDir must be an absolute path");
  const git = (...args) => exec("git", ["-C", repo, ...args]);
  const active = new Map(); // sha -> promise of its record: one run per commit at a time
  let runs = 0;

  const nodeDir = () => path.dirname(path.dirname(realpathSync(node)));
  const environment = () => {
    let playwright = null;
    try {
      playwright = JSON.parse(readFileSync(path.join(repo, "node_modules", "playwright", "package.json"), "utf8")).version;
    } catch {}
    const limit = LIMITS.checks; // the launcher passed in is made with checksLimits() (agents/resource-group.mjs)
    return {
      os: `${os.type()} ${os.release()}`, node: process.versions.node, playwright,
      cores: Math.max(1, Math.round(limit.cpuPercent / 100)), hostCores: os.cpus().length, memoryMiB: limit.memoryMiB, hostMemoryMiB: Math.round(os.totalmem() / 1048576),
      network: "none (tests), yes (audit)", gpu: kind("/dev/dri") ? "not passed into the box: software GL" : "software GL", bwrap: bwrap ? "present" : "absent", cgroups: kind("/sys/fs/cgroup/cgroup.controllers") ? "mounted" : "absent",
    };
  };

  // One command in the box, with its output kept in `logFile`. -> { exit, timedOut, stopped, text }
  async function boxed({ command, audit = null, timeoutMs, wt, logFile, signal }) {
    const id = `check-${process.pid}-${(runs += 1)}`;
    const args = audit ? auditBoxArgv({ dir: audit, nodeDir: nodeDir(), command }) : checkBoxArgv({ repo, worktree: wt.dir, gitDir: wt.gitDir, nodeDir: nodeDir(), browsers: kind(browsers)?.isDirectory() ? browsers : null, command, packages: wt.packages });
    const { child, group } = await launcher.launch({ slotClass: SLOT_CLASS, id, bin: bwrap, args, cwd: "/", env: {} });
    if (!group) {
      child.kill("SIGKILL");
      throw new EnforcementError("the checks have no resource group to run in");
    }
    const log = createWriteStream(logFile);
    let written = 0;
    const chunks = []; // the output, oldest chunks dropped past OUTPUT_KEPT; joined once at the end
    let held = 0;
    const keep = (chunk) => {
      const s = String(chunk);
      chunks.push(s);
      held += s.length;
      while (held > OUTPUT_KEPT && chunks.length > 1) held -= chunks.shift().length;
      if (written < LOG_MAX_BYTES) {
        log.write(s.slice(0, LOG_MAX_BYTES - written));
        written += s.length;
      }
    };
    child.stdin.on("error", () => {});
    child.stdin.end();
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let timedOut = false;
    let stopped = false;
    const timer = setTimeout(() => ((timedOut = true), group.kill()), timeoutMs);
    const stop = () => ((stopped = true), group.kill());
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    // "exit", not "close": the launcher's anchor holds the gate pipe open until the group is killed.
    const exit = await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    group.kill(); // a browser a test left behind ends with the group
    await group.settled(5000);
    await new Promise((resolve) => log.end(resolve));
    return { exit, timedOut, stopped, text: chunks.join("") };
  }

  async function runJob(job, { wt, dir, sha, signal }) {
    const started = Date.now();
    const command = [realpathSync(node), ...(job.npm ? [npmCli(), ...job.npm] : job.args)];
    const shown = job.shown ?? (job.npm ? `npm ${job.npm.join(" ")}` : `node ${job.args.join(" ")}`);
    const logName = `${job.name}.log`;
    const result = { name: job.name, ci: job.ci, command: shown, box: job.network ? "network on" : "no network", exit: null, state: "green", durationMs: 0, failures: [], flaky: [], log: logName, reason: null };
    let audit = null;
    if (job.network) {
      // Only the two package files of the commit, read from git, never from the worktree.
      audit = path.join(dir, "audit-input");
      await mkdir(audit);
      for (const file of ["package.json", "package-lock.json"]) await writeFile(path.join(audit, file), String((await git("show", `${sha}:${file}`)).stdout));
      await writeFile(path.join(audit, "npmrc"), ""); // npm's user config: empty (it will not load /dev/null twice)
    }
    const first = await boxed({ command, audit, timeoutMs: job.timeoutMs, wt, logFile: path.join(dir, logName), signal });
    result.exit = first.exit;
    if (first.stopped) return { ...result, state: "error", reason: "stopped", durationMs: Date.now() - started };
    if (first.timedOut) return { ...result, state: "red", reason: `timed out after ${Math.round(job.timeoutMs / 60000)} minutes`, durationMs: Date.now() - started, failures: job.tests ? parseTap(first.text, wt.dir).slice(0, FAILURES_MAX) : [] };
    if (first.exit === 0) return { ...result, durationMs: Date.now() - started };
    if (!job.tests) return { ...result, state: "red", reason: `exit ${first.exit}`, output: tail(first.text, OUTPUT_MAX), durationMs: Date.now() - started };
    const failures = parseTap(first.text, wt.dir).slice(0, FAILURES_MAX);
    const files = [...new Set(failures.map((f) => f.file).filter((f) => f && !path.isAbsolute(f) && !f.startsWith("..")))];
    if (failures.length === 0 || files.length === 0) return { ...result, state: "red", reason: `exit ${first.exit}, no failing test named`, output: tail(first.text, OUTPUT_MAX), durationMs: Date.now() - started };
    // Each failing test's file once more, on the same commit: a test that passes now is marked flaky.
    const again = await boxed({ command: [realpathSync(node), "--test", ...files], timeoutMs: job.timeoutMs, wt, logFile: path.join(dir, `${job.name}.rerun.log`), signal });
    if (again.stopped) return { ...result, state: "error", reason: "stopped", durationMs: Date.now() - started };
    const still = new Set(parseTap(again.text, wt.dir).map((f) => `${f.file}|${f.name}`));
    const rerunOk = again.exit === 0;
    const flaky = failures.filter((f) => rerunOk || (!again.timedOut && !still.has(`${f.file}|${f.name}`)));
    const real = failures.filter((f) => !flaky.includes(f));
    return { ...result, state: real.length === 0 ? "flaky" : "red", reason: real.length === 0 ? "every failing test passed when it was run again" : `${real.length} test${real.length === 1 ? "" : "s"} failed`, failures: real, flaky: flaky.map((f) => ({ name: f.name, file: f.file, output: f.output })), rerun: { command: `node --test ${files.join(" ")}`, exit: again.exit, log: `${job.name}.rerun.log` }, durationMs: Date.now() - started };
  }

  const npmCli = () => {
    const cli = path.join(nodeDir(), "lib", "node_modules", "npm", "bin", "npm-cli.js");
    if (!kind(cli)?.isFile()) throw new EnforcementError(`npm is not where Node keeps it (${cli})`);
    return cli;
  };

  // Tests that failed in an earlier run of this commit and pass in this one are flaky too.
  async function earlierFlakes(sha, jobsDone) {
    const passed = new Set();
    for (const j of jobsDone) if (j.state === "green" || j.state === "flaky") passed.add(j.name);
    const marks = [];
    for (const before of await records(sha)) {
      for (const j of before.jobs ?? []) {
        if (!passed.has(j.name)) continue;
        for (const f of j.failures ?? []) marks.push({ job: j.name, name: f.name, file: f.file, earlier: before.id });
      }
    }
    return marks.slice(0, FAILURES_MAX);
  }

  async function records(sha) {
    const dir = path.join(recordDir, sha);
    const names = (await readdir(dir).catch(() => [])).filter((n) => /^\d{8}T\d{6}Z(-\d+)?\.json$/.test(n)).sort();
    const out = [];
    for (const n of names) {
      try {
        out.push(JSON.parse(await readFile(path.join(dir, n), "utf8")));
      } catch {}
    }
    return out;
  }

  // Commits beyond the newest KEPT_COMMITS lose their records.
  async function pruneCommits() {
    const shas = (await readdir(recordDir).catch(() => [])).filter((s) => SHA_RE.test(s));
    if (shas.length <= KEPT_COMMITS) return;
    const dated = await Promise.all(shas.map(async (s) => [s, (await records(s)).at(-1)?.startedAt ?? ""]));
    dated.sort((a, b) => String(b[1]).localeCompare(String(a[1])));
    for (const [s] of dated.slice(KEPT_COMMITS)) if (!active.has(s)) await rm(path.join(recordDir, s), { recursive: true, force: true });
  }

  async function prune(sha) {
    const dir = path.join(recordDir, sha);
    const names = (await readdir(dir).catch(() => [])).filter((n) => /^\d{8}T\d{6}Z(-\d+)?$/.test(n)).sort();
    for (const n of names.slice(0, Math.max(0, names.length - KEPT_RECORDS))) {
      await rm(path.join(dir, n), { recursive: true, force: true });
      await rm(path.join(dir, `${n}.json`), { force: true });
    }
  }

  async function execute({ sha, why, signal }) {
    const startedAt = now();
    let id = stamp(startedAt);
    const base = path.join(recordDir, sha);
    await mkdir(base, { recursive: true });
    for (let n = 2; existsSync(path.join(base, id)); n += 1) id = `${stamp(startedAt)}-${n}`;
    const dir = path.join(base, id);
    await mkdir(dir);
    const record = { id, sha, why: why ?? "delivery", startedAt: startedAt.toISOString(), endedAt: null, state: "error", reason: null, environment: environment(), differences: [], jobs: [], flaky: [], dir };
    record.differences = envDifferences(record.environment);
    const finish = async (state, reason) => {
      record.state = state;
      record.reason = reason;
      record.endedAt = now().toISOString();
      await writeFile(path.join(base, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
      await prune(sha).catch(() => {});
      await pruneCommits().catch(() => {});
      return record;
    };
    if (launcher?.enforced !== true || typeof launcher.launch !== "function") return finish("error", "the checks have no resource group to run in");
    if (!bwrap || !kind(bwrap)?.isFile()) return finish("error", "bubblewrap (bwrap) is not installed; the checks cannot be boxed without it");
    try {
      await git("cat-file", "-e", `${sha}^{commit}`);
    } catch {
      return finish("error", `the commit ${sha.slice(0, 12)} is not in this repository`);
    }
    // The packages the box mounts. With the den's packages folders (deps/<lock-hash>/node_modules, made by den:update) it
    // is the folder for the commit's own lockfile. Without them it is the checkout's node_modules, which must match the
    // commit's lockfile: a merged dependency not yet installed here once failed a whole run (den-mvp/13, 2026-10-16).
    let packages;
    try {
      if (depsDir !== undefined) {
        const lockText = (await exec("git", ["-C", repo, "show", `${sha}:package-lock.json`], { maxBuffer: 64 * 1024 * 1024 })).stdout;
        packages = path.join(depsDir, lockHash(lockText), "node_modules");
        if (!kind(packages)?.isDirectory()) return finish("skipped", "the packages for this commit's package-lock.json are not installed for the den (npm run den:update installs them); GitHub CI decides");
      } else {
        if (!kind(path.join(repo, "node_modules"))?.isDirectory()) return finish("error", "the repository has no node_modules to run the checks with (npm ci)");
        const [theirs, ours] = await Promise.all([git("rev-parse", `${sha}:package-lock.json`), git("hash-object", "package-lock.json")]);
        if (String(theirs.stdout).trim() !== String(ours.stdout).trim()) return finish("skipped", "the commit changes package-lock.json, so the packages installed here do not match it; GitHub CI decides");
        packages = path.join(repo, "node_modules");
      }
    } catch (err) {
      return finish("error", `could not compare the lockfile: ${String(err?.stderr || err?.message || err).trim().slice(0, 200)}`);
    }
    await mkdir(path.join(packages, ".vite"), { recursive: true }).catch(() => {}); // the box mounts its own over it
    // One deadline for the whole record: the user's Stop (signal) and the deadline both end the running job.
    const late = new AbortController();
    const both = new AbortController();
    const name = `check-${sha.slice(0, 12)}-${process.pid}-${(runs += 1)}`;
    const wtDir = path.join(repo, ...WORKTREES_DIR.split("/"), name);
    try {
      // The checkout runs on the host, so nothing of the commit's may run there: no hooks, no LFS smudge filter, and no attributes
      // from the commit (the empty tree), so its .gitattributes selects no driver. The user's global and system config are not read.
      await exec("git", ["-C", repo, `--attr-source=${EMPTY_TREE}`, "-c", "core.hooksPath=/dev/null", "-c", "filter.lfs.process=", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.required=false", "worktree", "add", "--detach", wtDir, sha], { env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    } catch (err) {
      return finish("error", `could not make a worktree at the commit: ${String(err?.stderr || err?.message || err).trim().slice(0, 200)}`);
    }
    const deadline = setTimeout(() => (late.abort(), both.abort()), deadlineMs);
    signal?.addEventListener("abort", () => both.abort(), { once: true });
    if (signal?.aborted) both.abort();
    const pastDeadline = () => finish("red", `the checks ran past their ${Math.round(deadlineMs / 60000)}-minute limit`);
    try {
      const wt = { packages, dir: realpathSync(wtDir), gitDir: String((await exec("git", ["-C", wtDir, "rev-parse", "--absolute-git-dir"])).stdout).trim() };
      // The audit job is seconds long and has its own box, so it runs alongside the test jobs, which run one at a time.
      const done = (result) => (record.jobs.push(result), writeFile(path.join(base, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`)); // progress, for a reader
      const beside = Promise.all(jobs.filter((j) => j.network).map((job) => runJob(job, { wt, dir, sha, signal: both.signal }).then(done)));
      beside.catch(() => {}); // a throw is read when it is awaited below; an early return must not leave it unhandled
      for (const job of jobs.filter((j) => !j.network)) {
        if (late.signal.aborted) return await pastDeadline();
        if (signal?.aborted) return await finish("error", "stopped");
        await done(await runJob(job, { wt, dir, sha, signal: both.signal }));
      }
      await beside;
      record.jobs.sort((a, b) => jobs.findIndex((j) => j.name === a.name) - jobs.findIndex((j) => j.name === b.name)); // ci.yml's order
      if (late.signal.aborted) return await pastDeadline();
      record.flaky = await earlierFlakes(sha, record.jobs);
      const state = runState(record.jobs);
      const red = record.jobs.filter((j) => j.state !== "green" && j.state !== "flaky").map((j) => `${j.name}: ${j.reason}`);
      return await finish(state, red.join("; ") || null);
    } catch (err) {
      if (err instanceof EnforcementError) return await finish("error", `the resource group refused the checks: ${err.reason ?? err.message}`);
      return await finish("error", `the checks could not run: ${String(err?.message ?? err).slice(0, 300)}`);
    } finally {
      clearTimeout(deadline);
      await git("worktree", "remove", "--force", wtDir).catch(() => rm(wtDir, { recursive: true, force: true }));
    }
  }

  let queue = Promise.resolve(); // one run at a time: they are outside the worker slots, so they never stack up
  /** Runs the checks of one commit, after any run before it. A second call for a commit that is queued or running gets the same run. */
  function run({ sha, why, signal } = {}) {
    if (typeof sha !== "string" || !SHA_RE.test(sha)) return Promise.reject(new TypeError("checks: sha must be a full commit id"));
    if (active.has(sha)) return active.get(sha);
    const p = queue.then(() => execute({ sha, why, signal })).finally(() => active.delete(sha));
    queue = p.catch(() => {});
    active.set(sha, p);
    return p;
  }

  async function latest(sha) {
    if (typeof sha !== "string" || !SHA_RE.test(sha)) return null;
    return (await records(sha)).at(-1) ?? null;
  }

  /** The newest record of each of the most recently run commits. */
  async function recent(n = 10) {
    const shas = (await readdir(recordDir).catch(() => [])).filter((s) => SHA_RE.test(s));
    const last = (await Promise.all(shas.map((s) => latest(s)))).filter(Boolean);
    return last.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, n);
  }

  return { run, latest, recent, running: () => [...active.keys()] };
}
