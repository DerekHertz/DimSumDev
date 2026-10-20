import test from 'node:test';
import assert from 'node:assert/strict';
import * as layout from './layout.mjs';

test('the walking location follows authored places and labels open paths honestly', () => {
  assert.equal(typeof layout.walkLocation, 'function');
  assert.equal(layout.walkLocation({ x: 0, z: 34 }), 'Entrance');
  assert.equal(layout.walkLocation({ x: -20.2, z: -11.9 }), 'Steamers');
  assert.equal(layout.walkLocation({ x: 20.2, z: -11.9 }), 'Tea & Pantry');
  assert.equal(layout.walkLocation({ x: -21, z: 6 }), 'Library');
  assert.equal(layout.walkLocation({ x: 0, z: -5 }), 'Garden paths');
});
