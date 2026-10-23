import test from 'node:test';
import assert from 'node:assert/strict';
import * as layout from './layout.mjs';

test('the walking location follows authored places and labels open paths honestly', () => {
  assert.equal(typeof layout.walkLocation, 'function');
  assert.equal(layout.walkLocation({ x: 0, z: 42 }), 'Entrance');
  assert.equal(layout.walkLocation({ x: -30.5, z: 24 }), 'Steamers');
  assert.equal(layout.walkLocation({ x: 30.5, z: -32 }), 'Tea & Pantry');
  assert.equal(layout.walkLocation({ x: 0, z: 24 }), 'Library');
  assert.equal(layout.walkLocation({ x: 0, z: -4 }), 'Garden paths');
});
