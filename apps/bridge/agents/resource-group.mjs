// den-mvp outcome 1 (spec section 2): the resource group every agent and its descendants run in.
// The launcher starts the CLI inside a transient systemd user scope (the approach agent-os/01 proved), under one slice
// that bounds all agents together. The bridge itself stays outside. Nothing here trusts that a flag was accepted: the
// control group the child really landed in is read back, and a mismatch kills the child and refuses the run. There is
// no unconfined fallback; a host that cannot enforce the limits starts no agent, and the refusal says what is missing.
//   createResourceLauncher({ env, limits?, slice? }) -> { enforced: true, preflight(), launch(...) }
//   preflight() -> { ok: true } | { ok: false, reason }      a real probe through launch(), cached for a short time
//   launch({ slotClass, id, bin, args, cwd, env }) -> { child, group }   rejects with EnforcementError when refused
// The command itself waits behind a gate (START_GATE) until the limits have been read back, so a refused run never ran.
//   group = { unit, dir, kill(), exhausted() -> "memory" | "processes" | null, settled(ms) -> Promise<boolean> }
//           the group outlives the command's own exit until kill(), so exhausted() can still be read then
//   watchStorage({ dir, limitBytes, onOver }) -> stop()      the job-storage monitor (not a quota; see below)
import { spawn as spawnChild, execFile } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SLOT_CLASSES } from "./policy.mjs";
import { prepareWriteScope, scopedWriteBindArgs } from "./scoped-writes.mjs";

export class EnforcementError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "EnforcementError";
    this.reason = reason;
  }
}

// ---- limits (limits.json, a guardrail path: the operator edits it, an agent cannot) ----------
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isGroupLimit = (g) => isPlainObject(g) && Object.keys(g).length === 3 && intIn(g.memoryMiB, 16, 1024 * 1024) && intIn(g.cpuPercent, 5, 6400) && intIn(g.tasks, 8, 65536);
/**
 * Checks a limits object: one group limit per slot class, the aggregate, the storage bounds, and the den's checks and test guard (one
 * group limit each: den-mvp/34, den-mvp/70). Throws on anything else.
 */
export function checkLimits(limits) {
  const ok = isPlainObject(limits) && Object.keys(limits).length === 5 && isPlainObject(limits.classes) && isGroupLimit(limits.checks) && isGroupLimit(limits.guard) &&
    Object.keys(limits.classes).length === SLOT_CLASSES.length && SLOT_CLASSES.every((c) => isGroupLimit(limits.classes[c])) &&
    isGroupLimit(limits.aggregate) && isPlainObject(limits.storage) && Object.keys(limits.storage).length === 2 &&
    intIn(limits.storage.jobMiB, 1, 1024 * 1024) && intIn(limits.storage.outputMiB, 1, 1024);
  if (!ok) throw new Error("limits.json: bad limits data");
  return limits;
}
export const LIMITS = Object.freeze(checkLimits(JSON.parse(readFileSync(new URL("./limits.json", import.meta.url), "utf8"))));

// den-mvp/34: the limits a launcher for the den's checks is made with. A test suite is short and CPU-bound, unlike an
// agent, so it gets the checks group of its own: in a slice of its own (den-checks), outside the agents' aggregate, one
// run at a time (delivery/checks.mjs queues them). The checks run as the "worker" slot class of that launcher.
export const CHECKS_SLICE = "den-checks";
const oneGroup = (limits, group) => checkLimits({ ...limits, classes: { ...limits.classes, worker: group }, aggregate: group });
export const checksLimits = (limits = LIMITS) => oneGroup(limits, limits.checks);
// den-mvp/70: the test guard reruns untrusted tests, so it gets a slice of its own (den-guard) and a smaller limit. Sharing den-checks
// let a guard rerun and a checks run starve each other into a memory kill when two deliveries overlapped.
export const GUARD_SLICE = "den-guard";
export const guardLimits = (limits = LIMITS) => oneGroup(limits, limits.guard);

