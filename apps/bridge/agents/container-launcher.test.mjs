// hardening/10: the container launcher takes the place of the resource-group launcher when the flag is on; docker and spawn are injected.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createContainerLauncher } from "./container.mjs";
import { EnforcementError, LIMITS } from "./resource-group.mjs";

const run = { slotClass: "worker", id: "run-1", bin: "claude", cwd: "/h/repo/.claude/worktrees/w1", env: {},
  args: ["-p", "--settings", JSON.stringify({ permissions: {}, sandbox: { enabled: true } })],
  container: { role: "developer", sessionId: "7f1f6f0e-0000-4000-8000-000000000001", mainGit: "/h/repo/.git" } };

function setup({ proxyUp = true, running = true, oom = { killed: false } } = {}) {
  const calls = [];
  const spawned = [];
  const docker = async (args) => {
    calls.push(args);
    if (args[0] === "inspect" && args.includes("{{.State.OOMKilled}}")) return { ok: true, out: String(oom.killed), err: "" };
    if (args[0] === "inspect" && args.at(-1) === "den-proxy") return { ok: proxyUp, out: proxyUp ? "true" : "", err: proxyUp ? "" : "No such object" };
    if (args[0] === "inspect") return { ok: running, out: running ? "true" : "", err: running ? "" : "No such object" };
    return { ok: true, out: "", err: "" };
  };
  const spawn = (bin, argv, opts) => {
    const child = Object.assign(new EventEmitter(), { stdin: {}, stdout: {}, stderr: new EventEmitter(), pid: 0 });
    spawned.push({ bin, argv, opts });
    setImmediate(() => child.emit("spawn"));
    return child;
  };
  const minted = [];
  const proxy = { ports: { developer: 8080 }, mintRunSecret: async ({ role }) => (minted.push(role), { secret: "s".repeat(32) }) };
  return { calls, spawned, minted, launcher: createContainerLauncher({ env: { PATH: "/usr/bin" }, image: "den-agent:0123456789ab", docker, spawn, proxy, limits: LIMITS, startWaitMs: 50 }) };
}

test("launch starts docker with the class limits, the proxy env and the run secret, and returns a child and a group", async () => {
  const { launcher, spawned, minted } = setup();
  const { child, group } = await launcher.launch(run);
  assert.equal(spawned[0].bin, "/usr/bin/docker");
  const argv = spawned[0].argv;
  assert.deepEqual(minted, ["developer"]);
  assert.ok(argv.includes(`--memory`) && argv.includes(`${LIMITS.classes.worker.memoryMiB}m`));
  assert.ok(argv.some((a) => a.startsWith("HTTPS_PROXY=http://") && a.includes("ssssssss@den-proxy:8080")));
  assert.ok(argv.includes("-w") && argv.includes("/h/repo/.claude/worktrees/w1"));
  assert.ok(!argv.some((a) => a.includes("sandbox")), "the CLI sandbox block is dropped inside the container");
  assert.ok(child && typeof group.kill === "function" && typeof group.exhausted === "function");
});

test("the run is refused, and no secret minted, when the proxy is not up", async () => {
  const { launcher, minted, spawned } = setup({ proxyUp: false });
  await assert.rejects(launcher.launch(run), EnforcementError);
  assert.deepEqual(minted, []);
  assert.deepEqual(spawned, []);
});

test("the run is refused when the container never comes up", async () => {
  const { launcher } = setup({ running: false });
  await assert.rejects(launcher.launch(run), /did not start/);
});

test("exhausted() names memory once docker reports the container OOM-killed (read in the background, so it stays synchronous)", async () => {
  const oom = { killed: false };
  const { launcher } = setup({ oom });
  const { group } = await launcher.launch(run);
  assert.equal(group.exhausted(), null);
  await new Promise((r) => setImmediate(r));
  assert.equal(group.exhausted(), null);
  oom.killed = true;
  await new Promise((r) => setImmediate(r));
  group.exhausted();
  await new Promise((r) => setImmediate(r));
  assert.equal(group.exhausted(), "memory");
});

test("governed paths go in read-only: an existing one is mounted, a missing one gets a placeholder that is swept on exit", async () => {
  const { mkdtemp, mkdir, lstat, rm, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");
  const wt = pathMod.join(await realpath(await mkdtemp(pathMod.join(tmpdir(), "den-gov-"))), "w1");
  await mkdir(pathMod.join(wt, ".claude"), { recursive: true });
  try {
    const denyWrite = [`${wt}/.claude`, `${wt}/.github/workflows`, "/h/repo/.git/refs"];
    const { launcher, spawned } = setup();
    const { child } = await launcher.launch({ ...run, cwd: wt, args: ["-p", "--settings", JSON.stringify({ permissions: {}, sandbox: { filesystem: { denyWrite } } })] });
    const ro = spawned[0].argv.filter((a) => a.endsWith(":ro"));
    assert.ok(ro.includes(`${wt}/.claude:${wt}/.claude:ro`));
    assert.ok(ro.includes(`${wt}/.github/workflows:${wt}/.github/workflows:ro`));
    assert.ok(!ro.some((a) => a.startsWith("/h/repo/.git/refs")), "a path under no rw mount is already read-only or absent");
    const ph = await lstat(`${wt}/.github/workflows`);
    assert.ok(ph.isFile() && ph.size === 0 && (ph.mode & 0o222) === 0, "the placeholder is an empty read-only file");
    child.emit("exit", 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await lstat(`${wt}/.github`).then(() => true, () => false), false, "the placeholder and the dir made for it are gone");
  } finally {
    await rm(pathMod.dirname(wt), { recursive: true, force: true });
  }
});
