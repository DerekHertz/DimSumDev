import * as T from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';

// The approved handcrafted-kiosk study, expressed as reusable world-unit parts.
// Repeated primitives share immutable source geometry; only the merged result
// is ever attached to the live scene. No image maps, DOM, or local lights.
const primitives = new Map();
function cached(key, build) {
  if (!primitives.has(key)) primitives.set(key, build());
  return primitives.get(key);
}

export function craftedPalette() {
  const mat = (name, color, extra = {}) => {
    const material = new T.MeshStandardMaterial({color, roughness: .82, ...extra});
    material.name = 'crafted-' + name;
    return material;
  };
  return {
    wood: mat('wood', '#c59764'), darkwood: mat('darkwood', '#76543b'),
    endgrain: mat('endgrain', '#a87a4c'), bamboo: mat('bamboo', '#e1be7b'),
    stone: mat('stone', '#d7cfb5'), ivory: mat('plaster', '#f2e7cd'),
    jade: mat('jade', '#8eaea2'), slate: mat('slate', '#738c91'), blue: mat('blue', '#6b949d'),
    red: mat('terracotta', '#c5846d'), gold: mat('gold', '#d6b56b'),
    pink: mat('pink', '#d5aca0'), leaf: mat('leaf', '#71947b'),
    amber: mat('lantern', '#ffe4a6', {emissive: '#ffc66c', emissiveIntensity: .45}),
    water: mat('water', '#83b7af', {roughness: .36, transparent: true, opacity: .84}),
  };
}

function mesh(g, geometry, material, at = [0, 0, 0], scale = [1, 1, 1]) {
  const result = new T.Mesh(geometry, material);
  result.position.set(...at); result.scale.set(...scale);
  g.add(result);
  return result;
}

export function box(g, size, material, at, radius = .025) {
  const r = Math.min(radius, Math.min(...size) * .4);
  const key = ['box', ...size, r].join(',');
  return mesh(g, cached(key, () => r > .009
    ? new RoundedBoxGeometry(...size, 1, r) : new T.BoxGeometry(...size)), material, at);
}

export function cyl(g, radius, height, material, at, segments = 20) {
  return mesh(g, cached(['cylinder', radius, height, segments].join(','),
    () => new T.CylinderGeometry(radius, radius, height, segments)), material, at);
}

export function orb(g, radius, material, at, scale = [1, 1, 1]) {
  return mesh(g, cached('sphere,' + radius, () => new T.SphereGeometry(radius, 10, 6)), material, at, scale);
}

export function line(g, points, radius, material, segments = Math.max(8, points.length * 3), radial = 6) {
  const geometry = new T.TubeGeometry(new T.CatmullRomCurve3(points.map(p => new T.Vector3(...p))), segments, radius, radial, false);
  const result = mesh(g, geometry, material);
  result.userData.temporaryGeometry = true;
  return result;
}

export function ring(g, radius, tube, material, at, rotation = [-Math.PI / 2, 0, 0]) {
  const result = mesh(g, cached(['ring', radius, tube].join(','), () => new T.TorusGeometry(radius, tube, 6, 32)), material, at);
  result.rotation.set(...rotation);
  return result;
}

export function roundedDisc(g, radius, height, material, at, scaleZ = 1, segments = 40) {
  const key = ['disc', radius, height, segments].join(',');
  const geometry = cached(key, () => {
    const r = Math.min(.028, height * .28);
    const profile = [[0, -height / 2], [radius - r, -height / 2], [radius, -height / 2 + r],
      [radius, height / 2 - r], [radius - r, height / 2], [0, height / 2]];
    return new T.LatheGeometry(profile.map(p => new T.Vector2(...p)), segments);
  });
  return mesh(g, geometry, material, at, [1, 1, scaleZ]);
}