const MIB = 1024 * 1024;
const CPU_PERIOD = 100_000; // systemd's default cpu.max period, in microseconds
/** The systemd properties of one group limit; no swap, and a memory kill takes one process, not the scope (the bridge ends the run). */
export const groupProperties = (g) => [`MemoryMax=${g.memoryMiB * MIB}`, "MemorySwapMax=0", `CPUQuota=${g.cpuPercent}%`, `TasksMax=${g.tasks}`];
/** What the kernel's control-group files must read once those properties are applied. */
export const groupFiles = (g) => ({ "memory.max": String(g.memoryMiB * MIB), "memory.swap.max": "0", "pids.max": String(g.tasks), "cpu.max": `${g.cpuPercent * (CPU_PERIOD / 100)} ${CPU_PERIOD}` });

const CGROUP_ROOT = "/sys/fs/cgroup";
const ABS_RE = /^(?:\/[A-Za-z0-9._@+-]+)+$/;
const UNIT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SLICE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The command waits here, already inside its scope, until the launcher writes "go" on descriptor 3. A closed pipe or
// any other word ends it with GATE_REFUSED, so nothing of the command runs before its limits are read back.
// Before the command starts, a small anchor process is left reading the same pipe. It keeps the scope alive after the
// command's last process is gone (systemd removes an empty scope at once, and with it the record of a memory kill),
// and it ends when the launcher closes the pipe or kills the group.
// Once released, the command raises its own OOM score (raising needs no privilege): den.slice holds the bridge as well, and
// when it fills, the kernel must kill a run, not the bridge. A host that refuses the write still runs the command.
export const GATE_REFUSED = 126;
export const OOM_SCORE = 500;
export const START_GATE = `IFS= read -r go <&3 && [ "$go" = go ] || exit ${GATE_REFUSED}; { echo ${OOM_SCORE} >/proc/self/oom_score_adj; } 2>/dev/null; ( (exec <&3 3<&- >/dev/null 2>&1; while read -r _; do :; done) & ); exec 3<&-; exec "$@"`;

/**
 * The systemd-run argv (no binary name) that starts `bin args` in its own scope. The bus variables the launcher needs
 * are removed again before the CLI starts, no file the run writes may pass the job-storage bound, and the command
 * starts only once the gate is released.
 */
export function buildScopeArgv({ unit, slice, limit, fileBytes, bin, args, wrapper = "bwrap", hide = [], hideSockets = [], writeScope, cwd, privateDirs = [] }) {
  if (typeof unit !== "string" || !/^[a-z0-9][a-z0-9-]{0,80}\.scope$/.test(unit)) throw new TypeError("buildScopeArgv: bad unit name");
  if (typeof slice !== "string" || !SLICE_RE.test(slice)) throw new TypeError("buildScopeArgv: bad slice name");
  if (!isGroupLimit(limit) || !intIn(fileBytes, MIB, Number.MAX_SAFE_INTEGER)) throw new TypeError("buildScopeArgv: bad limit");
  if (typeof bin !== "string" || bin === "" || !Array.isArray(args) || !args.every((a) => typeof a === "string")) throw new TypeError("buildScopeArgv: bad command");
  const paths = [...hide, ...hideSockets];
  if (typeof wrapper !== "string" || wrapper === "" || !paths.every((p) => typeof p === "string" && ABS_RE.test(p))) throw new TypeError("buildScopeArgv: bad wrapper");
  if (writeScope !== undefined && (typeof cwd !== "string" || !ABS_RE.test(cwd))) throw new TypeError("buildScopeArgv: scoped writes need a plain absolute cwd");
  if (!Array.isArray(privateDirs) || privateDirs.length > 4 || !privateDirs.every((dir) => typeof dir === "string" && ABS_RE.test(dir) && dir !== "/")) throw new TypeError("buildScopeArgv: privateDirs must be plain absolute directories");
  // The run sees /sys/fs/cgroup read-only (no limit file, no cgroup.procs, no new mount) and none of the service
  // manager's bus sockets: the directories are covered by an empty tmpfs, a lone socket by /dev/null. A private pid
  // namespace with its own /proc keeps /proc/<pid>/root of the host's processes (which see the unwrapped mounts) out of reach.
  const wrap = [wrapper, "--dev-bind", "/", "/", ...(writeScope === undefined ? [] : scopedWriteBindArgs(writeScope)), "--unshare-pid", "--proc", "/proc", "--ro-bind", CGROUP_ROOT, CGROUP_ROOT, ...hide.flatMap((d) => ["--tmpfs", d]), ...hideSockets.flatMap((f) => ["--ro-bind", "/dev/null", f]), ...privateDirs.flatMap((dir) => ["--tmpfs", dir, "--remount-ro", dir]), ...(writeScope === undefined ? [] : ["--chdir", cwd]), "--die-with-parent", "--"];
  return [
    "--user", "--scope", "--quiet", "--collect", "--unit", unit, "--slice", `${slice}.slice`,
    ...[...groupProperties(limit), "OOMPolicy=continue"].flatMap((p) => ["-p", p]),
    "--", "env", "-u", "XDG_RUNTIME_DIR", "-u", "DBUS_SESSION_BUS_ADDRESS",
    "prlimit", `--fsize=${fileBytes}:${fileBytes}`, "--", "/bin/sh", "-c", START_GATE, "den-gate", ...wrap, bin, ...args,
  ];
}

