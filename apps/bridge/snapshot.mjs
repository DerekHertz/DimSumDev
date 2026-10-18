// Snapshot builder for the bridge (ADR 0011 decision 3). Reads a .scratch/ tree
// and returns the GET /state payload. Read-only: no Board write paths.
import { newerUsage } from "./usage-reading.mjs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parsePriority, orderFrontier } from "../organism-infra/priority.mjs";
import { buildRequests } from "./requests-log.mjs";
import { compareRefs } from "../../packages/board-refs/src/compare-refs.mjs";
import { readGoals } from "../organism-infra/goals.mjs";

const HANDOFF_CAP = 8192;

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

const headerValue = (md, label) => {
  const m = new RegExp(`^\\*\\*${label}:\\*\\*[ \\t]*(.*?)[ \\t]*$`, "m").exec(md);
  return m ? m[1] : null;
};

function parseTicket(md) {
  const title = /^#[ \t]+(.+?)[ \t]*$/m.exec(md)?.[1] ?? "";
  const typeRaw = headerValue(md, "Type");
  const type = typeRaw ? (typeRaw.split(/\s+/)[0] || "").toLowerCase() || null : null;
  const status = headerValue(md, "Status") ?? "unknown";
  const goal = headerValue(md, "Goal") || null;
  const blockedByRaw = headerValue(md, "Blocked by") ?? "";
  const blockers = [];
  for (const tok of blockedByRaw.split(",")) {
    const m = /^\s*(?:([a-z0-9-]+)\/)?(\d+)/.exec(tok);
    if (m) blockers.push({ feature: m[1] ?? null, nn: m[2] });
  }
  let blockedReason = null;
  const ci = md.search(/^## Comments\s*$/m);
  if (ci >= 0) {
    const bullets = md
      .slice(ci)
      .split("\n")
      .filter((l) => /^- /.test(l));
    if (bullets.length) blockedReason = bullets[bullets.length - 1].slice(2).trim();
  }
  return { title, type, status, goal, blockers, blockedReason, md };
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
export async function buildSnapshot(root, seq = 0, { readUsage = () => null, boardRoot = root } = {}) {
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
    if (!/-orchestrator-[^/]*\.md$/.test(name)) continue;
    try {
      const st = await stat(path.join(control, "_handoffs", name));
      handoffTimestamps.push(new Date(st.mtimeMs).toISOString());
    } catch {
      // vanished
    }
  }

  // all tickets, resolved included (blocker lookup)
  const all = new Map();
  const featureNames = [];
  for (const feature of await listDir(scratch)) {
    const issues = path.join(scratch, feature, "issues");
    const names = await listDir(issues);
    if (!names.length) continue;
    featureNames.push(feature);
    for (const name of names) {
      const m = /^(\d+)-.*\.md$/.exec(name);
      if (!m) continue;
      const file = path.join(issues, name);
      const md = await readText(file);
      if (md === null) continue;
      const st = await stat(file);
      const t = parseTicket(md);
      t.ref = `${feature}/${name.slice(0, -3)}`;
      t.feature = feature;
      t.nn = m[1];
      t.mtimeMs = st.mtimeMs;
      t.locked = (await readText(path.join(issues, `${name.slice(0, -3)}.lock`))) ?? null;
      all.set(t.ref, t);
    }
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
    if (t.status === "resolved") continue;
    const blockedBy = [];
    for (const b of t.blockers) {
      const dep = findByNumber(b.feature ?? t.feature, b.nn);
      if (!dep) blockedBy.push({ ref: `${b.feature ?? t.feature}/${b.nn}`, status: "unknown" });
      else if (dep.status !== "resolved") blockedBy.push({ ref: dep.ref, status: dep.status });
    }
    const ready = t.status === "ready-for-agent" && blockedBy.length === 0;
    const priority = parsePriority(t.md);
    const readySince = ready ? readyAt.get(t.ref) ?? new Date(t.mtimeMs).toISOString() : null;
    let holder = null;
    if (t.locked !== null) {
      const [cell, since] = t.locked.trim().split(/\s+/);
      holder = { cell: cell ?? null, since: since ?? null };
    }
    const req = pendingByRef.get(t.ref);
    const verdict = lastVerdict.get(t.ref);
    const mergeGate =
      t.status === "in-review" && !holder && verdict && verdict.cell === "security" && verdict.verdict === "pass";
    const row = {
      ref: t.ref,
      feature: t.feature,
      title: t.title,
      type: t.type,
      status: t.status,
      goal: t.goal,
      ready,
      priority,
      effectivePriority: priority,
      bumps: 0,
      bumped: false,
      readySince,
      blockedBy,
      blockedReason: t.status === "blocked" ? t.blockedReason : null,
      holder,
      lastCell: lastRow.get(t.ref)?.cell ?? null,
      gate: mergeGate ? "merge" : null,
      request: req ? { id: req.id, kind: req.kind, ts: req.ts } : null,
      handoff: await newestHandoff(scratch, t.feature, t.nn),
    };
    // den-mvp/13: the ticket's own text, only while it waits on the user, so Needs you can show it before Approve.
    if (t.status === "ready-for-human") row.text = t.md.slice(0, TICKET_TEXT_CAP);
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
