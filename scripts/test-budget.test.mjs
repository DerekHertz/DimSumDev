// ci-cd/15: the CPU a test run may take. Criterion map (the ticket's Done-when):
//   budget has one source and a script that bypasses it fails -> "the budget has one source", "no script starts node --test outside test-budget", "the bypass scan catches ..."
//   a run cannot raise the cap                                 -> "a worktree's own budget copy cannot move the shared quota", "the budget comes from the main checkout", "limiterFor" (CI=1 stays capped)
//   no systemd: nice and a lowered concurrency, end to end     -> "without a systemd user manager ..."
//   the quota is in effect after set-property                  -> "the slice's quota is in effect ..."
//   two runs together stay under the budget                    -> "two runs started together stay under the budget"
//   test:path honours the cap                                  -> "test:path runs niced inside the tests slice"
//   no orphan process on timeout                               -> "a SIGTERM to the run stops the test files and what they started"
//   the limiter picks the right mechanism                      -> "limiterFor" and "nodeTestArgs" tests
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUDGET, limiterFor, loadBudget, nodeTestArgs } from "./test-budget.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envWithoutCI = () => {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  delete env.NODE_TEST_CONTEXT;
  return env;
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};
const canScope = spawnSync("systemd-run", ["--user", "--scope", "--quiet", "true"], { stdio: "ignore" }).status === 0;
const SKIP_SCOPE = canScope && process.env.GITHUB_ACTIONS !== "true" ? false : "no systemd user manager (or GitHub Actions): the slice cannot be exercised here";

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Run a test:path stub run from a fresh scope, so it does not sit inside the slice that `npm test` may hold.
function stubRun(dir, { escape = canScope } = {}) {
  const argv = [process.execPath, path.join(ROOT, "scripts/test-path.mjs"), dir];
  const [cmd, ...args] = escape ? ["systemd-run", "--user", "--scope", "--quiet", ...argv] : argv;
  return spawn(cmd, args, { cwd: ROOT, env: envWithoutCI(), stdio: ["ignore", "pipe", "pipe"] });
}
const finished = (child) => new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));

test("the budget has one source: scripts/test-budget.json, read by test-budget.mjs", () => {
  const raw = JSON.parse(readFileSync(path.join(ROOT, "scripts/test-budget.json"), "utf8"));
  assert.ok(Number.isInteger(raw.cpuPercent) && raw.cpuPercent >= 100 && raw.cpuPercent <= 800, "cpuPercent is whole percent of one core, within this 8-core box");
  assert.match(raw.slice, /^den-[a-z]+\.slice$/);
  assert.ok(Number.isInteger(raw.niceness) && raw.niceness > 0 && raw.niceness <= 19);
});

const EXEC_CALL = /\b(?:exec|spawn)\w*\s*\(/;
function startsNodeTest(rel, text) {
  const code = text.split("\n").filter((line) => !/^\s*(\/\/|#(?!!)|\*)/.test(line)).join("\n");
  if (rel.endsWith(".sh")) return /(^|\s)--test\b/m.test(code);
  if (/test-budget\.mjs/.test(code)) return false;
  return /["'`]--test(-concurrency[^"'`]*)?["'`]/.test(code) || (EXEC_CALL.test(code) && /(^|[\s"'`}])--test\b/m.test(code));
}

