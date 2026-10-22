import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, mkdir, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync } from "node:fs";
import * as canary from "./codex-permissions-canary.mjs";
const { offlineCanaryPlan, resolveCanaryExecutables, CANARY_SLICE } = canary;
const runOfflineCanary = options => {
  assert.equal(typeof canary.runControlledOfflineCanary, "function", "trusted launcher injection is missing; never fall through to native launch");
  return canary.runControlledOfflineCanary(options);
};

function fakeLauncher(onLaunch, settle = async () => true) {
  const calls = [];
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  const group = { unit: "owned-fake.scope", kill() { calls.push("kill"); child.stdout.end(); child.stderr.end(); child.emit("close"); }, async settled(ms) { calls.push(["settled", ms]); return settle(); } };
  return { calls, child, enforced: true, async preflight() { return { ok: true }; }, async launch(input) { calls.push(input); setImmediate(() => onLaunch(child)); return { child, group }; } };
}

test("trusted offline injection captures bounded raw failure output and positively settles only its group", async () => {
  await withExecutableFixture(async ({ paths }) => {
    const observations = [];
    const launcher = fakeLauncher(child => { child.stdout.write("fixture stdout failure"); child.stderr.write("fixture stderr failure"); child.exitCode = 1; child.emit("exit", 1, null); });
    const result = await runOfflineCanary({ ...paths, launcher, observe: event => observations.push(event) });
    assert.equal(result.ok, false);
    assert.equal(result.settled, true);
    assert.equal(result.rawOutput.stdout, "fixture stdout failure");
    assert.equal(result.rawOutput.stderr, "fixture stderr failure");
    assert.equal(result.rawOutput.stdoutBytes, 22);
    assert.deepEqual(launcher.calls.slice(1), ["kill", ["settled", 3000]]);
    assert.equal(observations[0].unit, "owned-fake.scope");
    assert.equal(observations.at(-1).settled, true);
    assert.equal(existsSync(launcher.calls[0].cwd), false);
  });
});

for (const cause of ["abort", "timeout"]) test(`offline ${cause} waits for positive exact-group cleanup before returning`, async () => {
  await withExecutableFixture(async ({ paths }) => {
    const controller = new AbortController();
    let acknowledge;
    const settled = new Promise(resolve => { acknowledge = resolve; });
    const launcher = fakeLauncher(() => { if (cause === "abort") controller.abort(); }, () => settled);
    let returned = false;
    const pending = runOfflineCanary({ ...paths, launcher, signal: controller.signal, timeoutMs: 20 }).then(result => { returned = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(returned, false);
    assert.ok(launcher.calls.includes("kill"));
    acknowledge(true);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.settled, true);
    assert.equal(result.status[cause === "abort" ? "aborted" : "timeout"], true);
    assert.equal(existsSync(launcher.calls[0].cwd), false);
  });
});

test("offline cancellation before entry starts no launcher", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runOfflineCanary({ signal: controller.signal, launcher: { launch() { assert.fail("must not launch"); } } }), { name: "AbortError" });
});

