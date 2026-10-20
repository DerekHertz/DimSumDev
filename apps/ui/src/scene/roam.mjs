// den-scene-v1/01: pandas remain at their team; only handoffs trigger travel.
// Pure snapshot-event lifecycle shared by the renderer and integration tests.
import { BAO, CUB_BASKET, CUB_BASKET_RADIUS, STALL_CENTERS, TABLE, TALLY, placeRole, stallCenterX, stallWidth, stallYaw, teamOf } from "./banquet-layout.mjs";
import { handoffPath } from "./handoffs.mjs";

export const ROAMER_TYPES = ["product", "architect", "developer", "scout", "qa", "security", "designer"];
export const WALK_SPEED = 0.9;
const PAD = 0.4;
const rect = (x, z, hx, hz) => ({ kind: "rect", x0: x - hx - PAD, x1: x + hx + PAD, z0: z - hz - PAD, z1: z + hz + PAD });

/** Prop footprints retained for callers that inspect scene clearance, including the Tally. */
export function roamObstacles(counts = {}) {
  const out = [
    { kind: "circle", x: TABLE.x, z: TABLE.z, r: 2.2 },
    rect(BAO.position[0], BAO.position[2], BAO.scale * 1.0, BAO.scale * 0.875),
    { kind: "circle", x: CUB_BASKET.x, z: CUB_BASKET.z, r: CUB_BASKET_RADIUS + PAD },
    rect(0, 4.6, stallWidth(counts.cubs ?? 0) / 2, 0.35),
    rect(TALLY.x, TALLY.z, TALLY.frame.width / 2 + 0.1, TALLY.frame.depth / 2 + 0.1),
  ];
  for (const [team, c] of Object.entries(STALL_CENTERS)) {
    const yaw = stallYaw(team), half = stallWidth(counts[team] ?? 0) / 2;
    const platform = c.z < 0 ? 0.15 : 0;
    out.push(rect(stallCenterX(team, counts[team] ?? 0), c.z,
      half * Math.cos(yaw) + 0.5 * Math.abs(Math.sin(yaw)) + platform,
      half * Math.abs(Math.sin(yaw)) + 0.5 * Math.cos(yaw) + platform));
  }
  return out;
}

function walk(route, distance) {
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (distance < length && length > 0) {
      const t = distance / length;
      return { x: a.x + (b.x - a.x) * t, y: (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * t,
        z: a.z + (b.z - a.z) * t, heading: Math.atan2(b.x - a.x, b.z - a.z), done: false };
    }
    distance -= length;
  }
  return { ...route.at(-1), done: true, heading: 0 };
}

/**
 * Idle and working pandas share their fixed team slot. A derived handoff moves only its source
 * participant, delivers at the receiving kiosk, then returns to its own slot. Event expiry never
 * cancels a delivery; duplicate events never restart it. Reduced motion consumes events in place.
 */
export function stepRoamer(prev, { seed, slot = placeRole(seed, 0), working, handoffs = [], dt, reduced }) {
  const seen = new Set(prev?.seen ?? []);
  const queue = [...(prev?.queue ?? [])];
  for (const h of handoffs) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    if (h.fromPlacement === seed && !h.sameTeam && STALL_CENTERS[h.from] && STALL_CENTERS[h.to]) queue.push(h);
  }
  // The UI retains only a short expiring event window; keep enough history without growing forever.
  const history = [...seen].slice(-128);
  const home = slot ?? placeRole(seed, 0);
  const team = teamOf(seed);
  const resting = () => ({ phase: working ? "working" : "idle", ...home,
    heading: STALL_CENTERS[team] ? stallYaw(team) : 0, moving: false, opacity: 1, seen: history, queue });
  if (reduced) return { ...resting(), queue: [] };
  let state = prev?.route ? { ...prev, seen: history, queue } : resting();
  if (!state.route && queue.length) {
    const handoff = queue.shift();
    const path = handoffPath(handoff.from, handoff.to).map((p) => ({ ...p, y: 0 }));
    const departure = prev ? { x: prev.x, y: prev.y, z: prev.z } : { ...home };
    state = { ...state, phase: "handoff", handoff, home, route: [departure, ...path], walked: 0 };
  }
  if (!state.route) return state;
  const walked = state.walked + WALK_SPEED * Math.max(0, dt);
  const point = walk(state.route, walked);
  if (!point.done) return { ...state, ...point, walked, moving: true, opacity: 1 };
  if (state.phase === "handoff") {
    // Spend one frame at the receiver so delivery has an observable endpoint before the return.
    return { ...state, ...point, phase: "returning", route: [...state.route.slice(1)].reverse().concat(state.home), walked: 0, moving: true, opacity: 1 };
  }
  return resting();
}
