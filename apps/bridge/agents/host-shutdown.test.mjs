// organism-infra/140 (criterion 4): the bridge ends every child it started when it is signalled, exits, or crashes.
// ADR 0016 decision 2, process lifetime: a handler on SIGINT, SIGTERM, SIGHUP and uncaughtException runs the kill
// sequence (stdin close, grace, SIGTERM, grace, SIGKILL); the 'exit' event sends SIGKILL synchronously.
//
// These tests run host-shutdown-probe.mjs as a separate node process whose runtime wraps real OS children that
// ignore SIGTERM and stdin close, so only the escalation to SIGKILL can end them. The signal handlers belong to
// startBridge (the probe installs nothing itself) and close() removes them.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeStateFixture } from "../bridge-fixture.mjs";
import { until, sleep } from "./host-test-helpers.mjs";

const PROBE = fileURLToPath(new URL("./host-shutdown-probe.mjs", import.meta.url));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

// Start the probe, wait for its ready line, run `act(probe, pids)`, wait for it to exit, then check the children.
async function run(mode, act) {
  const fx = await makeStateFixture({ empty: true, git: true });
  const probe = spawn(process.execPath, [PROBE, fx.root, mode], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  probe.stdout.on("data", (c) => (out += c));
  probe.stderr.on("data", (c) => (err += c));
  const exited = new Promise((resolve) => probe.once("exit", (code, signal) => resolve({ code, signal })));
  let pids = [];
  try {
    await until(() => out.includes("\n") || probe.exitCode !== null, { ms: 8000, what: "the probe's ready line" });
    assert.ok(out.includes("\n"), `the probe exited before it was ready (code ${probe.exitCode}): ${err.slice(0, 400)}`);
    const msg = JSON.parse(out.split("\n")[0]);
    assert.ok(msg.ready, `probe said: ${out}`);
    pids = msg.pids;
    assert.equal(pids.length, 2);
    assert.ok(pids.every(alive), "both children are running before the shutdown");
    await act(probe);
    const result = await Promise.race([exited, sleep(8000).then(() => "hung")]);
    assert.notEqual(result, "hung", `the bridge did not exit (stderr: ${err.slice(0, 300)})`);
    await until(() => pids.every((p) => !alive(p)), { ms: 3000, what: `children ${pids} to be gone` });
    return { result, err };
  } finally {
    for (const p of pids) if (alive(p)) process.kill(p, "SIGKILL");
    if (probe.exitCode === null) probe.kill("SIGKILL");
    await fx.cleanup();
  }
}

describe("shutdown stops every child, even ones that ignore SIGTERM", () => {
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    test(`${sig} to the bridge: both children are killed and the bridge exits`, { timeout: 25000 }, async () => {
      await run("hold", (probe) => probe.kill(sig));
    });
  }

  test("an uncaught exception: both children are killed and the bridge still exits non-zero", { timeout: 25000 }, async () => {
    const { result, err } = await run("throw", () => {});
    assert.notEqual(result.code, 0, "a crash must not be turned into a clean exit");
    assert.match(err, /probe boom/, "the handler reports the error on stderr instead of swallowing it");
  });

  test("process.exit() while children are alive: the exit handler SIGKILLs them synchronously", { timeout: 25000 }, async () => {
    await run("exit", () => {});
  });
});
