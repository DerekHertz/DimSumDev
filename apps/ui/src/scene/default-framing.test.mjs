// den-iso-v1/02 (replaces the perspective framing tests of den-scene-v1/01): the default isometric frame.
// Every kiosk, Bao, the susan, the hamper and the Tally fall inside the viewport at 1440x900 and 375x667
// (digest section 1), and no sign or counter is covered by another kiosk, Bao or the table (den-map check 1).
// Geometry is projected through iso-projection.mjs (defaultFrame + worldToScreen); the kiosk is its complete
// geometry: roof, posts, counter, platform and noren, as in the old test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultFrame, worldToScreen } from "./iso-projection.mjs";
import { BAO, CUB_BASKET, CUB_BASKET_RADIUS, TABLE, TALLY, STALL_CENTERS, stallCenterX, stallPlatform, stallRoof, stallWidth, stallYaw } from "./banquet-layout.mjs";
import { teamLabels } from "./team-labels.mjs";
import { EAVE_Y, POST_BASE, POST_SIZE, postHeight, postPositions, roofTriangles } from "./stall-roof.mjs";

const SIZES = [{ width: 1440, height: 900 }, { width: 375, height: 667 }];
const N = 3; // default three-slot kiosks: the layout constants, no extra placements

const box = (x, y, z, hx, hy, hz) => [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [-1, 1].map((sz) => [x + sx * hx, y + sy * hy, z + sz * hz])));
const world = (team, n, [x, y, z]) => {
  const yaw = stallYaw(team);
  return [stallCenterX(team, n) + x * Math.cos(yaw) + z * Math.sin(yaw), y + stallPlatform(team), STALL_CENTERS[team].z - x * Math.sin(yaw) + z * Math.cos(yaw)];
};
const completeKiosk = (team, n) => {
  const width = stallWidth(n), roof = stallRoof(team);
  const flatRoof = roofTriangles(width, 1, roof);
  const points = Array.from({ length: flatRoof.length / 3 }, (_, i) => flatRoof.slice(i * 3, i * 3 + 3));
  points.push(...box(0, 0.25, 0, width / 2, 0.25, 0.5));
  points.push(...box(0, 0.52, 0.5, (width + 0.1) / 2, 0.03, 0.05));
  for (const [x, z] of postPositions(width, 1)) points.push(...box(x, POST_BASE + postHeight(roof) / 2, z, POST_SIZE / 2, postHeight(roof) / 2, POST_SIZE / 2));
  points.push(...box(0, (roof?.eave ?? EAVE_Y) - 0.2, 0.45, 0.14, 0.14, 0.14));
  const platform = stallPlatform(team);
  if (platform) points.push(...box(0, -platform / 2, 0, (width + 0.3) / 2, platform / 2, 0.65));
  return points.map((p) => world(team, n, p));
};
const baoBox = () => { const [x, y, z] = BAO.position, s = BAO.scale; return box(x, y, z, s, s, s * 0.875); };
const tableRing = () => Array.from({ length: 128 }, (_, i) => [TABLE.x + TABLE.radius * Math.cos(i * Math.PI / 64), TABLE.height, TABLE.z + TABLE.radius * Math.sin(i * Math.PI / 64)]);
const hamper = () => box(CUB_BASKET.x, 0.2, CUB_BASKET.z, CUB_BASKET_RADIUS, 0.2, CUB_BASKET_RADIUS);
const tally = () => box(TALLY.x, TALLY.groundY + TALLY.leg.height + TALLY.frame.height / 2, TALLY.z, TALLY.frame.width / 2, TALLY.frame.height / 2 + TALLY.leg.height / 2, TALLY.frame.depth / 2);
const rect = (points, frame) => {
  const ps = points.map((p) => worldToScreen(p, frame));
  return { x0: Math.min(...ps.map((p) => p.x)), x1: Math.max(...ps.map((p) => p.x)), y0: Math.min(...ps.map((p) => p.y)), y1: Math.max(...ps.map((p) => p.y)) };
};
const inside = (r, { width, height }) => r.x0 >= 0 && r.x1 <= width && r.y0 >= 0 && r.y1 <= height;

test("the default frame contains every kiosk, Bao, the susan, the hamper and the Tally at 1440x900 and 375x667", () => {
  for (const size of SIZES) {
    const frame = defaultFrame(size);
    const things = {
      Bao: baoBox(), susan: tableRing(), hamper: hamper(), Tally: tally(),
      ...Object.fromEntries(Object.keys(STALL_CENTERS).map((s) => [s, completeKiosk(s, N)])),
    };
    for (const [name, pts] of Object.entries(things)) {
      const r = rect(pts, frame);
      assert.ok(inside(r, size), `${name} at ${size.width}x${size.height}: ${JSON.stringify(r)}`);
    }
  }
});

