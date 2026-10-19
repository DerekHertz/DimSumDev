// ADR 0013: the banquet market anchor model. Pure; no three, React or DOM. Role and slot index
// in, world position (where the plush's feet stand) out. Units are scene units, +z toward the camera.

/**
 * Bao, host of the table, sits at the back (den-scene-v1/11, option B, Soft bun: 2.1, a 1.5x). His local box is about
 * 2 x 2 x 1.75 centred on the origin, so his footprint is 2.1 x 1.8375 half-sizes about his position.
 */
export const BAO = { position: [0, 2.1, -3.3], scale: 2.1 };

/**
 * The Pass seats at rest, in Bao's local model units (the designer's measurements of the posed mesh, feet at y -1): the
 * orchestrator on the crown, product on the arm with x < 0 and architect on the arm with x > 0.
 */
const SEAT_LOCAL = {
  orchestrator: [0, 1.034, -0.185],
  product: [-0.81, 0.09, -0.04],
  architect: [0.81, 0.09, -0.04],
};
const seatAtRest = (type) => SEAT_LOCAL[type].map((v, k) => BAO.position[k] + BAO.scale * v);

/** The Pass rail on Bao's crown (a fitting 0.05 thick, 2.0 long), with the service bell seated on it away from the orchestrators. */
export const RAIL = { x: 0, y: seatAtRest("orchestrator")[1] - 0.025, z: seatAtRest("orchestrator")[2], width: 2.0, height: 0.05 };
export const BELL = { x: 0.75, y: RAIL.y + RAIL.height / 2, z: RAIL.z };

/**
 * Tally (den-scene-v1/05): a wooden suanpan abacus on two short legs, on the front floor beside the
 * Cubs basket, to its right, turned toward the camera. The legs stand on groundY; the frame bottom sits
 * at groundY + leg.height and the frame stands on the legs.
 */
const TALLY_POSITION = { x: 1.8, z: 3.0 };
export const TALLY = {
  ...TALLY_POSITION,
  groundY: 0,
  rotationY: 0, // front-on: with an orthographic camera "face the camera" is yaw 0
  frame: { width: 1.1, height: 1.4, depth: 0.12, bar: 0.08 },
  leg: { width: 0.08, height: 0.15 },
};

/** World point the Tally pill hangs from: centred over the frame top, 0.27 above it. */
export const tallyAnchor = () => ({
  x: TALLY.x,
  y: TALLY.groundY + TALLY.leg.height + TALLY.frame.height + 0.27,
  z: TALLY.z,
});

export const TABLE = { x: 0, z: 0, radius: 1.3, height: 0.7 };
export const CUB_BASKET = { x: -1.8, z: 3.0 };
export const CUB_BASKET_RADIUS = 0.55;

const STALL_SPACING = 0.75;
const STALL_BASE_SLOTS = 3;
const COUNTER_Y = 0.6;

/** The back stalls stand on a low platform so their placements rise above the front row's roofs (default camera). */
export const BACK_PLATFORM = 0.5;
/**
 * The front stalls carry a low roof. The eave is raised to 1.77 (user, 2026-10-01, den-scene-v1/09 round 2) so the
 * noren bottom (eave - 0.22 = 1.55) clears the qa douli and security cap at head height; the roof does not hide the
 * back counters from the default camera because the horseshoe puts it to the side of them on screen.
 */
export const FRONT_ROOF = { eave: 1.77, rise: 0.4 };

/**
 * Pass perches: extra orchestrators step -0.4 world x along the rail (away from the bell); extra product and architect
 * placements step -0.4 world z along the arm top. A fourth placement and beyond clamp to the last seat so nothing floats.
 */
const PASS = {
  orchestrator: { axis: 0, step: -0.39 }, // 0.39, not 0.4, so the third 0.44-wide panda (0.78 + 0.22 = 1.0) stays on the 2.0 rail
  product: { axis: 2, step: -0.4 },
  architect: { axis: 2, step: -0.4 },
};
const PASS_SEATS = 3;

const STALLS = {
  steamers: { x: -3.6, z: -1.4, y: COUNTER_Y + BACK_PLATFORM, row: "back" },
  "front-of-house": { x: 3.6, z: -1.4, y: COUNTER_Y + BACK_PLATFORM, row: "back" },
  tea: { x: -5.2, z: 2.0, y: COUNTER_Y, row: "front" },
  pantry: { x: 5.2, z: 2.0, y: COUNTER_Y, row: "front" },
  cubs: { x: 0, z: 4.6, y: 0 },
};

