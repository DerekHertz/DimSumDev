import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { frameDue, DEFAULT_FPS, FPS_OPTIONS, createFrameSchedule, createFramePreference } from './frame-cap.mjs';

test('a frame is due once a 30 fps interval has passed, with a little slack for rAF jitter', () => {
  assert.equal(DEFAULT_FPS, 30);
  assert.equal(frameDue(0, -Infinity), true);
  assert.equal(frameDue(16.7, 0), false); // a 60 Hz display's next tick is skipped
  assert.equal(frameDue(33.3, 0), true);
  assert.equal(frameDue(32.5, 0), true); // jitter just under the interval still draws
  // 144 Hz ticks: about one in five draws, so 30 a second at most.
  let last = -Infinity, drawn = 0;
  for (let t = 0; t < 1000; t += 1000 / 144) if (frameDue(t, last)) { last = t; drawn++; }
  assert.ok(drawn <= 30 && drawn >= 28, `drew ${drawn} frames in a second`);
});

test('the den Canvas renders on demand and mounts the frame cap', () => {
  const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  assert.match(app, /<Canvas[^>]*frameloop="demand"/);
  assert.match(app, /<FrameCap\s+fps=\{fps\}\s*\/>/);
});

test('the frame schedule keeps the chosen average rate across different displays without catch-up bursts', () => {
  for (const hz of [60, 120, 144, 165]) for (const fps of FPS_OPTIONS) {
    const due = createFrameSchedule(fps); let drawn = 0;
    for (let tick = 0; tick < hz * 10; tick++) if (due(tick * 1000 / hz)) drawn++;
    const expected = Math.min(hz, fps) * 10;
    assert.ok(Math.abs(drawn - expected) <= 1, `${hz} Hz / ${fps} FPS: drew ${drawn}, expected ${expected}`);
  }
  const due = createFrameSchedule(60);
  assert.equal(due(0), true); assert.equal(due(5000), true); assert.equal(due(5000), false);
  assert.equal(due(5001), false); assert.equal(due(5016.7), true);
});

test('frame targets persist and invalid or inaccessible storage falls back safely', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const preference = createFramePreference(storage); assert.equal(preference.fps, 30);
  for (const fps of FPS_OPTIONS) { preference.set(fps); assert.equal(createFramePreference(storage).fps, fps); }
  preference.set(0); assert.equal(preference.fps, 120); assert.equal(values.get('den.fps'), '120');
  for (const invalid of ['0', '-1', 'NaN', 'Infinity', 'unlimited', '144']) { values.set('den.fps', invalid); assert.equal(createFramePreference(storage).fps, 30); }
  assert.equal(createFramePreference().fps, 30);
  const blocked = createFramePreference({ getItem() { throw Error('unavailable'); }, setItem() { throw Error('unavailable'); } });
  blocked.set(60); assert.equal(blocked.fps, 60);
});
