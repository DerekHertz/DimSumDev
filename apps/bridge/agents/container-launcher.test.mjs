// hardening/10: the container launcher takes the place of the resource-group launcher when the flag is on; docker and spawn are injected.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createContainerLauncher } from "./container.mjs";
import { EnforcementError, LIMITS } from "./resource-group.mjs";

const run = { slotClass: "worker", id: "run-1", bin: "claude", cwd: "/h/repo/.claude/worktrees/w1", env: {},
  args: ["-p", "--settings", JSON.stringify({ permissions: {}, sandbox: { enabled: true } })],
  container: { role: "developer", sessionId: "7f1f6f0e-0000-4000-8000-000000000001", mainGit: "/h/repo/.git" } };

const SESSIONS = mkdtempSync(join(tmpdir(), "den-sessions-"));
test.after(() => rmSync(SESSIONS, { recursive: true, force: true }));

function setup({ proxyUp = true, running = true, oom = { killed: false }, internal = "true", sessionsDir = SESSIONS, stale = false, spawnThrows = false } = {}) {
  const calls = [];
  const spawned = [];
  const docker = async (args) => {
    calls.push(args);
    if (args[0] === "network" && args[1] === "inspect") return { ok: true, out: args.includes("{{.Internal}}") ? internal : "[]", err: "" };
    if (args[0] === "inspect" && args.includes("{{.State.OOMKilled}}")) return { ok: true, out: String(oom.killed), err: "" };
    if (args[0] === "inspect" && args.at(-1) === "den-proxy") return { ok: proxyUp, out: proxyUp ? "true" : "", err: proxyUp ? "" : "No such object" };
    const on = stale || (running && spawned.length > 0); // stale: a container of that name is running before this launch
    if (args[0] === "inspect") return { ok: on, out: on ? "true" : "", err: on ? "" : "No such object" };
    return { ok: true, out: "", err: "" };
  };
  const spawn = (bin, argv, opts) => {
    if (spawnThrows) throw new Error("spawn EACCES");
    const child = Object.assign(new EventEmitter(), { stdin: {}, stdout: {}, stderr: new EventEmitter(), pid: 0 });
    spawned.push({ bin, argv, opts });
    setImmediate(() => child.emit("spawn"));
    return child;
  };
  const minted = [];
  const retired = [];
  const proxy = { ports: { developer: 8080, target: 8081 }, mintRunSecret: async ({ role }) => (minted.push(role), { secret: "s".repeat(32) }), retireRunSecret: async (s) => { retired.push(s); } };
  return { calls, spawned, minted, retired, launcher: createContainerLauncher({ env: { PATH: "/usr/bin" }, image: "den-agent:0123456789ab", docker, spawn, proxy, limits: LIMITS, startWaitMs: 50, sessionsDir }) };
}

