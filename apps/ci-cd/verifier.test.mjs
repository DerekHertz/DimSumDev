// trust-ladder/02: the pure parts of the browser verifier (flow parsing, reproduction steps, orphan sweep, agent image).
// The browser runs live in verify-ui.browser.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeStep, findRunPids, parseFlow, reproSteps, sweepRun } from "./verifier.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

test("parseFlow accepts every step kind and returns the steps in order", () => {
  const flow = parseFlow({
    name: "all",
    steps: [
      { goto: "a.html" },
      { click: "#b" },
      { fill: { selector: "#n", value: "x" } },
      { press: "Enter" },
      { waitFor: "#r" },
      { expectText: { selector: "#r", text: "ok" } },
      { wait: 10 },
      { screenshot: "end" },
    ],
  });
  assert.equal(flow.name, "all");
  assert.equal(flow.steps.length, 8);
});

test("parseFlow rejects a missing steps list, an unknown step, a step with two actions and a bad screenshot name", () => {
  assert.throws(() => parseFlow({ name: "x" }), /steps/);
  assert.throws(() => parseFlow({ name: "x", steps: [{ hover: "#a" }] }), /unknown step.*hover/i);
  assert.throws(() => parseFlow({ name: "x", steps: [{ click: "#a", press: "Enter" }] }), /exactly one/i);
  assert.throws(() => parseFlow({ name: "x", steps: [{ screenshot: "../escape" }] }), /screenshot name/i);
});

test("describeStep words each step the way a person would be told to do it", () => {
  assert.equal(describeStep({ goto: "a.html" }), "open a.html");
  assert.equal(describeStep({ click: "#boom" }), "click #boom");
  assert.equal(describeStep({ fill: { selector: "#n", value: "den" } }), 'type "den" into #n');
  assert.equal(describeStep({ press: "Enter" }), "press Enter");
  assert.equal(describeStep({ waitFor: "#r" }), "wait for #r");
  assert.equal(describeStep({ expectText: { selector: "#r", text: "ok" } }), 'expect #r to contain "ok"');
  assert.equal(describeStep({ wait: 500 }), "wait 500 ms");
  assert.equal(describeStep({ screenshot: "end" }), 'take screenshot "end"');
});

test("reproSteps numbers the steps up to and including the one that was running", () => {
  const steps = [{ goto: "a.html" }, { click: "#b" }, { press: "Enter" }];
  assert.deepEqual(reproSteps(steps, 1), ["1. open a.html", "2. click #b"]);
  assert.deepEqual(reproSteps(steps, 0), ["1. open a.html"]);
});

async function fakeProc(entries) {
  const dir = await mkdtemp(path.join(tmpdir(), "verifier-proc-"));
  for (const [pid, argv] of Object.entries(entries)) {
    await mkdir(path.join(dir, pid));
    await writeFile(path.join(dir, pid, "cmdline"), argv.join("\0") + "\0");
  }
  await mkdir(path.join(dir, "self")); // /proc has non-numeric entries too
  return dir;
}

test("findRunPids matches only processes whose command line carries this run's marker", async () => {
  const procDir = await fakeProc({
    100: ["/usr/bin/chromium", "--verify-run=run-aaa", "--headless"],
    101: ["/usr/bin/chromium", "--verify-run=run-bbb"],
    102: ["node", "verify-ui.mjs"],
  });
  try {
    assert.deepEqual(findRunPids("run-aaa", { procDir }), [100]);
    assert.deepEqual(findRunPids("run-zzz", { procDir }), []);
  } finally {
    await rm(procDir, { recursive: true, force: true });
  }
});

test("sweepRun kills exactly the matched pids with SIGKILL and reports them", async () => {
  const procDir = await fakeProc({ 200: ["chromium", "--verify-run=run-ccc"], 201: ["chromium", "--verify-run=run-other"] });
  const killed = [];
  try {
    const swept = sweepRun("run-ccc", { procDir, kill: (pid, sig) => killed.push([pid, sig]) });
    assert.deepEqual(swept, [200]);
    assert.deepEqual(killed, [[200, "SIGKILL"]]);
  } finally {
    await rm(procDir, { recursive: true, force: true });
  }
});

test("the agent image installs Chromium and points PW_CHROMIUM_PATH at it, so a container run needs no host browser", async () => {
  const dockerfile = await readFile(path.join(REPO_ROOT, "apps/bridge/agents/image/Dockerfile"), "utf8");
  const code = dockerfile.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.match(code, /apt-get install[^\n]*\bchromium\b/);
  assert.match(code, /^ENV PW_CHROMIUM_PATH=\/usr\/bin\/chromium$/m);
});

test("package.json exposes the verifier as npm run verify:ui", async () => {
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["verify:ui"], "node apps/ci-cd/verify-ui.mjs");
});