// ---- the host's control groups and bus -----------------------------------------------------
const read = (file) => {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
};
const isSocket = (file) => {
  try {
    return statSync(file).isSocket();
  } catch {
    return false;
  }
};
const counter = (text, key) => Number(new RegExp(`^${key} (\\d+)$`, "m").exec(text ?? "")?.[1] ?? 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const oneLine = (text) => String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 300);

/** The first executable called `name` on `PATH`, or null. */
const onPath = (name, PATH) => String(PATH ?? "").split(":").filter((d) => d.startsWith("/")).map((d) => path.join(d, name)).find((f) => { try { accessSync(f, constants.X_OK); return statSync(f).isFile(); } catch { return false; } }) ?? null;
const isDir = (f) => { try { return statSync(f).isDirectory(); } catch { return false; } };

// F39 security review: the system journal holds the bridge's console, launch URLs included, and the user can read it
// (systemd-journal ACL). A run sees neither directory: each is covered by an empty tmpfs like the bus directories.
export const JOURNAL_DIRS = Object.freeze(["/var/log/journal", "/run/log/journal"]);

/** What the wrapper must hide so a run cannot reach the service manager or read the journal: bus and journal directories, and lone bus sockets. */
export function busPlaces(env, { uid = process.getuid?.(), journalDirs = JOURNAL_DIRS } = {}) {
  const rd = typeof env?.XDG_RUNTIME_DIR === "string" && ABS_RE.test(env.XDG_RUNTIME_DIR.replace(/\/+$/, "")) ? env.XDG_RUNTIME_DIR.replace(/\/+$/, "") : `/run/user/${uid}`;
  // The den's state folder holds the build box's packages and the releases, so only its bus socket is hidden, not the folder.
  const dirs = [`/run/user/${uid}`, rd, ...journalDirs];
  const hide = [...new Set(dirs.filter((d) => d && ABS_RE.test(d) && isDir(d)))];
  const denBus = typeof env?.HOME === "string" ? `${env.HOME}/.local/state/den/user-bus` : null;
  const hideSockets = [...new Set([env?.DEN_USER_BUS, denBus])].filter((f) => typeof f === "string" && ABS_RE.test(f) && isSocket(f) && !hide.some((d) => f.startsWith(`${d}/`)));
  return { hide, hideSockets, sockets: [`${rd}/bus`, env?.DEN_USER_BUS, typeof env?.HOME === "string" ? `${env.HOME}/.local/state/den/user-bus` : null].filter((f) => typeof f === "string" && ABS_RE.test(f)) };
}