test("the bypass scan catches array, execSync-string, template and shell forms, and lets budgeted or comment-only files through", () => {
  const caught = {
    "a.mjs": 'spawnSync(process.execPath, ["--test", "x.test.mjs"])',
    "b.mjs": 'import { execSync } from "node:child_process";\nexecSync("node --test x.test.mjs");',
    "c.mjs": "execSync(`${process.execPath} --test x.test.mjs`)",
    "d.sh": "#!/bin/sh\nnode --test x.test.mjs\n",
    "e.sh": "cd apps && node --test-concurrency=2 y.test.mjs",
  };
  const passed = {
    "f.mjs": 'import { runNodeTests } from "./test-budget.mjs";\nexecSync("node --test x");',
    "g.mjs": "// run node --test by hand\nconst a = 1;",
    "h.sh": "#!/bin/sh\n# node --test is capped by npm run test:path\necho hi",
    "i.mjs": 'const hint = "Run node --test with --test-concurrency=2";',
  };
  for (const [rel, text] of Object.entries(caught)) assert.equal(startsNodeTest(rel, text), true, rel);
  for (const [rel, text] of Object.entries(passed)) assert.equal(startsNodeTest(rel, text), false, rel);
});

test("no script starts node --test outside test-budget", () => {
  const exempt = new Map([
    ["scripts/test-guard.mjs", "runs inside the bridge's own checks resource group and box"],
    ["apps/bridge/delivery/checks.mjs", "the den's checks run in the den-checks resource group (limits.json: 400%)"],
    ["apps/bridge/delivery/prompts.mjs", "prompt text telling a worker how to run a test; it starts nothing"],
  ]);
  const bypass = [];
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    if (rel.startsWith("mods/") || rel.startsWith("docs/")) continue;
    const text = readFileSync(file, "utf8");
    if (path.basename(file) === "package.json") {
      for (const [name, cmd] of Object.entries(JSON.parse(text).scripts ?? {})) {
        if (/--test\b/.test(cmd)) bypass.push(`${rel} script "${name}": ${cmd}`);
      }
      continue;
    }
    const scanned = (rel.endsWith(".mjs") && !rel.endsWith(".test.mjs")) || rel.endsWith(".sh");
    if (scanned && rel !== "scripts/test-budget.mjs" && !exempt.has(rel) && startsNodeTest(rel, text)) bypass.push(rel);
  }
  assert.deepEqual(bypass, [], "these start node --test without the shared budget; route them through scripts/test-budget.mjs");
});

test("package.json runs the suites only through the capped scripts", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const name of ["test", "test:rest", "test:browser", "test:path"]) {
    assert.match(pkg.scripts[name], /scripts\/test-(lock|split|path)\.mjs/, name);
  }
});

test("limiterFor: only GitHub Actions is unlimited, a den cgroup keeps nice, a working systemd gets the slice", () => {
  const ok = () => ({ status: 0 });
  const refuse = () => ({ status: 1 });
  assert.equal(limiterFor({ env: { GITHUB_ACTIONS: "true" }, cgroup: "0::/", run: ok }), "none");
  assert.equal(limiterFor({ env: { CI: "1" }, cgroup: "0::/user.slice/app.slice/x.scope", run: ok }), "slice", "CI=1 in a run's env does not lift the cap");
  assert.equal(limiterFor({ env: { CI: "true", GITHUB_ACTIONS: "false" }, cgroup: "0::/user.slice/app.slice/x.scope", run: refuse }), "nice");
  assert.equal(limiterFor({ env: {}, cgroup: "0::/user.slice/user@1000.service/den.slice/den-agents.slice/x.scope", run: ok }), "nice");
  assert.equal(limiterFor({ env: {}, cgroup: `0::/user.slice/user@1000.service/den.slice/${BUDGET.slice}/x.scope`, run: ok }), "nice");
  assert.equal(limiterFor({ env: {}, cgroup: "0::/user.slice/app.slice/x.scope", run: ok }), "slice");
  assert.equal(limiterFor({ env: {}, cgroup: "0::/user.slice/app.slice/x.scope", run: refuse }), "nice");
  const calls = [];
  limiterFor({ env: {}, cgroup: "0::/app.slice", run: (cmd, args) => (calls.push([cmd, ...args]), ok()) });
  assert.deepEqual(calls[0].slice(0, 4), ["systemctl", "--user", "set-property", "--runtime"]);
  assert.ok(calls[0].includes(BUDGET.slice) && calls[0].includes(`CPUQuota=${BUDGET.cpuPercent}%`), "the slice gets the configured quota");
});

