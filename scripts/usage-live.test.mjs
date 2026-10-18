// organism-infra/234 (merged into den-mvp/88): `node scripts/usage.mjs --live` and the stale mark. fetch is replaced through a
// --import preload (as in usage-cache.test.mjs); the cache file is written by the test under a temporary HOME.
// Pinned contract (the ticket leaves it open):
//   --live (alone, or with --provider claude) skips the cache. It prints a live reading (source "live") or exits nonzero with a
//     one-line diagnostic on stderr and nothing on stdout. It never falls back to a cached or stale reading, and it makes no
//     network call during a 429 cooldown (it exits nonzero instead). The diagnostic never holds the token.
//   Without --live, a reading served from the cache after a failed or cooling-down read (stale:true) and older than 30 minutes
//     (age_s > 1800) is marked unknown: exit 0, "unknown": true, and every window's "percent" is null. A stale reading under
//     30 minutes keeps today's output (stale:true with the percents).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const USAGE = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "scripts", "usage.mjs");
const TOKEN = ["synthetic", "usage", "live", "234", "marker"].join("-");
const BODY = (five) => ({ five_hour: { utilization: five, resets_at: "2026-10-09T00:00:00.000Z" }, seven_day: { utilization: 10, resets_at: "2026-10-12T00:00:00.000Z" } });
const PRELOAD = `
import { appendFileSync, readFileSync } from "node:fs";
const dir = ${"${DIR}"};
globalThis.fetch = async () => {
  const b = JSON.parse(readFileSync(dir + "/behavior.json", "utf8"));
  appendFileSync(dir + "/calls.log", "x\\n");
  return new Response(JSON.stringify(b.body ?? {}), { status: b.status, headers: b.headers ?? {} });
};
`;

function harness() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "usage-live-")));
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  writeFileSync(path.join(dir, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }));
  writeFileSync(path.join(dir, "preload.mjs"), PRELOAD.replace("${DIR}", JSON.stringify(dir)));
  const h = {
    set: (b) => writeFileSync(path.join(dir, "behavior.json"), JSON.stringify(b)),
    cache: ({ ageS, percent = 87, cooldownS = 0 }) =>
      writeFileSync(path.join(dir, ".claude", "usage-cache.json"), JSON.stringify({ at: Date.now() - ageS * 1000, windows: { "5-hour": { percent, resets_at: "2026-10-09T00:00:00.000Z", resets_local: "x" }, weekly: { percent: 10, resets_at: null, resets_local: "y" } }, cooldown_until: cooldownS ? Date.now() + cooldownS * 1000 : 0 })),
    calls: () => (existsSync(path.join(dir, "calls.log")) ? readFileSync(path.join(dir, "calls.log"), "utf8").split("\n").filter(Boolean).length : 0),
    usage(args = [], extra = {}) {
      const env = { ...process.env, HOME: dir, USERPROFILE: dir, NODE_OPTIONS: `--import ${pathToFileURL(path.join(dir, "preload.mjs")).href}`, ...extra };
      for (const k of ["CLAUDE_CODE_REMOTE", "USAGE_CACHE_TTL_MS"]) if (!(k in extra)) delete env[k];
      const r = spawnSync(process.execPath, [USAGE, ...args], { encoding: "utf8", env, timeout: 20000 });
      let json = null;
      try {
        json = JSON.parse(r.stdout);
      } catch {}
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  return h;
}

test("--live skips a fresh cache and prints the live reading", () => {
  const h = harness();
  try {
    h.cache({ ageS: 5, percent: 42 });
    h.set({ status: 200, body: BODY(60) });
    const r = h.usage(["--live"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json["5-hour"].percent, 60);
    assert.equal(r.json.source, "live");
    assert.equal(h.calls(), 1);
    assert.equal(h.usage(["--provider", "claude", "--live"]).json["5-hour"].percent, 60);
  } finally {
    h.cleanup();
  }
});

test("--live that cannot read exits nonzero with a sanitized diagnostic and prints no cached percent", () => {
  const h = harness();
  try {
    h.cache({ ageS: 5, percent: 42 });
    h.set({ status: 500, body: {} });
    const r = h.usage(["--live"]);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout.trim(), "", "nothing on stdout, so no caller can read a percent from it");
    assert.doesNotMatch(r.stderr, /expected --provider/, "the flag is known");
    assert.equal(h.calls(), 1, "a live read was tried");
    assert.match(r.stderr, /\S/);
    assert.equal(r.stderr.includes(TOKEN), false);
  } finally {
    h.cleanup();
  }
});

test("--live during a rate-limit cooldown makes no network call and exits nonzero", () => {
  const h = harness();
  try {
    h.cache({ ageS: 5, percent: 42, cooldownS: 300 });
    h.set({ status: 200, body: BODY(60) });
    const r = h.usage(["--live"]);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout.trim(), "");
    assert.equal(h.calls(), 0);
    assert.doesNotMatch(r.stderr, /expected --provider/, "the flag is known");
    assert.match(r.stderr, /429|cool|rate/i);
  } finally {
    h.cleanup();
  }
});

test("a stale reading older than 30 minutes is marked unknown, never printed as a current percent", () => {
  const h = harness();
  try {
    h.cache({ ageS: 8534, percent: 87, cooldownS: 300 }); // the 2026-10-17 case: 2.4 hours old, cooling down
    const r = h.usage();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.unknown, true);
    assert.equal(r.json.stale, true);
    assert.equal(r.json["5-hour"].percent, null);
    assert.equal(r.json.weekly.percent, null);
    assert.equal(r.stdout.includes("87"), false);
  } finally {
    h.cleanup();
  }
});

test("an old cache whose refresh fails is marked unknown too", () => {
  const h = harness();
  try {
    h.cache({ ageS: 7200, percent: 87 });
    h.set({ status: 500, body: {} });
    const r = h.usage();
    assert.equal(r.json.unknown, true);
    assert.equal(r.json["5-hour"].percent, null);
    assert.equal(h.calls(), 1, "the live fetch is tried first");
  } finally {
    h.cleanup();
  }
});

test("a stale reading under 30 minutes keeps its percent and the stale mark, and is not unknown", () => {
  const h = harness();
  try {
    h.cache({ ageS: 600, percent: 87, cooldownS: 300 });
    const r = h.usage();
    assert.equal(r.json.stale, true);
    assert.equal(r.json["5-hour"].percent, 87);
    assert.notEqual(r.json.unknown, true);
  } finally {
    h.cleanup();
  }
});

test("a fresh live read is neither stale nor unknown", () => {
  const h = harness();
  try {
    h.cache({ ageS: 7200, percent: 87 });
    h.set({ status: 200, body: BODY(30) });
    const r = h.usage();
    assert.equal(r.json["5-hour"].percent, 30);
    assert.notEqual(r.json.stale, true);
    assert.notEqual(r.json.unknown, true);
  } finally {
    h.cleanup();
  }
});
