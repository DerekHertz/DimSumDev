// den-mvp outcome 1 (spec section 2, "Hardware" in Testing Decisions): the resource group around every agent.
//   pure      the limits file, the systemd-run argv, the control-group values they must produce
//   refusal   a host whose user service manager cannot be reached starts nothing, and says why
//   live      real processes under reduced limits, through the same launcher production uses. These need a reachable
//             user service manager; where there is none they are skipped, and the skip reason is the launcher's own.
// The probes are small and bounded: a few hundred MiB at most, a few dozen processes, a few seconds.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn as spawnChild, execFile } from "node:child_process";
import { EnforcementError, GATE_REFUSED, LIMITS, OOM_SCORE, START_GATE, buildScopeArgv, busPlaces, cgroupOf, checkLimits, createResourceLauncher, findUserBus, groupFiles, groupProperties, judgeProbe, PROBE_SCRIPT, measureTree, watchStorage } from "./resource-group.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { hostPid } from "./launcher-test-helpers.mjs";
import { SLOTS } from "./policy.mjs";

const MIB = 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, { ms = 8000, what = "the condition" } = {}) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(25);
  }
};

describe("limits.json: the spec's defaults", () => {
  test("two workers at 2 GiB / one CPU / 256 processes; Bao at 1 GiB / half a CPU / 128; no scout class (team-and-den-ux/57)", () => {
    assert.deepEqual(LIMITS.classes.worker, { memoryMiB: 2048, cpuPercent: 100, tasks: 256 });
    assert.deepEqual(LIMITS.classes.bao, { memoryMiB: 1024, cpuPercent: 50, tasks: 128 });
    assert.deepEqual(Object.keys(LIMITS.classes), ["worker", "bao"]);
    assert.deepEqual(LIMITS.aggregate, { memoryMiB: 6144, cpuPercent: 300, tasks: 768 });
    assert.deepEqual(LIMITS.storage, { jobMiB: 4096, outputMiB: 20 });
    assert.deepEqual(LIMITS.checks, { memoryMiB: 4096, cpuPercent: 400, tasks: 1024 }, "den-mvp/34: the den's checks, one run at a time");
    assert.deepEqual(LIMITS.guard, { memoryMiB: 2048, cpuPercent: 200, tasks: 512 }, "den-mvp/70: the test guard's own group");
  });

  test("den-mvp/70: the guard's limits and slice are its own, apart from the checks'", async () => {
    const { guardLimits, GUARD_SLICE, CHECKS_SLICE } = await import("./resource-group.mjs");
    const l = guardLimits();
    assert.deepEqual(l.classes.worker, LIMITS.guard);
    assert.deepEqual(l.aggregate, LIMITS.guard);
    assert.notEqual(GUARD_SLICE, CHECKS_SLICE, "a guard rerun and a checks run must not share a slice aggregate");
    assert.ok(LIMITS.guard.memoryMiB < LIMITS.checks.memoryMiB);
  });

  test("den-mvp/34: a checks launcher's limits put the checks group on its worker class and as its slice's aggregate", async () => {
    const { checksLimits } = await import("./resource-group.mjs");
    const l = checksLimits();
    assert.deepEqual(l.classes.worker, LIMITS.checks);
    assert.deepEqual(l.aggregate, LIMITS.checks);
    assert.deepEqual(l.classes.bao, LIMITS.classes.bao);
    assert.deepEqual(LIMITS.classes.worker, { memoryMiB: 2048, cpuPercent: 100, tasks: 256 }, "the agents' own limits are unchanged");
  });

  test("every slot at its class limit fits inside the aggregate", () => {
    for (const key of ["memoryMiB", "cpuPercent", "tasks"]) {
      const sum = Object.entries(SLOTS).reduce((n, [cls, slots]) => n + slots * LIMITS.classes[cls][key], 0);
      assert.ok(sum <= LIMITS.aggregate[key], `${key}: ${sum} > ${LIMITS.aggregate[key]}`);
    }
  });

  test("bad data is refused at load: a missing class, an extra key, a limit of zero, a string", () => {
    const good = JSON.parse(JSON.stringify(LIMITS));
    assert.doesNotThrow(() => checkLimits(good));
    const bad = (edit) => {
      const copy = JSON.parse(JSON.stringify(LIMITS));
      edit(copy);
      assert.throws(() => checkLimits(copy), /bad limits data/);
    };
    bad((l) => delete l.classes.bao);
    bad((l) => (l.classes.extra = l.classes.worker));
    bad((l) => (l.unlimited = true));
    bad((l) => (l.classes.worker.memoryMiB = 0));
    bad((l) => (l.aggregate.tasks = "768"));
    bad((l) => (l.classes.worker.swap = true));
    bad((l) => delete l.storage.jobMiB);
    bad((l) => delete l.checks);
    bad((l) => (l.checks.cpuPercent = 0));
    bad((l) => delete l.guard);
    bad((l) => (l.guard.tasks = 0));
  });
});