test("nodeTestArgs: every limited run is capped by the budget, an env value only lowers it", () => {
  const cores = BUDGET.cpuPercent / 100;
  assert.deepEqual(nodeTestArgs("rest", {}, "slice"), [`--test-concurrency=${cores}`]);
  assert.deepEqual(nodeTestArgs("browser", {}, "slice"), [`--test-concurrency=${Math.min(3, cores)}`]);
  assert.deepEqual(nodeTestArgs("browser", { BROWSER_FILE_CONCURRENCY: "1" }, "slice"), ["--test-concurrency=1"]);
  assert.deepEqual(nodeTestArgs("browser", { BROWSER_FILE_CONCURRENCY: "99" }, "slice"), [`--test-concurrency=${cores}`], "an env value cannot raise the cap");
  assert.deepEqual(nodeTestArgs("browser", { BROWSER_FILE_CONCURRENCY: "abc" }, "slice"), [`--test-concurrency=${Math.min(3, cores)}`]);
  const shared = Math.floor(cores / 2);
  assert.deepEqual(nodeTestArgs("rest", {}, "nice"), [`--test-concurrency=${shared}`], "without a shared slice each run takes half, so two together fit");
  assert.deepEqual(nodeTestArgs("rest", {}, "none"), [], "CI keeps node's default");
  assert.deepEqual(nodeTestArgs("browser", {}, "none"), ["--test-concurrency=3"], "CI keeps the browser cap from ci-cd/08");
});