test("uncertain offline group cleanup refuses success and retains its own fixture", async () => {
  await withExecutableFixture(async ({ paths }) => {
    const launcher = fakeLauncher(child => { child.exitCode = 1; child.emit("exit", 1, null); }, async () => false);
    try {
      await assert.rejects(runOfflineCanary({ ...paths, launcher }), /group cleanup uncertain: owned-fake.scope/);
      assert.equal(existsSync(launcher.calls[0].cwd), true);
      assert.deepEqual(launcher.calls.slice(1), ["kill", ["settled", 3000], "kill", ["settled", 3000]]);
    } finally {
      // This is an in-memory launcher: it never creates a real process/group.
      const root = path.dirname(launcher.calls[0].cwd);
      assert.ok(root.startsWith("/tmp/den-codex-profile-task2-"));
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("overflow stops the fake group and bounds retained diagnostic excerpts", async () => {
  await withExecutableFixture(async ({ paths }) => {
    const launcher = fakeLauncher(child => { child.stdout.write("x".repeat(9000)); child.stderr.write("y".repeat(65000)); });
    const result = await runOfflineCanary({ ...paths, launcher });
    assert.equal(result.overflow, true);
    assert.equal(result.ok, false);
    assert.equal(result.rawOutput.stdout.length, 8000);
    assert.equal(result.rawOutput.stdoutBytes, 9000);
    assert.equal(result.rawOutput.stderrBytes, 65000);
    assert.equal(result.rawOutput.totalBytes, 74000);
    assert.equal(result.settled, true);
  });
});

async function withExecutableFixture(check) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(path.join(parent, "den-codex-executable-fixture-"));
  try {
    const executable = path.join(root, "dummy-executable");
    await writeFile(executable, "fixture-only; never execute", { mode: 0o700 });
    await chmod(executable, 0o700);
    await check({ root, executable, paths: { nodeBin: executable, codexBin: executable, nativeHelper: executable } });
  } finally {
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith("den-codex-executable-fixture-"));
    await rm(resolved, { recursive: true, force: true });
  }
}

test("execution admission accepts real executable files and rejects a directory for every supplied binary", async () => {
  await withExecutableFixture(async ({ root, executable, paths }) => {
    const resolved = await resolveCanaryExecutables(paths);
    assert.deepEqual(resolved, { nodeBin: await realpath(executable), codexBin: await realpath(executable), nativeHelper: await realpath(executable) });
    const directory = path.join(root, "directory");
    await mkdir(directory);
    for (const name of Object.keys(paths)) {
      await assert.rejects(resolveCanaryExecutables({ ...paths, [name]: directory }), /regular executable file/);
    }
  });
});

test("POSIX execution admission refuses non-executable files for all binary inputs", { skip: process.platform === "win32" ? "Windows does not enforce POSIX execute bits" : false }, async () => {
  await withExecutableFixture(async ({ root, paths }) => {
    const nonExecutable = path.join(root, "non-executable");
    await writeFile(nonExecutable, "fixture-only", { mode: 0o600 });
    await chmod(nonExecutable, 0o600);
    for (const name of Object.keys(paths)) await assert.rejects(resolveCanaryExecutables({ ...paths, [name]: nonExecutable }), { code: "EACCES" });
  });
});

test("POSIX executable aliases resolve to the checked regular file; directory aliases refuse", { skip: process.platform === "win32" ? "Fixture symlinks require POSIX permissions" : false }, async () => {
  await withExecutableFixture(async ({ root, executable, paths }) => {
    const alias = path.join(root, "wrapper-alias");
    const directoryAlias = path.join(root, "directory-alias");
    await symlink(executable, alias);
    await symlink(root, directoryAlias);
    assert.equal((await resolveCanaryExecutables({ ...paths, codexBin: alias })).codexBin, await realpath(executable));
    await assert.rejects(resolveCanaryExecutables({ ...paths, nativeHelper: directoryAlias }), /regular executable file/);
  });
});

test("the offline canary plan selects only the task-owned slice and shell sandbox", () => {
  const plan = offlineCanaryPlan({ root: "/tmp/den-codex-profile-task2-Ab1234", codexBin: "/tools/codex", nativeHelper: "/tools/private-package/bin/codex", nodeBin: "/tools/node", port: 12345 });
  assert.equal(plan.slice, "den-agents-codex-task2");
  assert.equal(CANARY_SLICE, plan.slice);
  assert.equal(plan.launchable, false);
  assert.deepEqual(plan.args.slice(0, 6), ["sandbox", "--permission-profile", "bridge-offline-canary", "--cd", `${plan.root}/worktree`, "--"]);
  assert.equal(plan.env.CODEX_HOME, `${plan.root}/native`);
  assert.equal(plan.env.HOME, `${plan.root}/home`);
  assert.equal(Object.hasOwn(plan.env, "OPENAI_API_KEY"), false);
  assert.match(plan.config, /cli_auth_credentials_store = "ephemeral"/);
  assert.match(plan.config, /"\/tmp\/den-codex-profile-task2-Ab1234\/native" = "deny"/);
  assert.match(plan.config, /"\/tools\/private-package\/bin\/codex" = "read"/);
  assert.doesNotMatch(plan.config, /"\/tools\/private-package" =/);
  assert.doesNotMatch(plan.config, /"\/tools" =/);
});

test("the canary refuses roots outside its disposable fixture prefix and command interpolation", () => {
  const valid = { root: "/tmp/den-codex-profile-task2-Ab1234", codexBin: "/tools/codex", nativeHelper: "/tools/private-package/bin/codex", nodeBin: "/tools/node", port: 12345 };
  for (const patch of [{ root: "/tmp" }, { root: `${valid.root}/child` }, { root: `${valid.root}/../outside` }, { codexBin: "/tools/codex;echo" }, { nativeHelper: undefined }, { nativeHelper: "/tools/../codex" }, { port: 0 }]) {
    assert.throws(() => offlineCanaryPlan({ ...valid, ...patch }));
  }
});