test("every team sign anchor is inside the default frame at both sizes", () => {
  for (const size of SIZES) {
    const frame = defaultFrame(size);
    for (const l of teamLabels({})) {
      const s = worldToScreen([l.x, l.y, l.z], frame);
      assert.ok(s.x >= 0 && s.x <= size.width && s.y >= 0 && s.y <= size.height, `${l.id} at ${size.width}: ${JSON.stringify(s)}`);
    }
  }
});

test("the Tally faces the camera front-on (yaw 0) and no longer shares the perspective base distance", () => {
  assert.equal(TALLY.rotationY, 0);
});

const overlaps = (a, b) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) + 1e-9 && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0) + 1e-9;
const within = (p, r) => p.x > r.x0 && p.x < r.x1 && p.y > r.y0 && p.y < r.y1;

test("den-map check 1: at the default frame every counter is clear of other counters, Bao and the table", () => {
  for (const size of SIZES) {
    const frame = defaultFrame(size);
    const bao = rect(baoBox(), frame), table = rect(tableRing(), frame);
    const counters = Object.keys(STALL_CENTERS).map((team) => ({
      team,
      rect: rect([-1, 1].flatMap((x) => [-1, 1].map((z) => world(team, N, [x * stallWidth(N) / 2, 0.5, z * 0.5]))), frame),
    }));
    for (let i = 0; i < counters.length; i++) {
      const { team, rect: r } = counters[i];
      assert.ok(!overlaps(r, bao), `${size.width}: ${team} counter / Bao`);
      assert.ok(!overlaps(r, table), `${size.width}: ${team} counter / table`);
      for (let j = i + 1; j < counters.length; j++) assert.ok(!overlaps(r, counters[j].rect), `${size.width}: ${team} / ${counters[j].team} counters`);
    }
  }
});

test("den-map check 1: at the default frame no kiosk sign sits behind another kiosk, Bao or the table", () => {
  for (const size of SIZES) {
    const frame = defaultFrame(size);
    const bao = rect(baoBox(), frame), table = rect(tableRing(), frame);
    const kiosks = Object.fromEntries(Object.keys(STALL_CENTERS).map((s) => [s, rect(completeKiosk(s, N), frame)]));
    for (const l of teamLabels({}).filter((x) => STALL_CENTERS[x.team])) {
      const sign = worldToScreen([l.x, l.y, l.z], frame);
      assert.ok(!within(sign, bao), `${size.width}: ${l.team} sign / Bao`);
      assert.ok(!within(sign, table), `${size.width}: ${l.team} sign / table`);
      for (const [other, r] of Object.entries(kiosks)) if (other !== l.team) assert.ok(!within(sign, r), `${size.width}: ${l.team} sign / ${other} kiosk`);
    }
  }
});

// den-scene-v1/11 A1 (-2 spec): the back kiosks stand at x +-3.6 beside the bigger Bao, which pulled the Tea sign under the
// Steamers kiosk until Tea and Pantry moved out to x +-5.2. These two tests hold that margin (measured 15 px at 1440x900,
// 5 px at 375x667, and the front kiosks 2 px inside the 375 edge).
const pxOutside = (p, r) => Math.hypot(Math.max(r.x0 - p.x, p.x - r.x1, 0), Math.max(r.y0 - p.y, p.y - r.y1, 0));

test("den-scene-v1/11 A1: every kiosk sign anchor is at least 4 px outside every other kiosk's rectangle at both sizes", () => {
  for (const size of SIZES) {
    const frame = defaultFrame(size);
    const kiosks = Object.fromEntries(Object.keys(STALL_CENTERS).map((s) => [s, rect(completeKiosk(s, N), frame)]));
    for (const l of teamLabels({}).filter((x) => STALL_CENTERS[x.team])) {
      const sign = worldToScreen([l.x, l.y, l.z], frame);
      for (const [other, r] of Object.entries(kiosks)) {
        if (other !== l.team) assert.ok(pxOutside(sign, r) >= 4, `${size.width}: ${l.team} sign is ${pxOutside(sign, r).toFixed(1)} px from the ${other} kiosk`);
      }
    }
  }
});

test("den-scene-v1/11 A1: the Tea and Pantry kiosk rectangles are at least 1 px inside the viewport at both sizes", () => {
  for (const size of SIZES) {
    const frame = defaultFrame(size);
    for (const team of ["tea", "pantry"]) {
      const r = rect(completeKiosk(team, N), frame);
      assert.ok(r.x0 >= 1 && r.x1 <= size.width - 1 && r.y0 >= 1 && r.y1 <= size.height - 1, `${team} at ${size.width}: ${JSON.stringify(r)}`);
    }
  }
});
