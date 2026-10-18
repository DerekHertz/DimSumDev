// Prints plan usage (5-hour and weekly) for usage-watch in sessions where the
// desktop app's get_usage tool is missing (WSL, macOS). Ticket organism-infra/33.
// Reads the Claude Code OAuth token (credentials file, or the Keychain on macOS;
// see usage-token.mjs) and sends it only to api.anthropic.com.
// Never prints the token. The endpoint is undocumented; on any failure with no
// cached reading it exits 1 so usage-watch falls back to asking the user.
//
// Ticket organism-infra/167: one shared cache (~/.claude/usage-cache.json) serves every caller
// (statusline, hooks, bridge, orchestrator). A reading under 5 minutes old (USAGE_CACHE_TTL_MS
// overrides, for tests) is served without a network call. An HTTP 429 is never retried: it records
// a cooldown (Retry-After seconds, else 5 minutes) and later reads print the cached windows with
// "stale": true until it ends. A lock file keeps concurrent readers to one network call.
// The cache holds only the canonical windows, a timestamp and the cooldown, never the token.
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findToken, describeFailure } from "./usage-token.mjs";
import { toLocalReset } from "./usage-local-time.mjs";

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_S = 300;
const MAX_COOLDOWN_S = 3600;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;
const STALE_UNKNOWN_S = 1800; // a cached reading older than this is not a current percent (den-mvp/88, organism-infra/234)
// --live: skip the cache and never fall back to it; a failed or cooling-down read exits nonzero with nothing on stdout.
const LIVE = process.argv.includes("--live");

const ttlEnv = process.env.USAGE_CACHE_TTL_MS;
const TTL_MS = ttlEnv !== undefined && ttlEnv !== "" && Number.isFinite(Number(ttlEnv)) ? Number(ttlEnv) : DEFAULT_TTL_MS;
const CACHE_FILE = path.join(os.homedir(), ".claude", "usage-cache.json");
const LOCK_FILE = `${CACHE_FILE}.lock`;

