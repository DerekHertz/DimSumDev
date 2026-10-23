import test from 'node:test';
import assert from 'node:assert/strict';
import {Box3, Vector3, Raycaster} from 'three';
import {createStylizedStructure, STYLIZED_STRUCTURE_IDS} from './legacy-stylized-structures.mjs';
import {createSurfaceNavigation} from '../../../src/scene/meshy/navigation.mjs';

function walk(nav, from, to) {
  let floor = 0;
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const count = Math.ceil(length / .06);
  for (let i = 0; i <= count; i++) {
    const x = from[0] + (to[0] - from[0]) * i / count;
    const z = from[1] + (to[1] - from[1]) * i / count;
    const next = nav.groundAt(x, z, floor);
    assert.notEqual(next, null, `walk blocked at ${x.toFixed(2)}, ${z.toFixed(2)} from floor ${floor}`);
    assert.ok(next - floor <= .315, 'a tread must fit the walking step height');
    floor = next;
  }
  return floor;
}

test('every structure builds without browser globals and uses finite world-unit geometry', () => {
  for (const id of STYLIZED_STRUCTURE_IDS) {
    const group = createStylizedStructure(id);
    const b = new Box3().setFromObject(group), size = b.getSize(new Vector3());
    assert.ok(size.toArray().every(v => Number.isFinite(v) && v > 0), id);
    assert.ok(Math.abs(b.min.y) < .00001, id + ' must have its foot at zero');
    assert.ok(b.max.y <= 4.8, id + ' must fit the human-scale roof height');
    assert.equal(group.userData.structure.id, id);
    for (const door of group.userData.structure.doors)
      assert.ok(door.max[1] - door.min[1] >= 2.35, id + ' must have standing headroom');
  }
});

test('kiosk right entrances are walkable while service counters stay solid', () => {
  for (const id of ['steamers', 'front', 'tea', 'pantry']) {
    const group = createStylizedStructure(id), nav = createSurfaceNavigation([group]);
    assert.ok(Math.abs(walk(nav, [4, -.32], [0, -.32]) - .36) < .015);
    assert.equal(nav.groundAt(0, 1.4, .36), null, id + ' service counter must remain solid');
    const door = group.userData.structure.doors[0];
    assert.ok(door.max[2] - door.min[2] >= 1.25);
  }
});

test('library, stage, and pavilion approaches can be walked from ground level', () => {
  for (const [id, from, to] of [
    ['library', [0, 4], [0, 0]],
    ['festival', [0, 4], [0, 0]],
    ['pavilion', [0, 7], [0, 1.2]],
  ]) {
    const group = createStylizedStructure(id), nav = createSurfaceNavigation([group]);
    assert.ok(Math.abs(walk(nav, from, to) - group.userData.structure.floorY) < .015, id);
  }
});

test('gate and gate tea table have comfortable first-person proportions', () => {
  const gate = createStylizedStructure('gate');
  assert.equal(walk(createSurfaceNavigation([gate]), [0, 2], [0, -2]), 0);
  const table = createStylizedStructure('dining').userData.structure.table;
  assert.equal(table.width, 2);
  assert.ok(table.top < 1);
});

function renderBudget(group) {
  let triangles = 0, batches = 0;
  group.traverse(node => {
    if (!node.isMesh) return;
    const vertices = node.geometry.index?.count ?? node.geometry.attributes.position.count;
    triangles += vertices / 3 * (node.isInstancedMesh ? node.count : 1);
    batches += Array.isArray(node.material) ? node.geometry.groups.length : 1;
  });
  return { triangles, batches };
}
function hits(group, origin, direction, far = 1) {
  group.updateMatrixWorld(true);
  return new Raycaster(new Vector3(...origin), new Vector3(...direction).normalize(), 0, far).intersectObject(group, true);
}

test('crafted geometry stays inside the approved browser triangle and draw-batch budgets', () => {
  const budgets = {
    steamers: [35000, 25], front: [35000, 25], tea: [35000, 25], pantry: [35000, 25],
    library: [60000, 30], gate: [60000, 30], pavilion: [60000, 30], festival: [60000, 30],
    center: [8000, 10], dining: [8000, 10], games: [8000, 10], training: [8000, 10],
  };
  for (const [id, [triangleLimit, batchLimit]] of Object.entries(budgets)) {
    const actual = renderBudget(createStylizedStructure(id));
    assert.ok(actual.triangles > 0 && actual.triangles <= triangleLimit, `${id}: ${actual.triangles} triangles exceeds ${triangleLimit}`);
    assert.ok(actual.batches > 0 && actual.batches <= batchLimit, `${id}: ${actual.batches} draw batches exceeds ${batchLimit}`);
  }
});

test('kiosk lattice admits sight through actual rear and side openings while its bars remain solid', () => {
  for (const id of ['steamers', 'front', 'tea', 'pantry']) {
    const group = createStylizedStructure(id);
    assert.equal(hits(group, [.84, 2.12, -2.3], [0, 0, 1]).length, 0, id + ' rear window must not have a solid wall behind its lattice');
    assert.ok(hits(group, [.732, 2.12, -2.3], [0, 0, 1]).length > 0, id + ' rear lattice bar must be actual geometry');
    assert.equal(hits(group, [-2.6, 2.1, .34], [1, 0, 0], .7).length, 0, id + ' side window must have a real opening');
    assert.ok(hits(group, [-2.6, 2.1, .233], [1, 0, 0], .7).length > 0, id + ' side lattice bar must be actual geometry');
  }
});

test('roofs have a curved section rather than a few flat roof planes', () => {
  for (const id of ['steamers', 'front', 'tea', 'pantry', 'library', 'gate', 'pavilion', 'festival']) {
    const group = createStylizedStructure(id), slopes = new Set();
    const limit = id === 'gate' ? .90 : 1.8;
    for (let z = .15; z <= limit; z += .065) {
      const intersection = hits(group, [.22, 6, z], [0, -1, 0], 4)[0];
      assert.ok(intersection, id + ' roof must cover the section');
      const normal = intersection.face.normal;
      if (Math.abs(normal.y) > .2) slopes.add(Math.round(normal.z / normal.y * 40));
    }
    assert.ok(slopes.size >= 6, `${id}: the roof section has only ${slopes.size} distinct slopes`);
  }
});

test('round table rims have bevel geometry instead of a sharp cylindrical top edge', () => {
  for (const id of ['center', 'dining']) {
    const group = createStylizedStructure(id), table = group.userData.structure.table;
    let rounded = false;
    group.updateMatrixWorld(true);
    group.traverse(node => {
      if (!node.isMesh) return;
      const position = node.geometry.attributes.position, normal = node.geometry.attributes.normal;
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i), z = position.getZ(i), y = position.getY(i);
        const radial = Math.hypot(x, z * table.width / table.depth);
        if (radial > table.width * .48 && radial < table.width * .51 && y > table.top - .20 && y < table.top + .01
          && Math.abs(normal.getY(i)) > .15 && Math.abs(normal.getY(i)) < .95) rounded = true;
      }
    });
    assert.equal(rounded, true, id + ' tabletop needs a sloping bevel at its outer rim');
  }
});
