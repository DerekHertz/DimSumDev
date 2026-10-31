// portable-den/14: the jg wrapper keeps a partial result instead of discarding it, says when discovery was incomplete,
// and cuts a hung jg at a wall-time cap without leaving any process of its group behind.
// Seams: runJg({run}) for result classification, spawnJg(argv, {cmd, timeoutMs, graceMs}) for process handling, and the
// CLI (node scripts/jg.mjs) with a fake `jg` first on PATH for the printed output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const POSIX_ONLY = { skip: process.platform === "win32" && "POSIX process groups" };
import { killTree, resolveJg, runJg, spawnJg } from "./jg.mjs";
import { spawnRun } from "./dispatch-context.mjs";

const JG_MJS = fileURLToPath(new URL("./jg.mjs", import.meta.url));
const REPO = path.dirname(path.dirname(JG_MJS));
const tmp = (p) => mkdtempSync(path.join(realpathSync(tmpdir()), p));
const root = () => {
  const r = tmp("jg14-r-");
  mkdirSync(path.join(r, ".git"));
  writeFileSync(path.join(r, ".git", "HEAD"), "ref: refs/heads/main\n");
  return r;
};
const answer = (stdout, exitCode, extra = {}) => ({ run: async () => ({ stdout, exitCode, ...extra }) });

const INCOMPLETE = [
  "Jevgrep: 3 relevant files; discovery incomplete.",
  'Issue: "resource_limit": 4',
  '- "a.mjs" — implementation; source below',
  "End context.",
  "",
].join("\n");

test("exit 2 with a ranked list returns the list with a partial reason; the row is not a fallback", async () => {
  const r = await runJg({ query: "q", root: root(), ...answer(INCOMPLETE, 2) });
  assert.equal(r.stdout, INCOMPLETE);
  assert.equal(r.row.fallback, false);
  assert.equal(r.row.filesReturned, 3);
  assert.equal(r.row.reason, undefined);
  assert.match(r.row.partial, /jg-exit-2/);
  assert.match(r.row.partial, /discovery incomplete/);
  assert.match(r.row.partial, /resource_limit/);
});

test("a non-zero exit with nothing usable on stdout still falls back to rg", async () => {
  for (const [stdout, code] of [["", 2], ['Provider error: "boom"\n', 2], ["Jevgrep: 0 relevant files; discovery incomplete.\n", 2], ["", 13]]) {
    const r = await runJg({ query: "q", root: root(), ...answer(stdout, code) });
    assert.equal(r.stdout, undefined, `exit ${code} ${JSON.stringify(stdout)}`);
    assert.equal(r.row.fallback, true);
    assert.equal(r.row.reason, `jg-exit-${code}`);
  }
});

test("discovery incomplete on exit 0 is flagged as partial too, so the agent can narrow the root", async () => {
  const r = await runJg({ query: "q", root: root(), ...answer(INCOMPLETE, 0) });
  assert.equal(r.stdout, INCOMPLETE);
  assert.equal(r.row.fallback, false);
  assert.match(r.row.partial, /discovery incomplete/);
  assert.doesNotMatch(r.row.partial, /jg-exit/);
});

test("a complete result carries no partial marker", async () => {
  const r = await runJg({ query: "q", root: root(), ...answer("Jevgrep: 2 relevant files.\nEnd context.\n", 0) });
  assert.equal(r.row.partial, undefined);
  assert.equal(r.row.fallback, false);
});

test("a jg cut at the wall-time cap keeps what it printed; with nothing printed the reason is jg-timeout", async () => {
  const cut = await runJg({ query: "q", root: root(), ...answer(INCOMPLETE + "Interrupted.\n", 130, { timedOut: true }) });
  assert.equal(cut.row.fallback, false);
  assert.match(cut.row.partial, /timed out/);
  const none = await runJg({ query: "q", root: root(), ...answer("", 130, { timedOut: true }) });
  assert.equal(none.row.fallback, true);
  assert.equal(none.row.reason, "jg-timeout");
});

