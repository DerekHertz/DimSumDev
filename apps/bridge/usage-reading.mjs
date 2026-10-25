// Friction F19, hardening/17: the den's usage reading. The source is the snapshot scripts/statusline.mjs writes from the
// status line's documented `rate_limits` (~/.claude/usage-cache.json: { at, windows: { "5-hour": { percent }, weekly: { percent } } };
// it never holds the token). A snapshot older than STALE_MS is "unknown" (the reading carries `stale: true` and no
// percent), never the old number. A bridge-started run emits no status line (claude -p, disableAllHooks), so the snapshot is
// only as fresh as the terminal sessions on the box. scripts/usage.mjs is the headless fallback: it starts once, in the
// background, only when there is no usable snapshot file (missing, unreadable or unparseable). That script owns the network call, its lock and the 429 cooldown,
// so the bridge adds no call of its own.
//   createUsageReading({ cacheFile?, refresh?, now? }) -> () => { fiveHour, weekly, sampledAt, stale? } | null
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STALE_MS = 5 * 60_000;
const USAGE_SCRIPT = fileURLToPath(new URL("../../scripts/usage.mjs", import.meta.url));
const pct = (w) => (Number.isFinite(w?.percent) ? w.percent : null);

function startRefresh() {
  try {
    const child = spawn(process.execPath, [USAGE_SCRIPT], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no reading this time; the next snapshot tries again after STALE_MS
  }
}

export function createUsageReading({ cacheFile = path.join(os.homedir(), ".claude", "usage-cache.json"), refresh = startRefresh, now = Date.now } = {}) {
  let lastRefresh = -Infinity;
  return function read() {
    let cache = null;
    try {
      cache = JSON.parse(readFileSync(cacheFile, "utf8"));
    } catch {
      cache = null;
    }
    const missing = cache === null || typeof cache !== "object";
    if (missing && now() - lastRefresh > STALE_MS) {
      lastRefresh = now();
      refresh();
    }
    const at = Number.isFinite(cache?.at) ? cache.at : null;
    const fiveHour = pct(cache?.windows?.["5-hour"]);
    if (at === null || fiveHour === null) return null;
    const sampledAt = new Date(at).toISOString();
    if (now() - at > STALE_MS) return { fiveHour: null, weekly: null, sampledAt, stale: true };
    return { fiveHour, weekly: pct(cache.windows.weekly), sampledAt };
  };
}

/** The newer of two readings ({ sampledAt } ISO strings); either may be null. */
export function newerUsage(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(b.sampledAt ?? "") > Date.parse(a.sampledAt ?? "") ? b : a;
}