describe("the scope argv and the values it must produce", () => {
  const limit = { memoryMiB: 2048, cpuPercent: 100, tasks: 256 };
  const argv = buildScopeArgv({ unit: "den-run-abc.scope", slice: "den-agents", limit, fileBytes: 4096 * MIB, bin: "claude", args: ["-p", "--agent", "sre"] });

  test("systemd cannot expand dollars in the start gate or the command's arguments", () => {
    const script='printf "%s\\n" "$$" "$HOME" "${literal}"';
    const command=buildScopeArgv({unit:"den-run-literal.scope",slice:"den-agents",limit,fileBytes:4096*MIB,bin:"sh",args:["-c",script]});
    assert.ok(command.indexOf("--expand-environment=no")>=0&&command.indexOf("--expand-environment=no")<command.indexOf("--"));
    assert.equal(command[command.indexOf("den-gate")-1],START_GATE);
    assert.equal(command.at(-1),script);
  });

  test("a user scope in the agents slice with memory, no swap, CPU and process limits", () => {
    assert.deepEqual(argv.slice(0, 8), ["--user", "--scope", "--quiet", "--collect", "--unit", "den-run-abc.scope", "--slice", "den-agents.slice"]);
    const props = argv.filter((_, i) => argv[i - 1] === "-p" && i < argv.indexOf("--"));
    assert.deepEqual(props, ["MemoryMax=2147483648", "MemorySwapMax=0", "CPUQuota=100%", "TasksMax=256", "OOMPolicy=continue"]);
    assert.deepEqual(groupProperties(limit), props.slice(0, 4));
  });

  test("the launcher's bus variables are removed before the CLI, and the CLI's own flags are never read as the launcher's", () => {
    const rest = argv.slice(argv.indexOf("--") + 1);
    assert.deepEqual(rest, ["env", "-u", "XDG_RUNTIME_DIR", "-u", "DBUS_SESSION_BUS_ADDRESS", "prlimit", "--fsize=4294967296:4294967296", "--", "/bin/sh", "-c", START_GATE, "den-gate", "bwrap", "--dev-bind", "/", "/", "--unshare-pid", "--proc", "/proc", "--ro-bind", "/sys/fs/cgroup", "/sys/fs/cgroup", "--die-with-parent", "--", "claude", "-p", "--agent", "sre"]);
  });

  test("the gate runs the command only on the launcher's word: a closed pipe or another word ends it with the refusal code", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "den-gate-"));
    const through = (word, name) =>
      new Promise((resolve) => {
        const child = spawnChild("/bin/sh", ["-c", START_GATE, "den-gate", "touch", path.join(dir, name)], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
        child.stdio[3].on("error", () => {});
        if (word === null) child.stdio[3].destroy();
        else child.stdio[3].end(word);
        child.once("exit", (code) => resolve(code));
      });
    try {
      assert.equal(await through("go\n", "released"), 0, "and the anchor ends with the pipe");
      assert.equal(existsSync(path.join(dir, "released")), true);
      for (const [word, name] of [[null, "closed"], ["", "empty"], ["no\n", "other"], ["go", "unfinished"], ["go go\n", "more"]]) {
        assert.equal(await through(word, name), GATE_REFUSED, name);
        assert.equal(existsSync(path.join(dir, name)), false, name);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // den.slice holds the bridge and every group: when it fills, the kernel must pick a run, not the bridge (score 100 from the user manager).
  test("a released command runs with OOM score 500, so a run is killed before the bridge", async () => {
    const out = await new Promise((resolve) => {
      const child = spawnChild("/bin/sh", ["-c", START_GATE, "den-gate", "cat", "/proc/self/oom_score_adj"], { stdio: ["ignore", "pipe", "ignore", "pipe"] });
      let text = "";
      child.stdout.on("data", (d) => (text += d));
      child.stdio[3].on("error", () => {});
      child.stdio[3].end("go\n");
      child.once("close", () => resolve(text.trim()));
    });
    assert.equal(out, String(OOM_SCORE));
    assert.equal(OOM_SCORE, 500);
  });

  test("the control-group files that prove the limits", () => {
    assert.deepEqual(groupFiles(limit), { "memory.max": "2147483648", "memory.swap.max": "0", "pids.max": "256", "cpu.max": "100000 100000" });
    assert.equal(groupFiles({ memoryMiB: 1024, cpuPercent: 50, tasks: 128 })["cpu.max"], "50000 100000");
    assert.equal(groupFiles(LIMITS.aggregate)["cpu.max"], "300000 100000");
  });

  test("a unit, slice or command that is not plain is a TypeError, never a looser argv", () => {
    const ok = { unit: "den-run-abc.scope", slice: "den-agents", limit, fileBytes: MIB, bin: "claude", args: [] };
    for (const edit of [{ unit: "x.service" }, { unit: "-p.scope" }, { unit: "a b.scope" }, { slice: "den agents" }, { slice: "../x" }, { limit: { ...limit, tasks: 0 } }, { fileBytes: 0 }, { bin: "" }, { args: [1] }]) {
      assert.throws(() => buildScopeArgv({ ...ok, ...edit }), TypeError, JSON.stringify(edit));
    }
  });
});

describe("a host that cannot enforce the limits starts nothing", () => {
  const dirs = [];
  after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });
  // CI has no bwrap: these hosts get a stand-in on PATH so the refusal under test is the bus's, not the wrapper's.
  const emptyHost = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "den-nobus-"));
    dirs.push(dir);
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "bwrap"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    return { PATH: `${bin}:${process.env.PATH}`, HOME: dir, XDG_RUNTIME_DIR: dir };
  };

  test("no reachable bus: findUserBus gives a reason that names the place it looked", async () => {
    const env = await emptyHost();
    const found = findUserBus(env);
    assert.equal(found.env, undefined);
    assert.match(found.reason, /user service manager's bus is not reachable/);
    assert.ok(found.reason.includes(`${env.XDG_RUNTIME_DIR}/bus`));
  });

  test("preflight fails with that reason, launch rejects with an EnforcementError, and no process is spawned", async () => {
    let spawns = 0;
    const launcher = createResourceLauncher({ env: await emptyHost(), spawn: () => (spawns += 1, assert.fail("nothing may be spawned")) });
    const check = await launcher.preflight();
    assert.equal(check.ok, false);
    assert.match(check.reason, /bus is not reachable/);
    await assert.rejects(launcher.launch({ slotClass: "worker", id: "abc", bin: "sleep", args: ["1"], cwd: "/", env: {} }), (err) => err instanceof EnforcementError && /bus is not reachable/.test(err.reason));
    assert.equal(spawns, 0);
  });

  test("a host without bwrap is refused at startup, with the reason, and nothing is spawned", async () => {
    const launcher = createResourceLauncher({ env: { PATH: "/nonexistent" }, spawn: () => assert.fail("nothing may be spawned") });
    const check = await launcher.preflight();
    assert.equal(check.ok, false);
    assert.match(check.reason, /bwrap is not installed/);
  });

  test("the default runtime is the enforced one: its spawn rejects and the binary it names is never run", async () => {
    const env = await emptyHost();
    const marker = path.join(env.HOME, "ran");
    const runtime = createClaudeRuntime({ controlRoot: "/", env: { ...env, DEN_CLAUDE_BIN: "touch" } });
    assert.equal(runtime.enforced, true);
    assert.equal((await runtime.preflight()).ok, false);
    await assert.rejects(runtime.spawn({ role: "sre", cwd: env.HOME, prompt: marker, sessionId: "0f8fad5b-d9cb-469f-a165-70867728950e" }), { name: "EnforcementError" });
    await sleep(100);
    assert.equal(existsSync(marker), false);
  });

  test("an unknown slot class or an id that is not a plain name is a TypeError before anything else, on any host", async () => {
    const launcher = createResourceLauncher({ env: process.env, spawn: () => assert.fail("nothing may be spawned"), exec: () => assert.fail("nothing may be run") });
    await assert.rejects(launcher.launch({ slotClass: "huge", id: "abc", bin: "true", args: [], cwd: "/", env: {} }), TypeError);
    await assert.rejects(launcher.launch({ slotClass: "worker", id: "A B", bin: "true", args: [], cwd: "/", env: {} }), TypeError);
  });
});

