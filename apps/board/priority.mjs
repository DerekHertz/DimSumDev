// Ticket priority: parse the header line and order the frontier (ADR 0011
// decision 3, docs/agents/issue-tracker.md). Pure functions, no I/O.
//
// Rules:
// - `**Priority:** P0`..`P3` on its own line. Missing or malformed is P2.
// - No aging (queue/06, ADR 0015 Amendment 3: the Queue replaces the bump). A ticket's
//   effective priority is its priority; `bumps` is always 0 and `bumped` false. The
//   fields stay so the UI snapshot and queue-model keep their shape.
// - Order: priority, then readySince (oldest first), then ticket number
//   (numeric), then ref as a final stable tiebreak.
//
// handoffTimestamps is still accepted (the snapshot builder passes it) and unused.

import { compareRefs } from "../../packages/board-refs/src/compare-refs.mjs";

const LEVELS = ["P0", "P1", "P2", "P3"];

export function parsePriority(ticketMarkdown) {
  const m = /^\*\*Priority:\*\*[ \t]*(P[0-3])[ \t]*$/m.exec(String(ticketMarkdown ?? ""));
  return m ? m[1] : "P2";
}

function ticketNumber(ref) {
  const slug = String(ref).split("/").pop();
  const m = /^(\d+)/.exec(slug);
  return m ? Number(m[1]) : Infinity;
}

export function orderFrontier(candidates, handoffTimestamps) {
  const rows = candidates.map((c) => ({
    ref: c.ref,
    priority: c.priority,
    effectivePriority: c.priority,
    bumps: 0,
    bumped: false,
    _level: LEVELS.indexOf(c.priority),
    _ready: Date.parse(c.readySince),
  }));
  rows.sort(
    (a, b) =>
      a._level - b._level ||
      a._ready - b._ready ||
      ticketNumber(a.ref) - ticketNumber(b.ref) ||
      compareRefs(a.ref, b.ref),
  );
  return rows.map(({ _level, _ready, ...out }) => out);
}
