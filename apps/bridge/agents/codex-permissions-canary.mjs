// OFFLINE SHELL-only experiment. No app-server, provider, auth or account calls.
// Import/default invocation launches nothing. Production admission stays disabled.
import { mkdtemp, mkdir, writeFile, readFile, symlink, realpath, rm, stat, access } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createResourceLauncher } from "./resource-group.mjs";
import { compileCodexPermissions, renderCodexConfig } from "./codex-permissions.mjs";

export const CANARY_SLICE = "den-agents-codex-task2";
const PREFIX = "/tmp/den-codex-profile-task2-";
const SAFE_PATH = /^\/(?:[A-Za-z0-9._@+-]+\/)*[A-Za-z0-9._@+-]+$/;
const MARKER = "disposable-fixture-marker";

// Filesystem admission belongs to the execution entry, not the pure plan. A
// canonical directory must never become an executable's subtree read grant.
export async function resolveCanaryExecutables({ nodeBin, codexBin, nativeHelper } = {}) {
  const resolved = {};
  for (const [name, supplied] of Object.entries({ nodeBin, codexBin, nativeHelper })) {
    if (typeof supplied !== "string" || supplied.length > 4096 || !path.isAbsolute(supplied) || /[\x00-\x1f\x7f]/.test(supplied)) throw new TypeError(`invalid ${name} executable path`);
    const canonical = await realpath(supplied);
    if (!(await stat(canonical)).isFile()) throw new TypeError(`${name} must resolve to a regular executable file`);
    await access(canonical, constants.X_OK);
    resolved[name] = canonical;
  }
  return Object.freeze(resolved);
}

