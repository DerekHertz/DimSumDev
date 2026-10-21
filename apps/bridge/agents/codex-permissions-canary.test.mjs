import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, mkdir, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { offlineCanaryPlan, resolveCanaryExecutables, CANARY_SLICE } from "./codex-permissions-canary.mjs";

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
