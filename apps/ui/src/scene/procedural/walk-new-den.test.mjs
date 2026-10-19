// den-layout/04, rewritten for the village (den-mvp/25): walk mode in the den. The seam is the one the app uses:
// createDenExplorer over the den that RestaurantDen assembles (the kit's village, wave 1 zones mounted on it).
// Expected positions are literals from the kit's layout (teams, props, floor radius 28), not recomputed from the code under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createBao } from './bao.mjs';
import { createDenScene } from './den-scene.mjs';
import { compactPanda, compactEnvironment } from './compact.mjs';
import { canvasDocument } from './den-test-helpers.mjs';
import { createDenExplorer } from './explorer.mjs';
import { isDenPositionBlocked } from './walk.mjs';
import { createReviewAgents } from '../../review/agents.mjs';
import { mountExpansionPond } from '../expansion/pond.mjs';
import { mountWorkZones } from '../expansion/work-zones.mjs';
import { REVIEW_TEAMS, REVIEW_OBSTACLES, LANTERN_POSTS } from '../../review/site-plan.mjs';
import { ZONES } from '../expansion/integration/zone-contract.mjs';

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    emit(type, event = {}) { for (const fn of listeners.get(type) || []) fn(event); },
  };
}

// Builds the den the way RestaurantDen does, plus an explorer on it with a stubbed document, and tears both down.
function withNewDenWalker(run) {
  const previous = { document: globalThis.document, window: globalThis.window };
  const doc = eventTarget(), win = eventTarget(), canvas = eventTarget();
  doc.pointerLockElement = null; win.matchMedia = () => ({ matches: false });
  canvas.setPointerCapture = () => {};
  let den, pond, work, agents, explorer;
  globalThis.document = canvasDocument();
  try {
    den = createDenScene(THREE, createBao);
    den.setLabels(false);
    for (const p of den.pandas) compactPanda(THREE, p);
    compactEnvironment(THREE, den);
    pond = mountExpansionPond(den);
    work = mountWorkZones(den);
    agents = createReviewAgents(den, createBao);
    globalThis.document = doc; globalThis.window = win;
    const navigation = { enabled: true }, modes = [];
    explorer = createDenExplorer(THREE, { canvas, orbitControls: navigation, den, onModeChange: (v) => modes.push(v) });
    run({ explorer, den, doc, navigation, modes });
  } finally {
    explorer?.dispose();
    globalThis.document = canvasDocument(); globalThis.window = previous.window;
    agents?.dispose(); work?.dispose(); pond?.dispose(); den?.dispose();
    globalThis.document = previous.document;
  }
}

const FLOOR_RADIUS = 28;
const WALKER_RADIUS = 0.26;

// Flood fill over the explorer's own blocked() from the spawn, on a 0.25 m grid. Returns a predicate for the
// reachable placements and the placement count.
function reachableFrom(explorer, start) {
  const step = 0.25, half = Math.ceil(26 / step);
  const key = (i, j) => (i + half) * (2 * half + 1) + (j + half);
  const seen = new Set(), queue = [[Math.round(start.x / step), Math.round(start.z / step)]];
  seen.add(key(...queue[0]));
  for (let head = 0; head < queue.length; head++) {
    const [i, j] = queue[head];
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = j + dj;
      if (Math.abs(a) > half || Math.abs(b) > half || seen.has(key(a, b))) continue;
      if (explorer.blocked(a * step, b * step)) continue;
      seen.add(key(a, b)); queue.push([a, b]);
    }
  }
  return { size: seen.size, near: (x, z, radius) => {
    for (let a = Math.floor((x - radius) / step); a <= Math.ceil((x + radius) / step); a++) {
      for (let b = Math.floor((z - radius) / step); b <= Math.ceil((z + radius) / step); b++) {
        if (Math.hypot(a * step - x, b * step - z) <= radius && seen.has(key(a, b))) return true;
      }
    }
    return false;
  } };
}

test('walk mode enters, moves with W and exits with Esc on the new den, with den-v1/03 controls', () => {
  withNewDenWalker(({ explorer, doc, navigation, modes }) => {
    explorer.enter();
    assert.equal(explorer.active, true);
    assert.equal(navigation.enabled, false, 'orbit camera is parked while walking');
    assert.deepEqual(modes, [true]);
    const start = explorer.camera.position.clone();
    explorer.update(0.1);
    assert.deepEqual(explorer.camera.position.toArray(), start.toArray(), 'standing still without a key');
    doc.emit('keydown', { code: 'KeyW', preventDefault() {}, target: {} });
    for (let i = 0; i < 30; i++) explorer.update(1 / 30);
    const walked = explorer.camera.position.distanceTo(start);
    assert.ok(walked > 1.8 && walked < 2.4, 'one second of W from the spawn covers ~2.1 m (it must face open floor), got ' + walked);
    doc.emit('keydown', { code: 'Escape', preventDefault() {}, target: {} });
    assert.equal(explorer.active, false);
    assert.equal(navigation.enabled, true, 'orbit camera is back after Esc');
    assert.deepEqual(modes, [true, false]);
  });
});

