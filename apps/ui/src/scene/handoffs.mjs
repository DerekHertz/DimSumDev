// showcase-v1/04: work moving between teams. Pure; no three, React or DOM.
//   deriveHandoffs(prev, next)  ticket change events -> handoffs (active role changed)
//   susanLayout(items)          one basket per ticket, turned toward its team's stall
//   turnAngle / lerpAngle       the basket turn over dur-slow (a jump under reduced motion)
//   lanternState(placements)         which stall lanterns and whether the service bell glow
import { ACTIVE_STATUSES, roleOf } from "./scene-from-state.mjs";
import { BAO, CUB_BASKET, STALL_CENTERS, TABLE, teamOf } from "./banquet-layout.mjs";
import { compareRefs } from "../../../../packages/board-refs/src/compare-refs.mjs";

/** dur-slow: the motion token for a basket turning between stalls. */
export const DUR_SLOW_MS = 700;
export const MAX_SUSAN_BASKETS = 12;

const OUTER_RADIUS = 0.85;
const INNER_RADIUS = 0.55;
const BASKET_GAP = 0.4;
const ANGLE_STEP = 0.5;

/** Tickets that are active or queued, with the role working (or last worked) them and its team. */
export function trackedTickets(snapshot) {
  const tickets = snapshot?.tickets ?? [];
  const frontier = new Set(snapshot?.frontier ?? []);
  const out = new Map();
  const list = tickets
    .filter((t) => ACTIVE_STATUSES.has(t.status) || frontier.has(t.ref))
    .sort((a, b) => compareRefs(a.ref, b.ref));
  for (const t of list) {
    const role = roleOf(t);
    out.set(t.ref, { role, team: teamOf(role) });
  }
  return out;
}

/**
 * A handoff is a ticket in both snapshots whose active role changed. New and resolved tickets
 * are not handoffs; neither is the first snapshot.
 * @returns {{ref: string, fromPlacement: string, toPlacement: string, from: string, to: string, sameTeam: boolean}[]}
 */
export function deriveHandoffs(prev, next) {
  if (!prev) return [];
  const before = trackedTickets(prev);
  const handoffs = [];
  for (const [ref, now] of trackedTickets(next)) {
    const was = before.get(ref);
    if (!was || was.role === now.role) continue;
    handoffs.push({
      ref, fromPlacement: was.role, toPlacement: now.role, from: was.team, to: now.team, sameTeam: was.team === now.team,
    });
  }
  return handoffs;
}

/** Travel around the rear horseshoe, never through its open front gap. */
export function handoffPath(fromTeam, toTeam) {
  const from = STALL_CENTERS[fromTeam], to = STALL_CENTERS[toTeam];
  if (!from || !to) return [];
  if (fromTeam === toTeam) return [{ ...from }, { ...to }];
  const rearAngle = (p) => {
    const a = Math.atan2(p.z, p.x);
    return a < 0 || p.x > 0 ? a + 2 * Math.PI : a;
  };
  const start = rearAngle(from), end = rearAngle(to);
  // Radius 6.1 keeps rear travel clear of Bao's padded roam rect (corner distance 6.08) as well as the tabletop.
  const radius = Math.max(6.1, Math.hypot(from.x, from.z), Math.hypot(to.x, to.z));
  const steps = Math.ceil(Math.abs(end - start) / (Math.PI / 12));
  const arc = Array.from({ length: steps + 1 }, (_, i) => {
    const a = start + (end - start) * i / steps;
    return { x: radius * Math.cos(a), z: radius * Math.sin(a) };
  });
  return [{ ...from }, ...arc, { ...to }];
}

/** Angle around the susan (0 toward +z, positive toward +x) that points at a team. */
export function teamBearing(team) {
  const at = STALL_CENTERS[team] ?? (team === "cubs" ? CUB_BASKET : { x: BAO.position[0], z: BAO.position[2] });
  return Math.atan2(at.x - TABLE.x, at.z - TABLE.z);
}

const xy = (b) => [Math.sin(b.angle) * b.radius, Math.cos(b.angle) * b.radius];

/**
 * Baskets in input order, each turned toward its team. A basket that would touch an earlier one
 * moves along the ring, or to the inner ring, until it clears by BASKET_GAP.
 * @param {{ref: string, team: string}[]} items
 * @returns {{ref: string, team: string, angle: number, radius: number}[]}
 */
export function susanLayout(items) {
  const placed = [];
  for (const { ref, team } of items.slice(0, MAX_SUSAN_BASKETS)) {
    const base = teamBearing(team);
    let chosen = null;
    for (let step = 0; step <= 2 * MAX_SUSAN_BASKETS && !chosen; step++) {
      const offset = Math.ceil(step / 2) * ANGLE_STEP * (step % 2 ? 1 : -1);
      for (const radius of [OUTER_RADIUS, INNER_RADIUS]) {
        const candidate = { ref, team, angle: base + offset, radius };
        const [x, y] = xy(candidate);
        if (placed.every((p) => Math.hypot(xy(p)[0] - x, xy(p)[1] - y) >= BASKET_GAP)) {
          chosen = candidate;
          break;
        }
      }
    }
    placed.push(chosen ?? { ref, team, angle: base, radius: OUTER_RADIUS });
  }
  return placed;
}

const TAU = 2 * Math.PI;

/** Interpolate between two angles along the shorter arc. */
export function lerpAngle(from, to, t) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return from + d * t;
}

/** The basket's angle `elapsedMs` into a turn. Reduced motion: it is at the target at once. */
export function turnAngle(from, to, elapsedMs, reducedMotion) {
  if (reducedMotion) return to;
  const t = Math.min(1, Math.max(0, elapsedMs / DUR_SLOW_MS));
  const eased = t * t * (3 - 2 * t);
  return lerpAngle(from, to, eased);
}

/**
 * @param {{role: string, pose: string}[]} placements
 * @returns {{stalls: Set<string>, bell: boolean}} stall teams whose lantern lights; bell glows for any waiting placement
 */
export function lanternState(placements) {
  const stalls = new Set();
  let bell = false;
  for (const c of placements) {
    if (c.pose !== "waiting_on_user") continue;
    bell = true;
    const team = teamOf(c.role);
    if (STALL_CENTERS[team]) stalls.add(team);
  }
  return { stalls, bell };
}
