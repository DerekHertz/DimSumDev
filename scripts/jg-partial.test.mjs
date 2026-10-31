// portable-den/14: the jg wrapper keeps a partial result instead of discarding it, says when discovery was incomplete,
// and cuts a hung jg at a wall-time cap without leaving any process of its group behind.
// Seams: runJg({run}) for result classification, spawnJg(argv, {cmd, timeoutMs, graceMs}) for process handling, and the
// CLI (node scripts/jg.mjs) with a fake `jg` first on PATH for the printed output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runJg, spawnJg } from "./jg.mjs";

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

test("a jg that ignores SIGINT and SIGTERM is cut at the cap and its whole process group is gone", async () => {
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

test("terminating the wrapper itself kills the jg group", async () => {
  const h = hangingJg();
  const driver = path.join(path.dirname(h.script), "driver.mjs");
  writeFileSync(driver, `import { spawnJg } from ${JSON.stringify(pathToFileURL(JG_MJS).href)};\nawait spawnJg([${JSON.stringify(h.pidfile)}], { cmd: [process.execPath, ${JSON.stringify(h.script)}], timeoutMs: 60000 });\n`);
  const wrapper = spawn(process.execPath, [driver], { stdio: "ignore" });
  const exited = new Promise((r) => wrapper.on("exit", r));
  for (let i = 0; i < 100 && !existsSync(h.pidfile); i++) await new Promise((r) => setTimeout(r, 50));
  const pids = h.pids();
  assert.deepEqual(pids.map(alive), [true, true]);
  wrapper.kill("SIGTERM");
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
