// Ticket den-scene-v1/05: the stone stele becomes a wooden suanpan abacus at TALLY (name kept).
// Expected values are hand-worked literals from the designer spec (handoffs/05-designer-spec.md), not
// recomputed from the module. Contract for TALLY:
//   { x, z, groundY, rotationY, frame: {width, height, depth, bar}, leg: {width, height} }
// The legs stand on groundY; the frame bottom sits at groundY + leg.height; the frame stands on the legs.
// R3F cannot render under node --test, so geometry criteria that live only in JSX read the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TALLY, BAO, TABLE, CUB_BASKET, CUB_BASKET_RADIUS, STALL_CENTERS, placeRole, stallCenterX, stallWidth, stallYaw, tallyAnchor } from "./banquet-layout.mjs";
import { roamObstacles } from "./roam.mjs";
import { YAW, defaultFrame, worldToScreen } from "./iso-projection.mjs";
import { EAVE_Y } from "./stall-roof.mjs";
import { TALLY_LABEL, TALLY_ARIA_LABEL } from "./tally-face.mjs";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
const FRAME = defaultFrame({ width: 1440, height: 900 }); // den-iso-v1/02: the isometric default frame
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} != ${b}`);
// Screen position in px of a world point at the default frame (y grows downward).
const project = (x, y, z) => worldToScreen([x, y, z], FRAME);
const rectOf = (points) => {
  const ps = points.map(([x, y, z]) => project(x, y, z));
  return { x0: Math.min(...ps.map((p) => p.x)), x1: Math.max(...ps.map((p) => p.x)), y0: Math.min(...ps.map((p) => p.y)), y1: Math.max(...ps.map((p) => p.y)) };
};
const boxPoints = (x, y, z, hx, hy, hz) => [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [-1, 1].map((sz) => [x + sx * hx, y + sy * hy, z + sz * hz])));
const overlap = (a, b) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
// The abacus: frame and legs, from the floor to the frame top.
const abacusRect = () => rectOf(boxPoints(TALLY.x, frameTop() / 2, TALLY.z, TALLY.frame.width / 2, frameTop() / 2, TALLY.frame.depth / 2));

const frameBottom = () => TALLY.groundY + TALLY.leg.height;
const frameTop = () => frameBottom() + TALLY.frame.height;

test("Tally face points toward the orthographic camera: front-on, the camera's heading", () => {
  close(TALLY.rotationY, YAW, 1e-12, "Tally faces the isometric camera");
});

test("the abacus stands beside the Cubs basket: x 1.8, z 3.0, on the floor, turned front-on to the camera (yaw 0)", () => {
  assert.equal(TALLY.x, 1.8);
  assert.equal(TALLY.z, 3.0);
  assert.equal(TALLY.groundY, 0);
  assert.equal(TALLY.rotationY, 0);
});

test("frame is 1.1 wide x 1.4 tall x 0.12 deep with 0.08 bars, on two 0.08 x 0.15 legs: frame bottom 0.15, top 1.55", () => {
  assert.deepEqual(TALLY.frame, { width: 1.1, height: 1.4, depth: 0.12, bar: 0.08 });
  assert.equal(TALLY.leg.width, 0.08);
  assert.equal(TALLY.leg.height, 0.15);
  close(frameBottom(), 0.15, 1e-9, "frame bottom");
  close(frameTop(), 1.55, 1e-9, "frame top");
});

test("grounded beside the basket: on the floor, level with the basket, 0.3+ clear of it, behind the cub row", () => {
  assert.equal(TALLY.groundY, 0);
  assert.equal(TALLY.z, CUB_BASKET.z);
  const frameLeft = TALLY.x - TALLY.frame.width / 2; // 1.25
  assert.ok(frameLeft - CUB_BASKET.x - CUB_BASKET_RADIUS >= 0.3, `gap to basket ${frameLeft - CUB_BASKET_RADIUS}`);
  const front = TALLY.z + TALLY.frame.depth / 2; // 3.06
  assert.ok(front <= 4.6 - 0.35, `frame front ${front} stays behind the cub row`);
});

test("from the default frame the abacus covers only floor: its top is below Bao's feet and the table top on screen, and its box is clear of the table, Bao and the Pantry and Front of House kiosks", () => {
  const top = project(0, frameTop(), TALLY.z).y; // about 631 px at 1440x900
  const baoFeet = project(0, 0, BAO.position[2]).y; // 468 px
  const tableTop = project(0, TABLE.height, TABLE.z).y; // 539 px
  assert.ok(top > baoFeet, `abacus top ${top} is not below Bao's feet ${baoFeet}`);
  assert.ok(top > tableTop, `abacus top ${top} is not below the table top ${tableTop}`);

  const box = abacusRect();
  const table = rectOf(Array.from({ length: 128 }, (_, i) => [TABLE.x + TABLE.radius * Math.cos(i * Math.PI / 64), TABLE.height, TABLE.z + TABLE.radius * Math.sin(i * Math.PI / 64)]));
  const [bx, by, bz] = BAO.position, s = BAO.scale;
  const bao = rectOf(boxPoints(bx, by, bz, s, s, s * 0.875));
  assert.ok(!overlap(box, table), "abacus box overlaps the table");
  assert.ok(!overlap(box, bao), "abacus box overlaps Bao");
  for (const team of ["pantry", "front-of-house"]) {
    // the kiosk body: footprint (width + 0.3, depth 1.3) from the floor to the eave
    const yaw = stallYaw(team), cx = stallCenterX(team, 3), cz = STALL_CENTERS[team].z, hw = (stallWidth(3) + 0.3) / 2;
    const body = rectOf(boxPoints(0, EAVE_Y / 2, 0, hw, EAVE_Y / 2, 0.65).map(([x, y, z]) => [cx + x * Math.cos(yaw) + z * Math.sin(yaw), y, cz - x * Math.sin(yaw) + z * Math.cos(yaw)]));
    assert.ok(!overlap(box, body), `abacus box overlaps the ${team} kiosk`);
  }
});