describe("the probe's verdict", () => {
  test("only a clean exit that said 'contained' passes; any named attempt, a bad code or no answer is a refusal with its reason", () => {
    assert.equal(judgeProbe(0, "contained\n"), null);
    assert.match(judgeProbe(1, "limit file /x/memory.max was writable\n"), /was writable/);
    assert.match(judgeProbe(1, "the service manager's bus socket /run/user/1/bus is visible\n"), /is visible/);
    assert.match(judgeProbe(0, "the process moved itself to the root control group\n"), /moved itself/);
    assert.match(judgeProbe(1, "the service manager answered a connection\n"), /answered a connection/);
    assert.match(judgeProbe(0, ""), /code 0/);
    assert.match(judgeProbe(null, ""), /no answer/);
    assert.match(judgeProbe(1, "", "bwrap: Creating new namespace failed: Operation not permitted\n"), /code 1.*bwrap: Creating new namespace failed: Operation not permitted/);
  });
});

describe("active(id) without a readable answer", () => {
  test("no bus, or an answer that is not a state, rejects: unknown is never read as gone", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "den-nobus-"));
    await assert.rejects(createResourceLauncher({ env: { PATH: process.env.PATH, HOME: dir, XDG_RUNTIME_DIR: dir } }).active("abc"), EnforcementError);
    const odd = createResourceLauncher({ env: process.env, exec: (_f, _a, _o, cb) => cb(new Error("boom"), "", "Failed to connect to bus") });
    if (findUserBus(process.env).env) await assert.rejects(odd.active("abc"), /could not tell whether den-run-abc\.scope is still running/);
  });
});