const TEAM = {
  developer: "steamers", scout: "steamers",
  qa: "tea", security: "pantry", designer: "front-of-house",
};

/** The four stalls' centres on the floor (the cub row is not a stall). */
export const STALL_CENTERS = Object.fromEntries(
  Object.entries(STALLS).filter(([k]) => k !== "cubs").map(([k, v]) => [k, { x: v.x, z: v.z }]),
);

/** Each kiosk faces the table, capped to preserve its counter's default-camera sight line. */
export function stallYaw(team) {
  const { x, z } = STALL_CENTERS[team];
  return Math.max(-0.52, Math.min(0.52, Math.atan2(-x, -z)));
}

/** Height of a stall's platform (0 for the front row) and the roof it carries, for the renderer. */
export const stallPlatform = (team) => (STALLS[team]?.row === "back" ? BACK_PLATFORM : 0);
export const stallRoof = (team) => (STALLS[team]?.row === "front" ? FRONT_ROOF : undefined);
/** Counter top height in the world, where a stall's placements stand. */
export const counterTop = (team) => STALLS[team].y;

export function teamOf(role) {
  if (PASS[role]) return role;
  return TEAM[role] ?? "cubs";
}

/** "steamers#2" -> { team: "steamers", slot: 2 } */
export function parsePerch(perch) {
  const [team, slot] = perch.split("#");
  return { team, slot: Number(slot) };
}

/** Width of a stall's front: three fixed slots, then it widens by one slot per extra placement. */
export function stallWidth(count) {
  return Math.max(STALL_BASE_SLOTS, count) * STALL_SPACING;
}

/** A stall widens outward, away from x=0, so its inner edge (and the space around Bao) stays fixed. */
export function stallCenterX(team, count = STALL_BASE_SLOTS) {
  const stall = STALLS[team];
  const extra = stallWidth(count) - stallWidth(STALL_BASE_SLOTS);
  return stall.x + Math.sign(stall.x) * extra / 2;
}

/** Twelve active placements (scene-from-state MAX_PLUSH) plus the other idle Steamers role. */
export const MAX_STALL_PLACEMENTS = 13;

/** Outer edge (|x|) of the widest stall: Steamers holding every placement. The camera must be able to reach it. */
export const WIDEST_STALL_EDGE = Math.abs(stallCenterX("steamers", MAX_STALL_PLACEMENTS)) + stallWidth(MAX_STALL_PLACEMENTS) / 2;

/**
 * @param {string} role
 * @param {number} slot 0-based index within the team
 * @param {number} [count] placements in the team; only matters past three, when the slots widen
 */
export function placeRole(role, slot, count = STALL_BASE_SLOTS) {
  const pass = PASS[role];
  if (pass) {
    const at = seatAtRest(role);
    at[pass.axis] += pass.step * Math.min(slot, PASS_SEATS - 1);
    return { x: at[0], y: at[1], z: at[2] };
  }
  const stall = STALLS[teamOf(role)];
  const n = Math.max(STALL_BASE_SLOTS, count, slot + 1);
  const team = teamOf(role);
  const offset = (slot - (n - 1) / 2) * STALL_SPACING;
  const yaw = STALL_CENTERS[team] ? stallYaw(team) : 0;
  return { x: stallCenterX(team, n) + offset * Math.cos(yaw), y: stall.y, z: stall.z - offset * Math.sin(yaw) };
}

export const MAX_BASKETS = 8;
const SUSAN_RADIUS = 0.85;
const SUSAN_Y = 0.75;

/** One basket position per frontier ticket around the lazy susan, first at the front. */
export function susanBaskets(n) {
  const count = Math.min(n, MAX_BASKETS);
  return Array.from({ length: count }, (_, i) => {
    const a = (2 * Math.PI * i) / count;
    return { x: TABLE.x + SUSAN_RADIUS * Math.sin(a), y: SUSAN_Y, z: TABLE.z + SUSAN_RADIUS * Math.cos(a) };
  });
}

