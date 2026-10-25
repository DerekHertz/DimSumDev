#!/usr/bin/env node
// organism-infra/109: Claude Code `statusLine` command. One line, no model or network call:
//   5h 11% → 19:59Z · wk 51% · ctx 64k/80k · v1 ████░░ 8/12 · 4 to go · 123: qa verify · gates 2
// Input: the status-line JSON on stdin (Claude Code docs, statusline page:
// session_id, transcript_path, context_window.current_usage, rate_limits.five_hour / seven_day
// { used_percentage, resets_at }, present for Pro/Max after the first API response). Plan usage is that
// input, written to the snapshot ~/.claude/usage-cache.json (hardening/17) for the bridge; with no
// rate_limits the line shows the snapshot while it is under STALE_MS old, else "?". It never starts
// the usage script; everything else is local files.
// Always prints one line and exits 0.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readStdinJson, boardRoot, usageWindow } from "./hook-io.mjs";
import { STALE_MS } from "../apps/bridge/usage-reading.mjs";
import { saveContextTokens } from "./context-state.mjs";
import { readRequestRows, foldRequests } from "../apps/bridge/requests-log.mjs";
import { readNorthStar } from "./north-star.mjs";
import { CHIEF_OF_STAFF, budgetFor } from "./context-budget.mjs";
import { toLocalReset } from "./usage-local-time.mjs";

// organism-infra/220: the line shows the orchestrator budget; the numbers come from scripts/context-budget.json.
const { warn: CTX_YELLOW, stop: CTX_LIMIT } = budgetFor(CHIEF_OF_STAFF);
const PCT_YELLOW = 80;
const PCT_RED = 90;
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

// resets_at is documented as epoch seconds; milliseconds and ISO strings are accepted too. An ISO string or null out.
function resetIso(v) {
  const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : typeof v === "string" && v.trim() !== "" ? (Number.isFinite(Number(v)) ? (Number(v) < 1e12 ? Number(v) * 1000 : Number(v)) : Date.parse(v)) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// The windows the input carries, in the snapshot's shape. A window it lacks is absent, never guessed.
function windowsFromInput(rate) {
  const out = {};
  for (const [key, label] of [["five_hour", "5-hour"], ["seven_day", "weekly"]]) {
    const w = rate?.[key];
    if (typeof w?.used_percentage === "number" && Number.isFinite(w.used_percentage)) {
      const resets_at = resetIso(w.resets_at);
      out[label] = { percent: w.used_percentage, resets_at, resets_local: toLocalReset(resets_at) };
    }
  }
  return out;
}

function readSnapshot(file) {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// Atomic (tmp file, then rename) and best effort; keeps the cooldown_until scripts/usage-claude.mjs keeps in the same file.
function writeSnapshot(file, windows) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const keep = readSnapshot(file);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ at: Date.now(), windows, cooldown_until: Number.isFinite(keep?.cooldown_until) ? keep.cooldown_until : 0 }), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    rmSync(tmp, { force: true });
  }
}

function usageData(rate) {
  const file = process.env.STATUSLINE_CACHE || path.join(home, ".claude", "usage-cache.json");
  const live = windowsFromInput(rate);
  if (Object.keys(live).length) {
    writeSnapshot(file, live);
    return live;
  }
  const snap = readSnapshot(file);
  return Number.isFinite(snap?.at) && Date.now() - snap.at <= STALE_MS && snap.windows && typeof snap.windows === "object" ? snap.windows : null;
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
const usage = usageData(input.rate_limits);
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

const cw = input.context_window;
const fromPercent = Number.isFinite(cw?.used_percentage) && Number.isFinite(cw?.context_window_size) ? Math.round((cw.used_percentage / 100) * cw.context_window_size) : null;
const fromInput = sumUsage(cw?.current_usage) ?? fromPercent;
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
