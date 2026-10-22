import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import { smoothWeights } from './weight-smoothing.mjs';

// A 2 x 6 vertex strip: bone A owns x <= 2, bone B owns x >= 3, so the step sits on the edge between x=2 and x=3.
const strip = () => {
  const xyz = [], index = [];
  for (let x = 0; x < 6; x++) xyz.push(x, 0, 0, x, 1, 0);
  for (let x = 0; x < 5; x++) { const a = x * 2; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const weights = Array.from({ length: 12 }, (_, i) => [[i >> 1 <= 2 ? 'A' : 'B', 1]]);
  return { positions: new T.Float32BufferAttribute(xyz, 3), index: new T.Uint16BufferAttribute(index, 1), weights };
};
const of = (list, bone) => list.find(([b]) => b === bone)?.[1] ?? 0;

test('smoothing blends a two-bone step across an edge and keeps pinned vertices', () => {
  const { positions, index, weights } = strip();
  const out = smoothWeights(positions, index, weights, { iterations: 20, pin: p => p.x === 0 || p.x === 5 });
  assert.equal(out.length, 12);
  for (const i of [0, 1]) assert.deepEqual(out[i], [['A', 1]], 'pinned vertex keeps its weights');
  for (const i of [10, 11]) assert.deepEqual(out[i], [['B', 1]], 'pinned vertex keeps its weights');
  for (const i of [4, 5, 6, 7]) assert.ok(of(out[i], 'A') > .05 && of(out[i], 'B') > .05, `vertex ${i} is blended: ${JSON.stringify(out[i])}`);
  assert.ok(of(out[4], 'A') > of(out[6], 'A'), 'A falls off across the step');
  for (const list of out) assert.ok(Math.abs(list.reduce((s, [, w]) => s + w, 0) - 1) < 1e-6, 'weights sum to 1');
});

test('smoothing keeps at most four influences, normalised', () => {
  // Hub vertex 0 on bone H, five neighbours each on their own bone: one step leaves six candidates at the hub.
  const xyz = [0, 0, 0], index = [];
  for (let k = 0; k < 5; k++) { const a = k * 2 * Math.PI / 5; xyz.push(Math.cos(a), Math.sin(a), 0); }
  for (let k = 1; k <= 5; k++) index.push(0, k, k % 5 + 1);
  const weights = [[['H', 1]], ...'BCDEF'.split('').map(b => [[b, 1]])];
  const out = smoothWeights(new T.Float32BufferAttribute(xyz, 3), new T.Uint16BufferAttribute(index, 1), weights, { iterations: 1 });
  assert.equal(out[0].length, 4);
  assert.ok(Math.abs(out[0].reduce((s, [, w]) => s + w, 0) - 1) < 1e-6);
  for (const list of out) assert.ok(list.length <= 4);
});

test('zero iterations return the weights untouched', () => {
  const { positions, index, weights } = strip();
  assert.equal(smoothWeights(positions, index, weights, { iterations: 0 }), weights);
});