function stubDir(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "budget-"));
  const out = path.join(dir, "out");
  mkdirSync(out);
  files.forEach((body, i) => writeFileSync(path.join(dir, `stub${i}.test.mjs`), `import { test } from "node:test";\nconst OUT = ${JSON.stringify(out)};\n${body}\n`));
  return { dir, out, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("test:path runs niced inside the tests slice", { skip: process.env.GITHUB_ACTIONS === "true" ? "GitHub Actions runs unlimited" : false }, async () => {
  const stub = stubDir([
    `import os from "node:os"; import { readFileSync, writeFileSync } from "node:fs";
test("report", () => writeFileSync(OUT + "/report.json", JSON.stringify({ nice: os.getPriority(), cgroup: readFileSync("/proc/self/cgroup", "utf8") })));`,
  ]);
  try {
    const run = stubRun(stub.dir);
    const { code } = await finished(run);
    assert.equal(code, 0);
    const report = JSON.parse(readFileSync(path.join(stub.out, "report.json"), "utf8"));
    assert.ok(report.nice >= BUDGET.niceness, `niceness ${report.nice} should be at least ${BUDGET.niceness}`);
    if (!SKIP_SCOPE) assert.ok(report.cgroup.includes(BUDGET.slice), `the test file should run in ${BUDGET.slice}, got ${report.cgroup}`);
  } finally {
    stub.cleanup();
  }
});

test("two runs started together stay under the budget", { skip: SKIP_SCOPE, timeout: 120000 }, async () => {
  const burn = `import { appendFileSync } from "node:fs";
const start = Date.now();
test("burn", () => {
  while ((process.cpuUsage().user + process.cpuUsage().system) / 1000 < 1500) { /* spin */ }
  const u = process.cpuUsage();
  appendFileSync(OUT + "/" + process.pid + ".json", JSON.stringify({ start, end: Date.now(), cpuMs: (u.user + u.system) / 1000 }));
});`;
  const a = stubDir(Array(4).fill(burn));
  const b = stubDir(Array(4).fill(burn));
  try {
    const runs = [stubRun(a.dir), stubRun(b.dir)];
    const results = await Promise.all(runs.map(finished));
    assert.deepEqual(results.map((r) => r.code), [0, 0]);
    const rows = [a.out, b.out].flatMap((o) => readdirSync(o).map((f) => JSON.parse(readFileSync(path.join(o, f), "utf8"))));
    assert.equal(rows.length, 8);
    const cpu = rows.reduce((s, r) => s + r.cpuMs, 0) / 1000;
    const wall = (Math.max(...rows.map((r) => r.end)) - Math.min(...rows.map((r) => r.start))) / 1000;
    const cores = cpu / wall;
    assert.ok(cores <= (BUDGET.cpuPercent / 100) * 1.15, `two runs used ${cores.toFixed(2)} cores together (${cpu.toFixed(1)} CPU s in ${wall.toFixed(1)} s); the budget is ${BUDGET.cpuPercent / 100}`);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("a SIGTERM to the run stops the test files and what they started", { timeout: 60000 }, async () => {
  const stub = stubDir([
    `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
test("hang", async () => {
  const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(OUT + "/pids.json", JSON.stringify([process.pid, kid.pid]));
  await new Promise(() => setInterval(() => {}, 1000));
});`,
  ]);
  let pids = [];
  try {
    const run = stubRun(stub.dir, { escape: false });
    const done = finished(run);
    for (let i = 0; i < 100 && pids.length === 0; i++) {
      await sleep(100);
      try {
        pids = JSON.parse(readFileSync(path.join(stub.out, "pids.json"), "utf8"));
      } catch {}
    }
    assert.equal(pids.length, 2, "the stub should have started");
    run.kill("SIGTERM");
    const { code } = await done;
    assert.equal(code, 143, "the run reports the signal like a shell would");
    for (let i = 0; i < 80 && pids.some(alive); i++) await sleep(100);
    assert.deepEqual(pids.filter(alive), [], "no test file or child of one may outlive the run");
  } finally {
    for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    stub.cleanup();
  }
});

test("the budget comes from the main checkout: DEN_ROOT first, then the first worktree git lists, then this copy", () => {
  const main = mkdtempSync(path.join(tmpdir(), "budget main "));
  const local = mkdtempSync(path.join(tmpdir(), "budget local "));
  try {
    mkdirSync(path.join(main, "scripts"));
    writeFileSync(path.join(main, "scripts/test-budget.json"), JSON.stringify({ cpuPercent: 300, slice: "den-tests.slice", niceness: 10 }));
    writeFileSync(path.join(local, "test-budget.json"), JSON.stringify({ cpuPercent: 800, slice: "den-tests.slice", niceness: 10 }));
    const localUrl = new URL(`file://${path.join(local, "test-budget.json")}`);
    const listing = { stdout: `worktree ${main}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${local}\nHEAD def\n`, status: 0 };
    assert.equal(loadBudget({ env: { DEN_ROOT: main }, local: localUrl, git: () => ({ stdout: "", status: 1 }) }).cpuPercent, 300, "DEN_ROOT");
    assert.equal(loadBudget({ env: {}, local: localUrl, git: () => listing }).cpuPercent, 300, "first path git worktree list prints, spaces included");
    assert.equal(loadBudget({ env: { DEN_ROOT: path.join(main, "missing") }, local: localUrl, git: () => ({ stdout: "", status: 128 }) }).cpuPercent, 800, "no main checkout copy: this copy");
  } finally {
    rmSync(main, { recursive: true, force: true });
    rmSync(local, { recursive: true, force: true });
  }
});

function shimDir(shims) {
  const dir = mkdtempSync(path.join(tmpdir(), "budget shims "));
  const log = path.join(dir, "calls.log");
  for (const [name, body] of Object.entries(shims)) writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  const calls = () => {
    try {
      return readFileSync(log, "utf8");
    } catch {
      return "";
    }
  };
  return { dir, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a worktree's own budget copy cannot move the shared quota", { skip: process.platform === "win32" }, () => {
  const main = mkdtempSync(path.join(tmpdir(), "budget main "));
  const wt = mkdtempSync(path.join(tmpdir(), "budget wt "));
  const shim = shimDir({ systemctl: "exit 0" });
  try {
    mkdirSync(path.join(main, "scripts"));
    mkdirSync(path.join(wt, "scripts"));
    const real = JSON.parse(readFileSync(path.join(ROOT, "scripts/test-budget.json"), "utf8"));
    writeFileSync(path.join(main, "scripts/test-budget.json"), JSON.stringify({ ...real, cpuPercent: 300 }));
    writeFileSync(path.join(wt, "scripts/test-budget.json"), JSON.stringify({ ...real, cpuPercent: 800 }));
    writeFileSync(path.join(wt, "scripts/test-budget.mjs"), readFileSync(path.join(ROOT, "scripts/test-budget.mjs")));
    const probe = `import { limiterFor, BUDGET } from ${JSON.stringify(path.join(wt, "scripts/test-budget.mjs"))};
console.log(limiterFor({ cgroup: "0::/user.slice/app.slice/x.scope" }), BUDGET.cpuPercent);`;
    const env = { ...process.env, DEN_ROOT: main, PATH: `${shim.dir}${path.delimiter}${process.env.PATH}`, CI: "1" };
    delete env.GITHUB_ACTIONS;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "slice 300");
    assert.match(shim.calls(), /set-property --runtime den-tests\.slice CPUQuota=300%/, "the slice got the main checkout's number, not the worktree copy's 800");
    assert.doesNotMatch(shim.calls(), /CPUQuota=800%/);
  } finally {
    shim.cleanup();
    rmSync(main, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

test("without a systemd user manager the run is niced, takes half the concurrency and never calls systemd-run", { skip: process.platform === "win32", timeout: 60000 }, async () => {
  const shim = shimDir({ systemctl: "exit 1", "systemd-run": "exit 1" });
  const hold = `import os from "node:os"; import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
test("overlap", async () => {
  mkdirSync(OUT + "/live", { recursive: true });
  writeFileSync(OUT + "/live/" + process.pid, "");
  appendFileSync(OUT + "/seen", readdirSync(OUT + "/live").length + " " + os.getPriority() + "\\n");
  await new Promise((r) => setTimeout(r, 900));
  rmSync(OUT + "/live/" + process.pid);
});`;
  const stub = stubDir(Array(6).fill(hold));
  try {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts/test-path.mjs"), stub.dir], {
      cwd: ROOT,
      env: { ...envWithoutCI(), PATH: `${shim.dir}${path.delimiter}${process.env.PATH}`, DEN_ROOT: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { code } = await finished(child);
    assert.equal(code, 0);
    const seen = readFileSync(path.join(stub.out, "seen"), "utf8").trim().split("\n").map((l) => l.split(" ").map(Number));
    assert.equal(seen.length, 6);
    assert.equal(Math.max(...seen.map(([n]) => n)), Math.floor(BUDGET.cpuPercent / 200), "files run at half the budget's cores, so two runs together fit");
    assert.ok(seen.every(([, nice]) => nice >= BUDGET.niceness), "every test file is niced");
    assert.doesNotMatch(shim.calls(), /systemd-run/, "no scope is opened");
  } finally {
    shim.cleanup();
    stub.cleanup();
  }
});

test("the slice's quota is in effect after a run sets it", { skip: SKIP_SCOPE, timeout: 60000 }, async () => {
  const stub = stubDir([`test("noop", () => {});`]);
  try {
    const { code } = await finished(stubRun(stub.dir));
    assert.equal(code, 0);
    const shown = spawnSync("systemctl", ["--user", "show", "-p", "CPUQuotaPerSecUSec", "--value", BUDGET.slice], { encoding: "utf8" });
    assert.equal(shown.stdout.trim(), `${BUDGET.cpuPercent / 100}s`);
  } finally {
    stub.cleanup();
  }
});