export function lantern(g, m, at, red = false) {
  const [x, y, z] = at;
  cyl(g, .018, .23, m.darkwood, [x, y + .36, z], 8);
  cyl(g, .19, .045, m.wood, [x, y + .22, z], 14);
  orb(g, .225, red ? m.red : m.amber, [x, y, z], [1, 1.05, 1]);
  cyl(g, .16, .055, m.wood, [x, y - .22, z], 14);
  cyl(g, .026, .16, m.red, [x, y - .33, z], 8);
  for (let i = 0; i < 8; i++) {
    const angle = i * Math.PI / 4, dx = Math.cos(angle), dz = Math.sin(angle);
    line(g, [[x + dx * .10, y + .22, z + dz * .10],
      [x + dx * .224, y, z + dz * .224],
      [x + dx * .10, y - .21, z + dz * .10]], .009, m.bamboo, 8, 4);
  }
}

export function lattice(g, m, width, height, at, rotationY = 0) {
  const frame = new T.Group(); frame.position.set(...at); frame.rotation.y = rotationY; g.add(frame);
  for (const y of [-height / 2, height / 2]) box(frame, [width + .1, .085, .12], m.wood, [0, y, 0], .018);
  for (const x of [-width / 2, width / 2]) box(frame, [.085, height, .12], m.wood, [x, 0, 0], .018);
  const columns = Math.max(3, Math.round(width / .27)), rows = 4;
  for (let i = 1; i < columns; i++)
    box(frame, [.028, height - .05, .045], m.bamboo, [-width / 2 + i * width / columns, 0, .018], .008);
  for (let i = 1; i < rows; i++)
    box(frame, [width - .05, .028, .045], m.bamboo, [0, -height / 2 + i * height / rows, .025], .008);
  for (const sign of [-1, 1]) {
    const diagonal = box(frame, [.032, Math.min(.43, height * .38), .045], m.wood, [sign * .15, 0, .04], .008);
    diagonal.rotation.z = sign * Math.PI / 4;
  }
}

export function timberFrame(g, m, halfWidth, halfDepth, top, {front = true, back = true} = {}) {
  for (const z of [back ? -halfDepth : null, front ? halfDepth : null]) {
    if (z === null) continue;
    box(g, [halfWidth * 2 + .25, .20, .23], m.wood, [0, top - .10, z], .05);
    box(g, [halfWidth * 2, .055, .27], m.bamboo, [0, top - .245, z], .016);
    for (const sign of [-1, 1]) {
      const x = sign * halfWidth;
      line(g, [[x - sign * .68, top - .21, z], [x - sign * .46, top - .31, z],
        [x - sign * .17, top - .62, z], [x, top - .67, z]], .07, m.wood, 9);
      box(g, [.12, .08, .30], m.endgrain, [x - sign * .63, top - .22, z], .018);
    }
  }
  for (const x of [-halfWidth, halfWidth])
    box(g, [.23, .20, halfDepth * 2 + .20], m.wood, [x, top - .10, 0], .05);
}

