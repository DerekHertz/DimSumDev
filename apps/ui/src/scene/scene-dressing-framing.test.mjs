// den-iso-v1/04: the dressing at the default isometric frame (1440x900 and 375x667), projected through
// iso-projection.mjs. Geometric acceptance: no stone, pad or bamboo stalk covers a kiosk's sign or counter
// (den-map check 1, extended to the new scenery); both pads are inside the viewport (digest section 1);
// the Steamers / Front of House move shows up in the projected frame (digest section 1 table).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PITCH, defaultFrame, worldToScreen } from "./iso-projection.mjs";
import * as layout from "./banquet-layout.mjs";
import { teamLabels } from "./team-labels.mjs";

// Namespace import: until the dressing exists, each test fails on its own missing export, not the whole file on import.
const { BAMBOO_CLUSTERS, DORMANT_PADS, STALL_CENTERS, bambooStalks, stallCenterX, stallPlatform, stallWidth, stallYaw, stepStones } = layout;

const SIZES = [{ width: 1440, height: 900 }, { width: 375, height: 667 }];
const N = 3;
const STONE_R = 0.17, STONE_T = 0.04;

const box = (x, y, z, hx, hy, hz) => [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [-1, 1].map((sz) => [x + sx * hx, y + sy * hy, z + sz * hz])));
const disc = (x, y, z, r) => Array.from({ length: 32 }, (_, i) => [x + r * Math.cos((i * Math.PI) / 16), y, z + r * Math.sin((i * Math.PI) / 16)]);
const rect = (points, frame) => {
  const ps = points.map((p) => worldToScreen(p, frame));
  return { x0: Math.min(...ps.map((p) => p.x)), x1: Math.max(...ps.map((p) => p.x)), y0: Math.min(...ps.map((p) => p.y)), y1: Math.max(...ps.map((p) => p.y)) };
};
const overlaps = (a, b) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) + 1e-9 && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0) + 1e-9;
const within = (p, r) => p.x > r.x0 && p.x < r.x1 && p.y > r.y0 && p.y < r.y1;

// The kiosk counter's top face (as in default-framing.test.mjs) in world space.
const counterPoints = (team) => {
  const yaw = stallYaw(team), w = stallWidth(N);
  return [-1, 1].flatMap((x) => [-1, 1].map((z) => {
    const lx = x * w / 2, lz = z * 0.5;
    return [stallCenterX(team, N) + lx * Math.cos(yaw) + lz * Math.sin(yaw), 0.5 + stallPlatform(team), STALL_CENTERS[team].z - lx * Math.sin(yaw) + lz * Math.cos(yaw)];
  }));
};

// Depth toward the camera (larger is nearer): the camera looks along -z, tilted by PITCH. Scenery stands on the ground, so its
// depth is its base point's. A thing behind a counter is drawn under it and does not cover it, even where their rects overlap.
const depth = ([, y, z]) => z * Math.sin(PITCH) + y * Math.cos(PITCH);
const sceneryRects = (frame) => [
  ...stepStones().map((s) => ({ name: `stone ${s.index}`, depth: depth([s.x, 0, s.z]), r: rect(disc(s.x, STONE_T, s.z, STONE_R), frame) })),
  ...DORMANT_PADS.map((p) => ({ name: `${p.id} pad`, depth: depth([p.x, 0, p.z]), r: rect(disc(p.x, 0, p.z, p.radius), frame) })),
  ...bambooStalks().map((s, i) => ({ name: `bamboo ${s.cluster} #${i}`, depth: depth([s.x, 0, s.z]), r: rect(box(s.x, s.height / 2, s.z, s.width / 2, s.height / 2, s.width / 2), frame) })),
];