describe("job storage: the monitor around a run's work area", () => {
  test("measureTree reads real disk use, and a directory that is not there is null", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "den-du-"));
    try {
      const before = await measureTree(dir);
      await writeFile(path.join(dir, "blob"), Buffer.alloc(3 * MIB, 1));
      const after = await measureTree(dir);
      assert.ok(after - before >= 3 * MIB && after - before < 4 * MIB, `${before} -> ${after}`);
      assert.equal(await measureTree(path.join(dir, "missing")), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a work area that passes the bound calls onOver once, with what was measured; under the bound it stays quiet", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "den-watch-"));
    const calls = [];
    const stop = watchStorage({ dir, limitBytes: 1 * MIB, intervalMs: 30, onOver: (bytes) => calls.push(bytes) });
    try {
      await sleep(150);
      assert.deepEqual(calls, [], "an empty directory is under the bound");
      await writeFile(path.join(dir, "blob"), Buffer.alloc(2 * MIB, 1));
      await until(() => calls.length > 0, { ms: 5000, what: "the monitor to notice" });
      await sleep(150);
      assert.equal(calls.length, 1, "once, not on every look");
      assert.ok(calls[0] > 1 * MIB);
    } finally {
      stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable measurement is skipped, and stop() ends the watch", async () => {
    const calls = [];
    let looks = 0;
    const stop = watchStorage({ dir: "/nowhere", limitBytes: 1, intervalMs: 10, onOver: (b) => calls.push(b), measure: async () => ((looks += 1), looks < 3 ? null : 5) });
    await until(() => calls.length === 1, { ms: 2000, what: "the third look" });
    stop();
    const seen = looks;
    await sleep(60);
    assert.equal(looks, seen, "no look after stop()");
  });
});