// The probe's command: it tries to loosen its own limits, the slice's, and to leave its group, and to reach the bus.
// Every attempt that works is named on stdout; a contained run prints only "contained" and exits 0.
export const PROBE_SCRIPT = `d=/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup); bad=0
if [ ! -r "$d/memory.max" ] || [ ! -r "$d/../memory.max" ]; then echo "probe could not run: the group's limit files are not readable at $d"; exit 2; fi
for f in "$d/memory.max" "$d/pids.max" "$d/cpu.max" "$d/../memory.max" "$d/../pids.max"; do
  if (echo max > "$f") 2>/dev/null; then echo "limit file $f was writable"; bad=1; fi
done
for f in "$d/../cgroup.procs" "$d/../cgroup.subtree_control"; do
  if (echo $$ > "$f") 2>/dev/null; then echo "the process could write $f of the slice"; bad=1; fi
done
if command -v unshare >/dev/null 2>&1; then
  t=$(mktemp -d 2>/dev/null) && {
    if unshare -Urm sh -c "mount -t cgroup2 none $t && [ -w $t/cgroup.procs ]" >/dev/null 2>&1; then echo "a new cgroup2 mount was writable"; bad=1; fi
    if unshare -Urm sh -c "mount -o remount,rw /sys/fs/cgroup" >/dev/null 2>&1; then echo "/sys/fs/cgroup was remounted writable"; bad=1; fi
    rmdir "$t" 2>/dev/null
  }
fi
for j in ${JOURNAL_DIRS.join(" ")}; do if [ -n "$(ls -A "$j" 2>/dev/null)" ]; then echo "the system journal $j is readable"; bad=1; fi; done
for s in "$@" "/run/user/$(id -u)/bus"; do if [ -S "$s" ]; then echo "the service manager's bus socket $s is visible"; bad=1; fi; done
for r in /proc/*/root; do
  if [ -S "$r/run/user/$(id -u)/bus" ] 2>/dev/null; then echo "the bus is reachable through $r"; bad=1; break; fi
  if (echo max > "$r/sys/fs/cgroup/memory.max") 2>/dev/null; then echo "limit files writable through $r"; bad=1; break; fi
done
if command -v busctl >/dev/null 2>&1; then
  if busctl --user --no-pager status >/dev/null 2>&1; then echo "the service manager answered a connection"; bad=1; fi
else echo "busctl not tested: it is not installed" >&2; fi
[ $bad = 0 ] && echo contained; exit $bad`;

/** The probe's verdict from its exit code and what it printed: null when contained, else the reason. */
export function judgeProbe(code, out) {
  if (code === 0 && /^contained$/m.test(out)) return null;
  return `a run could loosen its own limits or reach the service manager: ${oneLine(out) || `the probe ended with ${code === null ? "no answer" : `code ${code}`}`}`;
}

/**
 * Where the user service manager can be reached: its runtime directory's bus, else a bus socket the operator set up
 * elsewhere (DEN_USER_BUS, or ~/.local/state/den/user-bus). -> { env } for systemd-run, or { reason }.
 */
export function findUserBus(env, { uid = process.getuid?.() } = {}) {
  const runtimeDir = typeof env?.XDG_RUNTIME_DIR === "string" && ABS_RE.test(env.XDG_RUNTIME_DIR.replace(/\/+$/, "")) ? env.XDG_RUNTIME_DIR.replace(/\/+$/, "") : `/run/user/${uid}`;
  const base = typeof env?.PATH === "string" ? { PATH: env.PATH } : {};
  if (isSocket(`${runtimeDir}/bus`)) return { env: { ...base, XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` } };
  const others = [env?.DEN_USER_BUS, typeof env?.HOME === "string" ? `${env.HOME}/.local/state/den/user-bus` : undefined].filter((p) => typeof p === "string" && ABS_RE.test(p));
  for (const bus of others) if (isSocket(bus)) return { env: { ...base, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` } };
  // The usual cause on WSL: a second mount on the runtime directory hides the manager's sockets.
  const mounts = (read("/proc/self/mountinfo") ?? "").split("\n").filter((line) => line.split(" ")[4] === runtimeDir).length;
  const why = mounts > 1 ? `; ${mounts} mounts are stacked on ${runtimeDir}, and the upper one hides it` : "";
  return { reason: `the user service manager's bus is not reachable at ${runtimeDir}/bus${why}` };
}

