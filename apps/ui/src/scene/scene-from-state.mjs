import { teamOf } from "./banquet-layout.mjs";
import { compareRefs } from "../../../../packages/board-refs/src/compare-refs.mjs";

// ADR 0011 decision 7: sceneFromState(snapshot) -> Placement[]. Pure; no three, React or DOM.
export const MAX_PLUSH = 12;

export const ACTIVE_STATUSES = new Set(["claimed", "in-review", "blocked", "ready-for-human"]);
const ARCHITECT_TYPES = new Set(["design", "design-question", "design-direction", "decision", "prototype"]);

export function roleOf(t) {
  if (t.holder?.role) return t.holder.role;
  if (t.lastRole) return t.lastRole;
  if (ARCHITECT_TYPES.has(t.type)) return "architect";
  if (t.type === "research") return "scout";
  return "developer";
}

function poseOf(t) {
  if (t.gate) return "waiting_on_user";
  if (t.status === "ready-for-human") return "waiting_on_user";
  if (t.status === "claimed") return "working";
  if (t.status === "in-review") return t.holder ? "working" : "done";
  if (t.status === "blocked") return "blocked";
  return "idle";
}

/**
 * One placement per active ticket. Queued (ready) tickets get no placement: they show only as baskets on the
 * lazy susan until a placement picks them up (showcase-v1/04).
 * @param {{tickets: object[]}} snapshot
 */
export function sceneFromState(snapshot) {
  const tickets = snapshot?.tickets ?? [];
  const active = tickets
    .filter((t) => ACTIVE_STATUSES.has(t.status))
    .sort((a, b) => compareRefs(a.ref, b.ref));
  const slots = {};
  return active.slice(0, MAX_PLUSH).map((t) => {
    const role = roleOf(t);
    const team = teamOf(role); // ADR 0013: perch is "<team>#<slot>"
    const slot = slots[team] ?? 0;
    slots[team] = slot + 1;
    return { ref: t.ref, role, status: t.status, perch: `${team}#${slot}`, pose: poseOf(t) };
  });
}

/**
 * The Pass is the head chef: Bao's crown never stands empty. When no orchestrator placement is active, add
 * an idle stand-in (no ticket, `synthetic: true`) so the scene shows one; chips skip it.
 */
export function withPassPlacement(placements) {
  if (placements.some((c) => c.role === "orchestrator")) return placements;
  return [...placements, { ref: "__pass", role: "orchestrator", status: "idle", perch: "orchestrator#0", pose: "idle", synthetic: true }];
}