// ---- live: real processes under reduced limits ------------------------------------------------
const production = await createResourceLauncher({ env: process.env }).preflight();
const skip = production.ok ? false : `this host cannot enforce the limits: ${production.reason}`;
const TEST_LIMITS = { classes: { worker: { memoryMiB: 96, cpuPercent: 20, tasks: 24 }, bao: { memoryMiB: 64, cpuPercent: 10, tasks: 16 } }, aggregate: { memoryMiB: 256, cpuPercent: 40, tasks: 64 }, storage: { jobMiB: 1, outputMiB: 1 }, checks: { memoryMiB: 96, cpuPercent: 20, tasks: 24 }, guard: { memoryMiB: 96, cpuPercent: 20, tasks: 24 } };
const SLICE = `den-test-p${process.pid}`;
let seq = 0;

describe("live: the launcher under reduced limits", { skip }, () => {
  const launcher = createResourceLauncher({ env: process.env, limits: TEST_LIMITS, slice: SLICE });
  const open = [];
  after(async () => {
    for (const { group } of open) group.kill();
    // The slice and its limits were made for this run only; drop both so no test leaves a unit behind.
    for (const verb of ["revert", "stop"]) await new Promise((resolve) => execFile("systemctl", ["--user", verb, `${SLICE}.slice`], { env: findUserBus(process.env).env, timeout: 5000 }, () => resolve()));
  });
  const start = async (script, slotClass = "worker", cwd = "/") => {
    const run = await launcher.launch({ slotClass, id: `t${process.pid}-${(seq += 1)}`, bin: "sh", args: ["-c", script], cwd, env: { PATH: process.env.PATH } });
    open.push(run);
    run.out = "";
    run.child.stdout.on("data", (c) => (run.out += c));
    run.child.stderr.resume();
    run.child.stdin.on("error", () => {});
    run.exit = new Promise((resolve) => run.child.once("exit", (code, signal) => resolve({ code, signal })));
    return run;
  };
  const value = (group, file) => readFileSync(path.join(group.dir, file), "utf8").trim();
  // den-mvp/35: a command's $$ is its number inside the run's private pid namespace; the host's /proc knows it by another.
  const hostPids = (run, nsPids) => nsPids.map((n) => hostPid(n, `/${SLICE}.slice/${run.group.unit}`) ?? assert.fail(`no host process is pid ${n} in ${run.group.unit}`));

  test("a child and its grandchild are in the run's own scope, with the class limits and the slice's aggregate read back from the kernel", async () => {
    const run = await start("sh -c 'echo $$; sleep 20' & echo $$; wait");
    await until(() => run.out.trim().split("\n").length >= 2, { what: "both pids" });
    const pids = hostPids(run, run.out.trim().split("\n"));
    const members = value(run.group, "cgroup.procs").split("\n").map(Number);
    for (const pid of pids) assert.ok(members.includes(pid) && (cgroupOf(pid) ?? "").endsWith(`/${SLICE}.slice/${run.group.unit}`), `pid ${pid} is in ${cgroupOf(pid)}`);
    for (const [file, want] of Object.entries(groupFiles(TEST_LIMITS.classes.worker))) assert.equal(value(run.group, file), want, file);
    for (const [file, want] of Object.entries(groupFiles(TEST_LIMITS.aggregate))) assert.equal(readFileSync(path.join(path.dirname(run.group.dir), file), "utf8").trim(), want, `slice ${file}`);
    assert.notEqual(cgroupOf(process.pid), cgroupOf(pids[0]), "the bridge's own process is outside the agents' group");
    run.group.kill();
    assert.equal(await run.group.settled(3000), true);
  });

  // den-mvp outcome 2: asked before a follow-up reuses the session of a run with no recorded end.
  test("active(id) says whether a run's scope is still there, by name", async () => {
    const run = await start("sleep 20");
    const id = run.group.unit.replace(/^den-run-|\.scope$/g, "");
    assert.equal(await launcher.active(id), true);
    run.group.kill();
    assert.equal(await run.group.settled(3000), true);
    await until(async () => (await launcher.active(id)) === false, { what: "the scope to be gone" });
    assert.equal(await launcher.active(`never-${process.pid}`), false);
    await assert.rejects(launcher.active("A B"), TypeError);
  });

  test("a run cannot change its own or the slice's limit files, leave its group, or reach the service manager's bus", async () => {
    const bus = findUserBus(process.env).env;
    const addr = bus.DBUS_SESSION_BUS_ADDRESS.replace(/^unix:path=/, "");
    const run = await start(`d=/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)
for f in "$d/memory.max" "$d/pids.max" "$d/cpu.max" "$d/../memory.max"; do (echo max > "$f") 2>/dev/null && echo "WROTE $f"; done
(echo $$ > /sys/fs/cgroup/cgroup.procs) 2>/dev/null && echo MOVED
for s in ${addr} ${process.env.HOME}/.local/state/den/user-bus /run/user/$(id -u)/bus; do [ -S "$s" ] && echo "BUS $s"; done
if command -v busctl >/dev/null; then busctl --user --no-pager status >/dev/null 2>&1 && echo "BUS CONNECTED"; fi
if command -v systemctl >/dev/null; then systemctl --user is-system-running >/dev/null 2>&1 && echo "SYSTEMCTL CONNECTED"; fi
echo done`);
    assert.deepEqual(await run.exit, { code: 0, signal: null });
    assert.equal(run.out, "done\n");
    assert.equal(value(run.group, "memory.max"), String(TEST_LIMITS.classes.worker.memoryMiB * MIB));
    run.group.kill();
  });

  test("the probe's own script finds nothing loosened: remounts, a new cgroup2 mount, the slice's files and /proc/<pid>/root included", async () => {
    const bus = findUserBus(process.env).env;
    const addr = bus.DBUS_SESSION_BUS_ADDRESS.replace(/^unix:path=/, "");
    const run = await start(`set -- ${addr}\n${PROBE_SCRIPT}`);
    assert.deepEqual(await run.exit, { code: 0, signal: null });
    assert.match(run.out, /^contained$/m);
    run.group.kill();
  });

  test("the preflight passes here, and a missing bwrap is a refusal with its reason", async () => {
    assert.deepEqual(await launcher.preflight(), { ok: true });
    const bare = createResourceLauncher({ env: { ...process.env, PATH: "/nonexistent" }, limits: TEST_LIMITS, slice: SLICE });
    const check = await bare.preflight();
    assert.equal(check.ok, false);
    assert.match(check.reason, /bwrap is not installed/);
  });

  test("a command that ends at once is still a start: the launcher saw it in its scope before it ran", async () => {
    for (let i = 0; i < 5; i += 1) {
      const run = await start("echo quick");
      assert.deepEqual(await run.exit, { code: 0, signal: null });
      assert.equal(run.out, "quick\n");
      run.group.kill();
    }
  });

  test("a scope whose limits do not read back is refused, and the command behind the gate never ran", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "den-refused-"));
    try {
      // A launcher whose systemd-run call loses the process limit: the scope starts, but the kernel's value is not the class's.
      const loose = createResourceLauncher({
        env: process.env, limits: TEST_LIMITS, slice: SLICE,
        spawn: (file, argv, options) => spawnChild(file, argv.filter((a, i) => !(a.startsWith("TasksMax=") || argv[i + 1]?.startsWith("TasksMax="))), options),
      });
      const marker = path.join(dir, "ran");
      await assert.rejects(
        loose.launch({ slotClass: "worker", id: `t${process.pid}-loose`, bin: "touch", args: [marker], cwd: dir, env: { PATH: process.env.PATH } }),
        (err) => err instanceof EnforcementError && /has pids\.max = \S+, not 24; the limits are not applied/.test(err.reason),
      );
      await sleep(200);
      assert.equal(existsSync(marker), false, "the command did not run");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("memory: a run whose only process is killed still reports it after the exit, until the group is let go", async () => {
    const hog = `exec ${JSON.stringify(process.execPath)} -e "const a=[];setInterval(()=>a.push(Buffer.alloc(8<<20,1)),5)"`;
    for (let i = 0; i < 4; i += 1) {
      const run = await start(hog);
      // bwrap is pid 1 of the run's namespace, so the kernel's kill shows as bwrap's exit with 128 + SIGKILL, not as the launcher's own signal.
      const ended = await run.exit;
      assert.ok(ended.signal === "SIGKILL" || ended.code === 137, `the kernel killed the run's main process: ${JSON.stringify(ended)}`);
      await sleep(150); // long enough for systemd to remove an empty scope
      assert.equal(run.group.exhausted(), "memory");
      run.group.kill();
      assert.equal(await run.group.settled(3000), true);
      await until(() => !existsSync(run.group.dir), { ms: 3000, what: "the scope to be removed once it is let go" });
      assert.equal(run.group.exhausted(), null, "a removed group reads as nothing, never as a limit");
    }
  });

  test("Bao's class gets its own, smaller limits", async () => {
    for (const cls of ["bao"]) {
      const run = await start("sleep 20", cls);
      for (const [file, want] of Object.entries(groupFiles(TEST_LIMITS.classes[cls]))) assert.equal(value(run.group, file), want, `${cls} ${file}`);
      run.group.kill();
      assert.equal(await run.group.settled(3000), true);
    }
  });

  test("memory: a grandchild that goes over the limit is killed by the kernel, and the group reports it", async () => {
    const hog = `${JSON.stringify(process.execPath)} -e "const a=[];for(let i=0;i<40;i++)a.push(Buffer.alloc(8<<20,1));setTimeout(()=>{},20000)"`;
    const run = await start(`${hog}; echo "hog exited $?"; sleep 20`);
    await until(() => run.group.exhausted() !== null, { ms: 15000, what: "an oom kill in the scope" });
    assert.equal(run.group.exhausted(), "memory");
    assert.ok(Number(value(run.group, "memory.peak")) <= TEST_LIMITS.classes.worker.memoryMiB * MIB, "usage never passed the limit");
    run.group.kill();
    assert.equal(await run.group.settled(3000), true);
  });

  test("processes: a fork loop stops at the limit, and the group reports it", async () => {
    const run = await start("i=0; while [ $i -lt 80 ]; do sleep 20 & i=$((i+1)); done; wait");
    await until(() => run.group.exhausted() !== null, { ms: 15000, what: "a refused fork in the scope" });
    assert.equal(run.group.exhausted(), "processes");
    assert.ok(Number(value(run.group, "pids.peak")) <= TEST_LIMITS.classes.worker.tasks);
    run.group.kill();
    assert.equal(await run.group.settled(3000), true);
  });

  test("CPU: a busy loop is throttled, not killed", async () => {
    const run = await start("while :; do :; done");
    await until(() => /^nr_throttled [1-9]/m.test(value(run.group, "cpu.stat")), { ms: 10000, what: "the scope to be throttled" });
    assert.equal(run.group.exhausted(), null, "a full CPU quota is not a failure");
    assert.equal(run.child.exitCode, null, "the process is still running");
    run.group.kill();
    assert.equal(await run.group.settled(3000), true);
  });

  test("storage: no single file may pass the job-storage bound", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "den-fsize-"));
    try {
      const run = await start("head -c 3145728 /dev/zero > big; echo done", "worker", dir);
      await run.exit;
      run.group.kill();
      assert.ok((await stat(path.join(dir, "big"))).size <= TEST_LIMITS.storage.jobMiB * MIB, "the file stopped at the bound");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stop: a kill of the group leaves no descendant, not even one that started its own session", async () => {
    const run = await start("setsid sh -c 'echo $$; exec sleep 60' & sh -c 'echo $$; sleep 60' & echo $$; wait");
    await until(() => run.out.trim().split("\n").length >= 3, { what: "three pids" });
    const pids = hostPids(run, run.out.trim().split("\n"));
    for (const pid of pids) assert.ok(existsSync(`/proc/${pid}`), `pid ${pid} is running`);
    run.group.kill();
    assert.equal(await run.group.settled(3000), true);
    await run.exit;
    await until(() => pids.every((pid) => !existsSync(`/proc/${pid}`)), { ms: 3000, what: "every descendant to be gone" });
  });

  test("aggregate: the slice bounds all runs together, below the sum of what each could take alone", async () => {
    const runs = [await start("sleep 20"), await start("sleep 20"), await start("sleep 20", "bao"), await start("sleep 20")];
    const slice = path.dirname(runs[0].group.dir);
    for (const run of runs) assert.equal(path.dirname(run.group.dir), slice, "every run is under the one slice");
    assert.equal(readFileSync(path.join(slice, "memory.max"), "utf8").trim(), String(TEST_LIMITS.aggregate.memoryMiB * MIB));
    assert.equal(readFileSync(path.join(slice, "pids.max"), "utf8").trim(), String(TEST_LIMITS.aggregate.tasks));
    for (const run of runs) run.group.kill();
    for (const run of runs) assert.equal(await run.group.settled(3000), true);
  });

  test("aggregate: runs that each stay under their own process limit are stopped together at the slice's", async () => {
    // Each run holds four processes before its first fork (den-mvp/35): the shell, the two bwrap processes of its pid namespace
    // (the outer one and the namespace's pid 1) and the anchor. So 19 + 19 + 8 forks make 23 + 23 + 12 = 58 under the slice's 64;
    // a fourth, worker run of 12 forks (16 with its own four, under its own 24) is stopped by the slice after two more.
    const forks = (n) => `i=0; while [ $i -lt ${n} ]; do sleep 20 & i=$((i+1)); done; echo ok; wait`;
    for (const { group } of open) group.kill();
    if (open.length) await until(() => readFileSync(path.join(path.dirname(open[0].group.dir), "pids.current"), "utf8").trim() === "0", { what: "the slice to be empty of earlier runs" });
    const first = [await start(forks(19)), await start(forks(19)), await start(forks(8), "bao")];
    for (const run of first) await until(() => run.out === "ok\n", { what: "a run under the aggregate to finish its forks" });
    const last = await start(forks(12));
    const slice = path.dirname(last.group.dir);
    assert.notEqual((await last.exit).code, 0, "the shell's fork was refused");
    assert.equal(last.out, "", "it never reached the end of its loop");
    assert.ok(Number(readFileSync(path.join(slice, "pids.peak"), "utf8")) <= TEST_LIMITS.aggregate.tasks, "the slice never held more than its limit");
    assert.ok(Number(value(last.group, "pids.peak")) < TEST_LIMITS.classes.worker.tasks, "its own limit was not what stopped it");
    for (const run of first) assert.equal(run.group.exhausted(), null, "the runs under the aggregate are not failed");
    for (const run of [...first, last]) run.group.kill();
    for (const run of [...first, last]) assert.equal(await run.group.settled(3000), true);
  });
});

