// organism-infra/167: one shared usage cache with a 429 cooldown.
// Public interface under test: `node scripts/usage.mjs` (-> usage-claude.mjs) and, for the
// statusline criterion, `node scripts/statusline.mjs`. Nothing touches the network: fetch is
// replaced through a --import preload that counts calls in a file and answers from a behavior file.
//
// Contract these tests pin (the ticket leaves it open, so the developer must honour it):
//   - the shared cache file lives under the user's home (os.homedir(), which follows $HOME), never
//     in the repo, and holds only the canonical windows, a timestamp and the cooldown;
//   - env USAGE_CACHE_TTL_MS overrides the 5 minute freshness (default 300000). A test seam so the
//     "cache is old" and "failed read" paths can run without waiting 5 minutes;
//   - a cache hit prints source "cache" (not stale); a live read prints source "live";
//     a stale answer (cooldown or failed read) prints stale:true, source:"cache", age_s;
//   - Retry-After is read as whole seconds.
// Criterion -> test map: see the "AC" tags in each test name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const USAGE = path.join(ROOT, "scripts", "usage.mjs");
const STATUSLINE = path.join(ROOT, "scripts", "statusline.mjs");
const TOKEN = ["synthetic", "usage", "cache", "167", "marker"].join("-");
const OK_BODY = {
  five_hour: { utilization: 42, resets_at: "2026-10-09T00:00:00.000Z" },
  seven_day: { utilization: 10, resets_at: "2026-10-12T00:00:00.000Z" },
};
const OWN_FILES = new Set([".credentials.json", "preload.mjs", "behavior.json", "calls.log"]);

const PRELOAD = `
import { appendFileSync, readFileSync } from "node:fs";
const dir = ${"${DIR}"};
globalThis.fetch = async () => {
  const b = JSON.parse(readFileSync(dir + "/behavior.json", "utf8"));
  appendFileSync(dir + "/calls.log", "x\\n");
  if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
  if (b.throw) throw new TypeError("fetch failed");
  return new Response(JSON.stringify(b.body ?? {}), { status: b.status, headers: b.headers ?? {} });
};
`;

