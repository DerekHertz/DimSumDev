// den-scene-v1/01: public layout and movement acceptance seams.
// Targets and tolerance come from docs/design/den-map.md, not existing placement math.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as layout from "./banquet-layout.mjs";
import { stepRoamer, roamObstacles } from "./roam.mjs";
import { PITCH, defaultFrame, worldToScreen } from "./iso-projection.mjs";
import { teamLabels } from "./team-labels.mjs";
import * as handoffs from "./handoffs.mjs";

const targets = {
  steamers: [-3.6, -1.4], "front-of-house": [3.6, -1.4],
  tea: [-5.2, 2], pantry: [5.2, 2],
};
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 0.3 + 1e-9, `${message}: ${actual} vs ${expected} (±0.3)`);

for (const [team, [x, z]] of Object.entries(targets)) {
  test(`horseshoe: ${team} is at its approved target`, () => {
    close(layout.STALL_CENTERS[team].x, x, `${team} x`);
    close(layout.STALL_CENTERS[team].z, z, `${team} z`);
  });
}
for (const [name, target, expected] of [["Cubs", layout.CUB_BASKET, [-1.8, 3]], ["Tally", layout.TALLY, [1.8, 3]]]) {
  test(`horseshoe: ${name} is at its approved target`, () => {
    close(target.x, expected[0], `${name} x`);
    close(target.z, expected[1], `${name} z`);
  });
}

test("horseshoe: every kiosk faces the table with capped yaw", () => {
  assert.equal(typeof layout.stallYaw, "function", "layout exports the approved stallYaw(team) seam");
  for (const [team, expected] of [["steamers", 0.52], ["front-of-house", -0.52], ["tea", 0.52], ["pantry", -0.52]]) {
    const { x, z } = layout.STALL_CENTERS[team];
    const yaw = layout.stallYaw(team);
    assert.ok(Math.abs(yaw) <= 0.52, `${team} yaw is capped`);
    assert.ok(Math.abs(yaw - Math.max(-0.52, Math.min(0.52, Math.atan2(-x, -z)))) < 1e-9, `${team} uses the table-facing clamp rule`);
    assert.ok(Math.abs(yaw - expected) < 1e-9, `${team} faces inward`);
  }
});

// Project actual prop extents: counter 2.25×1, Bao 2×2×1.75 at scale 1.4,
// tabletop radius 1.8 (Market.jsx). Rotating corners uses the same world axes as Three.
// den-iso-v1/02: the default frame is the orthographic isometric one (1440x900), projected through iso-projection.mjs.
const frame = defaultFrame({ width: 1440, height: 900 });
const bounds = (points) => {
  const projected = points.map((p) => worldToScreen(p, frame));
  return { x0: Math.min(...projected.map((p) => p.x)), x1: Math.max(...projected.map((p) => p.x)), y0: Math.min(...projected.map((p) => p.y)), y1: Math.max(...projected.map((p) => p.y)) };
};
const box = (cx, cy, cz, hx, hy, hz) => [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [-1, 1].map((sz) => [cx + sx * hx, cy + sy * hy, cz + sz * hz])));
// Convex polygons (screen points) overlap when no edge normal separates them (separating-axis test), with the same 1e-9 slack as overlaps().
const hull = (points) => points.map((p) => worldToScreen(p, frame));
const polygonsOverlap = (a, b) => ![a, b].some((poly) => poly.some((p, i) => {
  const q = poly[(i + 1) % poly.length], nx = q.y - p.y, ny = p.x - q.x;
  const range = (pts) => { const d = pts.map((v) => v.x * nx + v.y * ny); return [Math.min(...d), Math.max(...d)]; };
  const [a0, a1] = range(a), [b0, b1] = range(b);
  return Math.min(a1, b1) <= Math.max(a0, b0) + 1e-9 * Math.hypot(nx, ny);
}));
const depth = ([, y, z]) => z * Math.sin(PITCH) + y * Math.cos(PITCH); // toward the camera: larger is nearer
const overlaps = (a, b) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) + 1e-9 && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0) + 1e-9;

