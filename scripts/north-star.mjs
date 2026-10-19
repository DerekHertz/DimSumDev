#!/usr/bin/env node
// organism-infra/209: den v1 progress, read from the board only (no network, no usage API).
//   readNorthStar(root) -> { done, total, remaining, next }
// The ticket set is derived on every read: every ticket under .scratch/den-v1/issues/ plus the
// tickets they name in `Blocked by`, followed through the whole chain. Done is resolved or closed;
// parked tickets drop out of the total. `next` is the ref of the unblocked, not-done ticket with the
// longest path of not-done tickets depending on it (ties: higher priority, then the lower number).
// CLI: `node scripts/north-star.mjs --json` prints the object (root from DEN_ROOT or cwd).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FEATURE = "den-v1";
const DONE = new Set(["resolved", "closed"]);

const header = (text, name) => new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*(.*)$`, "m").exec(text)?.[1].trim() ?? "";

// Every ticket on the board, keyed `<feature>/<NN-slug>`.
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
      const ref = `${f.name}/${name.slice(0, -3)}`;
      const priority = /^P(\d+)/.exec(header(text, "Priority"));
      tickets.set(ref, {
        ref,
        feature: f.name,
        num: Number(m[1]),
        status: header(text, "Status").split(/\s+/)[0].toLowerCase(),
        priority: priority ? Number(priority[1]) : 2,
        blockedBy: header(text, "Blocked by"),
      });
    }
  }
  return tickets;
}

// `Blocked by` text -> ticket refs that exist on the board. `NN` is the same feature, `feature/NN`
// another; parenthesised prose and "None" are not refs.
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

export function readNorthStar(root) {
  const tickets = loadBoard(root);
  const byKey = new Map();
  for (const t of tickets.values()) byKey.set(`${t.feature}#${t.num}`, t.ref);
  const blockers = new Map(); // ref -> refs
  for (const t of tickets.values()) blockers.set(t.ref, blockerRefs(t, byKey));

  // The set: den-v1 tickets, then blockers through the chain (the walk continues through parked tickets, which stay out of the total).
  const set = new Set();
  const queue = [...tickets.values()].filter((t) => t.feature === FEATURE).map((t) => t.ref);
  while (queue.length) {
    const ref = queue.pop();
    if (set.has(ref)) continue;
    set.add(ref);
    queue.push(...blockers.get(ref));
  }

  const live = [...set].map((r) => tickets.get(r)).filter((t) => t.status !== "parked");
  const done = live.filter((t) => DONE.has(t.status)).length;
  const open = live.filter((t) => !DONE.has(t.status));
  const openRefs = new Set(open.map((t) => t.ref));

  // Dependents within the open tickets, then the longest path behind each ticket.
  const dependents = new Map(open.map((t) => [t.ref, []]));
  for (const t of open) for (const b of blockers.get(t.ref)) if (openRefs.has(b)) dependents.get(b).push(t.ref);
  const depth = new Map();
  // A cycle among open tickets leaves none of them unblocked, so a cut walk never reaches the ranking.
  const walk = (ref) => {
    if (depth.has(ref)) return depth.get(ref);
    depth.set(ref, 0);
    let best = 0;
    for (const d of dependents.get(ref)) best = Math.max(best, 1 + walk(d));
    depth.set(ref, best);
    return best;
  };

  const candidates = open.filter((t) => blockers.get(t.ref).every((b) => DONE.has(tickets.get(b).status)));
  const ranked = candidates
    .map((t) => ({ t, depth: walk(t.ref) }))
    .sort((a, b) => b.depth - a.depth || a.t.priority - b.t.priority || a.t.num - b.t.num);

  return { done, total: live.length, remaining: live.length - done, next: ranked[0]?.t.ref ?? null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.DEN_ROOT || process.env.ORGANISM_ROOT || process.cwd();
  const progress = readNorthStar(root);
  process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify(progress)}\n` : `v1 ${progress.done}/${progress.total} · ${progress.remaining} to go${progress.next ? ` · next: ${progress.next}` : ""}\n`);
}
