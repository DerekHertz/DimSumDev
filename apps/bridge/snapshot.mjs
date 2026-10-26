// Snapshot builder for the bridge (ADR 0011 decision 3). Reads a .scratch/ tree
// and returns the GET /state payload. Read-only: no Board write paths.
import { newerUsage } from "./usage-reading.mjs";
import { roleOf } from "../board/legacy-terms.mjs";
import { createMarkdownBoard } from "./board/markdown-board.mjs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { orderFrontier } from "../board/priority.mjs";
import { buildRequests } from "./requests-log.mjs";
import { compareRefs } from "../../packages/board-refs/src/compare-refs.mjs";
import { readGoals } from "../board/goals.mjs";

const HANDOFF_CAP = 8192;
const OFF_RELAY = new Set(["resolved", "closed", "parked"]);

async function readText(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function listDir(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function readJsonl(file) {
  const text = await readText(file);
  if (!text) return [];
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object") rows.push(row);
    } catch {
      // malformed line: skip
    }
  }
  return rows;
}

const TICKET_TEXT_CAP = 6000;

function capText(buf) {
  if (buf.length <= HANDOFF_CAP) return { text: buf.toString("utf8"), truncated: false };
  let end = HANDOFF_CAP;
  // do not cut inside a multi-byte UTF-8 sequence
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

async function newestHandoff(scratch, feature, nn) {
  const dir = path.join(scratch, feature, "handoffs");
  let best = null;
  for (const name of await listDir(dir)) {
    if (!name.startsWith(`${nn}-`)) continue;
    let st;
    try {
      st = await stat(path.join(dir, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { name, mtimeMs: st.mtimeMs };
  }
  if (!best) return null;
  const buf = await readFile(path.join(dir, best.name));
  return {
    path: `${feature}/handoffs/${best.name}`,
    mtime: new Date(best.mtimeMs).toISOString(),
    ...capText(buf),
  };
}

// den-mvp/49: `boardRoot` is the active project's root when it is not the den's. Its tickets, their handoffs and their events
// are read from there; usage, requests and the orchestrator's handoffs stay the den's (control-keyed).
// multi-project/01: the tickets come from `board.list()` (the project's Board, markdown or GitHub); with no `board` the markdown
// board of `boardRoot` reads them, as before. The overlay below (requests, events, effective priority, gate, handoff) stays here.
export async function buildSnapshot(root, seq = 0, { readUsage = () => null, boardRoot = root, board = null } = {}) {
  const control = path.join(root, ".scratch");
  const scratch = path.join(boardRoot, ".scratch");
  const [events, usageRows, requestRows] = await Promise.all([
    readJsonl(path.join(scratch, "events.jsonl")),
    readJsonl(path.join(control, "usage.jsonl")),
    readJsonl(path.join(control, "_requests", "requests.jsonl")),
  ]);

  // orchestrator handoffs
  const handoffTimestamps = [];
  for (const name of await listDir(path.join(control, "_handoffs"))) {
    if (!/-(?:chief-of-staff|orchestrator)-[^/]*\.md$/.test(name)) continue;
    try {
      const st = await stat(path.join(control, "_handoffs", name));
      handoffTimestamps.push(new Date(st.mtimeMs).toISOString());
    } catch {
      // vanished
    }
  }

  // all tickets, resolved included (blocker lookup)
  const all = new Map();
  for (const t of await (board ?? createMarkdownBoard(boardRoot)).list()) {
    const [feature] = t.ref.split("/");
    all.set(t.ref, { ...t, feature: t.feature ?? feature, nn: t.nn ?? /^\/?(\d+)/.exec(t.ref.slice(feature.length + 1))?.[1] });
  }
  const findByNumber = (feature, nn) => {
    for (const t of all.values()) if (t.feature === feature && Number(t.nn) === Number(nn)) return t;
    return null;
  };

  // events: newest row per ticket, newest verdict per ticket, ready transitions
  const lastRow = new Map();
  const lastVerdict = new Map();
  const readyAt = new Map();
  for (const e of events) {
    if (!e.feature || !e.ticket) continue;
    const key = `${e.feature}/${e.ticket}`;
    lastRow.set(key, e);
    if (e.verdict) lastVerdict.set(key, e);
    if (e.to_status === "ready-for-agent" && e.ts) readyAt.set(key, e.ts);
  }

  const requests = buildRequests(requestRows);
  const pendingByRef = new Map();
  // A router stop is not a gate request: it does not hold the ticket's gate (den-mvp/88).
  for (const r of requests) if (r.state === "pending" && r.kind !== "router-stop" && !pendingByRef.has(r.ref)) pendingByRef.set(r.ref, r);

  const goalsFile = await readGoals(root);
  const tickets = [];
  const candidates = [];
  for (const t of [...all.values()].sort((a, b) => compareRefs(a.ref, b.ref))) {
    if (OFF_RELAY.has(t.status)) continue;
    const blockedBy = [];
    for (const b of t.blockedBy) {
      const [bFeature, bNn] = [b.slice(0, b.lastIndexOf("/")), b.slice(b.lastIndexOf("/") + 1)];
      const dep = findByNumber(bFeature, bNn);
      if (!dep) blockedBy.push({ ref: b, status: "unknown" });
      else if (!OFF_RELAY.has(dep.status)) blockedBy.push({ ref: dep.ref, status: dep.status });
    }
    const ready = t.status === "ready-for-agent" && blockedBy.length === 0;
    const priority = t.priority ?? "P2";
    const readySince = ready ? readyAt.get(t.ref) ?? new Date(t.mtimeMs ?? 0).toISOString() : null;
    const holder = t.holder ? { role: t.holder.role ?? null, since: t.holder.since ?? null, ...(t.holder.run ? { run: t.holder.run } : {}) } : null;
    const req = pendingByRef.get(t.ref);
    const verdict = lastVerdict.get(t.ref);
    const mergeGate =
      t.status === "in-review" && !holder && verdict && roleOf(verdict) === "security" && verdict.verdict === "pass";
    const row = {
      ref: t.ref,
      feature: t.feature,
      title: t.title,
      type: t.type,
      status: t.status,
      goal: t.goal ?? null,
      ready,
      priority,
      effectivePriority: priority,
      bumps: 0,
      bumped: false,
      readySince,
      blockedBy,
      blockedReason: t.status === "blocked" ? t.blockedReason ?? null : null,
      holder,
      lastRole: roleOf(lastRow.get(t.ref)) ?? null,
      gate: mergeGate ? "merge" : null,
      request: req ? { id: req.id, kind: req.kind, ts: req.ts } : null,
      handoff: await newestHandoff(scratch, t.feature, t.nn),
    };
    // den-mvp/13: the ticket's own text, only while it waits on the user, so Needs you can show it before Approve.
    if (t.status === "ready-for-human") row.text = String(t.text ?? "").slice(0, TICKET_TEXT_CAP);
    tickets.push(row);
    if (ready && !holder) candidates.push({ ref: t.ref, priority, readySince });
  }

  const ordered = orderFrontier(candidates, handoffTimestamps);
  const byRef = new Map(tickets.map((t) => [t.ref, t]));
  for (const o of ordered) {
    const t = byRef.get(o.ref);
    t.effectivePriority = o.effectivePriority;
    t.bumps = o.bumps;
    t.bumped = o.bumped;
  }
  const frontier = ordered.map((o) => o.ref);
  if (frontier.length) byRef.get(frontier[0]).gate = "dispatch"; // organism-infra/227: locks no longer hold the gate back (capacity does)

  let usage = null;
  for (const r of usageRows) {
    if (r.kind === "usage" && typeof r.five_hour === "number") {
      usage = { fiveHour: r.five_hour, weekly: r.weekly ?? null, sampledAt: r.ts ?? null };
    }
  }
  // Friction F19: the plan-usage cache, when it is newer than the last row (usage-reading.mjs).
  usage = newerUsage(usage, readUsage());

  return {
    schema: 1,
    seq,
    generatedAt: new Date().toISOString(),
    sessions: handoffTimestamps.length,
    tickets,
    frontier,
    usage,
    requests,
    // den-mvp/61: the user's goals, and what is wrong with the file (none with no file: the board has no goals yet).
    goals: goalsFile.goals,
    goalErrors: goalsFile.missing ? [] : goalsFile.errors,
  };
}