test("horseshoe: default-camera counter rectangles clear kiosks, Bao and table", () => {
  const counters = Object.entries(layout.STALL_CENTERS).map(([team, c]) => {
    const yaw = layout.stallYaw?.(team) ?? 0; // pre-feature geometry has no rotation
    const points = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => {
      const x = sx * layout.stallWidth(3) / 2, z = sz * 0.5;
      return [c.x + x * Math.cos(yaw) + z * Math.sin(yaw), layout.stallPlatform(team) + 0.5, c.z - x * Math.sin(yaw) + z * Math.cos(yaw)];
    }));
    return { team, rect: bounds(points), shape: hull([points[0], points[1], points[3], points[2]]), depth: points.map(depth).reduce((a, b) => a + b, 0) / points.length };
  });
  const [bx, by, bz] = layout.BAO.position, s = layout.BAO.scale;
  const bao = bounds(box(bx, by, bz, s, s, s * 0.875));
  const tabletop = Array.from({ length: 128 }, (_, i) => {
    const angle = i * 2 * Math.PI / 128;
    return [layout.TABLE.x + 1.8 * Math.cos(angle), layout.TABLE.height, layout.TABLE.z + 1.8 * Math.sin(angle)];
  });
  const table = { shape: hull(tabletop), depth: tabletop.map(depth).reduce((a, b) => a + b, 0) / tabletop.length };
  for (let i = 0; i < counters.length; i++) {
    const { team, rect, shape, depth: counterDepth } = counters[i];
    assert.ok(!overlaps(rect, bao), `${team} counter overlaps Bao`);
    // Table versus counter: a true occlusion fails, a near miss of bounding rectangles does not. The tabletop is a flat disc and a counter
    // a flat slab, so each is a convex outline on screen; they must not share any pixel (the nearer one would be drawn over the other,
    // the way scene-dressing-framing's "covers" check treats scenery in front of a counter). At 1440x900 the Steamers counter's
    // bounding rect (x 349.05-564.12) pokes 2.17 px into the tabletop's (x 561.95-878.05), but the counter's inner corner sits at
    // y 440.7, above the table's far rim (y 448.2), and the disc has already curved away: no shared pixel.
    const front = table.depth > counterDepth ? "table" : `${team} counter`;
    assert.ok(!polygonsOverlap(shape, table.shape), `${team} counter and table occlude each other (the ${front} is in front)`);
    for (let j = i + 1; j < counters.length; j++) assert.ok(!overlaps(rect, counters[j].rect), `${team} counter overlaps ${counters[j].team}`);
  }
});

// Designer clarification: travel goes around the rear horseshoe, in the order
// Tea -> Steamers -> Front of House -> Pantry (or reverse), never across the
// front gap. Check continuous segment clearance, not just sparse waypoints.
const teamOrder = ["tea", "steamers", "front-of-house", "pantry"];
const rearAngle = (p, team) => {
  const angle = Math.atan2(p.z, p.x);
  return angle < 0 || team === "pantry" ? angle + 2 * Math.PI : angle;
};
for (const from of teamOrder) {
  for (const to of teamOrder.filter((team) => team !== from)) {
    test(`horseshoe: handoff ${from} to ${to} follows the rear arc and clears the table`, () => {
      assert.equal(typeof handoffs.handoffPath, "function", "handoffs exports the approved handoffPath(fromTeam,toTeam) seam");
      const path = handoffs.handoffPath(from, to);
      assert.ok(Array.isArray(path) && path.length >= 2, "travel has source and destination points");
      for (const [p, team] of [[path[0], from], [path.at(-1), to]]) {
        const c = layout.STALL_CENTERS[team];
        assert.ok(Math.hypot(p.x - c.x, p.z - c.z) < 1e-6, `${team} endpoint is its centre slot`);
      }
      const start = rearAngle(path[0], from), end = rearAngle(path.at(-1), to);
      const direction = Math.sign(teamOrder.indexOf(to) - teamOrder.indexOf(from));
      let previous = start;
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        assert.ok([a.x, a.z, b.x, b.z].every(Number.isFinite), "waypoints are finite");
        const dx = b.x - a.x, dz = b.z - a.z, length2 = dx * dx + dz * dz;
        const t = length2 ? Math.max(0, Math.min(1, -(a.x * dx + a.z * dz) / length2)) : 0;
        assert.ok(Math.hypot(a.x + t * dx, a.z + t * dz) >= 2.1 - 1e-9, `${from}->${to} segment ${i} enters tabletop clearance`);
        for (let sample = 1; sample <= 100; sample++) {
          const fraction = sample / 100;
          let angle = Math.atan2(a.z + fraction * dz, a.x + fraction * dx);
          while (angle - previous > Math.PI) angle -= 2 * Math.PI;
          while (angle - previous < -Math.PI) angle += 2 * Math.PI;
          assert.ok((angle - previous) * direction >= -1e-9, "travel advances in rear horseshoe order");
          assert.ok(angle >= Math.min(start, end) - 1e-9 && angle <= Math.max(start, end) + 1e-9, "travel never wraps through the front grass gap");
          previous = angle;
        }
      }
      assert.ok(Math.abs(previous - end) < 1e-6, "rear arc reaches its destination without a full front wrap");
    });
  }
}

for (const type of ["product", "architect", "developer", "scout", "qa", "security", "designer"]) {
  for (const reduced of [false, true]) {
    test(`horseshoe: idle ${type} stays at its slot for 60 seconds (reduced=${reduced})`, () => {
      const slot = layout.placeRole(type, 0), obstacles = roamObstacles();
      let state;
      for (let frame = 0; frame <= 60 * 30; frame++) {
        state = stepRoamer(state, { seed: type, slot, working: false, now: frame / 30, dt: 1 / 30, obstacles, reduced });
        assert.ok(Math.hypot(state.x - slot.x, state.y - slot.y, state.z - slot.z) < 1e-6, `${type} leaves its team at ${frame / 30}s`);
        assert.equal(state.moving, false, `${type} has no idle travel`);
      }
    });
  }
}

test("horseshoe: team labels follow the approved kiosk and Cubs centres", () => {
  const labels = teamLabels({});
  for (const [team, [x, z]] of Object.entries({ ...targets, cubs: [-1.8, 3] })) {
    const label = labels.find((entry) => entry.team === team);
    close(label.x, x, `${team} label x`);
    close(label.z, z, `${team} label z`);
  }
});
