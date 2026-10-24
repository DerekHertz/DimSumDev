// Test-only (den-revival/01, ADR 0030): runs `codex sandbox -- node probe.mjs` through the REAL launch plan, with no model and
// no account call: the resource launcher (systemd user scope, prlimit, the outer bwrap wrapper) and a named permission profile that
// grants only the Node binary and Codex's native helper (plus the worktree, which is the one write root).
// The production seam these tests pin (the developer writes it, apps/bridge/agents/codex-sandbox-plan.mjs):
//   codexSandboxPlan({ worktree, nativeStore, home, xdg, tmp, codexBin, nativeHelper, nodeBin, command }) ->
//     { configToml, bin, args, cwd, env }   the exact bin/args/cwd/env to give createResourceLauncher().launch(), and the text of
//     the config.toml the launcher writes into nativeStore. bin+args run `codex sandbox --permission-profile <name> --cd <worktree> -- <command>`
//     with a named profile that reads only nodeBin and nativeHelper, writes only the worktree, denies nativeStore, and has the network off.
// Production never imports this file. `codexSandboxHost()` says why a host cannot run it, so CI skips with a reason.
import { spawnSync, execFile } from "node:child_process";
import { createServer, connect } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createResourceLauncher, findUserBus } from "./resource-group.mjs";
import { findCodexNative } from "./codex-sandbox-plan.mjs";

const SLICE = `den-test-codexsb-p${process.pid}`;
const MARKER = "fake-credential-marker-do-not-leak";
let seq = 0;

let hostCheck;
/** { skip: false, ... } when this host can run the real launch plan; otherwise { skip: "<reason>" }. Cached. */
export function codexSandboxHost() {
  hostCheck ??= (async () => {
    if (process.platform !== "linux") return { skip: "the launch plan needs Linux (control groups, bubblewrap)" };
    if (spawnSync("sh", ["-c", "command -v bwrap"]).status !== 0) return { skip: "bwrap is not installed" };
    const native = findCodexNative();
    if (native.reason) return { skip: native.reason };
    const ready = await createResourceLauncher({ env: process.env, slice: SLICE }).preflight();
    if (!ready.ok) return { skip: `this host cannot enforce the resource group (user systemd bus?): ${ready.reason}` };
    return { skip: false, ...native, nodeBin: realpathSync(process.execPath) };
  })();
  return hostCheck;
}

const run = (file, args) => new Promise((resolve) => execFile(file, args, { env: findUserBus(process.env).env, timeout: 5000 }, () => resolve()));

/** Drops this process's slice (the host probe and every launch create it); call from `after()` in each test file.
 * systemd also makes the dash-parents of the slice name (den-test-codexsb, den-test): their runtime limits are reverted too. */
export async function dropSlice() {
  for (const verb of ["revert", "stop"]) await run("systemctl", ["--user", verb, `${SLICE}.slice`]);
  for (const parent of ["den-test-codexsb", "den-test"]) await run("systemctl", ["--user", "revert", `${parent}.slice`]);
}

/**
 * One disposable fixture under the home directory (never /tmp: a refused write must be checked on the host's real disk, where a
 * private /tmp mount cannot hide it). `fixture.root` holds: worktree/ (the one write root), outside/ (a host path the profile
 * does not grant), native/ (CODEX_HOME, denied) and home/.codex (a stand-in for the real one), each with a planted fake auth.json.
 * `fixture.run(probeSource, args)` runs the probe through `codex sandbox` in the real launch plan and returns
 * { code, signal, stdout, stderr, unit, settled, command }. `fixture.dispose()` kills every scope and removes the fixture.
 */
export async function makeFixture(host) {
  const { codexSandboxPlan } = await import("./codex-sandbox-plan.mjs").catch((err) => assert.fail(`missing feature: apps/bridge/agents/codex-sandbox-plan.mjs must export codexSandboxPlan() (${err.code ?? err.message})`));
  const root = mkdtempSync(path.join(os.homedir(), ".den-codex-sandbox-"));
  const worktree = `${root}/worktree`;
  const nativeStore = `${root}/native`;
  for (const dir of ["worktree", "outside", "native", "home/.codex", "xdg", "tmp"]) mkdirSync(`${root}/${dir}`, { recursive: true, mode: 0o700 });
  const authFiles = [`${nativeStore}/auth.json`, `${root}/home/.codex/auth.json`, `${root}/outside/auth.json`];
  for (const file of authFiles) writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: MARKER }), { mode: 0o600 });
  const launcher = createResourceLauncher({ env: process.env, slice: SLICE });
  const open = [];

  async function runProbe(source, args = []) {
    writeFileSync(`${worktree}/probe.mjs`, source, { mode: 0o600 });
    const plan = codexSandboxPlan({ worktree, nativeStore, home: `${root}/home`, xdg: `${root}/xdg`, tmp: `${root}/tmp`, codexBin: host.codexBin, nativeHelper: host.nativeHelper, nodeBin: host.nodeBin, command: [host.nodeBin, `${worktree}/probe.mjs`, ...args] });
    writeFileSync(`${nativeStore}/config.toml`, plan.configToml, { mode: 0o600 });
    const command = { bin: plan.bin, args: plan.args, cwd: plan.cwd, env: plan.env };
    const launched = await launcher.launch({ slotClass: "worker", id: `codex-sandbox-test-${process.pid}-${(seq += 1)}`, ...command });
    open.push(launched);
    const { child, group } = launched;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.stdin.on("error", () => {});
    child.stdin.end();
    const timer = setTimeout(() => group.kill(), 30000);
    const status = await new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", (err) => resolve({ code: null, signal: null, error: err.message }));
    });
    clearTimeout(timer);
    group.kill();
    const settled = await group.settled(3000);
    // Exit can precede the last data event; give the pipes a moment to drain.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { ...status, stdout, stderr, unit: group.unit, settled, command: { bin: command.bin, args: command.args } };
  }

  return {
    root, worktree, nativeStore, authFiles, marker: MARKER, outside: `${root}/outside`, run: runProbe,
    async dispose() {
      for (const { group } of open) group.kill();
      for (const { group } of open) await group.settled(3000);
      if (!root.startsWith(path.join(os.homedir(), ".den-codex-sandbox-"))) throw new Error("refused unsafe fixture cleanup target");
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A listener that counts connections; `connections()` is what the listener itself saw, the only proof of "refused". */
export async function countingListener() {
  let count = 0;
  const server = createServer((socket) => { count += 1; socket.destroy(); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { port: server.address().port, connections: () => count, reset: () => (count = 0), close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Positive control from the host: the listener does count a connection that is allowed, so "zero" is not a dead listener. */
export function touch(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => { socket.destroy(); setTimeout(resolve, 50); });
    socket.once("error", reject);
  });
}

/** A failing assertion message that carries what the launch printed, so a start failure is diagnosable from the test output. */
export const describeRun = (r) =>
  `codex sandbox exited code=${r.code} signal=${r.signal}${r.error ? ` error=${r.error}` : ""} unit=${r.unit} settled=${r.settled}\n  command: ${r.command.bin} ${r.command.args.join(" ")}\n  stdout: ${JSON.stringify(r.stdout)}\n  stderr: ${r.stderr === "" ? "(empty)" : `\n${r.stderr}`}`;
