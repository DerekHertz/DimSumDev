// organism-infra/143 (ADR 0016 decision 2, process lifetime; amendment 6): with the REAL Claude runtime, the bridge
// leaves neither the child nor the child's child alive when it is signalled, exits, or crashes. The stub ignores stdin
// EOF and SIGTERM and so does its grandchild, so only SIGKILL to the whole process group ends them: the synchronous
// 'exit' handler must group-kill, not just kill the leader.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeStateFixture } from "../bridge-fixture.mjs";
import { until, sleep } from "./host-test-helpers.mjs";
import { makeStub, alive } from "./claude-stub.mjs";

const PROBE = fileURLToPath(new URL("./claude-runtime-shutdown-probe.mjs", import.meta.url));

async function run(mode, act) {
  const fx = await makeStateFixture({ empty: true, git: true });
  const stub = await makeStub({ mode: "hang", grandchild: "ignoreTerm", ignoreTerm: true });
  const probe = spawn(process.execPath, [PROBE, fx.root, stub.bin, stub.dir, mode], { stdio: ["ignore", "pipe", "pipe"] });
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
    pids = [msg.pid, msg.grandchild];
    assert.ok(pids.every((p) => Number.isInteger(p) && alive(p)), `the child and grandchild run before the shutdown: ${pids}`);
    await act(probe);
    const result = await Promise.race([exited, sleep(8000).then(() => "hung")]);
    assert.notEqual(result, "hung", `the bridge did not exit (stderr: ${err.slice(0, 300)})`);
    await until(() => pids.every((p) => !alive(p)), { ms: 3000, what: `child and grandchild ${pids} to be gone` });
    return { result, err };
  } finally {
    for (const p of pids) if (Number.isInteger(p) && alive(p)) process.kill(p, "SIGKILL");
    if (probe.exitCode === null) probe.kill("SIGKILL");
    await fx.cleanup();
  }
}

describe("the Claude runtime's whole process group dies with the bridge", () => {
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    test(`${sig} to the bridge: child and grandchild are killed and the bridge exits`, { timeout: 25000 }, async () => {
      await run("hold", (probe) => probe.kill(sig));
    });
  }

  test("an uncaught exception: child and grandchild are killed and the bridge exits non-zero", { timeout: 25000 }, async () => {
    const { result, err } = await run("throw", () => {});
    assert.notEqual(result.code, 0);
    assert.match(err, /probe boom/);
  });

  test("process.exit() while the child is alive: the exit handler group-SIGKILLs it synchronously", { timeout: 25000 }, async () => {
    await run("exit", () => {});
  });
});
