// ci-cd/15: the CPU a test run may take. Criterion map (the ticket's Done-when):
//   budget has one source and a script that bypasses it fails -> "the budget has one source", "no script starts node --test outside test-budget"
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
import { BUDGET, limiterFor, nodeTestArgs } from "./test-budget.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envWithoutCI = () => {
  const env = { ...process.env };
  delete env.CI;
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
const SKIP_SCOPE = canScope && !process.env.CI ? false : "no systemd user manager (or CI): the slice cannot be exercised here";

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
  assert.deepEqual(BUDGET, raw);
  assert.ok(Number.isInteger(raw.cpuPercent) && raw.cpuPercent >= 100 && raw.cpuPercent <= 800, "cpuPercent is whole percent of one core, within this 8-core box");
  assert.match(raw.slice, /^den-[a-z]+\.slice$/);
  assert.ok(Number.isInteger(raw.niceness) && raw.niceness > 0 && raw.niceness <= 19);
});

test("no script starts node --test outside test-budget", () => {
  const exempt = new Map([
    ["scripts/test-guard.mjs", "runs inside the bridge's own checks resource group and box"],
    ["apps/bridge/delivery/checks.mjs", "the den's checks run in the den-checks resource group (limits.json: 400%)"],
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
    if (!rel.endsWith(".mjs") || rel.endsWith(".test.mjs") || rel === "scripts/test-budget.mjs" || exempt.has(rel)) continue;
    if (/["']--test(-concurrency[^"']*)?["']/.test(text) && !/test-budget\.mjs/.test(text)) bypass.push(rel);
  }
  assert.deepEqual(bypass, [], "these start node --test without the shared budget; route them through scripts/test-budget.mjs");
});

test("package.json runs the suites only through the capped scripts", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const name of ["test", "test:rest", "test:browser", "test:path"]) {
    assert.match(pkg.scripts[name], /scripts\/test-(lock|split|path)\.mjs/, name);
  }
});

test("limiterFor: CI is unlimited, a den cgroup keeps nice, a working systemd gets the slice", () => {
  const ok = () => ({ status: 0 });
  const refuse = () => ({ status: 1 });
  assert.equal(limiterFor({ env: { CI: "true" }, cgroup: "0::/", run: ok }), "none");
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

test("test:path runs niced inside the tests slice", { skip: process.env.CI ? "CI runs unlimited" : false }, async () => {
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