// Representation only: callers must admit actual files before execution.
export function offlineCanaryPlan({ root, nodeBin, codexBin, nativeHelper, port }) {
  if (!SAFE_PATH.test(root) || !root.startsWith(PREFIX) || !/^[a-zA-Z0-9]+$/.test(root.slice(PREFIX.length)) ||
      [nodeBin, codexBin, nativeHelper].some(value => typeof value !== "string" || !SAFE_PATH.test(value) || path.posix.normalize(value) !== value) ||
      !Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("invalid offline fixture plan");
  const worktree = `${root}/worktree`;
  const nativeStore = `${root}/native`;
  const compiled = compileCodexPermissions({ profileId: "bridge-offline-canary", worktree, nativeStore,
    // The native sandbox re-execs this precise installed helper before the probe.
    // Admit the executable itself, never its package/home parent directory.
    policy: { version: 1, readRoots: [worktree, nodeBin, nativeHelper], writeRoots: [`${worktree}/edit`],
      readOnlyPaths: [`${worktree}/edit/governed`], denyPaths: [`${worktree}/dummy-credential`], denyCommands: [], hosts: [] } });
  const config = renderCodexConfig({ ...compiled.config, cli_auth_credentials_store: "ephemeral" });
  return { root, worktree, nativeStore, config, launchable: compiled.launchable, bin: codexBin,
    args: ["sandbox", "--permission-profile", compiled.profileId, "--cd", worktree, "--", nodeBin, `${worktree}/probe.mjs`, root, String(port)],
    env: { PATH: `${path.posix.dirname(nodeBin)}:/usr/bin:/bin`, LANG: "C.UTF-8", HOME: `${root}/home`, CODEX_HOME: nativeStore,
      XDG_CONFIG_HOME: `${root}/xdg`, TMPDIR: `${root}/tmp` },
    slice: CANARY_SLICE, timeoutMs: 30000, outputBytes: 64000 };
}

const PROBE = String.raw`import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import net from 'node:net';
const [root,port,mode] = process.argv.slice(2);
const worktree = root+'/worktree';
const results=[];
function blocked(name,fn) { try { fn(); results.push({name,ok:false}); } catch(e) { results.push({name,ok:['EACCES','EPERM','EROFS','ENOENT','ENOTDIR'].includes(e.code)}); } }
function read(name,file) { blocked(name,()=>fs.readFileSync(file)); }
function write(name,file) { blocked(name,()=>fs.writeFileSync(file,'unexpected-fixture-write')); }
if(mode==='child') {
  read('descendant-denied-read',root+'/native/dummy-store');
  write('descendant-outside-write',root+'/outside/descendant');
} else {
  results.push({name:'allowed-read',ok:fs.readFileSync(worktree+'/source','utf8')==='disposable-fixture-marker'});
  fs.writeFileSync(worktree+'/edit/allowed','approved-write');
  results.push({name:'allowed-write',ok:fs.readFileSync(worktree+'/edit/allowed','utf8')==='approved-write'});
  read('native-store-read',root+'/native/dummy-store');
  write('native-store-write',root+'/native/dummy-store');
  read('credential-read',worktree+'/dummy-credential');
  write('credential-write',worktree+'/dummy-credential');
  write('source-readonly-write',worktree+'/source');
  write('governed-readonly-write',worktree+'/edit/governed');
  write('outside-write',root+'/outside/new-file');
  read('symlink-denied-read',worktree+'/credential-alias');
  read('symlink-native-store-read',worktree+'/native-alias/dummy-store');
  write('symlink-outside-write',worktree+'/edit/outside-alias/new-file');
  read('proc-self-root-denied-read','/proc/self/root'+worktree+'/dummy-credential');
  write('proc-self-root-outside-write','/proc/self/root'+root+'/outside/proc-file');
  const child=spawnSync(process.execPath,[worktree+'/probe.mjs',root,port,'child'],{timeout:5000,maxBuffer:8192,env:{PATH:process.env.PATH}});
  let descendants; try { descendants=JSON.parse(String(child.stdout)); } catch {}
  results.push({name:'descendant-ran',ok:child.status===0&&Array.isArray(descendants)&&descendants.length===2});
  if(Array.isArray(descendants)) results.push(...descendants);
  results.push(await new Promise(resolve=>{
    const socket=net.connect({host:'127.0.0.1',port:Number(port)});
    let finished=false;
    const done=(ok,observation)=>{if(finished)return;finished=true;socket.destroy();resolve({name:'localhost-network-denied',ok,observation});};
    socket.setTimeout(1000,()=>done(false,'timeout-only-unproved'));
    socket.once('connect',()=>done(false,'connection-succeeded'));
    socket.once('error',error=>done(['EACCES','EPERM','ENETUNREACH','EHOSTUNREACH','ECONNREFUSED'].includes(error.code),error.code));
  }));
}
console.log(JSON.stringify(results));
process.exitCode=results.every(r=>r.ok)?0:1;
`;

export async function runOfflineCanary({ codexBin, nativeHelper, nodeBin = process.execPath } = {}) {
  if (process.platform !== "linux") throw new Error("offline native canary requires Linux");
  if ([codexBin, nodeBin, nativeHelper].some(value => typeof value !== "string" || !SAFE_PATH.test(value))) throw new TypeError("explicit native binary paths are required");
  const executables = await resolveCanaryExecutables({ nodeBin, codexBin, nativeHelper });
  // No global environment is changed; the native CLI receives only a new,
  // disposable HOME/CODEX_HOME. These contain no real credentials or auth files.
  const root = await mkdtemp(PREFIX);
  let listener;
  let launched;
  let settled = null;
  try {
    let connections = 0;
    listener = createServer(socket => { connections += 1; socket.destroy(); });
    await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    const plan = offlineCanaryPlan({ root, ...executables, port: listener.address().port });
    for (const relative of ["worktree/edit", "native", "home", "xdg", "tmp", "outside"]) await mkdir(`${root}/${relative}`, { recursive: true, mode: 0o700 });
    for (const relative of ["worktree/source", "worktree/edit/governed", "worktree/dummy-credential", "native/dummy-store"]) await writeFile(`${root}/${relative}`, MARKER, { mode: 0o600 });
    await writeFile(`${plan.worktree}/probe.mjs`, PROBE, { mode: 0o600 });
    await writeFile(`${plan.nativeStore}/config.toml`, plan.config, { mode: 0o600 });
    await symlink(`${plan.worktree}/dummy-credential`, `${plan.worktree}/credential-alias`);
    await symlink(plan.nativeStore, `${plan.worktree}/native-alias`);
    await symlink(`${root}/outside`, `${plan.worktree}/edit/outside-alias`);
    const launcher = createResourceLauncher({ slice: CANARY_SLICE });
    const ready = await launcher.preflight();
    if (!ready.ok) throw new Error(`offline canary preflight refused: ${ready.reason}`);
    launched = await launcher.launch({ slotClass: "worker", id: `codex-profile-${randomBytes(8).toString("hex")}`,
      bin: plan.bin, args: plan.args, cwd: plan.worktree, env: plan.env });
    const { child, group } = launched;
    let closed = false;
    const closedPromise = new Promise(resolve => child.once("close", () => { closed = true; resolve(true); }));
    child.on("error", () => {}); // The bounded exit observer records the failure below.
    let stdout = "", stderr = "", bytes = 0, overflow = false;
    for (const [stream, append] of [[child.stdout, data => { stdout += data; }], [child.stderr, data => { stderr += data; }]]) stream.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > plan.outputBytes) { overflow = true; group.kill(); }
      else append(chunk.toString());
    });
    child.stdin.end();
    const status = await new Promise(resolve => {
      let finished = false;
      const done = value => { if (finished) return; finished = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => { group.kill(); done({ timeout: true }); }, plan.timeoutMs);
      child.once("exit", (code, signal) => done({ code, signal }));
      child.once("error", () => done({ error: "child process error" }));
      if (child.exitCode !== null || child.signalCode !== null) done({ code: child.exitCode, signal: child.signalCode });
    });
    // The launcher anchor can keep inherited descriptors open until killed.
    // Observe close before killing, then wait for bounded stdio drain before
    // parsing the final JSON; exit alone can precede the last data event.
    group.kill();
    settled = await group.settled(3000);
    if (!settled) throw new Error(`offline canary group cleanup uncertain: ${group.unit}`);
    const outputDrained = closed || await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 3000);
      closedPromise.then(() => { clearTimeout(timer); resolve(true); });
    });
    let results; try { results = JSON.parse(stdout.trim()); } catch {}
    const preserved = (await Promise.all(["worktree/source", "worktree/edit/governed", "worktree/dummy-credential", "native/dummy-store"].map(relative => readFile(`${root}/${relative}`, "utf8")))).every(value => value === MARKER);
    return { scope: "offline-native-SHELL-only", launchable: false, unit: group.unit, slice: CANARY_SLICE, settled, status,
      command: { bin: plan.bin, args: plan.args, cwd: plan.worktree },
      overflow, outputDrained, connections, markersPreserved: preserved, results: Array.isArray(results) ? results : null,
      // Diagnostics belong only to this credential-free experiment, bounded above.
      diagnostics: stderr.slice(0, 8000), ok: status.code === 0 && !overflow && outputDrained && connections === 0 && preserved && Array.isArray(results) && results.length === 18 && results.every(result => result.ok === true) };
  } finally {
    if (launched && settled !== true) { launched.group.kill(); settled = await launched.group.settled(3000); }
    if (listener) await new Promise(resolve => listener.close(resolve));
    // Preserve fixtures on uncertain cleanup; deleting files is not proof that a
    // surviving descendant died. The random root is the only recursive target.
    if (!launched || settled === true) {
      const resolved = await realpath(root);
      if (resolved !== root || !root.startsWith(PREFIX) || !/^[a-zA-Z0-9]+$/.test(root.slice(PREFIX.length))) throw new Error("refused unsafe canary cleanup target");
      await rm(root, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] !== "--run-offline" || process.argv.length !== 5) throw new Error("No default execution. Usage: node codex-permissions-canary.mjs --run-offline /absolute/codex /absolute/native-helper");
  const result = await runOfflineCanary({ codexBin: process.argv[3], nativeHelper: process.argv[4] });
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