// ---- den-iso-v1/04: scene dressing (docs/design/2026-10-01-iso-den.md section 2). The ring, pads and bamboo are
// placed here so the den-map checks (and the tests) see the same numbers the scene draws.

/** A ring of flat stepping stones around Bao's feet: an oval in the world, even in parametric angle (index 0 at +x, then toward +z). */
export const STONE_RING = {
  center: { x: BAO.position[0], z: BAO.position[2] },
  semiX: 7.3,
  semiZ: 6.3,
  count: 48,
  stone: { diameter: 0.34, thickness: 0.04 },
};

const PLATFORM_HALF_DEPTH = 0.65; // a kiosk's platform reaches 0.65 front and back of its centre
const PLATFORM_MARGIN = 0.15; // and 0.15 past each end of the counter

/** A point's distance into a footprint, in the footprint's own frame: negative inside, positive outside. */
const clearOfKiosk = (team, x, z) => {
  const yaw = stallYaw(team);
  const dx = x - stallCenterX(team);
  const dz = z - STALL_CENTERS[team].z;
  const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
  const lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
  const hx = (stallWidth(STALL_BASE_SLOTS) + 2 * PLATFORM_MARGIN) / 2;
  const ox = Math.abs(lx) - hx;
  const oz = Math.abs(lz) - PLATFORM_HALF_DEPTH;
  return Math.hypot(Math.max(ox, 0), Math.max(oz, 0)) + Math.min(Math.max(ox, oz), 0);
};

const clearOfBox = (cx, cz, hx, hz, x, z) => {
  const ox = Math.abs(x - cx) - hx;
  const oz = Math.abs(z - cz) - hz;
  return Math.hypot(Math.max(ox, 0), Math.max(oz, 0)) + Math.min(Math.max(ox, oz), 0);
};

/** Distance from a ground point to the nearest kiosk platform, table, hamper or Tally (negative inside one). */
const clearance = (x, z) => Math.min(
  ...Object.keys(STALL_CENTERS).map((s) => clearOfKiosk(s, x, z)),
  Math.hypot(x - TABLE.x, z - TABLE.z) - TABLE.radius,
  Math.hypot(x - CUB_BASKET.x, z - CUB_BASKET.z) - CUB_BASKET_RADIUS,
  clearOfBox(TALLY.x, TALLY.z, TALLY.frame.width / 2, TALLY.frame.depth / 2, x, z),
);

/** The ring's stones that survive the footprint rule: a step is dropped when its stone would touch a kiosk, table, hamper or Tally. */
export function stepStones() {
  const { center, semiX, semiZ, count, stone } = STONE_RING;
  const stones = [];
  for (let index = 0; index < count; index++) {
    const t = (2 * Math.PI * index) / count;
    const x = center.x + semiX * Math.cos(t);
    const z = center.z + semiZ * Math.sin(t);
    if (clearance(x, z) < stone.diameter / 2) continue;
    stones.push({ index, x, z });
  }
  return stones;
}

/** Dashed pads for roles not online yet. Dormant: no pandas, no click target beyond the label chip. */
export const DORMANT_PADS = [
  { id: "library", name: "Library", x: -3.4, z: -7.65 },
  { id: "drum", name: "Drum", x: 3.4, z: -7.65 },
].map((pad) => ({
  ...pad,
  radius: 0.65,
  dashed: true,
  dormant: true,
  label: `${pad.name} · coming online`,
  ariaLabel: `${pad.name}, coming online`,
}));

/** Bamboo borders: cluster centres on the ground, stalks in a row along x. */
export const BAMBOO_CLUSTERS = [
  { id: "back-left", x: -3.4, z: -8.5, stalks: 3, height: 3.0 },
  { id: "back-right", x: 3.6, z: -8.7, stalks: 3, height: 3.0 },
  { id: "right-edge", x: 7.8, z: 0.8, stalks: 2, height: 2.6 },
];
export const BAMBOO_STALK = { width: 0.13, spacing: 0.27 };

export const bambooStalks = () => BAMBOO_CLUSTERS.flatMap((c) => Array.from({ length: c.stalks }, (_, i) => ({
  cluster: c.id,
  x: c.x + (i - (c.stalks - 1) / 2) * BAMBOO_STALK.spacing,
  z: c.z,
  height: c.height,
  width: BAMBOO_STALK.width,
})));
