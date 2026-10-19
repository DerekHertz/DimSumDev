// organism-infra/228 (UI spec .scratch/organism-infra/handoffs/228-designer-spec.md): the pure pieces behind the Run
// control on a frontier ticket and the slot strip. No DOM, no fetch; Cards.jsx renders what these return.
// Contract and shapes: apps/ui/src/overlay/run-model.test.mjs.
import { capacity as capacityOf } from "../../../bridge/agents/capacity.mjs";
import { SLOTS, slotClassOf } from "../../../bridge/agents/policy.mjs";

/** The roles Run offers: every role. den-mvp outcome 1: a developer, qa or security agent may be started directly. */
export const ROLE_OPTIONS = ["orchestrator", "architect", "product", "designer", "scout", "herald", "developer", "qa", "security"];

const DEFAULT_ROLE = { feature: "orchestrator", bug: "orchestrator", "design-question": "architect", design: "architect", decision: "architect", spec: "product", ui: "designer", asset: "designer" };
const ENDED = new Set(["done", "failed", "terminated"]);

/** The role a ticket starts with in the select, by its type. Anything unrecognised (or no ticket) is the orchestrator. */
export function defaultRole(ticket) {
  // F32: the den reads Bao's "design question" as `design` (as the scene does); a ticket may add a note in brackets.
  const type = typeof ticket?.type === "string" ? ticket.type.replace(/\(.*?\)/g, "").trim().toLowerCase().replace(/\s+/g, "-") : null;
  return type !== null && Object.hasOwn(DEFAULT_ROLE, type) ? DEFAULT_ROLE[type] : "orchestrator";
}

const byRef = (a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);

/** One entry per ref, a live agent winning over a lock on the same ref; running first, then locks, each by ref. */
function orderedRefs(capacity) {
  const seen = new Map();
  for (const r of capacity?.refs ?? []) {
    if (!seen.has(r.ref) || r.kind === "live") seen.set(r.ref, { ref: r.ref, kind: r.kind === "live" ? "live" : "lock" });
  }
  const all = [...seen.values()];
  return [...all.filter((r) => r.kind === "live").sort(byRef), ...all.filter((r) => r.kind === "lock").sort(byRef)];
}

/** The rows of the slot strip: { ref, kind: "live"|"lock", role, tag, label }. No capacity gives no rows. */
export function slotRows(capacity, agents) {
  return orderedRefs(capacity).map(({ ref, kind }) => {
    if (kind === "lock") return { ref, kind, role: null, tag: "lock, no agent", label: `${ref}, lock held, no running agent` };
    const role = (agents ?? []).find((a) => a.ref === ref && !ENDED.has(a.state))?.role ?? null;
    const name = role ?? "agent";
    return { ref, kind, role, tag: `${name} · running`, label: `${ref}, running as ${name}` };
  });
}

/**
 * Whether Run is enabled for a ticket, and the visible text under it. Reasons, first match wins: demo mode, no steering
 * session, capacity unknown, a start in flight for this ref, the ticket already has a live agent, no room. `role` picks
 * the slot: the orchestrator (Bao) and a scout each have one reserved slot; every other role takes a worker slot.
 */
export function runState({ capacity, ticket, inflight, steer, role } = {}) {
  if (steer?.demo) return { enabled: false, reason: "Demo mode: actions are off" };
  if (steer?.state === "none") return { enabled: false, reason: "Couldn't send: not signed in to steer" };
  if (!capacity) return { enabled: false, reason: "Capacity unknown" };
  if (inflight) return { enabled: false, reason: "Starting…" };
  const rows = orderedRefs(capacity);
  if (rows.some((r) => r.ref === ticket?.ref && r.kind === "live")) return { enabled: false, reason: "Already running" };
  const cls = typeof role === "string" ? slotClassOf(role) : "worker";
  if (cls !== "worker") {
    const slot = capacity.reserved?.[cls] ?? { max: SLOTS[cls], refs: [] };
    if (slot.refs.includes(ticket?.ref)) return { enabled: false, reason: "Already running" };
    if (slot.refs.length >= slot.max) return { enabled: false, reason: `The ${cls === "bao" ? "Bao" : cls} slot is in use: ${slot.refs.join(", ")}` };
    return { enabled: true, reason: null };
  }
  if (capacity.room <= 0) {
    // The session cap binds when it leaves less room than max does; then the count is live agents against the cap.
    const capBinds = capacity.cap - capacity.live <= capacity.max - capacity.load;
    const refs = (capBinds ? rows.filter((r) => r.kind === "live") : rows).map((r) => r.ref).join(", ");
    return { enabled: false, reason: capBinds ? `${capacity.live} of ${capacity.cap} running: ${refs}` : `${capacity.load} of ${capacity.max} running: ${refs}` };
  }
  const others = rows.filter((r) => r.ref !== ticket?.ref).map((r) => r.ref);
  return { enabled: true, reason: others.length > 0 ? `Also running: ${others.join(", ")}` : null };
}

/**
 * The capacity as the UI holds it between snapshots: the shared pure capacity() over the agents and ticket holders in
 * the snapshot, with max and cap from its capacity key. A snapshot without that key (an older bridge) gives null.
 */
export function capacityFromSnapshot(snapshot) {
  const known = snapshot?.capacity;
  if (!known) return null;
  // Worker slots only: Bao's and a scout's agents (and the locks they hold) sit in their own reserved slots.
  const live = (snapshot.agents ?? []).filter((a) => a.ref && !ENDED.has(a.state));
  const reservedRefs = new Set(live.filter((a) => slotClassOf(a.role) !== "worker").map((a) => a.ref));
  const liveRefs = live.filter((a) => !reservedRefs.has(a.ref)).map((a) => a.ref);
  const lockedRefs = (snapshot.tickets ?? []).filter((t) => t.holder && !reservedRefs.has(t.ref)).map((t) => t.ref);
  const reserved = Object.fromEntries(Object.keys(SLOTS).filter((cls) => cls !== "worker").map((cls) => [cls, { max: known.reserved?.[cls]?.max ?? SLOTS[cls], refs: live.filter((a) => slotClassOf(a.role) === cls).map((a) => a.ref) }]));
  return { ...capacityOf({ liveRefs, lockedRefs, max: known.max, cap: known.cap }), reserved };
}

/** The Needs you dispatch prompt (note, Approve, Deny): hidden at room 0, with one line saying why. */
export function dispatchPrompt(capacity) {
  if (capacity && capacity.room <= 0) return { show: false, line: `No room to dispatch: ${capacity.load} of ${capacity.max} running.` };
  return { show: true, line: null };
}