/** The control group a process is in ("/user.slice/..."), or null. */
export const cgroupOf = (pid) => /^0::(\/.*)$/m.exec(read(`/proc/${pid}/cgroup`) ?? "")?.[1] ?? null;

function makeGroup(unit, dir, gate) {
  return {
    unit,
    dir,
    /** SIGKILL to every process in the group, whatever session or process group it moved to; the anchor goes with them. */
    kill() {
      gate?.destroy();
      try {
        writeFileSync(path.join(dir, "cgroup.kill"), "1");
      } catch {
        // the group is already gone
      }
    },
    /** Which hard limit the group has hit since it started, if any; readable until kill(). A full CPU quota only throttles. */
    exhausted() {
      if (counter(read(path.join(dir, "memory.events")), "oom_kill") > 0) return "memory";
      if (counter(read(path.join(dir, "pids.events")), "max") > 0) return "processes";
      return null;
    },
    /** Resolves true once no process is left in the group (or the group is gone), false after `ms`. */
    async settled(ms) {
      const until = Date.now() + ms;
      for (;;) {
        const procs = read(path.join(dir, "cgroup.procs"));
        if (procs === null || procs === "") return true;
        if (Date.now() >= until) return false;
        await sleep(20);
      }
    },
  };
}

// ---- job storage ----------------------------------------------------------------------------
// The kernel bounds one file (RLIMIT_FSIZE, above). The whole of a run's work area is watched from outside: once it
// passes the bound the run is ended as a storage failure. This is a monitor, not a quota: between two looks a run can
// write past the bound, and files outside the watched directory (temporary files, git objects) are not counted. A
// quota-backed volume is the hard bound and is not built yet.
export const STORAGE_POLL_MS = 10_000;
/** The disk space under `dir` in bytes (blocks in use, so a sparse file counts what it holds), or null when it cannot be read. */
export const measureTree = (dir, { exec = execFile } = {}) =>
  new Promise((resolve) => exec("du", ["-sk", "--", dir], { timeout: 30_000 }, (err, out) => {
    const kib = Number(/^(\d+)\s/.exec(String(out ?? ""))?.[1] ?? NaN);
    resolve(Number.isFinite(kib) ? kib * 1024 : null); // du exits non-zero for a file that vanished mid-walk; the total still counts
  }));
/** Calls onOver(bytes) once when `dir` passes `limitBytes`. -> stop(). One measurement at a time; an unreadable one is skipped. */
export function watchStorage({ dir, limitBytes, onOver, intervalMs = STORAGE_POLL_MS, measure = measureTree }) {
  let busy = false;
  let done = false;
  const timer = setInterval(async () => {
    if (busy || done) return;
    busy = true;
    const bytes = await measure(dir).catch(() => null);
    busy = false;
    if (done || bytes === null || bytes <= limitBytes) return;
    done = true;
    clearInterval(timer);
    onOver(bytes);
  }, intervalMs);
  timer.unref?.();
  return () => {
    done = true;
    clearInterval(timer);
  };
}

const SCOPE_WAIT_MS = 5000; // how long systemd-run gets to put the child in its scope
const PREFLIGHT_TTL_MS = 60_000; // a passed probe is believed this long; a failed one is asked again every time
const KILL_SETTLE_MS = 2000;

