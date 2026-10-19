// den-scene-v1/07: the one camera goal every control writes (zoom + look-at). Expected values are literals from
// the ticket (levels 1, 2, 3 = 1, 0.75, 0.55) and den-iso-v1/02 (the zoom range 0.55 to 1.2, the default target).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCameraStore, levelOfZoom, LEVEL_ZOOM } from "./camera-store.mjs";

test('the larger garden keeps team and panda levels in sync with its close zoom range',()=>{
  const levels={1:1,2:.4,3:.25},store=createCameraStore({minZoom:.25,levels});
  store.goToTeam('tea');assert.equal(store.getZoom(),.4);assert.equal(levelOfZoom(store.getZoom(),store.levels),2);
  store.goToLevel(3);assert.equal(store.getZoom(),.25);assert.equal(levelOfZoom(store.getZoom(),store.levels),3);
  store.stepZoom('+');assert.equal(store.getZoom(),.25);
  store.goToLevel(1);assert.equal(store.getZoom(),1);assert.equal(levelOfZoom(store.getZoom(),store.levels),1);
});

test("starts at the Level 1 framing: zoom 1, the default look-at", () => {
  const s = createCameraStore();
  assert.equal(s.getZoom(), 1);
  assert.deepEqual(s.getTarget(), [0, 0, -2.9]);
});

test("setZoom clamps to [0.55, 1.2] so the camera never goes inside a kiosk", () => {
  const s = createCameraStore();
  s.setZoom(0.01);
  assert.equal(s.getZoom(), 0.55);
  s.setZoom(50);
  assert.equal(s.getZoom(), 1.2);
});

test("+ and - step the same zoom, closer and farther, and clamp at both ends", () => {
  const s = createCameraStore();
  s.stepZoom("+");
  assert.equal(s.getZoom(), 0.9);
  s.stepZoom("-");
  s.stepZoom("-");
  assert.equal(s.getZoom(), 1.1);
  for (let i = 0; i < 40; i++) s.stepZoom("+");
  assert.equal(s.getZoom(), 0.55);
  for (let i = 0; i < 40; i++) s.stepZoom("-");
  assert.equal(s.getZoom(), 1.2);
});

test("goToLevel: 1 resets zoom and target, 2 and 3 dolly in where the camera already looks, 4 does nothing", () => {
  const s = createCameraStore();
  s.setTarget([1, 0, 1]);
  s.goToLevel(3);
  assert.equal(s.getZoom(), 0.55);
  assert.deepEqual(s.getTarget(), [1, 0, 1]);
  s.goToLevel(2);
  assert.equal(s.getZoom(), 0.75);
  s.goToLevel(4);
  assert.equal(s.getZoom(), 0.75);
  s.goToLevel(1);
  assert.equal(s.getZoom(), 1);
  assert.deepEqual(s.getTarget(), [0, 0, -2.9]);
});

test("goToTeam dollies to Level 2 and moves the look-at off the default target", () => {
  const s = createCameraStore();
  s.goToTeam("tea");
  assert.equal(s.getZoom(), 0.75);
  assert.notDeepEqual(s.getTarget(), [0, 0, -2.9]);
  assert.equal(s.getTarget()[1], 0);
});

test("subscribers hear a change once, and not a no-op write", () => {
  const s = createCameraStore();
  let n = 0;
  const off = s.subscribe(() => n++);
  s.setZoom(0.8);
  s.setZoom(0.8);
  s.setTarget([0, 0, -2.9]);
  assert.equal(n, 1);
  off();
  s.setZoom(0.9);
  assert.equal(n, 1);
});

test("levelOfZoom picks the nearest level; anything farther out than Level 1 reads Level 1", () => {
  assert.equal(levelOfZoom(1), 1);
  assert.equal(levelOfZoom(1.2), 1);
  assert.equal(levelOfZoom(0.8), 2);
  assert.equal(levelOfZoom(0.55), 3);
  assert.deepEqual(LEVEL_ZOOM, { 1: 1, 2: 0.75, 3: 0.55 });
});
