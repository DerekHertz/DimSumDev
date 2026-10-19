// Shared plumbing for the Claude Code hook commands (statusline.mjs, session-start.mjs,
// notify.mjs): read the JSON on stdin without ever throwing, and read plan usage through a
// bounded child process. No network or model call lives here: usage comes from the existing
// scripts/usage.mjs (or a test double), run as a node child.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const defaultUsageScript = path.join(HERE, "usage.mjs");

// Hook input JSON, or {} for empty, unreadable or malformed stdin.
export function readStdinJson() {
  let text = "";
  try {
    text = readFileSync(0, "utf8");
  } catch {
    return {};
  }
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export const boardRoot = () => process.env.DEN_ROOT || process.env.ORGANISM_ROOT || process.cwd();

// Run a usage script and return its parsed JSON, or null on timeout, non-zero exit,
// spawn failure or unparseable output.
export function runUsage(script, timeoutMs) {
  try {
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"], killSignal: "SIGKILL" });
    if (r.error || r.status !== 0) return null;
    const v = JSON.parse(r.stdout);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// Usage windows as {percent, resets_at} or null each.
export function usageWindow(usage, key) {
  const w = usage?.[key];
  if (!w || typeof w.percent !== "number" || !Number.isFinite(w.percent)) return null;
  return { percent: w.percent, resets_at: typeof w.resets_at === "string" ? w.resets_at : null };
}
