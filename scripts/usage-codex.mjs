// Only the supported app-server quota RPC is used; no auth files are read.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { toLocalReset } from "./usage-local-time.mjs";

function normalize(result) {
  const limits = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  if (limits?.limitId !== "codex") throw new Error("response has no Codex limits");
  const out = { provider: "codex", source: "account/rateLimits/read" };
  for (const window of [limits.primary, limits.secondary]) {
    if (window == null) continue;
    const label = { 300: "5-hour", 10080: "weekly" }[window?.windowDurationMins];
    if (!label || out[label] || typeof window.windowDurationMins !== "number" ||
        typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent) ||
        window.usedPercent < 0 || window.usedPercent > 100 ||
        typeof window.resetsAt !== "number" || !Number.isFinite(window.resetsAt) || window.resetsAt <= 0) {
      throw new Error("response has invalid usage windows");
    }
    const reset = new Date(window.resetsAt * 1000);
    if (!Number.isFinite(reset.getTime())) throw new Error("response has invalid reset time");
    out[label] = { percent: Math.round(window.usedPercent), resets_at: reset.toISOString(), resets_local: toLocalReset(reset) };
  }
  if (!out["5-hour"] && !out.weekly) throw new Error("response is missing usage windows");
  out["5-hour"] ??= { percent: null, resets_at: null, resets_local: null };
  out.weekly ??= { percent: null, resets_at: null, resets_local: null };
  return out;
}

export async function readCodexUsage() {
  const timeout = Number(process.env.USAGE_CODEX_TIMEOUT_MS ?? 10_000);
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 60_000) {
    throw new Error("timeout must be a positive integer no greater than 60000ms");
  }
  const runtime = mkdtempSync(join(tmpdir(), "usage-codex-"));
  let child, lines, timer;
  try {
    const result = await new Promise((resolve, reject) => {
      const fail = (message) => reject(new Error(message));
      let expected = 1;
      child = spawn("codex", ["-c", `sqlite_home=${JSON.stringify(runtime)}`, "app-server"], {
        env: { ...process.env, TMPDIR: runtime }, stdio: ["pipe", "pipe", "pipe"],
      });
      // Raw CLI/RPC messages can contain credentials; expose only local diagnostics.
      child.stderr.resume();
      child.once("error", () => fail("app-server could not start"));
      child.once("exit", () => fail("app-server exited before returning rate limits"));
      child.stdin.on("error", () => fail("app-server input failed"));
      const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
      lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let response;
        try { response = JSON.parse(line); }
        catch { fail("app-server returned malformed JSON"); return; }
        if (response?.id !== expected) return;
        if (response.error) { fail("app-server RPC failed (authentication or network may be unavailable)"); return; }
        if (!Object.hasOwn(response, "result")) { fail("app-server returned an invalid response"); return; }
        if (expected === 1) {
          expected = 2;
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        } else resolve(response.result);
      });
      timer = setTimeout(() => fail("app-server timed out"), timeout);
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "usage-watch", version: "1.0.0" } } });
    });
    return normalize(result);
  } finally {
    clearTimeout(timer);
    lines?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      // Quota reads create no work requiring a graceful shutdown. Reap before cleanup.
      await new Promise((resolve) => {
        child.once("close", resolve);
        child.kill("SIGKILL");
      });
    }
    rmSync(runtime, { recursive: true, force: true });
  }
}