function harness() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "usage-cache-")));
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  writeFileSync(path.join(dir, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }));
  writeFileSync(path.join(dir, "preload.mjs"), PRELOAD.replace("${DIR}", JSON.stringify(dir)));
  const root = path.join(dir, "root");
  mkdirSync(path.join(root, ".scratch", "organism-infra", "issues"), { recursive: true });
  mkdirSync(path.join(root, ".scratch", "_requests"), { recursive: true });
  const h = {
    dir,
    root,
    set(behavior) {
      writeFileSync(path.join(dir, "behavior.json"), JSON.stringify(behavior));
    },
    calls() {
      const f = path.join(dir, "calls.log");
      return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0;
    },
    env(extra = {}) {
      const env = { ...process.env, HOME: dir, USERPROFILE: dir, DEN_ROOT: root, ...extra };
      env.NODE_OPTIONS = `--import ${pathToFileURL(path.join(dir, "preload.mjs")).href}`;
      for (const k of ["CLAUDE_CODE_REMOTE", "CLAUDE_CODE_SESSION_ID", "STATUSLINE_CACHE", "STATUSLINE_USAGE_SCRIPT", "USAGE_CACHE_TTL_MS"]) {
        if (!(k in extra)) delete env[k];
      }
      return env;
    },
    usage(extra = {}) {
      const r = spawnSync(process.execPath, [USAGE], { encoding: "utf8", env: h.env(extra), timeout: 20000 });
      let json = null;
      try {
        json = JSON.parse(r.stdout);
      } catch {
        // not JSON
      }
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
    },
    usageAsync(extra = {}) {
      return new Promise((resolve) => {
        const p = spawn(process.execPath, [USAGE], { env: h.env(extra), stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        p.stdout.on("data", (d) => (stdout += d));
        p.stderr.on("data", (d) => (stderr += d));
        p.on("close", (status) => {
          let json = null;
          try {
            json = JSON.parse(stdout);
          } catch {
            // not JSON
          }
          resolve({ status, stdout, stderr, json });
        });
      });
    },
    statusline(extra = {}) {
      const stdin = JSON.stringify({ session_id: "s", cwd: "/tmp/x", context_window: { context_window_size: 200000, current_usage: null } });
      const r = spawnSync(process.execPath, [STATUSLINE], { encoding: "utf8", input: stdin, env: h.env({ STATUSLINE_USAGE_TIMEOUT_MS: "10000", ...extra }), timeout: 20000 });
      return { status: r.status, out: r.stdout.replace(/\x1b\[[0-9;]*m/g, ""), stderr: r.stderr };
    },
    // every file under the fake home except the harness's own files
    stateFiles() {
      const out = [];
      const walk = (d) => {
        for (const name of readdirSync(d)) {
          const p = path.join(d, name);
          if (p === root) continue;
          if (statSync(p).isDirectory()) walk(p);
          else if (!OWN_FILES.has(name)) out.push(p);
        }
      };
      walk(dir);
      return out;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("AC1: two reads within 5 minutes make one network call; the second is served from the cache", () => {
  const h = harness();
  try {
    h.set({ status: 200, body: OK_BODY });
    const a = h.usage();
    const b = h.usage();
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
    assert.equal(h.calls(), 1, "the second read must not call the network");
    assert.equal(a.json["5-hour"].percent, 42);
    assert.equal(b.json["5-hour"].percent, 42);
    assert.equal(b.json.weekly.percent, 10);
    assert.equal(a.json.source, "live");
    assert.equal(b.json.source, "cache");
    assert.notEqual(b.json.stale, true, "a fresh cache hit is not stale");
    assert.equal(typeof b.json.age_s, "number");
  } finally {
    h.cleanup();
  }
});

test("AC1: a reading older than the TTL is fetched again (TTL seam)", () => {
  const h = harness();
  try {
    h.set({ status: 200, body: OK_BODY });
    h.usage({ USAGE_CACHE_TTL_MS: "0" });
    h.usage({ USAGE_CACHE_TTL_MS: "0" });
    assert.equal(h.calls(), 2);
  } finally {
    h.cleanup();
  }
});

test("AC2: a 429 is not retried, and no call is made until Retry-After passes", async () => {
  const h = harness();
  try {
    const env = { USAGE_CACHE_TTL_MS: "0" };
    h.set({ status: 200, body: OK_BODY });
    assert.equal(h.usage(env).status, 0);
    assert.equal(h.calls(), 1);

    h.set({ status: 429, headers: { "Retry-After": "2" }, body: {} });
    h.usage(env);
    assert.equal(h.calls(), 2, "one call that gets the 429, no retry");
    h.usage(env);
    h.usage(env);
    assert.equal(h.calls(), 2, "no network call during the cooldown");

    await sleep(2500);
    h.set({ status: 200, body: OK_BODY });
    const after = h.usage(env);
    assert.equal(h.calls(), 3, "the cooldown ended, so the read goes to the network again");
    assert.equal(after.json.source, "live");
  } finally {
    h.cleanup();
  }
});

test("AC2: without Retry-After the cooldown is long (5 minutes), not a retry on the next read", async () => {
  const h = harness();
  try {
    const env = { USAGE_CACHE_TTL_MS: "0" };
    h.set({ status: 200, body: OK_BODY });
    h.usage(env);
    h.set({ status: 429, body: {} });
    h.usage(env);
    assert.equal(h.calls(), 2);
    await sleep(2500);
    h.usage(env);
    assert.equal(h.calls(), 2, "still cooling down 2.5 s after a 429 with no Retry-After");
  } finally {
    h.cleanup();
  }
});

test("AC3: during a cooldown with a cached reading the output is stale from the cache and exits 0", () => {
  const h = harness();
  try {
    const env = { USAGE_CACHE_TTL_MS: "0" };
    h.set({ status: 200, body: OK_BODY });
    h.usage(env);
    h.set({ status: 429, headers: { "Retry-After": "600" }, body: {} });
    for (const r of [h.usage(env), h.usage(env)]) {
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.equal(r.json.stale, true);
      assert.equal(r.json.source, "cache");
      assert.equal(typeof r.json.age_s, "number");
      assert.ok(r.json.age_s >= 0);
      assert.equal(r.json["5-hour"].percent, 42, "the cached windows are still printed");
      assert.equal(r.json.weekly.percent, 10);
    }
    assert.equal(h.calls(), 2);
  } finally {
    h.cleanup();
  }
});

test("AC3: any failed read (HTTP 500, network error) with a cached reading falls back to it, stale, exit 0", () => {
  const h = harness();
  try {
    const env = { USAGE_CACHE_TTL_MS: "0" };
    h.set({ status: 200, body: OK_BODY });
    h.usage(env);
    for (const behavior of [{ status: 500, body: {} }, { throw: true }]) {
      h.set(behavior);
      const r = h.usage(env);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.equal(r.json.stale, true);
      assert.equal(r.json.source, "cache");
      assert.equal(typeof r.json.age_s, "number");
      assert.equal(r.json["5-hour"].percent, 42);
    }
  } finally {
    h.cleanup();
  }
});

test("AC4: persistent failure with no cache exits nonzero with a sanitized message, as today", () => {
  const h = harness();
  try {
    h.set({ status: 429, headers: { "Retry-After": "600" }, body: {} });
    const first = h.usage();
    assert.notEqual(first.status, 0);
    assert.match(first.stderr, /429/);
    assert.equal(first.stdout.trim(), "", "nothing on stdout without a reading");
    assert.ok(!first.stderr.includes(TOKEN));
    const callsAfterFirst = h.calls();
    assert.equal(callsAfterFirst, 1);
    const second = h.usage();
    assert.notEqual(second.status, 0, "still no reading during the cooldown");
    assert.equal(h.calls(), 1, "and still no network call during the cooldown");
    assert.ok(!second.stderr.includes(TOKEN));

    const h2 = harness();
    try {
      h2.set({ status: 500, body: {} });
      const r = h2.usage();
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /500/);
      assert.ok(!r.stderr.includes(TOKEN));
    } finally {
      h2.cleanup();
    }
  } finally {
    h.cleanup();
  }
});

test("AC5: the statusline makes no network call and starts no usage.mjs of its own: it shows the snapshot usage.mjs left", () => {
  const h = harness();
  try {
    h.set({ status: 200, body: OK_BODY });
    assert.equal(h.usage().status, 0); // fills the shared cache: 1 call
    assert.equal(h.calls(), 1);
    for (let i = 0; i < 3; i++) {
      const s = h.statusline();
      assert.equal(s.status, 0);
      assert.match(s.out, /5h 42%/);
      assert.match(s.out, /wk 10%/);
    }
    assert.equal(h.calls(), 1, "the status line must not read usage itself (hardening/17)");
  } finally {
    h.cleanup();
  }
});

test("AC5: during a 429 cooldown the statusline keeps showing the snapshot while it is fresh and makes no calls", () => {
  const h = harness();
  try {
    const env = { USAGE_CACHE_TTL_MS: "0" };
    h.set({ status: 200, body: OK_BODY });
    h.usage(env);
    h.set({ status: 429, headers: { "Retry-After": "600" }, body: {} });
    h.usage(env); // meets the 429 and writes the cooldown
    for (let i = 0; i < 4; i++) {
      const s = h.statusline(env);
      assert.equal(s.status, 0);
      assert.match(s.out, /5h 42%/, "stale cached reading, not '5h ?'");
    }
    assert.equal(h.calls(), 2, "one call that met the 429; the status line never reaches the network");
  } finally {
    h.cleanup();
  }
});

test("AC6: concurrent reads make at most one network call", async () => {
  const h = harness();
  try {
    h.set({ status: 200, delayMs: 600, body: OK_BODY });
    const results = await Promise.all([h.usageAsync(), h.usageAsync(), h.usageAsync(), h.usageAsync()]);
    assert.ok(h.calls() <= 1, `expected at most one network call, got ${h.calls()}`);
    assert.ok(h.calls() >= 1, "somebody has to read");
    for (const r of results) {
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.equal(r.json["5-hour"].percent, 42);
    }
  } finally {
    h.cleanup();
  }
});

test("AC7: no token or credential text in the cache file or in any output", () => {
  const h = harness();
  try {
    const env = { USAGE_CACHE_TTL_MS: "0" };
    h.set({ status: 200, body: OK_BODY });
    const outs = [h.usage(env)];
    h.set({ status: 429, headers: { "Retry-After": "600" }, body: {} });
    outs.push(h.usage(env), h.usage(env));
    h.set({ status: 500, body: {} });
    outs.push(h.usage(env));
    for (const o of outs) {
      assert.ok(!o.stdout.includes(TOKEN), "stdout leaked the token");
      assert.ok(!o.stderr.includes(TOKEN), "stderr leaked the token");
      assert.ok(!/Bearer/i.test(o.stdout + o.stderr), "an Authorization header leaked");
    }
    const files = h.stateFiles();
    const cache = files.filter((f) => readFileSync(f, "utf8").includes("5-hour"));
    assert.ok(cache.length >= 1, `a cache file with the windows should exist under the home; found ${files.join(", ") || "no files"}`);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      assert.ok(!text.includes(TOKEN), `${f} holds the token`);
      assert.ok(!/accessToken|Bearer/i.test(text), `${f} holds credential text`);
    }
  } finally {
    h.cleanup();
  }
});

test("AC7: the cache holds only windows, a timestamp and the cooldown (no raw API body)", () => {
  const h = harness();
  try {
    h.set({ status: 200, body: { ...OK_BODY, extra_secret_field: "RAW-BODY-MARKER", account: { email: "x@example.com" } } });
    h.usage();
    const files = h.stateFiles();
    assert.ok(files.length >= 1, "a cache file should exist under the home");
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      assert.ok(!text.includes("RAW-BODY-MARKER"), `${f} stored the raw response body`);
      assert.ok(!text.includes("x@example.com"), `${f} stored account details`);
    }
  } finally {
    h.cleanup();
  }
});
