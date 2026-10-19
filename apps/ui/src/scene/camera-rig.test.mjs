// den-iso-v1/02: camera input math for the orthographic den. Pure. Zoom keeps the old semantics
// (factor 0.55..1.2, wheel +0.001 per deltaY, keys step 0.1); pan now moves the look-at target on the
// ground (digest section 1): drag dtx = -dx/k, dtz = -dy/(k sin p); arrow keys step 0.5 in x; limits from panLimits.
// Expected values are hand-worked from the digest, not recomputed from the module.
//
// Interface under test (apps/ui/src/scene/camera-rig.mjs), view = { width, height, zoom }, target = [x, y, z]:
//   ZOOM_MIN, ZOOM_MAX, clampZoom, keyZoom(zoom, key), wheelZoom(zoom, deltaY)
//   clampTarget(target, view), keyPan(target, key, view), dragPan(target, { dx, dy }, view)
// The perspective rig's exports (PAN_LIMIT, FOV_DEG, BASE_Y, BASE_Z, cameraPosition, panLimit, visibleHalfWidth,
// clampPan) are gone; the old perspective tests of those were replaced by iso-projection.test.mjs and this file.
import { test } from "node:test";
import assert from "node:assert/strict";

const load = () => import("./camera-rig.mjs");
const near = (a, b, tol, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} expected ${b} +-${tol}, got ${a}`);

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 667 };
const FEET = [0, 0, -2.9];

test("zoom limits are the agreed literals", async () => {
  const { ZOOM_MIN, ZOOM_MAX } = await load();
  assert.equal(ZOOM_MIN, 0.55);
  assert.equal(ZOOM_MAX, 1.2);
});

test("the perspective camera constants are gone", async () => {
  const m = await load();
  for (const name of ["FOV_DEG", "BASE_Y", "BASE_Z", "cameraPosition", "PAN_LIMIT", "visibleHalfWidth", "panLimit", "clampPan"]) {
    assert.ok(!(name in m), `${name} must not be exported by camera-rig.mjs`);
  }
});

test("clampZoom holds the factor within 0.55..1.2", async () => {
  const { clampZoom } = await load();
  assert.equal(clampZoom(1), 1);
  assert.equal(clampZoom(0.1), 0.55);
  assert.equal(clampZoom(3), 1.2);
});

test("keyZoom: plus zooms in (smaller factor), minus zooms out, clamped", async () => {
  const { keyZoom } = await load();
  assert.equal(keyZoom(1, "+"), 0.9);
  assert.equal(keyZoom(1, "="), 0.9);
  assert.equal(keyZoom(1, "-"), 1.1);
  assert.equal(keyZoom(0.6, "+"), 0.55);
  assert.equal(keyZoom(1.15, "-"), 1.2);
  assert.equal(keyZoom(1, "a"), 1);
});

test("wheelZoom: scrolling down (positive deltaY) zooms out, up zooms in, clamped to the digest's range", async () => {
  const { wheelZoom } = await load();
  assert.equal(wheelZoom(1, 100), 1.1);
  assert.equal(wheelZoom(1, -100), 0.9);
  assert.equal(wheelZoom(1, 100000), 1.2);
  assert.equal(wheelZoom(1, -100000), 0.55);
});

test("keyPan steps the target 0.5 in x and stops at the pan limit; other keys do nothing", async () => {
  const { keyPan } = await load();
  const { panLimits } = await import("./iso-projection.mjs");
  const view = { ...PHONE, zoom: 1 };
  const lim = panLimits(view).x;
  assert.ok(lim > 4, "phone at default has room to pan sideways");
  assert.deepEqual(keyPan(FEET, "ArrowRight", view), [0.5, 0, -2.9]);
  assert.deepEqual(keyPan(FEET, "ArrowLeft", view), [-0.5, 0, -2.9]);
  near(keyPan([lim - 0.2, 0, -2.9], "ArrowRight", view)[0], lim, 1e-9, "stops at the right limit");
  near(keyPan([-lim + 0.2, 0, -2.9], "ArrowLeft", view)[0], -lim, 1e-9, "stops at the left limit");
  assert.deepEqual(keyPan([1, 0, -2.9], "ArrowUp", view), [1, 0, -2.9]);
  assert.deepEqual(keyPan([1, 0, -2.9], "a", view), [1, 0, -2.9]);
});

// 1440x900, zoom 0.55: k = 87.805 / 0.55 = 159.64; sin p = 0.57735.
//   100 px right: dtx = -100 / 159.64 = -0.6264. 100 px down: dtz = -100 / (159.64 * 0.57735) = -1.0850.
test("dragPan: dragging right moves the target left, dragging down moves it back (away from the camera), by 1/k", async () => {
  const { dragPan } = await load();
  const view = { ...DESKTOP, zoom: 0.55 };
  const right = dragPan(FEET, { dx: 100, dy: 0 }, view);
  near(right[0], -0.6264, 1e-3, "dtx");
  near(right[2], -2.9, 1e-9, "no z change");
  assert.equal(right[1], 0);
  const left = dragPan(FEET, { dx: -100, dy: 0 }, view);
  near(left[0], 0.6264, 1e-3, "dtx");
  const down = dragPan(FEET, { dx: 0, dy: 100 }, view);
  near(down[0], 0, 1e-9, "no x change");
  near(down[2], -2.9 - 1.0850, 1e-3, "dtz");
  const up = dragPan(FEET, { dx: 0, dy: -100 }, view);
  near(up[2], -2.9 + 1.0850, 1e-3, "dtz");
});

test("dragPan keeps the ground point under the cursor under the cursor", async () => {
  const { dragPan } = await load();
  const { worldToScreen } = await import("./iso-projection.mjs");
  const view = { ...DESKTOP, zoom: 0.55 };
  const p = [1.8, 0, 0.5];
  const before = worldToScreen(p, { ...view, target: FEET });
  const target = dragPan(FEET, { dx: 80, dy: -30 }, view);
  const after = worldToScreen(p, { ...view, target });
  near(after.x - before.x, 80, 1e-6, "moved with the drag in x");
  near(after.y - before.y, -30, 1e-6, "moved with the drag in y");
});

test("pan clamps: no vertical pan at the default; about 1.9 units either way at the nearest zoom; x stops at the widest stall", async () => {
  const { dragPan, clampTarget } = await load();
  const { panLimits } = await import("./iso-projection.mjs");
  // default zoom, desktop: z cannot move at all
  assert.deepEqual(dragPan(FEET, { dx: 0, dy: 5000 }, { ...DESKTOP, zoom: 1 }).slice(2), [-2.9]);
  assert.deepEqual(dragPan(FEET, { dx: 0, dy: -5000 }, { ...DESKTOP, zoom: 1 }).slice(2), [-2.9]);
  // nearest zoom: |tz + 2.9| <= 1.872 (see iso-projection.test.mjs)
  const near55 = { ...DESKTOP, zoom: 0.55 };
  near(dragPan(FEET, { dx: 0, dy: -5000 }, near55)[2], -2.9 + 1.872, 0.01, "forward limit");
  near(dragPan(FEET, { dx: 0, dy: 5000 }, near55)[2], -2.9 - 1.872, 0.01, "back limit");
  // x on the phone stops where the widest stall's outer edge reaches the screen edge
  const phone = { ...PHONE, zoom: 1 };
  const lim = panLimits(phone).x;
  near(dragPan(FEET, { dx: -100000, dy: 0 }, phone)[0], lim, 1e-9, "x right limit");
  near(dragPan(FEET, { dx: 100000, dy: 0 }, phone)[0], -lim, 1e-9, "x left limit");
  // clampTarget pulls an out-of-range target back in and leaves an in-range one alone
  assert.deepEqual(clampTarget([0.5, 0, -2.9], phone), [0.5, 0, -2.9]);
  near(clampTarget([99, 0, -2.9], phone)[0], lim, 1e-9, "clampTarget x");
  near(clampTarget([0, 0, 40], near55)[2], -2.9 + 1.872, 0.01, "clampTarget z");
});

test("MAX_STALL_PLACEMENTS includes the scene's active cap plus the other idle Steamers role", async () => {
  const { MAX_STALL_PLACEMENTS } = await import("./banquet-layout.mjs");
  const { MAX_PLUSH } = await import("./scene-from-state.mjs");
  assert.equal(MAX_PLUSH, 12);
  assert.equal(MAX_STALL_PLACEMENTS, 13);
});
