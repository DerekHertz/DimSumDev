import { stationOf } from "./banquet-layout.mjs";
import { compareRefs } from "../../../../packages/board-refs/src/compare-refs.mjs";

// ADR 0011 decision 7: sceneFromState(snapshot) -> SceneCell[]. Pure; no three, React or DOM.
export const MAX_PLUSH = 12;

export const ACTIVE_STATUSES = new Set(["claimed", "in-review", "blocked", "ready-for-human"]);
const ARCHITECT_TYPES = new Set(["design", "design-question", "design-direction", "decision", "prototype"]);

export function cellTypeOf(t) {
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
 * One cell per active ticket. Queued (ready) tickets get no cell: they show only as baskets on the
 * lazy susan until a cell picks them up (showcase-v1/04).
 * @param {{tickets: object[]}} snapshot
 */
export function sceneFromState(snapshot) {
  const tickets = snapshot?.tickets ?? [];
  const active = tickets
    .filter((t) => ACTIVE_STATUSES.has(t.status))
    .sort((a, b) => compareRefs(a.ref, b.ref));
  const slots = {};
  return active.slice(0, MAX_PLUSH).map((t) => {
    const cellType = cellTypeOf(t);
    const station = stationOf(cellType); // ADR 0013: perch is "<station>#<slot>"
    const slot = slots[station] ?? 0;
    slots[station] = slot + 1;
    return { ref: t.ref, cellType, status: t.status, perch: `${station}#${slot}`, pose: poseOf(t) };
  });
}

/**
 * The Pass is the head chef: Bao's crown never stands empty. When no orchestrator cell is active, add
 * an idle stand-in (no ticket, `synthetic: true`) so the scene shows one; chips skip it.
 */
export function withPassCell(cells) {
  if (cells.some((c) => c.cellType === "orchestrator")) return cells;
  return [...cells, { ref: "__pass", cellType: "orchestrator", status: "idle", perch: "orchestrator#0", pose: "idle", synthetic: true }];
}
