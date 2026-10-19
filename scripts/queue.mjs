#!/usr/bin/env node
// organism-infra/212: the board's queue as buckets and as a text kanban. Board files and
// .scratch/usage.jsonl only (no network); the root comes from ORGANISM_ROOT, else the cwd.
//   readQueue(root) -> Promise<{ inFlight, ready, waitingOnUser, blocked, proposed }>
// Row: { ref, title, priority }. inFlight adds { cell, mode } from the lock; blocked adds
// { blockedBy }. The ready list is in the Queue's order (queue/06: buildQueue from
// apps/organism-infra/frontier-queue.mjs); each ready row carries { rank }, its 1-based position, and
// `proposed` lists the same tickets as { ref, title, rank }. A ready ticket buildQueue does not order
// (a blocker closed or parked, or not on the board) follows the ordered ones, in board order.
// CLI: `node scripts/queue.mjs [--json]`.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildQueue, loadSnapshot } from "../apps/organism-infra/frontier-queue.mjs";

const GONE = new Set(["resolved", "closed", "parked"]);
const MAX_TITLE = 60;

const header = (text, name) => new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*(.*)$`, "m").exec(text)?.[1].trim() ?? "";

const shorten = (title) => {
  const chars = [...title];
  return chars.length <= MAX_TITLE ? title : `${chars.slice(0, MAX_TITLE - 1).join("").trimEnd()}…`;
};

// Every ticket on the board, keyed `<feature>/<NN-slug>`, with its lock line if one is held.
function loadBoard(root) {
  const tickets = new Map();
  let features = [];
  try {
    features = readdirSync(path.join(root, ".scratch"), { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return tickets;
  }
  for (const f of features) {
    const dir = path.join(root, ".scratch", f.name, "issues");
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^(\d+)-.*\.md$/.exec(name);
      if (!m) continue;
      let text;
      try {
        text = readFileSync(path.join(dir, name), "utf8");
      } catch {
        continue;
      }
      let lock = null;
      try {
        lock = readFileSync(path.join(dir, `${name.slice(0, -3)}.lock`), "utf8").trim();
      } catch {
        // no lock held
      }
      const slug = name.slice(0, -3);
      const priority = /^P(\d+)/.exec(header(text, "Priority"));
      const title = /^#[ \t]*\d+:[ \t]*(.+)$/m.exec(text)?.[1].trim() ?? slug;
      tickets.set(`${f.name}/${slug}`, {
        ref: `${f.name}/${slug}`,
        feature: f.name,
        num: Number(m[1]),
        title: shorten(title),
        needsUser: /^user acts\b/i.test(header(text, "Type")),
        status: header(text, "Status").split(/\s+/)[0].toLowerCase(),
        priority: priority ? Number(priority[1]) : 2,
        blockedBy: header(text, "Blocked by"),
        lock,
      });
    }
  }
  return tickets;
}

// `Blocked by` text -> refs of tickets on the board. `NN` is the same feature, `feature/NN` another;
// parenthesised prose and "None" are not refs. A ticket the board doesn't hold is ignored.
function blockerRefs(ticket, byKey) {
  const out = [];
  for (const piece of ticket.blockedBy.replace(/\([^)]*\)/g, "").split(",")) {
    const m = /^\s*(?:([\w-]+)\/)?(\d+)\b/.exec(piece);
    if (!m) continue;
    const found = byKey.get(`${m[1] ?? ticket.feature}#${Number(m[2])}`);
    if (found) out.push(found);
  }
  return out;
}

const row = (t) => ({ ref: t.ref, title: t.title, priority: t.priority });

export async function readQueue(root) {
  const tickets = loadBoard(root);
  const byKey = new Map();
  for (const t of tickets.values()) byKey.set(`${t.feature}#${t.num}`, t.ref);

  const inFlight = [];
  const ready = [];
  const waitingOnUser = [];
  const blocked = [];

  for (const t of tickets.values()) {
    if (GONE.has(t.status)) continue;
    if (t.lock !== null || t.status === "claimed" || t.status === "in-review") {
      const parts = (t.lock ?? "").split(/\s+/).filter(Boolean);
      inFlight.push({ ...row(t), cell: parts[0] ?? null, mode: parts[2] === "specify" || parts[2] === "verify" ? parts[2] : null });
    } else if (t.status === "ready-for-human" || (t.status === "ready-for-agent" && t.needsUser)) {
      // den-mvp/105: a `user acts` ticket needs the user, not an agent, so it waits on the user.
      waitingOnUser.push(row(t));
    } else {
      const open = blockerRefs(t, byKey).filter((b) => !GONE.has(tickets.get(b).status));
      if (t.status === "blocked" || (t.status === "ready-for-agent" && open.length)) blocked.push({ ...row(t), blockedBy: open });
      else if (t.status === "ready-for-agent") ready.push(row(t));
    }
  }

  const byBoard = (a, b) => a.priority - b.priority || tickets.get(a.ref).feature.localeCompare(tickets.get(b.ref).feature) || tickets.get(a.ref).num - tickets.get(b.ref).num;
  for (const list of [ready, inFlight, waitingOnUser, blocked]) list.sort(byBoard); // ready is re-sorted below

  // Ready tickets in the Queue's order; buildQueue's ordered list also holds locked tickets, which are in flight here.
  const place = new Map((buildQueue(await loadSnapshot(root)).ordered).map((o, i) => [o.ref, i]));
  const spot = (r) => place.get(r.ref) ?? Number.MAX_SAFE_INTEGER;
  ready.sort((a, b) => spot(a) - spot(b));
  ready.forEach((r, i) => {
    r.rank = i + 1;
  });
  const proposed = ready.map((r) => ({ ref: r.ref, title: r.title, rank: r.rank }));
  return { inFlight, ready, waitingOnUser, blocked, proposed };
}

const MARKS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
const mark = (rank) => (rank >= 1 && rank <= MARKS.length ? MARKS[rank - 1] : `${rank}.`);
const short = (ref) => ref;

// The kanban as four stacked sections (a column per bucket would not fit a narrow terminal).
export function renderKanban(q) {
  const section = (heading, rows, line) => [`${heading} (${rows.length})`, ...(rows.length ? rows.map((r) => `  ${line(r)}`) : ["  -"]), ""];
  return [
    ...section("READY", q.ready, (r) => `${r.rank ? `${mark(r.rank)} ` : ""}${short(r.ref)}  ${r.title}  P${r.priority}`),
    ...section("IN FLIGHT", q.inFlight, (r) => `${short(r.ref)}  ${r.title}  [${r.cell ?? "no lock"}${r.mode ? ` ${r.mode}` : ""}]`),
    ...section("WAITING ON YOU", q.waitingOnUser, (r) => `${short(r.ref)}  ${r.title}`),
    ...section("BLOCKED", q.blocked, (r) => `${short(r.ref)}  ${r.title}${r.blockedBy.length ? `  <- ${r.blockedBy.map(short).join(", ")}` : ""}`),
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const q = await readQueue(process.env.ORGANISM_ROOT || process.cwd());
  process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify(q)}\n` : `${renderKanban(q)}\n`);
}
