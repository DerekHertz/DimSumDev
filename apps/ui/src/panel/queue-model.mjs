// Queue and selected-ticket view-models (pure; tested under node --test).
import { compareRefs } from "../../../../packages/board-refs/src/compare-refs.mjs";
const IN_FLIGHT = new Set(["claimed", "in-review", "blocked", "ready-for-human"]);
const NO_SELECTION = "Select a ticket in the queue or the scene.";

const shortRef = (ref) => ref.slice(ref.indexOf("/") + 1);

function row(t) {
  const open = (t.blockedBy ?? []).filter((b) => b.status !== "resolved");
  const blocked = t.status === "blocked" || open.length > 0;
  const blockedText = open.length ? `Blocked by ${open.map((b) => `${shortRef(b.ref)} (${b.status})`).join(", ")}` : null;
  return {
    ref: t.ref,
    title: t.title,
    priorityLabel: t.bumped ? `${t.effectivePriority} ↑` : t.effectivePriority,
    bumped: Boolean(t.bumped),
    bumpLabel: t.bumped ? `Bumped from ${t.priority} after ${t.bumps} sessions` : null,
    cellType: t.holder?.role ?? t.lastRole ?? null,
    status: t.status,
    blocked,
    blockedText,
    blockedReason: blocked ? (t.blockedReason ?? null) : null,
  };
}

export function queueModel(snapshot) {
  const byRef = new Map(snapshot.tickets.map((t) => [t.ref, t]));
  const frontierRefs = new Set(snapshot.frontier ?? []);
  const frontier = (snapshot.frontier ?? []).filter((r) => byRef.has(r)).map((r) => row(byRef.get(r)));
  const inFlight = snapshot.tickets
    .filter((t) => IN_FLIGHT.has(t.status) && !frontierRefs.has(t.ref))
    .sort((a, b) => compareRefs(a.ref, b.ref))
    .map(row);
  return { frontier, inFlight, empty: frontier.length === 0 && inFlight.length === 0 };
}

export function detailModel(snapshot, ref) {
  const t = ref ? snapshot.tickets.find((x) => x.ref === ref) : null;
  if (!t) return { kind: "none", message: NO_SELECTION };
  const base = {
    ref: t.ref,
    title: t.title,
    status: t.status,
    holder: t.holder ? `${t.holder.role} since ${t.holder.since}` : null,
  };
  if (!t.handoff) return { kind: "missing-handoff", message: "No handoff yet.", ...base };
  return { kind: "handoff", ...base, handoff: t.handoff };
}