const alive = (pid) => {
  if (!existsSync("/proc/self/stat")) {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
};
const settle = async (pids, ms = 3000) => {
  for (let t = 0; t < ms && pids.some(alive); t += 50) await new Promise((r) => setTimeout(r, 50));
};

// A stand-in jg that ignores SIGINT and SIGTERM, prints a partial list, and leaves a grandchild holding stdout.
function hangingJg() {
  const dir = tmp("jg14-h-");
  const script = path.join(dir, "hang.mjs");
  const pidfile = path.join(dir, "pids");
  writeFileSync(script, [
    'import { spawn } from "node:child_process";',
    'import fs from "node:fs";',
    'process.on("SIGINT", () => {}); process.on("SIGTERM", () => {});',
    'const gc = spawn(process.execPath, ["-e", "process.on(\'SIGINT\',()=>{});process.on(\'SIGTERM\',()=>{});setInterval(()=>{},1000)"], { stdio: ["ignore", "inherit", "inherit"] });',
    'fs.writeFileSync(process.argv[2], process.pid + " " + gc.pid);',
    'process.stdout.write("Jevgrep: 2 relevant files; discovery incomplete.\\n");',
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  return { script, pidfile, pids: () => readFileSync(pidfile, "utf8").split(" ").map(Number) };
}

test("a jg that ignores SIGINT and SIGTERM is cut at the cap and its whole process group is gone", POSIX_ONLY, async () => {
  const h = hangingJg();
  const t0 = Date.now();
  const r = await spawnJg([h.pidfile], { cmd: [process.execPath, h.script], timeoutMs: 400, graceMs: 150 });
  assert.ok(Date.now() - t0 < 3000, "returns shortly after the cap, not when the grandchild lets go");
  assert.equal(r.timedOut, true);
  assert.match(r.stdout, /^Jevgrep: 2 relevant files; discovery incomplete\./);
  const pids = h.pids();
  await settle(pids);
  assert.deepEqual(pids.map(alive), [false, false]);
});

for (const sig of ["SIGTERM", "SIGHUP"]) test(`${sig} to the wrapper itself kills the jg group`, POSIX_ONLY, async () => {
  const h = hangingJg();
  const driver = path.join(path.dirname(h.script), "driver.mjs");
  writeFileSync(driver, `import { spawnJg } from ${JSON.stringify(pathToFileURL(JG_MJS).href)};\nawait spawnJg([${JSON.stringify(h.pidfile)}], { cmd: [process.execPath, ${JSON.stringify(h.script)}], timeoutMs: 60000 });\n`);
  const wrapper = spawn(process.execPath, [driver], { stdio: "ignore" });
  const exited = new Promise((r) => wrapper.on("exit", r));
  for (let i = 0; i < 100 && !existsSync(h.pidfile); i++) await new Promise((r) => setTimeout(r, 50));
  const pids = h.pids();
  assert.deepEqual(pids.map(alive), [true, true]);
  wrapper.kill(sig);
  await exited;
  await settle(pids);
  assert.deepEqual(pids.map(alive), [false, false]);
});

function fakeJgOnPath(body) {
  const bin = tmp("jg14-bin-");
  const file = path.join(bin, "jg");
  writeFileSync(file, `#!/usr/bin/env node\nif (process.argv[2] === "--version") { console.log("0.8.0"); process.exit(0); }\n${body}\n`);
  chmodSync(file, 0o755);
  return bin;
}
const cli = (bin) => spawnSync(process.execPath, [JG_MJS, "where is the wrapper", "scripts"], {
  cwd: REPO, encoding: "utf8", timeout: 30000, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, DEN_ROOT: tmp("jg14-den-") },
});

test("CLI: a partial result prints a one-line 'jg: partial:' warning with the narrow-the-root advice, then the list", () => {
  const out = cli(fakeJgOnPath(`process.stdout.write(${JSON.stringify(INCOMPLETE)}); process.exit(2);`));
  assert.equal(out.status, 0);
  const [first, ...rest] = out.stdout.split("\n");
  assert.match(first, /^jg: partial: jg-exit-2, discovery incomplete \(resource_limit\)/);
  assert.match(first, /narrow the root/);
  assert.equal(rest.join("\n"), INCOMPLETE);
});

test("CLI: a complete result prints no warning; a failure with nothing usable still says to fall back to rg", () => {
  const complete = "Jevgrep: 2 relevant files.\nEnd context.\n";
  assert.equal(cli(fakeJgOnPath(`process.stdout.write(${JSON.stringify(complete)});`)).stdout, complete);
  const failed = cli(fakeJgOnPath("process.exit(2);"));
  assert.equal(failed.stdout, "jg: no result (jg-exit-2); fall back to rg\n");
});

// ── review round: OS-agnostic process handling, one cap, partial detection ───

const fakeChild = (pid = 4242) => Object.assign(new EventEmitter(), { pid, stdout: new PassThrough(), kill: () => true });
const recorder = () => { const calls = []; return { calls, fn: (...a) => { calls.push(a); return new EventEmitter(); } }; };

test("killTree on win32 runs `taskkill /pid <pid> /t /f`, and falls back to child.kill() when taskkill cannot start", () => {
  const rec = recorder();
  killTree(fakeChild(77), "SIGINT", { platform: "win32", spawnFn: rec.fn });
  assert.deepEqual(rec.calls.map(([c, a]) => [c, a]), [["taskkill", ["/pid", "77", "/t", "/f"]]]);

  const killed = [];
  const child = { ...fakeChild(77), kill: (s) => killed.push(s) };
  killTree(child, "SIGTERM", { platform: "win32", spawnFn: () => { throw new Error("spawn taskkill ENOENT"); } });
  const failing = new EventEmitter();
  killTree(child, "SIGKILL", { platform: "win32", spawnFn: () => failing });
  failing.emit("error", new Error("ENOENT"));
  assert.deepEqual(killed, ["SIGTERM", "SIGKILL"]);
});

test("killTree on POSIX signals the whole group (-pid), and signals the child when the group is gone", () => {
  const sent = [];
  killTree(fakeChild(88), "SIGINT", { platform: "linux", kill: (...a) => sent.push(a) });
  assert.deepEqual(sent, [[-88, "SIGINT"]]);
  const killed = [];
  killTree({ ...fakeChild(88), kill: (s) => killed.push(s) }, "SIGTERM", { platform: "linux", kill: () => { throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); } });
  assert.deepEqual(killed, ["SIGTERM"]);
});

test("spawnJg on win32 does not detach, does not use a shell, and cuts the cap with taskkill", async () => {
  const spawns = [];
  const spawnFn = (cmd, args, opts) => {
    spawns.push({ cmd, args, opts });
    return cmd === "taskkill" ? new EventEmitter() : fakeChild(555);
  };
  const r = await spawnJg(["a question"], { cmd: ["jg"], timeoutMs: 120, graceMs: 20, platform: "win32", spawnFn });
  assert.equal(r.timedOut, true);
  const [first, ...rest] = spawns;
  assert.equal(first.opts.detached, false);
  assert.ok(!first.opts.shell, "argv must never reach a shell");
  assert.deepEqual(first.args, ["a question"]);
  assert.ok(rest.length >= 1 && rest.every((s) => s.cmd === "taskkill" && s.args.join(" ") === "/pid 555 /t /f"), JSON.stringify(rest));
});

test("spawnJg on POSIX detaches jg into its own group", async () => {
  const seen = [];
  const spawnFn = (cmd, args, opts) => { seen.push(opts); return fakeChild(556); };
  await spawnJg(["q"], { cmd: ["jg"], timeoutMs: 60, graceMs: 10, platform: "linux", spawnFn, kill: () => {} });
  assert.equal(seen[0].detached, true);
});

const shimDir = "C:\\Users\\me\\AppData\\Roaming\\npm";
const SHIM = '@ECHO off\r\n...\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@dzhng\\jevgrep\\dist\\bin\\index.js" %*\r\n';
const winFs = (files) => ({ exists: (p) => p in files, read: (p) => files[p] });

test("resolveJg: off Windows it is plain `jg`; on Windows it runs the npm shim's JS entry with node, never through a shell", () => {
  assert.deepEqual(resolveJg({ platform: "linux" }), ["jg"]);
  const entry = path.win32.join(shimDir, "node_modules", "@dzhng", "jevgrep", "dist", "bin", "index.js");
  const files = { [path.win32.join(shimDir, "jg.cmd")]: SHIM, [entry]: "// js" };
  const cmd = resolveJg({ platform: "win32", pathEnv: `C:\\Windows;${shimDir}`, ...winFs(files), join: path.win32.join });
  assert.deepEqual(cmd, [process.execPath, entry]);
  assert.deepEqual(resolveJg({ platform: "win32", pathEnv: "C:\\Windows", ...winFs({}), join: path.win32.join }), ["jg"], "no shim: plain jg (a real jg.exe still starts)");
  const odd = { [path.win32.join(shimDir, "jg.cmd")]: "@echo hi & calc.exe\r\n" };
  assert.deepEqual(resolveJg({ platform: "win32", pathEnv: shimDir, ...winFs(odd), join: path.win32.join }), ["jg"], "a shim that names no JS entry is not run");
});

test("one cap covers the whole call: the escalation is inside the cap, not added to it", POSIX_ONLY, async () => {
  const h = hangingJg();
  const t0 = Date.now();
  const r = await spawnJg([h.pidfile], { cmd: [process.execPath, h.script], timeoutMs: 600, graceMs: 150 });
  const took = Date.now() - t0;
  assert.equal(r.timedOut, true);
  assert.ok(took < 800, `cap 600 ms with a 300 ms escalation returned after ${took} ms`);
  await settle(h.pids());
});

test("time spent on the version check comes out of the cap handed to jg", async () => {
  let handed;
  let t = 0;
  const r = await runJg({
    query: "q", root: root(), capMs: 1000, now: () => t,
    version: async () => { t += 400; return "0.8.0"; },
    run: async (argv, opts) => { handed = opts; return { stdout: INCOMPLETE, exitCode: 0 }; },
  });
  assert.equal(r.row.fallback, false);
  assert.equal(handed.timeoutMs, 600);
});

test("a list whose stated count differs from the files it lists, or that lacks End context., is partial even on exit 0", async () => {
  const entries = (n) => Array.from({ length: n }, (_, i) => `- "f${i}.mjs" — relevant; source below`).join("\n");
  const cases = [
    [`Jevgrep: 5 relevant files.\n${entries(2)}\nEnd file list.\n\nEnd context.\n`, /5 stated.*2 listed/],
    [`Jevgrep: 2 relevant files.\n${entries(2)}\nEnd file list.\n\nSource block "f0.mjs" lines 1-3:\n`, /End context/],
  ];
  for (const [stdout, re] of cases) {
    const r = await runJg({ query: "q", root: root(), ...answer(stdout, 0) });
    assert.equal(r.row.fallback, false);
    assert.match(r.row.partial, re, stdout);
  }
  const whole = `Jevgrep: 2 relevant files.\n${entries(2)}\nEnd file list.\n\n- "f9.mjs" 3-4\n\nEnd context.\n\n`;
  const ok = await runJg({ query: "q", root: root(), ...answer(whole, 0) });
  assert.equal(ok.row.partial, undefined, "declaration entries after End file list. are not files");
});

test("dispatch-context spawnRun cuts the whole process group at its timeout, not only the child", POSIX_ONLY, async () => {
  const dir = tmp("jg14-run-");
  const script = path.join(dir, "tree.mjs");
  const pidfile = path.join(dir, "pids");
  writeFileSync(script, [
    'import { spawn } from "node:child_process";',
    'import fs from "node:fs";',
    'const gc = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });',
    'fs.writeFileSync(process.argv[2], process.pid + " " + gc.pid);',
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  const r = await spawnRun(process.execPath, [script, pidfile], { timeoutMs: 400 });
  assert.equal(r.timedOut, true);
  const pids = readFileSync(pidfile, "utf8").split(" ").map(Number);
  await settle(pids);
  assert.deepEqual(pids.map(alive), [false, false]);
});