test("launch starts docker with the class limits, the proxy env and the run secret, and returns a child and a group", async () => {
  const { launcher, spawned, minted } = setup();
  const { child, group } = await launcher.launch(run);
  assert.equal(spawned[0].bin, "/usr/bin/docker");
  const argv = spawned[0].argv;
  assert.deepEqual(minted, ["developer"]);
  assert.ok(argv.includes(`--memory`) && argv.includes(`${LIMITS.classes.worker.memoryMiB}m`));
  assert.ok(!argv.some((a) => a.includes("s".repeat(32))), "the run secret is not on the docker argv");
  for (const name of ["ANTHROPIC_API_KEY", "HTTPS_PROXY", "https_proxy"]) {
    assert.ok(argv.some((a, i) => a === name && argv[i - 1] === "-e"), `${name} is passed by name`);
  }
  assert.equal(spawned[0].opts.env.ANTHROPIC_API_KEY, "s".repeat(32));
  assert.ok(spawned[0].opts.env.HTTPS_PROXY.includes("ssssssss@den-proxy:8080"));
  assert.ok(argv.includes("-w") && argv.includes("/h/repo/.claude/worktrees/w1"));
  assert.ok(argv.includes("--init"), "an init reaps orphans before they fill --pids-limit (security L4)");
  assert.ok(argv.some((a, i) => a === "never" && argv[i - 1] === "--pull"));
  assert.ok(argv.some((a, i) => a === "none" && argv[i - 1] === "--log-driver"), "the stream is not copied to docker's log");
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

test("the run is refused, and no secret minted, when den-agents is not an --internal network (security M2)", async () => {
  for (const internal of ["false", ""]) {
    const { launcher, minted, spawned } = setup({ internal });
    await assert.rejects(launcher.launch(run), (err) => err instanceof EnforcementError && /internal/.test(err.message));
    assert.deepEqual(minted, []);
    assert.deepEqual(spawned, []);
  }
});

test("the run secret is retired when the container exits, and when the start is refused after the mint (hardening/16 F4)", async () => {
  const { launcher, retired } = setup();
  const { child } = await launcher.launch(run);
  assert.deepEqual(retired, []);
  child.emit("exit", 0);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(retired, ["s".repeat(32)]);
  const failed = setup({ running: false });
  await assert.rejects(failed.launcher.launch(run), /did not start/);
  assert.deepEqual(failed.retired, ["s".repeat(32)]);
});

test("a follow-up mounts the same persistent session-store folder as the first run, at the CLI's store under HOME", async () => {
  const { mkdtemp, rm, stat, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");
  const sessionsDir = pathMod.join(await realpath(await mkdtemp(pathMod.join(tmpdir(), "den-sess-"))), "agent-sessions");
  try {
    const sid = run.container.sessionId;
    const store = `${sessionsDir}/${sid}:/root/.claude/projects:rw`;
    const first = setup({ sessionsDir });
    await first.launcher.launch({ ...run, args: [...run.args, "--session-id", sid] });
    const follow = setup({ sessionsDir });
    await follow.launcher.launch({ ...run, id: "run-2", args: [...run.args, "--resume", sid] });
    for (const { spawned } of [first, follow]) {
      const argv = spawned[0].argv;
      assert.ok(argv.some((a, i) => a === store && argv[i - 1] === "-v"), "the session store is mounted");
      assert.equal(argv.filter((a) => a.includes(sessionsDir)).length, 1, "only that session's folder is mounted");
    }
    assert.equal((await stat(`${sessionsDir}/${sid}`)).mode & 0o777, 0o700);
    const other = setup({ sessionsDir });
    await other.launcher.launch({ ...run, container: { ...run.container, sessionId: "7f1f6f0e-0000-4000-8000-000000000002" } });
    assert.ok(!other.spawned[0].argv.some((a) => a.startsWith(`${sessionsDir}/${sid}`)), "another session gets its own folder");
  } finally {
    await rm(pathMod.dirname(sessionsDir), { recursive: true, force: true });
  }
});

test("a session id that is not a plain UUID is refused before anything is minted", async () => {
  const { launcher, minted, spawned } = setup();
  await assert.rejects(launcher.launch({ ...run, container: { ...run.container, sessionId: "../x" } }), TypeError);
  assert.deepEqual(minted, []);
  assert.deepEqual(spawned, []);
});

test("a secured connection's --mcp-config file is mounted read-only at its host path", async () => {
  const file = "/h/state/den/credentials/run/0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b10.json";
  const { launcher, spawned } = setup();
  await launcher.launch({ ...run, container: { ...run.container, mcpConfigFile: file } });
  const argv = spawned[0].argv;
  assert.ok(argv.some((a, i) => a === `${file}:${file}:ro` && argv[i - 1] === "-v"));
  const without = setup();
  await without.launcher.launch(run);
  assert.ok(!without.spawned[0].argv.some((a) => a.includes("/credentials/")));
});

test("the run is refused, and no secret minted, when a container of the same name is already running (security L5)", async () => {
  const { launcher, minted, spawned } = setup({ stale: true });
  await assert.rejects(launcher.launch(run), (err) => err instanceof EnforcementError && /already running/.test(err.message));
  assert.deepEqual(minted, []);
  assert.deepEqual(spawned, []);
});

test("a governed path with a symlink anywhere under the worktree is refused before the mint, and nothing lands outside (security N1)", async () => {
  const { mkdtemp, mkdir, readdir, rm, realpath, symlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");
  const root = await realpath(await mkdtemp(pathMod.join(tmpdir(), "den-gov-link-")));
  const outside = pathMod.join(root, "outside");
  try {
    for (const [link, governed] of [[".github", ".github/workflows"], [".claude", ".claude"]]) {
      const wt = pathMod.join(root, `w-${link.slice(1)}`);
      await mkdir(wt, { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(outside, pathMod.join(wt, link));
      const denyWrite = [`${wt}/${governed}`];
      const { launcher, minted, spawned } = setup();
      await assert.rejects(launcher.launch({ ...run, cwd: wt, args: ["-p", "--settings", JSON.stringify({ permissions: {}, sandbox: { filesystem: { denyWrite } } })] }),
        (err) => err instanceof EnforcementError && /symlink/.test(err.message), `${governed} through a symlinked ${link} is refused`);
      assert.deepEqual(minted, [], "no secret is minted");
      assert.deepEqual(spawned, []);
      assert.deepEqual(await readdir(outside), [], "nothing is created at the symlink's target");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a synchronous throw from the proxy env or the spawn retires the secret and sweeps the placeholders (security N2)", async () => {
  const { mkdtemp, mkdir, lstat, rm, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");
  const root = await realpath(await mkdtemp(pathMod.join(tmpdir(), "den-gov-throw-")));
  try {
    const wt = pathMod.join(root, "w1");
    await mkdir(wt);
    const args = ["-p", "--settings", JSON.stringify({ permissions: {}, sandbox: { filesystem: { denyWrite: [`${wt}/.github/workflows`] } } })];
    const thrown = setup({ spawnThrows: true });
    await assert.rejects(thrown.launcher.launch({ ...run, cwd: wt, args }), /spawn EACCES/);
    assert.deepEqual(thrown.retired, ["s".repeat(32)], "the secret is retired when spawn throws");
    assert.equal(await lstat(`${wt}/.github`).then(() => true, () => false), false, "the placeholder and its dir are swept");
    const noPort = setup();
    await assert.rejects(noPort.launcher.launch({ ...run, cwd: wt, args, container: { ...run.container, role: "qa" } }), /no proxy port/);
    assert.deepEqual(noPort.retired, ["s".repeat(32)], "the secret is retired when the proxy env throws");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("multi-project/02: a target run mints the empty-allowlist identity and mounts its toolchain read-only at its host path", async () => {
  const { launcher, spawned, minted } = setup();
  await launcher.launch({ ...run, container: { ...run.container, target: true, toolchain: ["/h/acme/node_modules"] } });
  assert.deepEqual(minted, ["target"]);
  const argv = spawned[0].argv;
  assert.ok(argv.some((a, i) => a === "/h/acme/node_modules:/h/acme/node_modules:ro" && argv[i - 1] === "-v"));
  assert.ok(!argv.some((a) => a.includes("ticket")), "no ticket file is mounted");
});