export function createResourceLauncher({ env = process.env, limits = LIMITS, slice = "den-agents", spawn = spawnChild, exec = execFile } = {}) {
  checkLimits(limits);
  if (!SLICE_RE.test(slice)) throw new TypeError("createResourceLauncher: bad slice name");
  let passed = 0; // when the last probe passed
  let probing = null;
  let probes = 0;

  const run = (file, args, busEnv) =>
    new Promise((resolve) => exec(file, args, { env: busEnv, timeout: SCOPE_WAIT_MS }, (err, _out, stderr) => resolve(err ? oneLine(stderr) || oneLine(err.message) : null)));

  const checkRun = ({ slotClass, id }) => {
    if (!SLOT_CLASSES.includes(slotClass)) throw new TypeError("resource launcher: unknown slot class");
    if (typeof id !== "string" || !UNIT_ID_RE.test(id)) throw new TypeError("resource launcher: id must be a plain lower-case name");
  };

  // Starts the command in its scope and returns once the child is known to be inside it with every limit applied.
  // Until then the command waits at the gate; only a start that passed every check releases it.
  async function start({ slotClass, id, bin, args, cwd, env: childEnv, prefix, writeScope, privateDirs = [] }) {
    checkRun({ slotClass, id });
    if (process.platform !== "linux") throw new EnforcementError("hardware limits need Linux control groups; this host has none");
    if (read(path.join(CGROUP_ROOT, "cgroup.controllers")) === null) throw new EnforcementError("control groups v2 are not mounted at /sys/fs/cgroup");
    const wrapper = onPath("bwrap", env?.PATH ?? process.env.PATH);
    if (wrapper === null) throw new EnforcementError("bwrap is not installed; a run cannot be kept from loosening its own limits without it");
    const bus = findUserBus(env);
    if (!bus.env) throw new EnforcementError(bus.reason);
    const limit = limits.classes[slotClass];
    const unit = `${prefix}-${id}.scope`;
    // The slice bounds every agent together. Set on each start: it is one cheap call, and a restarted manager forgets it.
    const sliceFailed = await run("systemctl", ["--user", "set-property", "--runtime", `${slice}.slice`, ...groupProperties(limits.aggregate)], bus.env);
    if (sliceFailed !== null) throw new EnforcementError(`could not set the limits of ${slice}.slice: ${sliceFailed}`);
    const { hide, hideSockets } = busPlaces(env);
    let scoped;
    let child;
    try {
      scoped = writeScope === undefined ? undefined : prepareWriteScope(writeScope);
      if (privateDirs.some((dir) => realpathSync(dir) !== dir || !lstatSync(dir).isDirectory())) throw new Error("private filesystem directories must exist and be canonical");
      const argv = buildScopeArgv({ unit, slice, limit, fileBytes: limits.storage.jobMiB * MIB, bin, args, wrapper, hide, hideSockets, writeScope: scoped, cwd, privateDirs });
      child = spawn("systemd-run", argv, { shell: false, detached: true, cwd, env: { ...childEnv, ...bus.env }, stdio: ["pipe", "pipe", "pipe", "pipe", ...(scoped?.stdio ?? [])] });
    } catch (err) {
      throw new EnforcementError(`could not prepare the scoped filesystem: ${err.message}`);
    } finally {
      scoped?.close();
    }
    const gate = child.stdio?.[3];
    gate?.on("error", () => {});
    let stderr = "";
    const onStderr = (chunk) => {
      if (stderr.length < 4096) stderr += String(chunk);
    };
    child.stderr.on("data", onStderr);
    let gone = false;
    child.once("exit", () => (gone = true));
    try {
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", resolve);
      });
    } catch (err) {
      throw new EnforcementError(`systemd-run could not be started: ${oneLine(err?.message)}`);
    }
    child.on("error", () => {});
    const refuse = (reason, group) => {
      gate?.destroy();
      group?.kill();
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
      return new EnforcementError(reason);
    };
    const until = Date.now() + SCOPE_WAIT_MS;
    let cg = null;
    while (Date.now() < until && !gone) {
      cg = cgroupOf(child.pid);
      if (cg !== null && cg.endsWith(`/${slice}.slice/${unit}`)) break;
      cg = null;
      await sleep(15);
    }
    if (cg === null) throw refuse(gone ? `systemd-run did not start the scope: ${oneLine(stderr) || "it exited"}` : `the child was not in ${unit} after ${SCOPE_WAIT_MS} ms`);
    if (!gate) throw refuse("the launcher has no start gate to the child");
    const group = makeGroup(unit, path.join(CGROUP_ROOT, cg), gate);
    for (const [dir, want, what] of [[group.dir, groupFiles(limit), unit], [path.dirname(group.dir), groupFiles(limits.aggregate), `${slice}.slice`]]) {
      for (const [file, value] of Object.entries(want)) {
        const got = read(path.join(dir, file));
        if (got !== value) throw refuse(`${what} has ${file} = ${got ?? "(unreadable)"}, not ${value}; the limits are not applied`, group);
      }
    }
    child.stderr.off("data", onStderr);
    gate.resume(); // nothing is read from the child's side; the pipe stays open for the anchor until group.kill()
    gate.write("go\n");
    return { child, group };
  }

  // One real start of a small process through the same code an agent takes. It tries to loosen its own limits and to
  // reach the service manager; the host is refused if any attempt works, or if it cannot be told.
  async function probe() {
    try {
      const { sockets } = busPlaces(env);
      const { child, group } = await start({ slotClass: "worker", id: `${process.pid}-${(probes += 1)}`, bin: "/bin/sh", args: ["-c", PROBE_SCRIPT, "den-probe", ...sockets], cwd: "/", env: { PATH: env?.PATH ?? process.env.PATH }, prefix: "den-probe" });
      child.stdin.on("error", () => {});
      let out = "";
      child.stdout.on("data", (c) => out.length < 4096 && (out += c));
      child.stderr.resume();
      const code = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), SCOPE_WAIT_MS);
        child.once("exit", (c) => (clearTimeout(timer), resolve(c)));
      });
      group.kill();
      const verdict = judgeProbe(code, out);
      if (verdict !== null) return { ok: false, reason: verdict };
      if (!(await group.settled(KILL_SETTLE_MS))) return { ok: false, reason: `the probe's processes outlived a kill of ${group.unit}` };
      passed = Date.now();
      return { ok: true };
    } catch (err) {
      if (err instanceof EnforcementError) return { ok: false, reason: err.reason };
      throw err;
    }
  }

  function preflight() {
    if (Date.now() - passed < PREFLIGHT_TTL_MS) return Promise.resolve({ ok: true });
    return (probing ??= probe().finally(() => (probing = null)));
  }

  // den-mvp outcome 2: whether a run's scope still exists, asked by its name (never by a stored pid). The host asks
  // before a follow-up reuses the session of a run with no recorded end. An answer it cannot read rejects.
  function active(id) {
    if (typeof id !== "string" || !UNIT_ID_RE.test(id)) return Promise.reject(new TypeError("resource launcher: id must be a plain lower-case name"));
    const bus = findUserBus(env);
    if (!bus.env) return Promise.reject(new EnforcementError(bus.reason));
    const unit = `den-run-${id}.scope`;
    return new Promise((resolve, reject) =>
      exec("systemctl", ["--user", "is-active", unit], { env: bus.env, timeout: SCOPE_WAIT_MS }, (_err, out) => {
        const state = String(out ?? "").trim();
        if (["inactive", "failed"].includes(state)) return resolve(false);
        if (["active", "activating", "deactivating", "reloading"].includes(state)) return resolve(true);
        reject(new EnforcementError(`could not tell whether ${unit} is still running`));
      }));
  }

  return {
    enforced: true,
    scopedWrites: true,
    limits,
    slice,
    preflight,
    active,
    async launch({ slotClass, id, bin, args, cwd, env: childEnv, writeScope, privateDirs }) {
      checkRun({ slotClass, id });
      const ready = await preflight();
      if (!ready.ok) throw new EnforcementError(ready.reason);
      return start({ slotClass, id, bin, args, cwd, env: childEnv, prefix: "den-run", writeScope, privateDirs });
    },
  };
}