export function craftedRoof(g, m, width, depth, eave, rise, color = 'slate') {
  const hw = width / 2, hd = depth / 2, end = Math.min(width * .165, hw - .25);
  const tile = m[color].clone(); tile.side = T.DoubleSide; tile.name = 'crafted-tile';
  const light = tile.clone(), shadow = tile.clone();
  light.color.lerp(new T.Color('#c1d3c8'), .23); light.name = 'crafted-tile-light';
  shadow.color.lerp(new T.Color('#354e55'), .18); shadow.name = 'crafted-tile-shadow';
  const point = (face, u, v, lift = 0) => {
    const x = face < 2 ? v * (end + (hw - end) * u) : (face === 2 ? 1 : -1) * (end + (hw - end) * u);
    const z = face < 2 ? (face === 0 ? 1 : -1) * hd * u : hd * u * v;
    return [x, eave - .05 + rise * (1 - u) ** 2 + .115 * u ** 7 + .19 * Math.abs(v) ** 5 * u ** 6 + lift, z];
  };
  const tilePositions = new Map();
  function tilePatch(face, u0, u1, v0, v1, material, lift) {
    if (!tilePositions.has(material)) tilePositions.set(material, []);
    const vertices = tilePositions.get(material);
    const at = (i, j) => point(face, T.MathUtils.lerp(u0, u1, i / 2), T.MathUtils.lerp(v0, v1, j / 2), lift + .014 * Math.sin(Math.PI * j / 2));
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      vertices.push(...a, ...b, ...d, ...b, ...c, ...d);
    }
  }
  for (let face = 0; face < 4; face++) {
    tilePatch(face, 0, 1, -1, 1, shadow, -.045);
    const columns = face < 2 ? Math.round(width / .24) : Math.max(10, Math.round(depth / .29)), rows = 8;
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const tone = (column * 7 + row * 3 + face) % 11;
      tilePatch(face, row / rows, Math.min(1, (row + 1) / rows + .014),
        -1 + column * 2 / columns + .003, -1 + (column + 1) * 2 / columns - .003,
        tone < 2 ? light : tone === 5 ? shadow : tile, .009 + row * .0007);
    }
    const edge = Array.from({length: 17}, (_, i) => point(face, 1, -1 + i / 8, -.015));
    line(g, edge, .055, light, 24);
    line(g, edge.map(([x, y, z]) => [x, y - .09, z]), .05, m.wood, 24);
  }
  for (const v of [-1, 1]) for (const face of [0, 1]) {
    const points = Array.from({length: 13}, (_, i) => point(face, i / 12, v, .045));
    // Lifted tips remain inside the existing roof's exterior footprint.
    points.push(point(face, 1, v, .13));
    line(g, points, .045, light, 19);
  }
  line(g, [[-end - .15, eave + rise + .10, 0], [-end, eave + rise + .035, 0],
    [0, eave + rise + .04, 0], [end, eave + rise + .035, 0], [end + .15, eave + rise + .10, 0]], .055, light, 20, 8);
  for (let x = -end; x <= end; x += .23) {
    const tileCap = cyl(g, .065, .18, tile, [x, eave + rise, 0], 10); tileCap.rotation.z = Math.PI / 2;
  }
  for (let x = -hw + .65; x < hw - .4; x += .65)
    box(g, [.09, .09, depth * .79], m.wood, [x, eave - .075, 0], .018);
  // Hundreds of tile patches become three buffers directly, avoiding one
  // temporary geometry, mesh and world-matrix update for each tile.
  for (const [material, vertices] of tilePositions) {
    const geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.Float32BufferAttribute(vertices, 3)); geometry.computeVertexNormals();
    mesh(g, geometry, material).userData.temporaryGeometry = true;
  }
}

export function bakeCrafted(source) {
  source.updateMatrixWorld(true);
  const buckets = new Map();
  source.traverse(o => {
    if (!o.isMesh) return;
    const geometry = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    geometry.applyMatrix4(o.matrixWorld); geometry.deleteAttribute('uv');
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    if (!buckets.has(o.material)) buckets.set(o.material, []);
    buckets.get(o.material).push({geometry,walkable:o.userData.navigationSurface==='walkable'});
  });
  const group = new T.Group();
  for (const [material, parts] of buckets) {
    const geometry = mergeGeometries(parts.map(part=>part.geometry), false);
    const result = new T.Mesh(geometry, material); result.name = material.name || 'crafted-detail';
    // Retain source-solid boundaries for navigation without changing render buffers
    // or draw batches: a shared material does not make the intervening air solid.
    let start=0;
    result.userData.navigationParts=parts.map(({geometry,walkable})=>{
      const count=geometry.attributes.position.count,part={start,count,walkable};start+=count;return part;
    });
    result.castShadow = result.receiveShadow = true; group.add(result);
    parts.forEach(part => part.geometry.dispose());
  }
  source.traverse(o => {if (o.userData.temporaryGeometry) o.geometry.dispose();});
  return group;
}
