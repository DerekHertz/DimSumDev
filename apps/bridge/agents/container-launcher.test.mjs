// hardening/10: the container launcher takes the place of the resource-group launcher when the flag is on; docker and spawn are injected.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createContainerLauncher } from "./container.mjs";
import { EnforcementError, LIMITS } from "./resource-group.mjs";

const run = { slotClass: "worker", id: "run-1", bin: "claude", cwd: "/h/repo/.claude/worktrees/w1", env: {},
  args: ["-p", "--settings", JSON.stringify({ permissions: {}, sandbox: { enabled: true } })],
  container: { role: "developer", sessionId: "7f1f6f0e-0000-4000-8000-000000000001", mainGit: "/h/repo/.git" } };

function setup({ proxyUp = true, running = true } = {}) {
  const calls = [];
  const spawned = [];
  const docker = async (args) => {
    calls.push(args);
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
