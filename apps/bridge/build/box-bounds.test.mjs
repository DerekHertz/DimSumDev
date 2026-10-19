// den-mvp/16 item 2 (ADR 0026 decision 2): a build that hangs is stopped and refused with code `build`; builds run one at a time.
// The launcher is faked: no bubblewrap is needed.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { VITE_BIN, createBuildBox } from "./box.mjs";
import { makeProbeFolder } from "./box-test-helpers.mjs";

// A launcher whose builds never end until the group is killed (`hang`) or until `finish()` is called.
function fakeLauncher({ hang }) {
  const state = { started: 0, running: 0, maxRunning: 0, finishers: [] };
  const launcher = {
    enforced: true,
    async launch() {
      state.started += 1;
      state.running += 1;
      state.maxRunning = Math.max(state.maxRunning, state.running);
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
      let over = false;
      const end = (code) => {
        if (over) return;
        over = true;
        state.running -= 1;
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", code);
      };
      state.finishers.push(() => end(0));
      const group = { unit: "fake.scope", kill: () => end(null), settled: async () => true };
      if (!hang) setTimeout(() => end(1), 20);
      return { child, group };
    },
  };
  return { launcher, state };
}

describe("bounds on a build", () => {
  let folder;
  let packages;
  before(async () => {
    folder = await makeProbeFolder({});
    packages = await mkdtemp(path.join(tmpdir(), "den-box-deps-"));
    await mkdir(path.join(packages, "vite/bin"), { recursive: true });
    await writeFile(path.join(packages, VITE_BIN), "");
  });
  after(() => Promise.all([rm(folder, { recursive: true, force: true }), rm(packages, { recursive: true, force: true })]));

  test("a build that does not finish is stopped after the limit and refused with code build and a reason", async () => {
    const { launcher, state } = fakeLauncher({ hang: true });
    const box = createBuildBox({ launcher, bwrap: process.execPath, timeoutMs: 80 });
    const result = await box.build({ folder, packages });
    assert.equal(result.ok, false);
    assert.equal(result.code, "build");
    assert.match(result.reason, /did not finish/);
    assert.equal(state.running, 0);
  });

  test("two builds do not run at once: the second waits for the first", async () => {
    const { launcher, state } = fakeLauncher({ hang: false });
    const box = createBuildBox({ launcher, bwrap: process.execPath });
    const other = createBuildBox({ launcher, bwrap: process.execPath }); // another box in the same process shares the turn
    const results = await Promise.all([box.build({ folder, packages }), other.build({ folder, packages }), box.build({ folder, packages })]);
    assert.equal(results.length, 3);
    assert.equal(state.started, 3);
    assert.equal(state.maxRunning, 1);
  });

  test("a build waiting for its turn that is stopped never starts", async () => {
    const { launcher, state } = fakeLauncher({ hang: true });
    const box = createBuildBox({ launcher, bwrap: process.execPath, timeoutMs: 150 });
    const ctl = new AbortController();
    const first = box.build({ folder, packages });
    const second = box.build({ folder, packages, signal: ctl.signal });
    ctl.abort();
    const [, stopped] = await Promise.all([first, second]);
    assert.equal(stopped.code, "stopped");
    assert.equal(state.started, 1);
  });
});
