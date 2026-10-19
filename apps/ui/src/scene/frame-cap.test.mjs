import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { frameDue, MAX_FPS } from './frame-cap.mjs';

test('a frame is due once a 30 fps interval has passed, with a little slack for rAF jitter', () => {
  assert.equal(MAX_FPS, 30);
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
  assert.match(app, /<FrameCap\s*\/>/);
});