test("no stone, pad or bamboo stalk covers a kiosk counter at the default frame, at both sizes", () => {
  for (const size of SIZES) {
    const frame = defaultFrame(size);
    const counters = Object.keys(STALL_CENTERS).map((team) => {
      const pts = counterPoints(team);
      return { team, r: rect(pts, frame), depth: pts.map(depth).reduce((a, b) => a + b, 0) / pts.length };
    });
    for (const thing of sceneryRects(frame)) for (const c of counters) {
      if (thing.depth <= c.depth) continue; // behind the counter: drawn under it
      assert.ok(!overlaps(thing.r, c.r), `${size.width}x${size.height}: ${thing.name} covers the ${c.team} counter`);
    }
  }
});

test("no stone, pad or bamboo stalk covers a kiosk sign anchor at the default frame, at both sizes", () => {
  for (const size of SIZES) {
    const frame = defaultFrame(size);
    const signs = teamLabels({}).filter((l) => STALL_CENTERS[l.team]).map((l) => ({ team: l.team, p: worldToScreen([l.x, l.y, l.z], frame) }));
    for (const thing of sceneryRects(frame)) for (const s of signs) {
      assert.ok(!within(s.p, thing.r), `${size.width}x${size.height}: ${thing.name} covers the ${s.team} sign`);
    }
  }
});

test("both dormant pads fall inside the viewport at 1440x900 and 375x667", () => {
  for (const size of SIZES) {
    const frame = defaultFrame(size);
    for (const p of DORMANT_PADS) {
      const r = rect(disc(p.x, 0, p.z, p.radius), frame);
      assert.ok(r.x0 >= 0 && r.x1 <= size.width && r.y0 >= 0 && r.y1 <= size.height, `${p.id} at ${size.width}: ${JSON.stringify(r)}`);
    }
  }
});

test("the pads sit behind Bao's shoulders at the digest's pixels: Library left of the ring centre, Drum right, level with each other", () => {
  const frame = defaultFrame(SIZES[0]);
  const [lib, drum] = DORMANT_PADS.map((p) => worldToScreen([p.x, 0, p.z], frame));
  // hand-worked (den-scene-v1/11: pads at (+-3.4, -7.65), look-at z -2.9): x = 720 +- 3.4 * 87.8 = 421.5 / 1018.5;
  // y = 468 - (7.65 - 2.9) * 0.57735 * 87.8 = 227.2
  assert.ok(Math.abs(lib.x - 421.5) < 2 && Math.abs(drum.x - 1018.5) < 2, `x ${lib.x}, ${drum.x}`);
  assert.ok(Math.abs(lib.y - 227.2) < 2 && Math.abs(drum.y - 227.2) < 2, `y ${lib.y}, ${drum.y}`);
});

test("the Steamers and Front of House move reaches the screen: kiosk centres at the digest's pixels at both sizes", () => {
  const table = [
    [{ width: 1440, height: 900 }, "steamers", 404, 508], [{ width: 1440, height: 900 }, "front-of-house", 1036, 508],
    [{ width: 375, height: 667 }, "steamers", 84, 360], [{ width: 375, height: 667 }, "front-of-house", 291, 360],
  ];
  for (const [size, team, px, py] of table) {
    const p = worldToScreen([stallCenterX(team, N), 0.5, STALL_CENTERS[team].z], defaultFrame(size));
    assert.ok(Math.abs(p.x - px) <= 2 && Math.abs(p.y - py) <= 2, `${team} at ${size.width}: ${p.x.toFixed(1)}, ${p.y.toFixed(1)} vs ${px}, ${py}`);
  }
});

test("the right-edge bamboo cluster stays inside the 1440x900 viewport", () => {
  const frame = defaultFrame(SIZES[0]);
  const edge = BAMBOO_CLUSTERS.find((c) => c.id === "right-edge");
  const r = rect(bambooStalks().filter((s) => s.cluster === edge.id).flatMap((s) => box(s.x, s.height / 2, s.z, s.width / 2, s.height / 2, s.width / 2)), frame);
  assert.ok(r.x0 >= 0 && r.x1 <= 1440 && r.y0 >= 0 && r.y1 <= 900, JSON.stringify(r)); // digest: x 7.8 -> about 1405 px
});
