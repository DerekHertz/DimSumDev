// organism-infra/109: scripts/statusline.mjs is Claude Code's `statusLine` command.
// Public interface under test: `node scripts/statusline.mjs` with the status-line input JSON on
// stdin and these env seams (no real Claude Code session, network or credentials needed):
//   DEN_ROOT              board root: .scratch/*/issues/*.lock (in-flight relay) and
//                              .scratch/_requests/requests.jsonl (pending gate requests)
//   rate_limits (stdin)        the documented five_hour / seven_day { used_percentage, resets_at } (hardening/17)
//   STATUSLINE_CACHE           the usage snapshot file (default ~/.claude/usage-cache.json): written from rate_limits,
//                              read back for up to 5 minutes when the input carries none
//   STATUSLINE_USAGE_SCRIPT    a recorder that must never run: the status line no longer starts scripts/usage.mjs
//   HOME                       ~/.claude/... transcript lookups and the shared context state
// Output is one line; colour is ANSI yellow (\x1b[33m) / red (\x1b[31m) around the segment.
// Criterion -> test map: see the "AC" tags in each test name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(ROOT, "scripts", "statusline.mjs");
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s) => s.replace(ANSI, "");

const EPOCH_5H = 1790971140; // 2026-10-02T19:59:00Z
const EPOCH_WK = 1791244800; // 2026-10-06T00:00:00Z
const rateLimits = (five = 11, week = 51) => ({
  five_hour: { used_percentage: five, resets_at: EPOCH_5H },
  seven_day: { used_percentage: week, resets_at: EPOCH_WK },
});

function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "statusline-")));
  const home = path.join(dir, "home");
  const root = path.join(dir, "root");
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(root, ".scratch", "organism-infra", "issues"), { recursive: true });
  mkdirSync(path.join(root, ".scratch", "_requests"), { recursive: true });
  const count = path.join(dir, "usage-calls.txt");
  const usageScript = path.join(dir, "fake-usage.mjs");
  writeFileSync(
    usageScript,
    [
      `import { appendFileSync } from "node:fs";`,
      `appendFileSync(${JSON.stringify(count)}, "x\\n");`,
      `console.log("{}");`,
    ].join("\n"),
  );
  const cache = path.join(dir, "usage-cache.json");
  return { dir, home, root, count, usageScript, cache };
}

const snapshot = (f) => JSON.parse(readFileSync(f.cache, "utf8"));
const calls = (f) => (existsSync(f.count) ? readFileSync(f.count, "utf8").split("\n").filter(Boolean).length : 0);

function input({ tokens = 64_010, session = "sess-1", rate = rateLimits(), extra = {} } = {}) {
  const ctx =
    tokens === null
      ? { context_window_size: 200000, current_usage: null }
      : {
          context_window_size: 200000,
          current_usage: { input_tokens: 10, output_tokens: 7777, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 10 },
        };
  return { session_id: session, cwd: "/tmp/x", context_window: ctx, ...(rate ? { rate_limits: rate } : {}), ...extra };
}