test("only the bus socket in the den's state folder is hidden, not the folder: the build box reads its packages there", async (t) => {
  const { createServer } = await import("node:net");
  const home = await mkdtemp(path.join(tmpdir(), "den-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const state = path.join(home, ".local", "state", "den");
  await mkdir(path.join(state, "deps"), { recursive: true });
  const sock = path.join(state, "user-bus");
  const server = createServer().listen(sock);
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const { hide, hideSockets } = busPlaces({ HOME: home, XDG_RUNTIME_DIR: path.join(home, "run") }, { uid: 99999 });
  assert.equal(hide.includes(state), false, "the state folder stays visible");
  assert.deepEqual(hideSockets, [sock]);
});

// F39 security review: the system journal holds the bridge's launch URLs, so a run sees the journal directories empty.
test("the journal directories are covered like the bus directories, and the probe fails a run that can read one", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "den-journal-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const journal = path.join(base, "journal");
  await mkdir(journal);
  const { hide } = busPlaces({}, { uid: 99999, journalDirs: [journal, path.join(base, "absent")] });
  assert.ok(hide.includes(journal), "an existing journal directory is covered");
  assert.ok(!hide.includes(path.join(base, "absent")), "a missing one is skipped");
  assert.deepEqual(busPlaces({}, { uid: 99999 }).hide.filter((d) => d.includes("journal")), ["/var/log/journal", "/run/log/journal"].filter((d) => existsSync(d)));
  const argv = buildScopeArgv({ unit: "den-x.scope", slice: "den", limit: LIMITS.classes.worker, fileBytes: 1 << 30, bin: "/bin/true", args: [], hide: [journal] });
  assert.ok(argv.join(" ").includes(`--tmpfs ${journal}`));
  assert.match(PROBE_SCRIPT, /for j in \/var\/log\/journal \/run\/log\/journal; do/);
  assert.ok(PROBE_SCRIPT.indexOf("bad=0") < PROBE_SCRIPT.indexOf("system journal"), "the check is counted, after bad is set");
});
