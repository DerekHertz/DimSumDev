// den-mvp/62 (spec .scratch/den-mvp/handoffs/62-designer-spec.md): the Queue drawer's view-model. Pure; contract and
// shapes in queue-drawer-model.test.mjs. Goals come from the snapshot (.scratch/goals.md, den-mvp/61).
import { compareRefs } from "../../../../packages/board-refs/src/compare-refs.mjs";
import { needsYouModel, shortRef } from "./overlay-model.mjs";

const YOU = new Set(["ready-for-human", "needs-triage", "needs-design"]);
const MAX_DEPTH = 3;
const NEXT_MAX = 2;

export function queueDrawerModel(snapshot, nowMs) {
  const tickets = snapshot?.tickets ?? [];
  const byRef = new Map(tickets.map((t) => [t.ref, t]));
  const openBlockers = (t) => (t.blockedBy ?? []).map((b) => b.ref).filter((ref) => byRef.has(ref));
  const depths = new Map();
  const depthOf = (ref, seen = new Set()) => {
    if (depths.has(ref)) return depths.get(ref);
    if (seen.has(ref)) return 0; // a cycle on the board: stop rather than loop
    seen.add(ref);
    const open = openBlockers(byRef.get(ref));
    const d = open.length ? Math.min(MAX_DEPTH, 1 + Math.max(...open.map((b) => depthOf(b, seen)))) : 0;
    depths.set(ref, d);
    return d;
  };
  const stateOf = (t) => (openBlockers(t).length ? "waiting" : t.status === "in-review" ? "review" : YOU.has(t.status) || (t.status === "ready-for-agent" && t.type === "user") ? "you" : "ready");
  const row = (t) => ({
    ref: t.ref,
    short: shortRef(t.ref),
    title: t.title,
    type: t.type ?? null,
    priority: t.effectivePriority ?? t.priority ?? "P2",
    state: stateOf(t),
    depth: depthOf(t.ref),
    waitsOn: openBlockers(t).map(shortRef),
  });
  const order = (a, b) => a.depth - b.depth || a.priority.localeCompare(b.priority) || compareRefs(a.ref, b.ref);
  const block = (key, name, why, rows) => {
    const sorted = rows.sort(order);
    const counts = { open: sorted.length, ready: 0, review: 0, you: 0, waiting: 0 };
    for (const r of sorted) counts[r.state] += 1;
    return { key, name, why, counts, next: sorted.filter((r) => r.state === "ready").slice(0, NEXT_MAX).map((r) => r.ref), tickets: sorted };
  };

  const goalList = snapshot?.goals ?? [];
  const known = new Set(goalList.map((g) => g.key));
  const goals = goalList
    .map((g) => block(g.key, g.name, g.why, tickets.filter((t) => t.goal === g.key).map(row)))
    .filter((g) => g.tickets.length > 0);
  const loose = tickets.filter((t) => !known.has(t.goal)).map(row);
  if (loose.length) goals.push(block(null, "No goal", "Tickets that name no goal from .scratch/goals.md.", loose));

  const needs = needsYouModel(snapshot, nowMs).requests.map((r) => ({ key: r.key, kind: r.kind, text: r.rowText ?? r.title ?? r.key }));
  return {
    openCount: tickets.length,
    needs,
    goalErrors: snapshot?.goalErrors ?? [],
    openGoal: goals.find((g) => g.counts.ready > 0)?.key ?? null,
    goals,
  };
}