function run(f, stdin, env = {}) {
  const e = { ...process.env, HOME: f.home, DEN_ROOT: f.root, STATUSLINE_USAGE_SCRIPT: f.usageScript, STATUSLINE_CACHE: f.cache, ...env };
  delete e.CLAUDE_CODE_SESSION_ID;
  delete e.CLAUDE_CODE_REMOTE;
  const t0 = process.hrtime.bigint();
  const r = spawnSync("node", [SCRIPT], { cwd: f.root, env: e, input: typeof stdin === "string" ? stdin : JSON.stringify(stdin), encoding: "utf8", timeout: 20000 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ...r, ms, text: strip(r.stdout ?? "") };
}

function lock(f, name, content) {
  writeFileSync(path.join(f.root, ".scratch", "organism-infra", "issues", name), content);
}

function requests(f, rows) {
  writeFileSync(path.join(f.root, ".scratch", "_requests", "requests.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("AC1: prints one line: 5h %, reset time, weekly %, ctx tokens vs 80k, in-flight relay, gate count", () => {
  const f = fixture();
  lock(f, "123-demo.lock", "qa 2026-10-02T17:13:04.772Z verify in-review");
  requests(f, [
    { id: "a", ts: "2026-10-02T10:00:00Z", kind: "merge-approve", ref: "organism-infra/1-x" },
    { id: "b", ts: "2026-10-02T10:01:00Z", kind: "dispatch-approve", ref: "organism-infra/2-y" },
    { id: "c", ts: "2026-10-02T10:02:00Z", kind: "merge-approve", ref: "organism-infra/3-z" },
    { handled: "c", ts: "2026-10-02T10:03:00Z", outcome: "done" },
  ]);
  const r = run(f, input());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.text, "5h 11% → 19:59Z · wk 51% · ctx 64k/80k · 123: qa verify · gates 2\n");
});

test("AC1: several in-flight tickets are all named; a lock without a mode names the agent; write-locks and unlocked tickets are ignored", () => {
  const f = fixture();
  lock(f, "123-demo.lock", "qa 2026-10-02T17:13:04.772Z verify in-review");
  lock(f, "124-other.lock", "developer 2026-10-02T17:14:04.772Z");
  lock(f, "125-write.write-lock.json", JSON.stringify({ pid: 1 }));
  writeFileSync(path.join(f.root, ".scratch", "organism-infra", "issues", "125-write.md"), "# 125\n\n**Status:** ready-for-agent\n");
  const r = run(f, input());
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.text.includes("123: qa verify"), r.text);
  assert.ok(r.text.includes("124: developer"), r.text);
  assert.ok(!r.text.includes("125"), r.text);
  assert.equal(r.text.trim().split("\n").length, 1);
});

test("AC1: no requests file and no locks still prints the line with gates 0", () => {
  const f = fixture();
  const r = run(f, input());
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.text.includes("gates 0"), r.text);
  assert.ok(r.text.includes("5h 11%"), r.text);
});

test("AC2: below every threshold nothing is yellow or red and there is no /compact hint", () => {
  const f = fixture();
  const r = run(f, input({ tokens: 69_000 }));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/\x1b\[(33|31)m/.test(r.stdout), JSON.stringify(r.stdout));
  assert.ok(!r.text.includes("/compact"), r.text);
});