test("cubs never cover the rods: a plush top (y 0.8) in the cub row projects below the frame bottom", () => {
  const plush = project(0, 0.8, 4.6).y; // 766 px
  const face = project(0, frameBottom(), TALLY.z).y; // 731 px
  assert.ok(plush > face, `cub top ${plush} reaches the frame bottom ${face}`);
});

test("the abacus's screen box does not overlap any Pass perch, the Steamers/Front of House/Pantry perches, or the cub row", () => {
  const b = abacusRect();
  const perches = [
    ["designer", [0, 1, 2]],
    ["architect", [0, 1]],
    ["orchestrator", [0]],
    ["product", [0, 1]],
    ["developer", [0, 1, 2]],
    ["security", [0, 1, 2]], // pantry#0..2
    ["cub", [0, 1, 2, 3, 4, 5, 6, 7]], // cub row slots 0..7
  ];
  for (const [type, slots] of perches) {
    for (const s of slots) {
      const p = placeRole(type, s, type === "cub" ? 8 : 3);
      const q = project(p.x, p.y, p.z);
      const hit = q.x > b.x0 && q.x < b.x1 && q.y > b.y0 && q.y < b.y1;
      assert.ok(!hit, `${type}#${s} perch projects onto the abacus`);
    }
  }
});

test("prop clearance: the abacus footprint (1.8, 3.0) is blocked; the old Tally obstacle at (-3.0, 0.3) is gone", () => {
  const covered = (x, z) =>
    roamObstacles({}).some((o) =>
      o.kind === "circle" ? Math.hypot(x - o.x, z - o.z) < o.r : x > o.x0 && x < o.x1 && z > o.z0 && z < o.z1,
    );
  assert.ok(covered(1.8, 3.0), "the abacus footprint remains available to scene-clearance callers");
  assert.ok(covered(1.25, 2.9) && covered(2.35, 3.1), "the whole frame footprint (1.1 wide, 0.12 deep) plus margin is covered");
  assert.ok(!covered(-3.0, 0.3), "the pagoda slate's footprint no longer blocks roamers");
});

test("the Tally pill anchors about 0.27 above the frame top, centred on it", () => {
  const a = tallyAnchor();
  assert.equal(a.x, TALLY.x);
  assert.equal(a.z, TALLY.z);
  close(a.y, frameTop() + 0.27, 0.02, "pill anchor height");
  close(a.y, 1.82, 0.02, "pill anchor height (literal)");
});

test("accessible name, label and click route are unchanged; 'spills' stays", () => {
  assert.equal(TALLY_LABEL, "Tally");
  assert.equal(TALLY_ARIA_LABEL, "Tally: open the dashboard");
  assert.match(read("./tally-face.mjs"), /spills/i);
  assert.match(read("./ChipLayer.jsx"), /TALLY_ARIA_LABEL/);
});
