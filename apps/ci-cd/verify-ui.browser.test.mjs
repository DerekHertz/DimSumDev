// trust-ladder/02: `npm run verify:ui` drives the real browser through a named flow and returns evidence.
// Public interface under test:
//   node apps/ci-cd/verify-ui.mjs --flow <flow.json> [--out <dir>] [--timeout <ms>] [--json]
//   exit 0 = no findings, 1 = findings (or a timeout), 2 = bad arguments or no browser.
//   <out>/report.json: { ok, runId, url, steps, screenshots[{name,path}], consoleErrors[], pageErrors[],
//     networkFailures[], perf{loadMs,tracePath,...}, findings[{kind,message,step,reproduce[]}] }
// Needs Playwright plus an installed browser; runs through `npm run test:path`, which caps browser files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const FIXTURES = "apps/ci-cd/fixtures/verifier";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function runCli(args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["apps/ci-cd/verify-ui.mjs", ...args], { cwd: REPO_ROOT, detached: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      reject(new Error(`verify-ui did not exit within ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.once("error", reject);
  });
}

async function withOut(fn) {
  const out = await mkdtemp(path.join(tmpdir(), "verify-ui-test-"));
  try {
    return await fn(out);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

const readReport = async (out) => JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));

// An independent scan of /proc (not the verifier's own), so a sweep bug cannot hide an orphan.
async function processesWith(needle) {
  const found = [];
  for (const pid of (await readdir("/proc")).filter((n) => /^\d+$/.test(n))) {
    try {
      if ((await readFile(`/proc/${pid}/cmdline`, "utf8")).includes(needle)) found.push(Number(pid));
    } catch {
      // the process exited between readdir and read
    }
  }
  return found;
}

function accepts(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 1000 });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(false));
  });
}

test("a flow against the good fixture returns screenshots, console errors, network failures and a perf trace", async () => {
  await withOut(async (out) => {
    const { code, stdout, stderr } = await runCli(["--flow", `${FIXTURES}/good.flow.json`, "--out", out], { timeoutMs: 60000 });
    assert.equal(code, 0, `stdout: ${stdout}\nstderr: ${stderr}`);
    const report = await readReport(out);
    assert.equal(report.ok, true);
    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.networkFailures, []);
    assert.deepEqual(report.screenshots.map((s) => s.name), ["loaded", "after-add"]);
    for (const shot of report.screenshots) {
      const bytes = await readFile(shot.path);
      assert.ok(bytes.subarray(0, 8).equals(PNG_MAGIC) && bytes.length > 1000, `${shot.name} is a real PNG`);
    }
    assert.ok(report.perf.loadMs > 0, "page load time is measured");
    const trace = JSON.parse(await readFile(report.perf.tracePath, "utf8"));
    assert.ok(Array.isArray(trace.traceEvents) && trace.traceEvents.length > 0, "the perf trace holds events");
  });
});

test("a run with --json prints the same report on stdout", async () => {
  await withOut(async (out) => {
    const { code, stdout } = await runCli(["--flow", `${FIXTURES}/good.flow.json`, "--out", out, "--json"], { timeoutMs: 60000 });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), await readReport(out));
  });
});

test("the broken fixture produces findings with steps to reproduce: a thrown error, a failed request and a 404", async () => {
  await withOut(async (out) => {
    const { code, stdout, stderr } = await runCli(["--flow", `${FIXTURES}/broken.flow.json`, "--out", out], { timeoutMs: 60000 });
    assert.equal(code, 1, `stdout: ${stdout}\nstderr: ${stderr}`);
    const { ok, findings } = await readReport(out);
    assert.equal(ok, false);

    const thrown = findings.find((f) => f.kind === "page-error");
    assert.match(thrown?.message ?? "", /boom from fixture/);
    assert.deepEqual(thrown.reproduce, ["1. open apps/ci-cd/fixtures/verifier/broken.html", "2. click #boom"]);

    const failed = findings.find((f) => f.kind === "request-failed");
    assert.match(failed?.message ?? "", /127\.0\.0\.1:9/);
    assert.deepEqual(failed.reproduce, ["1. open apps/ci-cd/fixtures/verifier/broken.html", "2. click #boom", "3. click #load"]);

    const missing = findings.find((f) => f.kind === "http-error");
    assert.match(missing?.message ?? "", /missing\.json.*404/);
    assert.equal(missing.reproduce.at(-1), "3. click #load");
    assert.match(stdout, /page-error/, "the summary on stdout names the finding kinds");
  });
});

test("a flow that hangs is stopped by --timeout and leaves no browser or dev server behind", async () => {
  await withOut(async (out) => {
    const { code, stdout, stderr } = await runCli(["--flow", `${FIXTURES}/hang.flow.json`, "--out", out, "--timeout", "4000"], { timeoutMs: 40000 });
    assert.equal(code, 1, `stdout: ${stdout}\nstderr: ${stderr}`);
    const report = await readReport(out);
    assert.ok(report.findings.some((f) => f.kind === "timeout"), "the timeout is a finding");
    assert.match(report.runId, /^run-/);
    assert.deepEqual(await processesWith(report.runId), [], "no process still carries the run's browser marker");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await accepts(Number(new URL(report.url).port)), false, "the dev server port is closed");
  });
});

test("a missing flow file exits 2 and says so", async () => {
  const { code, stderr } = await runCli(["--flow", `${FIXTURES}/nope.flow.json`], { timeoutMs: 20000 });
  assert.equal(code, 2);
  assert.match(stderr, /nope\.flow\.json/);
});

test("the den target builds the UI, serves a fixture board and returns evidence from the real app", async () => {
  await withOut(async (out) => {
    const { code, stdout, stderr } = await runCli(["--den", "--flow", `${FIXTURES}/den.flow.json`, "--out", out], { timeoutMs: 170000 });
    assert.equal(code, 0, `stdout: ${stdout}\nstderr: ${stderr}`);
    const report = await readReport(out);
    assert.deepEqual(report.findings, []);
    assert.ok(report.screenshots.length >= 1);
    assert.deepEqual((await readdir(out)).filter((f) => f.endsWith(".png")).length >= 1, true);
    assert.ok((await stat(report.perf.tracePath)).size > 0);
  });
});