test("AC2: context at 70k is yellow, at 80k is red with '→ /compact', and just under 80k has no hint", () => {
  const f = fixture();
  const at70 = run(f, input({ tokens: 70_000 }));
  assert.match(at70.stdout, /\x1b\[33m[^\x1b]*ctx 70k\/80k[^\x1b]*\x1b\[0m/);
  assert.ok(!at70.text.includes("/compact"), at70.text);

  const at79 = run(f, input({ tokens: 79_000 }));
  assert.match(at79.stdout, /\x1b\[33m[^\x1b]*ctx 79k\/80k/);
  assert.ok(!at79.text.includes("/compact"), at79.text);

  const at80 = run(f, input({ tokens: 80_000 }));
  assert.match(at80.stdout, /\x1b\[31m[^\x1b]*ctx 80k\/80k/);
  assert.ok(at80.text.includes("→ /compact"), at80.text);

  const at95 = run(f, input({ tokens: 95_000 }));
  assert.match(at95.stdout, /\x1b\[31m[^\x1b]*ctx 95k\/80k/);
  assert.ok(at95.text.includes("→ /compact"), at95.text);
});

test("AC2: 5-hour usage is yellow at 80% and red at 90%; weekly follows the same thresholds", () => {
  assert.match(run(fixture(), input({ rate: rateLimits(80, 10) })).stdout, /\x1b\[33m[^\x1b]*5h 80%/);
  assert.ok(!/\x1b\[(33|31)m/.test(run(fixture(), input({ tokens: 1000, rate: rateLimits(79, 79) })).stdout));
  assert.match(run(fixture(), input({ rate: rateLimits(90, 10) })).stdout, /\x1b\[31m[^\x1b]*5h 90%/);
  assert.match(run(fixture(), input({ rate: rateLimits(10, 91) })).stdout, /\x1b\[31m[^\x1b]*wk 91%/);
});

const writeSnapshot = (f, snap) => writeFileSync(f.cache, JSON.stringify(snap));
const OLD = { "5-hour": { percent: 32, resets_at: "2026-10-02T19:59:00.000Z" }, weekly: { percent: 44, resets_at: "2026-10-06T00:00:00.000Z" } };

test("17-AC1: with rate_limits in the input the snapshot holds both windows, their reset times and a timestamp", () => {
  const f = fixture();
  const before = Date.now();
  const r = run(f, input());
  assert.equal(r.status, 0, r.stderr);
  const snap = snapshot(f);
  assert.ok(snap.at >= before && snap.at <= Date.now(), `at ${snap.at}`);
  assert.deepEqual(snap.windows, {
    "5-hour": { percent: 11, resets_at: "2026-10-02T19:59:00.000Z" },
    weekly: { percent: 51, resets_at: "2026-10-06T00:00:00.000Z" },
  });
});

test("17-AC1: without rate_limits the snapshot does not claim a reading, and the line says '5h ?' / 'wk ?'", () => {
  const f = fixture();
  const r = run(f, input({ rate: null }));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(f.cache), "no snapshot file may be written without a reading");
  assert.ok(r.text.startsWith("5h ? · wk ? · "), r.text);
});

test("17-AC1: a window absent from the input is absent from the snapshot, never guessed; zero is a reading", () => {
  const f = fixture();
  const r = run(f, input({ rate: { five_hour: { used_percentage: 0, resets_at: EPOCH_5H } } }));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(snapshot(f).windows), ["5-hour"]);
  assert.equal(snapshot(f).windows["5-hour"].percent, 0);
  assert.ok(r.text.startsWith("5h 0% → 19:59Z · wk ? · "), r.text);
});

test("17-AC1: a window with no usable percentage is treated as absent", () => {
  const f = fixture();
  const r = run(f, input({ rate: { five_hour: { used_percentage: "lots", resets_at: EPOCH_5H }, seven_day: { used_percentage: null } } }));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(f.cache));
  assert.ok(r.text.startsWith("5h ? · wk ? · "), r.text);
});

test("17-AC1: resets_at as epoch seconds, epoch milliseconds or an ISO string all land as one ISO string", () => {
  for (const at of [EPOCH_5H, EPOCH_5H * 1000, "2026-10-02T19:59:00Z"]) {
    const f = fixture();
    run(f, input({ rate: { five_hour: { used_percentage: 11, resets_at: at } } }));
    assert.equal(snapshot(f).windows["5-hour"].resets_at, "2026-10-02T19:59:00.000Z", String(at));
  }
});

test("17-AC1: a missing resets_at keeps the percentage and stores no reset time", () => {
  const f = fixture();
  const r = run(f, input({ rate: { five_hour: { used_percentage: 12 } } }));
  assert.equal(snapshot(f).windows["5-hour"].percent, 12);
  assert.equal(snapshot(f).windows["5-hour"].resets_at, null);
  assert.ok(r.text.startsWith("5h 12% · wk ? · "), r.text);
});

test("17-AC1: writing keeps the cooldown_until that scripts/usage-claude.mjs keeps, and leaves no temp file behind", () => {
  const f = fixture();
  writeSnapshot(f, { at: Date.now() - 1000, windows: OLD, cooldown_until: 4_000_000_000_000 });
  run(f, input());
  const snap = snapshot(f);
  assert.equal(snap.cooldown_until, 4_000_000_000_000);
  assert.equal(snap.windows["5-hour"].percent, 11);
  assert.deepEqual(readdirSync(path.dirname(f.cache)).filter((n) => n.startsWith("usage-cache.json")), ["usage-cache.json"]);
});

test("17-AC1: an input without rate_limits does not clobber a snapshot written a minute ago, and the line shows it", () => {
  const f = fixture();
  const snap = { at: Date.now() - 60_000, windows: OLD, cooldown_until: 0 };
  writeSnapshot(f, snap);
  const r = run(f, input({ rate: null }));
  assert.ok(r.text.startsWith("5h 32% → 19:59Z · wk 44% · "), r.text);
  assert.deepEqual(snapshot(f), snap);
});

test("17-AC1: a snapshot older than 5 minutes is not shown: '5h ?' / 'wk ?', file untouched", () => {
  const f = fixture();
  const snap = { at: Date.now() - 6 * 60_000, windows: OLD, cooldown_until: 0 };
  writeSnapshot(f, snap);
  const r = run(f, input({ rate: null }));
  assert.ok(r.text.startsWith("5h ? · wk ? · "), r.text);
  assert.deepEqual(snapshot(f), snap);
});

test("17-AC1: a corrupt snapshot file is no reading and does not break the line", () => {
  const f = fixture();
  writeFileSync(f.cache, "{not json");
  const r = run(f, input({ rate: null }));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.text.startsWith("5h ? · wk ? · "), r.text);
});

test("17-AC3: the status line never starts scripts/usage.mjs: not with a reading, not without one, not with a stale snapshot", () => {
  const f = fixture();
  run(f, input());
  run(f, input({ rate: null }));
  fs.rmSync(f.cache);
  run(f, input({ rate: null }));
  writeSnapshot(f, { at: Date.now() - 3_600_000, windows: OLD, cooldown_until: 0 });
  run(f, input({ rate: null }));
  assert.equal(calls(f), 0, "STATUSLINE_USAGE_SCRIPT must not run");
  const src = readFileSync(SCRIPT, "utf8");
  assert.ok(!/usage\.mjs|runUsage|defaultUsageScript|STATUSLINE_USAGE_SCRIPT/.test(src), "statusline.mjs still names the usage script");
});

test("AC4: a run with a warm snapshot finishes in under 300 ms (best of 5)", () => {
  const f = fixture();
  const runs = Array.from({ length: 5 }, () => run(f, input()));
  for (const r of runs) {
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.text.includes("5h 11%"), r.text);
  }
  const best = Math.min(...runs.map((r) => r.ms));
  assert.ok(best < 300, `best warm run ${best.toFixed(0)} ms`);
});

test("AC4: statusline.mjs contains no model or network call of its own", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.ok(!/fetch\(|https?:\/\/|api\.anthropic|@anthropic-ai|node:https?|node:net/.test(src), "no network/model client in the script");
  assert.ok(!/(spawn|exec)(Sync|File|FileSync)?\(\s*["']claude["']/.test(src), "no claude CLI call");
});

test("AC5-input: context comes from the status-line input (current_usage summed, output tokens excluded)", () => {
  const f = fixture();
  const r = run(f, input({ tokens: 32_010 }));
  assert.ok(r.text.includes("ctx 32k/80k"), r.text);
});

test("AC5-input: without current_usage it falls back to the last assistant usage in transcript_path", () => {
  const f = fixture();
  const tx = path.join(f.dir, "t.jsonl");
  const asst = (u) => JSON.stringify({ type: "assistant", message: { role: "assistant", usage: u } });
  writeFileSync(tx, [asst({ input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 }), asst({ input_tokens: 5, cache_creation_input_tokens: 5000, cache_read_input_tokens: 41_995, output_tokens: 99999 })].join("\n") + "\n");
  const r = run(f, input({ tokens: null, extra: { transcript_path: tx } }));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.text.includes("ctx 47k/80k"), r.text);
});

test("17-ctx: with no current_usage, context_window.used_percentage of the window size is the ctx reading; current_usage still wins", () => {
  const f = fixture();
  const pctOnly = { context_window_size: 200000, current_usage: null, used_percentage: 25 };
  assert.ok(run(f, input({ tokens: null, extra: { context_window: pctOnly } })).text.includes("ctx 50k/80k"));
  const both = { ...pctOnly, current_usage: { input_tokens: 10_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
  assert.ok(run(f, input({ tokens: null, extra: { context_window: both } })).text.includes("ctx 10k/80k"));
});

test("AC5-input: no context numbers anywhere prints 'ctx ?' and exits 0", () => {
  const f = fixture();
  const r = run(f, input({ tokens: null }));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.text.includes("ctx ?"), r.text);
});

test("robustness: empty or malformed stdin still prints one line and exits 0", () => {
  const f = fixture();
  for (const stdin of ["", "not json", "{"]) {
    const r = run(f, stdin);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.text.trim().split("\n").length, 1, JSON.stringify(r.text));
    assert.ok(r.text.includes("gates 0"), r.text);
  }
});