function fail(msg) {
  console.error(`usage: ${msg}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isWindows = (w) => w && typeof w === "object" && Object.keys(w).length > 0;

// {at, windows, cooldown_until} from the cache file; every field optional/null when absent.
function readCache() {
  try {
    const v = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    return {
      at: Number.isFinite(v?.at) ? v.at : null,
      windows: isWindows(v?.windows) ? v.windows : null,
      cooldownUntil: Number.isFinite(v?.cooldown_until) ? v.cooldown_until : 0,
    };
  } catch {
    return { at: null, windows: null, cooldownUntil: 0 };
  }
}

function writeCache({ at, windows, cooldownUntil }) {
  try {
    mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ at, windows, cooldown_until: cooldownUntil || 0 }), { mode: 0o600 });
    renameSync(tmp, CACHE_FILE);
  } catch {
    // the cache is best effort
  }
}

function emit(windows, extra) {
  console.log(JSON.stringify({ ...windows, ...extra }));
}

const ageS = (c) => Math.max(0, Math.round((Date.now() - c.at) / 1000));
const stale = (c) => ({ stale: true, source: "cache", age_s: ageS(c) });

// The answer the cache alone can give, or null when a network read is allowed.
function fromCache(c) {
  if (LIVE) return null;
  if (!c.windows || c.at === null) return null;
  if (Date.now() - c.at < TTL_MS) return () => emit(c.windows, { source: "cache", age_s: ageS(c) });
  return null;
}

function inCooldown(c) {
  return c.cooldownUntil > Date.now();
}

// Stale reading if there is one, else today's nonzero exit with the diagnostic. Past 30 minutes the percents are
// withheld: "unknown": true with every percent null.
function staleOrFail(c, msg) {
  if (!LIVE && c.windows && c.at !== null) {
    if (ageS(c) <= STALE_UNKNOWN_S) return emit(c.windows, stale(c));
    const blank = Object.fromEntries(Object.entries(c.windows).map(([k, w]) => [k, { ...w, percent: null }]));
    return emit(blank, { ...stale(c), unknown: true });
  }
  fail(msg);
}

function tryLock() {
  try {
    closeSync(openSync(LOCK_FILE, "wx", 0o600));
    return true;
  } catch (e) {
    if (e.code === "ENOENT") {
      try {
        mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
      } catch {
        // fall through: report the lock as busy
      }
    }
    return false;
  }
}

function unlock() {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    // already gone
  }
}

function retryAfterSeconds(res) {
  const raw = res.headers?.get?.("retry-after");
  if (raw === null || raw === undefined || raw === "") return DEFAULT_COOLDOWN_S;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.ceil(n), MAX_COOLDOWN_S);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.min(Math.max(0, Math.ceil((date - Date.now()) / 1000)), MAX_COOLDOWN_S);
  return DEFAULT_COOLDOWN_S;
}

// One network read. Returns {windows} on success or {error, cooldownS?} on failure.
async function fetchWindows(token) {
  let res;
  try {
    res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { error: `request failed (${e.name})` };
  }
  if (res.status === 401) return { error: "HTTP 401: the Claude Code login expired; run `claude /login`" };
  if (res.status === 429) return { error: "HTTP 429", cooldownS: retryAfterSeconds(res) };
  if (!res.ok) return { error: `HTTP ${res.status}` };

  let body;
  try {
    body = await res.json();
  } catch {
    return { error: "response was not JSON" };
  }
  const labels = { five_hour: "5-hour", seven_day: "weekly" };
  const windows = {};
  for (const [key, label] of Object.entries(labels)) {
    const w = body?.[key];
    if (w && typeof w.utilization === "number") {
      windows[label] = { percent: Math.round(w.utilization), resets_at: w.resets_at ?? null, resets_local: toLocalReset(w.resets_at) };
    }
  }
  if (!Object.keys(windows).length) return { error: "response had no usage windows" };
  return { windows };
}

async function main() {
  // Serve from the shared cache before touching credentials (the Keychain read is slow on macOS).
  const early = fromCache(readCache());
  if (early) return early();

  const found = findToken();
  const token = found.token;
  if (!token) {
    if (process.env.CLAUDE_CODE_REMOTE && !LIVE) {
      // Cloud sessions have no credentials: estimate from transcripts (ticket 32).
      const { estimate } = await import("./usage-estimate.mjs");
      console.log(JSON.stringify(estimate()));
      return;
    }
    return staleOrFail(readCache(), describeFailure(found));
  }
  if (process.env.USAGE_VERBOSE) console.error(`usage: token from ${found.source}`);

  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let c = readCache();
    const hit = fromCache(c);
    if (hit) return hit();
    if (inCooldown(c)) return staleOrFail(c, "HTTP 429 (cooling down after a rate limit; no request made)");

    if (tryLock()) {
      // process.exit skips finally, so decide under the lock, release, then print.
      let done;
      try {
        // Someone may have finished a read between our check and the lock.
        c = readCache();
        const again = fromCache(c);
        if (again) done = again;
        else if (inCooldown(c)) done = () => staleOrFail(c, "HTTP 429 (cooling down after a rate limit; no request made)");
        else {
          const r = await fetchWindows(token);
          if (r.windows) {
            writeCache({ at: Date.now(), windows: r.windows, cooldownUntil: 0 });
            done = () => emit(r.windows, { source: "live", age_s: 0 });
          } else {
            if (r.cooldownS !== undefined) writeCache({ at: c.at, windows: c.windows, cooldownUntil: Date.now() + r.cooldownS * 1000 });
            done = () => staleOrFail(c, r.error);
          }
        }
      } finally {
        unlock();
      }
      return done();
    }

    try {
      if (Date.now() - statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) unlock();
    } catch {
      // the holder just finished: loop and re-check the cache
    }
    if (Date.now() > deadline) return staleOrFail(readCache(), "timed out waiting for another usage read");
    await sleep(50);
  }
}

await main();
