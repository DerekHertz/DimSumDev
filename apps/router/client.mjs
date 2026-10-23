// den-mvp/88: the router's adapters to the far side: the bridge (client.test.mjs's header), the live usage read, the
// router-stop requests (requests.jsonl, read here and written through the bridge) and the ntfy push.
import { execFile } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { readRequestRows, ROUTER_STOP } from "../bridge/requests-log.mjs";

export function createBridgeClient({ url, token }) {
  const origin = new URL(url).origin;
  const post = async (route, body) => {
    const res = await fetch(`${origin}${route}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, ...(data?.error ? { error: String(data.error) } : {}), ...(data?.draining === true ? { draining: true } : {}), ...(Array.isArray(data?.resolved) ? { resolved: data.resolved } : {}), ...(data?.delivery ? { delivery: data.delivery } : {}), ...(data?.request ? { request: data.request } : {}) };
  };
  return {
    async state() {
      const res = await fetch(`${origin}/state`, { signal: AbortSignal.timeout(15_000) });
      if (res.status !== 200) throw new Error(`GET /state answered ${res.status}`);
      return res.json();
    },
    startDelivery: (ref) => post("/deliveries", { ref }),
    resumeDelivery: (id) => post(`/deliveries/${encodeURIComponent(id)}/resume`, {}),
    sweep: () => post("/deliveries/sweep", {}),
    recordStop: (stop) => post("/router-stops", { key: stop.key, kind: stop.kind, ...(stop.ref ? { ref: stop.ref } : {}), text: stop.text }),
    /** Follows GET /events; onChange runs for each event message. close() ends it. */
    events(onChange, onEnd = () => {}) {
      let buffer = "";
      let ended = false;
      const end = () => void (ended || ((ended = true), onEnd())); // a clean end, a destroyed socket and a refused connection each reach it, once
      const req = http.get(`${origin}/events`, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          let at;
          while ((at = buffer.indexOf("\n\n")) >= 0) {
            const message = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            if (/^data:/m.test(message)) onChange(message);
          }
        });
        res.on("end", end);
        res.on("close", end);
      });
      req.on("error", end);
      return { close: () => ((ended = true), req.destroy()) };
    },
  };
}

const runNode = (args) => new Promise((resolve) => {
  execFile(process.execPath, args, { timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
});

// Beside this file's own layout (<root>/apps/router, <root>/scripts), so the installed router runs its copy, not the checkout's.
export const USAGE_SCRIPT = fileURLToPath(new URL("../../scripts/usage.mjs", import.meta.url));

/** What `scripts/usage.mjs --live` printed, or { error } with its one-line diagnostic. */
export async function readLiveUsage({ run = runNode, script = USAGE_SCRIPT } = {}) {
  const out = await run([script, "--live"]);
  if (out.code !== 0) return { error: String(out.stderr).trim().split("\n").at(-1) || `usage.mjs exited ${out.code}` };
  try {
    return JSON.parse(out.stdout);
  } catch {
    return { error: "usage.mjs printed something that is not JSON" };
  }
}

const runGit = (cwd, args) => new Promise((resolve, reject) => {
  execFile("git", args, { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});

/** Delivery id -> the files its branch changed since its base, for each running or paused delivery git can read. A delivery
 *  git cannot read (no base, a missing commit) is left out, so it holds the files its ticket names. */
export async function readChangedFiles(root, deliveries, { git = runGit } = {}) {
  const out = new Map();
  for (const d of deliveries) {
    if ((d?.state !== "running" && d?.state !== "paused") || !/^[0-9a-f]{40}$/.test(d.base ?? "")) continue;
    const head = /^[0-9a-f]{40}$/.test(d.candidate?.sha ?? "") ? d.candidate.sha : d.branch;
    if (typeof head !== "string" || !head || head.startsWith("-")) continue;
    try {
      out.set(d.id, (await git(root, ["diff", "--name-only", d.base, head, "--"])).split("\n").filter(Boolean));
    } catch {}
  }
  return out;
}

/** The keys of router-stop requests the board holds that still silence a stop (see knownStopKeys). */
export async function readKnownStops(root) {
  return knownStopKeys(await readRequestRows(root));
}

/** read() served again for ttlMs, a failure ({ error }) included, so a cooldown or 429 is not hit on every tick. */
export function cachedReading(read, { ttlMs, now = Date.now }) {
  let at = -Infinity;
  let value;
  return async () => {
    if (now() - at >= ttlMs) {
      value = await read();
      at = now();
    }
    return value;
  };
}

// A pending stop is known. A dismissed one stays known only when its key names one occurrence (a pause); a dismissed
// "usage-reading" or "order" stop that is still true comes back, since the router is still stuck.
export function knownStopKeys(rows) {
  const handled = new Set(rows.filter((r) => typeof r?.handled === "string").map((r) => r.handled));
  return rows.filter((r) => r?.kind === ROUTER_STOP && typeof r.key === "string" && (!handled.has(r.id) || r.key.startsWith("pause:"))).map((r) => r.key);
}

/** A short push to the user's private ntfy topic. With no URL it does nothing. Errors never carry the URL. */
export async function pushNtfy(url, stop) {
  if (!url) return false;
  let res;
  try {
    res = await fetch(url, { method: "POST", redirect: "error", headers: { Title: `Den: ${stop.kind}` }, body: `${stop.ref ? `${stop.ref}: ` : ""}${stop.text}`.slice(0, 500), signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new Error(`push failed (${err.name})`);
  }
  if (!res.ok) throw new Error(`push failed (HTTP ${res.status})`);
  return true;
}
