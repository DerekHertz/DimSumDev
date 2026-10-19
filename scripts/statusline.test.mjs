// organism-infra/109: scripts/statusline.mjs is Claude Code's `statusLine` command.
// Public interface under test: `node scripts/statusline.mjs` with the status-line input JSON on
// stdin and these env seams (no real Claude Code session, network or credentials needed):
//   DEN_ROOT              board root: .scratch/*/issues/*.lock (in-flight relay) and
//                              .scratch/_requests/requests.jsonl (pending gate requests)
//   STATUSLINE_USAGE_SCRIPT    a node script that prints usage JSON like scripts/usage-claude.mjs
//                              (default scripts/usage.mjs); the ONLY external read
//   STATUSLINE_CACHE           file caching the usage read; fresh for 60 s by file mtime
//   STATUSLINE_USAGE_TIMEOUT_MS  bound on the usage read (default is the developer's choice)
//   HOME                       ~/.claude/... transcript lookups and the shared context state
// Output is one line; colour is ANSI yellow (\x1b[33m) / red (\x1b[31m) around the segment.
// Criterion -> test map: see the "AC" tags in each test name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(ROOT, "scripts", "statusline.mjs");
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s) => s.replace(ANSI, "");

const USAGE = {
  "5-hour": { percent: 11, resets_at: "2026-10-02T19:59:00.000Z" },
  weekly: { percent: 51, resets_at: "2026-10-06T00:00:00.000Z" },
};

function fixture({ usage = USAGE, usageExit = 0, usageHang = false } = {}) {
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
      usageHang ? `await new Promise((r) => setTimeout(r, 15000));` : "",
      usageExit ? `console.error("usage: boom"); process.exit(${usageExit});` : "",
      `console.log(${JSON.stringify(JSON.stringify(usage))});`,
    ].join("\n"),
  );
  const cache = path.join(dir, "usage-cache.json");
  return { dir, home, root, count, usageScript, cache };
}

const calls = (f) => (existsSync(f.count) ? readFileSync(f.count, "utf8").split("\n").filter(Boolean).length : 0);

function input({ tokens = 64_010, session = "sess-1", extra = {} } = {}) {
  const ctx =
    tokens === null
      ? { context_window_size: 200000, current_usage: null }
      : {
          context_window_size: 200000,
          current_usage: { input_tokens: 10, output_tokens: 7777, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 10 },
        };
  return { session_id: session, cwd: "/tmp/x", context_window: ctx, ...extra };
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
  const mk = (five, week) => ({ "5-hour": { percent: five, resets_at: "2026-10-02T19:59:00.000Z" }, weekly: { percent: week, resets_at: "2026-10-06T00:00:00.000Z" } });
  const y = fixture({ usage: mk(80, 10) });
  assert.match(run(y, input()).stdout, /\x1b\[33m[^\x1b]*5h 80%/);

  const below = fixture({ usage: mk(79, 79) });
  assert.ok(!/\x1b\[(33|31)m/.test(run(below, input({ tokens: 1000 })).stdout));

  const red = fixture({ usage: mk(90, 10) });
  assert.match(run(red, input()).stdout, /\x1b\[31m[^\x1b]*5h 90%/);

  const wk = fixture({ usage: mk(10, 91) });
  assert.match(run(wk, input()).stdout, /\x1b\[31m[^\x1b]*wk 91%/);
});

test("AC3: the usage read is cached on disk: a second run within 60 s does not call the usage script", () => {
  const f = fixture();
  const first = run(f, input());
  assert.equal(calls(f), 1);
  const second = run(f, input());
  assert.equal(calls(f), 1, "warm cache must not re-read usage");
  assert.equal(second.text, first.text);
  assert.ok(existsSync(f.cache));
});

test("AC3: a cache older than 60 s (by mtime) is refreshed", () => {
  const f = fixture();
  run(f, input());
  const old = Date.now() / 1000 - 120;
  utimesSync(f.cache, old, old);
  run(f, input());
  assert.equal(calls(f), 2);
});

test("AC3: a failing usage read prints '5h ?' and still exits 0 with the rest of the line", () => {
  const f = fixture({ usageExit: 1 });
  lock(f, "123-demo.lock", "qa 2026-10-02T17:13:04.772Z verify");
  const r = run(f, input());
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.text.includes("5h ?"), r.text);
  assert.ok(r.text.includes("ctx 64k/80k"), r.text);
  assert.ok(r.text.includes("123: qa verify"), r.text);
  assert.ok(r.text.includes("gates 0"), r.text);
});

test("AC3: a hanging usage read is cut off by STATUSLINE_USAGE_TIMEOUT_MS and prints '5h ?'", () => {
  const f = fixture({ usageHang: true });
  const r = run(f, input(), { STATUSLINE_USAGE_TIMEOUT_MS: "300" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.text.includes("5h ?"), r.text);
  assert.ok(r.ms < 5000, `took ${r.ms} ms`);
});

test("AC4: a warm-cache run finishes in under 300 ms (best of 5)", () => {
  const f = fixture();
  const cold = run(f, input()); // warm the cache
  assert.equal(cold.status, 0, cold.stderr);
  const runs = Array.from({ length: 5 }, () => run(f, input()));
  for (const r of runs) {
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.text.includes("5h 11%"), r.text);
  }
  assert.equal(calls(f), 1, "the timed runs must be warm-cache runs");
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