test('the walker is blocked by each team\'s counter and posts, and by the Pass, from every side', () => {
  assert.equal(REVIEW_TEAMS.length, 4);
  withNewDenWalker(({ explorer }) => {
    for (const s of REVIEW_TEAMS) {
      // The prep counter (3 m wide, a metre or so deep, along the front) and the front posts are solid...
      for (const [lx, lz] of [[0, 0.65], [1.2, 0.65], [-1.2, 0.65], [1.6, 1.08], [-1.6, -1.08]]) {
        assert.equal(explorer.blocked(s.x + lx, s.z + lz), true, `team at ${s.x},${s.z}: local ${lx},${lz} is walkable`);
      }
      // ...the floor behind the counter, where the role stands, is open, and so is the ground 1 m clear of its front.
      assert.equal(explorer.blocked(s.x - 0.5, s.z - 0.5), false, `team at ${s.x},${s.z}: the working floor is walkable`);
      assert.equal(explorer.blocked(s.x, s.z + 1.05 + WALKER_RADIUS + 1), false, `team at ${s.x},${s.z}: the space in front is walkable`);
    }
    for (const [x, z] of [[0, -8], [-1.2, -8], [1.2, -8], [-2.5, -10], [2.5, -10]]) assert.equal(explorer.blocked(x, z), true, `the Pass is walkable at ${x},${z}`);
  });
});

test('the walker is blocked by the village\'s props: lantern posts, the round table, mahjong table, tally, practice garden, library, wave 1 zones', () => {
  withNewDenWalker(({ explorer }) => {
    const solid = [
      ...LANTERN_POSTS.map(([x, , z]) => [x, z]),
      [0, 9], [-9, 19], [18, 10], [14, 18.25], [-14, 10], [0, -20], [14, -19], [-12.8, 19],
      ...['repair', 'archive'].map((id) => ZONES.find((z) => z.id === id).position).map(([x, , z]) => [x, z]),
    ];
    for (const [x, z] of solid) assert.equal(explorer.blocked(x, z), true, `walkable at ${x},${z}`);
  });
});

test('the walker cannot leave the garden: every point past the floor edge (radius 28) is blocked', () => {
  withNewDenWalker(({ explorer }) => {
    for (const angle of [0, 0.7, 1.6, 2.4, 3.14, 4.0, 4.9, 5.7]) {
      const r = FLOOR_RADIUS + WALKER_RADIUS + 0.2;
      const x = Math.sin(angle) * r, z = Math.cos(angle) * r;
      assert.equal(explorer.blocked(x, z), true, `open past the floor edge at angle ${angle}`);
      assert.equal(explorer.blocked(x * 1.5, z * 1.5), true, `open far past the floor edge at angle ${angle}`);
    }
  });
});

test('the spawn point is inside a walkable area of the village, clear of every obstacle with room around it', () => {
  withNewDenWalker(({ explorer, den }) => {
    explorer.enter();
    const { x, z } = explorer.camera.position;
    assert.equal(explorer.blocked(x, z), false, `spawn ${x},${z} is blocked`);
    assert.ok(Math.hypot(x, z) < FLOOR_RADIUS - 1, 'spawn is on the floor, away from its edge');
    assert.equal(isDenPositionBlocked(x, z, [...REVIEW_OBSTACLES, ...den.obstacles], 0.65), false, 'spawn is hemmed in');
    for (const s of REVIEW_TEAMS) assert.ok(Math.hypot(x - s.x, z - s.z) > 3, `spawn is in the team at ${s.x},${s.z}`);
  });
});

test('from the spawn the walker can reach every team, every leisure place and every wave 1 zone approach, across the pond bridge', () => {
  withNewDenWalker(({ explorer }) => {
    explorer.enter();
    const reach = reachableFrom(explorer, explorer.camera.position);
    assert.ok(reach.size > 4000, 'the reachable area is large (a 2.1 m/s walker should cover most of the village): ' + reach.size + ' placements');
    // Teams, leisure places and props are the kit's own positions.
    for (const [x, z] of [[-14, -10], [14, -10], [-14, 0], [14, 0], [0, -10], [0, 9], [-14, 10], [-9, 19], [14, 18], [4, 20], [18, 10], [0, -20], [-10, -20], [14, -19]]) {
      assert.ok(reach.near(x, z, 3.0), `cannot get within 3 m of ${x},${z}`);
    }
    for (const id of ['repair', 'archive', 'pond']) {
      const zone = ZONES.find((z) => z.id === id);
      assert.ok(reach.near(zone.approach[0], zone.approach[2], 1.0), `cannot reach the ${id} approach`);
    }
    // The pond's arched bridge: both banks of the water are reachable, and the bridge deck itself is walkable.
    assert.equal(explorer.blocked(-21, 9), false, 'the bridge deck is walkable');
    assert.ok(reach.near(-21, 6.4, 0.5) && reach.near(-21, 11.6, 0.5), 'both banks of the pond are reachable');
  });
});

test('the walk check is back in smoke:ui against the new den', () => {
  const smoke = readFileSync(new URL('../../../../ci-cd/smoke-ui.mjs', import.meta.url), 'utf8');
  assert.ok(/check\(\s*["'`]walk: Enter the den/.test(smoke), 'smoke-ui.mjs has no active "walk: Enter the den" check');
  assert.ok(!/check is dropped/.test(smoke), 'the dropped-check note is still in place');
});
