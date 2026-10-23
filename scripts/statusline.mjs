#!/usr/bin/env node
// organism-infra/109: Claude Code `statusLine` command. One line, no model or network call:
//   5h 11% → 19:59Z · wk 51% · ctx 64k/80k · v1 ████░░ 8/12 · 4 to go · 123: qa verify · gates 2
// Input: the status-line JSON on stdin (Claude Code docs, statusline page:
// session_id, transcript_path, context_window.current_usage). Plan usage comes from
// scripts/usage.mjs through a 60 s on-disk cache (it only saves a spawn: the 5 minute shared cache
// and the 429 cooldown live in usage-claude.mjs, so a refresh never adds a network call);
// everything else is local files.
// Always prints one line and exits 0.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readStdinJson, boardRoot, runUsage, usageWindow, defaultUsageScript } from "./hook-io.mjs";
import { saveContextTokens } from "./context-state.mjs";
import { readRequestRows, foldRequests } from "../apps/bridge/requests-log.mjs";
import { readNorthStar } from "./north-star.mjs";
import { CHIEF_OF_STAFF, budgetFor } from "./context-budget.mjs";

// organism-infra/220: the line shows the orchestrator budget; the numbers come from scripts/context-budget.json.
const { warn: CTX_YELLOW, stop: CTX_LIMIT } = budgetFor(CHIEF_OF_STAFF);
const PCT_YELLOW = 80;
const PCT_RED = 90;
const CACHE_TTL_MS = 60_000;
const V1_BAR = 6;
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const paint = (color, text) => (color ? `${color}${text}${RESET}` : text);
const pctColor = (p) => (p >= PCT_RED ? RED : p >= PCT_YELLOW ? YELLOW : null);

const home = process.env.HOME || os.homedir();
const input = readStdinJson();

function sumUsage(u) {
  if (!u || typeof u !== "object") return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
}

// The last assistant usage in the transcript's tail, or null.
function transcriptTokens(file) {
  if (typeof file !== "string" || !file) return null;
  try {
    const size = statSync(file).size;
    const len = Math.min(size, 1_000_000);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      let rec;
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const u = rec?.type === "assistant" ? rec.message?.usage : null;
      if (u) return sumUsage(u);
    }
  } catch {
    // unreadable transcript: no number
  }
  return null;
}

function usageData() {
  const cache = process.env.STATUSLINE_CACHE || path.join(home, ".claude", "statusline-usage.json");
  try {
    if (Date.now() - statSync(cache).mtimeMs < CACHE_TTL_MS) {
      const v = JSON.parse(readFileSync(cache, "utf8"));
      if (v && typeof v === "object") return v;
    }
  } catch {
    // no usable cache: read fresh
  }
  const timeout = Number(process.env.STATUSLINE_USAGE_TIMEOUT_MS) || 4000;
  const fresh = runUsage(process.env.STATUSLINE_USAGE_SCRIPT || defaultUsageScript, timeout);
  if (fresh && (usageWindow(fresh, "5-hour") || usageWindow(fresh, "weekly"))) {
    try {
      mkdirSync(path.dirname(cache), { recursive: true });
      writeFileSync(cache, JSON.stringify(fresh));
    } catch {
      // cache is best effort
    }
    return fresh;
  }
  return null;
}

function resetTime(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
}

// In-flight relay: every claim lock `.scratch/<feature>/issues/NN-slug.lock`
// ("<agent> <iso-time> [mode] ..."). Write locks and reclaim files are not claims.
function relay(root) {
  const out = [];
  let features = [];
  try {
    features = readdirSync(path.join(root, ".scratch"), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const f of features) {
    if (!f.isDirectory()) continue;
    const dir = path.join(root, ".scratch", f.name, "issues");
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^0*(\d+)-.*\.lock$/.exec(name);
      if (!m || name.includes(".reclaim-")) continue;
      try {
        const [role, , mode] = readFileSync(path.join(dir, name), "utf8").trim().split(/\s+/);
        if (role) out.push(`${m[1]}: ${role}${mode ? ` ${mode}` : ""}`);
      } catch {
        // lock vanished mid-read
      }
    }
  }
  return out;
}

async function pendingGates(root) {
  try {
    return foldRequests(await readRequestRows(root)).filter((r) => r.state === "pending").length;
  } catch {
    return 0;
  }
}

// organism-infra/209: den v1 progress, board files only; omitted when the set is empty.
function v1Segment(root) {
  try {
    const { done, total, remaining } = readNorthStar(root);
    if (!total) return null;
    const fill = done >= total ? V1_BAR : Math.min(V1_BAR - 1, Math.round((done / total) * V1_BAR));
    return `v1 ${"█".repeat(fill)}${"░".repeat(V1_BAR - fill)} ${done}/${total} · ${remaining} to go`;
  } catch {
    return null;
  }
}

const root = boardRoot();
const usage = usageData();
const segs = [];

const five = usageWindow(usage, "5-hour");
if (five) {
  const reset = resetTime(five.resets_at);
  segs.push(paint(pctColor(five.percent), `5h ${Math.round(five.percent)}%${reset ? ` → ${reset}` : ""}`));
} else {
  segs.push("5h ?");
}
const week = usageWindow(usage, "weekly");
segs.push(week ? paint(pctColor(week.percent), `wk ${Math.round(week.percent)}%`) : "wk ?");

const fromInput = sumUsage(input.context_window?.current_usage);
if (fromInput !== null && typeof input.session_id === "string") saveContextTokens(home, input.session_id, fromInput);
const tokens = fromInput !== null ? fromInput : transcriptTokens(input.transcript_path);
if (tokens === null) {
  segs.push("ctx ?");
} else {
  const label = `ctx ${Math.round(tokens / 1000)}k/${CTX_LIMIT / 1000}k`;
  segs.push(tokens >= CTX_LIMIT ? paint(RED, `${label} → /compact`) : paint(tokens >= CTX_YELLOW ? YELLOW : null, label));
}

const v1 = v1Segment(root);
if (v1) segs.push(v1);

const flight = relay(root);
if (flight.length) segs.push(flight.join(", "));
segs.push(`gates ${await pendingGates(root)}`);

process.stdout.write(segs.join(" · ") + "\n");
