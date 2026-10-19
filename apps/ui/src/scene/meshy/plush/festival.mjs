/** Standalone look study: a red-and-gold cloth dragon, carried by pandas, on a garden stage.
 * +Y up, +Z audience. Architecture/costume/instruments only; the review owns the pandas.
 */
import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { castsShadow } from './garden-kit.mjs';

export const FESTIVAL_PALETTE = Object.freeze({
  red: '#c64236', redLight: '#df6650', redDeep: '#8d302d', gold: '#e3b04f', goldLight: '#f5d88a',
  jade: '#79a98b', jadeDeep: '#3d755f', jadeLight: '#bdd2a6', timber: '#b08052', honey: '#d8ac76',
  paleWood: '#eccb98', cream: '#fff3d8', ink: '#304d40', mouth: '#622f32', pink: '#eead8c',
});
export function dragonPath(t) {
  return new T.Vector3(-2.7 + t * 5.75, 1.94 + .14 * Math.cos(t * Math.PI * 2), 1.55 + .30 * Math.sin(t * Math.PI * 1.4));
}
export function createFestival() {
  const root = new T.Group(); root.name = 'Bamboo festival — standalone stage study';
  root.userData = { assetId: 'festival-stage-study', entrance: '+Z', reviewOnly: false };
  const colors = FESTIVAL_PALETTE, mats = Object.fromEntries(Object.entries(colors).map(([name, color]) => [name, new T.MeshStandardMaterial({ color, roughness: .83, metalness: name.startsWith('gold') ? .12 : 0 })]));
  const caches = new Map(), sources = new Set();
  const cached = (key, make) => { if (!caches.has(key)) caches.set(key, make()); return caches.get(key); };
  const group = (name, parent = root, at = [0, 0, 0]) => { const g = new T.Group(); g.name = name; g.position.fromArray(at); parent.add(g); return g; };
  const mesh = (parent, geometry, material, at = [0, 0, 0]) => { const m = new T.Mesh(geometry, mats[material] || material); m.position.fromArray(at); parent.add(m); sources.add(geometry); return m; };
  const box = (p, size, at, color, radius = .045) => { const r = Math.min(radius, ...size.map(v => v * .24)); return mesh(p, cached(`b:${size}:${r}`, () => new RoundedBoxGeometry(...size, 2, r)), color, at); };
  const orb = (p, r, at, color, scale = [1, 1, 1]) => { const m = mesh(p, cached(`s:${r}`, () => new T.SphereGeometry(r, 24, 16)), color, at); m.scale.fromArray(scale); return m; };
  const cyl = (p, r, h, at, color, top = r) => mesh(p, cached(`c:${r}:${h}:${top}`, () => new T.CylinderGeometry(top, r, h, 28)), color, at);
  const ring = (p, r, w, at, color) => mesh(p, cached(`r:${r}:${w}`, () => new T.TorusGeometry(r, w, 8, 48)), color, at);
  const tube = (p, points, r, color, segments = 24) => mesh(p, new T.TubeGeometry(new T.CatmullRomCurve3(points.map(v => new T.Vector3(...v))), segments, r, 8, false), color);
  function beam(p, a, b, r, color) {
    const from = new T.Vector3(...a), to = new T.Vector3(...b), m = cyl(p, r, from.distanceTo(to), from.clone().add(to).multiplyScalar(.5).toArray(), color);
    m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), to.sub(from).normalize()); return m;
  }
  function plaque(p, text, at, w, h = .44, color = 'redDeep') {
    box(p, [w + .14, h + .12, .10], [at[0], at[1], at[2] - .035], 'gold');
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = Math.round(1024 * h / w);
    const c = canvas.getContext('2d'); c.fillStyle = colors[color]; c.fillRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = colors.cream; c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = `600 ${canvas.height * .52}px sans-serif`; c.fillText(text, 512, canvas.height * .54, 970);
    const map = new T.CanvasTexture(canvas); map.colorSpace = T.SRGBColorSpace;
    return mesh(p, new T.PlaneGeometry(w, h), new T.MeshStandardMaterial({ map, roughness: .9 }), [at[0], at[1], at[2] + .02]);
  }
  function flame(p, at, size, color, yaw = 0) {
    // A curved leaf/flame silhouette, rather than another row of spherical body segments.
    const s = new T.Shape(); s.moveTo(-.23, 0); s.bezierCurveTo(-.48, .40, -.15, .72, .08, 1); s.bezierCurveTo(.03, .59, .42, .43, .27, .08); s.quadraticCurveTo(.02, -.03, -.23, 0);
    const m = mesh(p, new T.ExtrudeGeometry(s, { depth: .065, bevelEnabled: true, bevelSize: .025, bevelThickness: .02, bevelSegments: 2, steps: 1, curveSegments: 12 }), color, at); m.scale.fromArray(size); m.rotation.y = yaw; return m;
  }
  function lantern(p, at, scale = 1, color = 'red') {
    const g = group('Ribbed festival lantern', p, at); g.scale.setScalar(scale);
    beam(g, [0, 0, 0], [0, -.25, 0], .013, 'gold'); orb(g, .28, [0, -.56, 0], color, [1, 1.15, 1]);
    for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; tube(g, [[Math.cos(a) * .12, -.25, Math.sin(a) * .12], [Math.cos(a) * .282, -.56, Math.sin(a) * .282], [Math.cos(a) * .12, -.88, Math.sin(a) * .12]], .007, 'goldLight', 12); }
    for (const y of [-.25, -.9]) cyl(g, .13, .045, [0, y, 0], 'gold');
    for (const x of [-.045, 0, .045]) beam(g, [x, -.94, 0], [x, -1.19, 0], .009, 'gold');
  }
  function bamboo(p, at) {
    const g = group('Bamboo and blossoms', p, at); cyl(g, .35, .45, [0, .225, 0], 'cream', .44); cyl(g, .42, .045, [0, .45, 0], 'gold');
    for (let i = 0; i < 3; i++) {
      const x = (i - 1) * .18, h = [2.2, 2.65, 2.35][i]; beam(g, [x, .47, 0], [x, h, .02], .043, 'jade');
      for (let y = .8; y < h; y += .38) cyl(g, .053, .025, [x, y, 0], 'jadeDeep');
      for (let j = 0; j < 4; j++) { const a = i * 1.7 + j * 2.2, end = [x + Math.cos(a) * .45, h - j * .16, Math.sin(a) * .33]; beam(g, [x, h - j * .16 - .09, 0], end, .012, 'jadeDeep'); const leaf = orb(g, .19, end, 'jade', [.34, .16, 1.4]); leaf.rotation.y = a + Math.PI / 2; }
    }
    for (let i = 0; i < 3; i++) { const x = -.24 + i * .25; beam(g, [x, .45, .15], [x + .1, .86, .18], .013, 'jadeDeep'); for (let j = 0; j < 5; j++) { const a = j / 5 * Math.PI * 2; orb(g, .055, [x + .1 + Math.cos(a) * .06, .86 + Math.sin(a) * .06, .18], 'pink', [1, 1, .5]); } orb(g, .028, [x + .1, .86, .21], 'gold'); }
  }
  // Honey timber grain and a subtle woven cloth texture keep the large surfaces tactile.
  function texture(draw) { const c = document.createElement('canvas'); c.width = c.height = 256; draw(c.getContext('2d')); const map = new T.CanvasTexture(c); map.colorSpace = T.SRGBColorSpace; return map; }
  const wood = texture(c => { c.fillStyle = '#fffaf0'; c.fillRect(0, 0, 256, 256); for (let i = 0; i < 65; i++) { c.strokeStyle = `rgba(105,68,35,${.03 + i % 3 * .012})`; c.beginPath(); for (let j = 0; j < 20; j++) { const x = i * 4 + Math.sin(i + j * .3) * 1.4; j ? c.lineTo(x, j * 14) : c.moveTo(x, 0); } c.stroke(); } });
  const weave = texture(c => { c.fillStyle = '#fffaf0'; c.fillRect(0, 0, 256, 256); c.fillStyle = '#e6dcd3'; for (let i = 0; i < 256; i += 4) { c.fillRect(i, 0, .7, 256); c.fillRect(0, i, 256, .7); } });
  for (const name of ['timber', 'honey', 'paleWood']) mats[name].map = wood;
  for (const name of ['red', 'redLight', 'redDeep']) mats[name].map = weave;

  const stage = group('Rounded festival stage and broad audience steps');
  box(stage, [13.2, .47, 9.0], [0, .13, 0], 'timber', .16);
  box(stage, [13.1, .18, 8.9], [0, .445, 0], 'gold', .08);
  for (let i = 0; i < 32; i++) box(stage, [.392, .09, 8.65], [-6.2 + i * .4, .58, 0], i % 5 === 0 ? 'paleWood' : 'honey', .012);
  for (const [z, y, w] of [[4.85, .4, 4.1], [5.25, .22, 4.55], [5.65, .04, 5.0]]) box(stage, [w, .17, .72], [0, y, z], 'paleWood');
  // Red apron and small gold tassels, with the entrance kept free.
  for (const side of [-1, 1]) {
    box(stage, [4.1, .34, .045], [side * 4.45, .24, 4.51], 'red');
    for (let i = 0; i < 10; i++) { const x = side * 4.45 - 1.8 + i * .4; orb(stage, .025, [x, .27, 4.55], 'gold'); beam(stage, [x, .19, 4.55], [x, .09, 4.55], .008, 'gold'); }
  }
  plaque(stage, 'A LITTLE CELEBRATION', [0, .27, 4.59], 2.65, .24);
  // Raised band riser: the musicians remain visible behind the long, low costume.
  const riser = group('Rear band riser', stage, [0, .625, -2.2]);
  box(riser, [10.7, .34, 2.75], [0, .17, 0], 'jadeDeep', .09);
  box(riser, [10.85, .07, 2.85], [0, .375, 0], 'paleWood');
  box(riser, [9.7, .015, 2.26], [0, .42, 0], 'jadeLight', .006);
  for (const x of [-5.05, 5.05]) box(stage, [.6, .18, .6], [x, .73, -.65], 'paleWood');

  const backdrop = group('Festival arch, fan, lanterns, and bunting');
  for (const x of [-5.75, 5.75]) {
    cyl(backdrop, .23, .19, [x, .72, -3.65], 'jadeDeep');
    cyl(backdrop, .13, 4.35, [x, 2.92, -3.65], 'timber');
    for (const y of [1.05, 2.0, 3.0, 4.0]) cyl(backdrop, .15, .035, [x, y, -3.65], 'gold');
    flame(backdrop, [x, 5.05, -3.65], [.6, .65, 1], 'gold', x < 0 ? -.25 : .25);
  }
  tube(backdrop, [[-5.8, 4.9, -3.65], [-4.5, 5.45, -3.65], [0, 5.72, -3.65], [4.5, 5.45, -3.65], [5.8, 4.9, -3.65]], .15, 'jadeDeep', 48);
  tube(backdrop, [[-5.8, 4.96, -3.62], [-4.5, 5.52, -3.62], [0, 5.79, -3.62], [4.5, 5.52, -3.62], [5.8, 4.96, -3.62]], .025, 'gold', 48);
  plaque(backdrop, 'THE BAMBOO FESTIVAL', [0, 5.13, -3.4], 4.6, .49, 'jadeDeep');
  // A folded half-fan backdrop, not a wall around the performance.
  const fan = group('Folded festival fan', backdrop, [0, 1.17, -3.48]);
  const fanShape = new T.Shape(); fanShape.moveTo(-3.02, 0); fanShape.absarc(0, 0, 3.02, Math.PI, 0, true); fanShape.lineTo(-3.02, 0);
  mesh(fan, new T.ExtrudeGeometry(fanShape, { depth: .06, bevelEnabled: true, bevelSize: .02, bevelThickness: .02, bevelSegments: 2, curveSegments: 48 }), 'cream');
  for (let i = 0; i <= 18; i++) { const a = i / 18 * Math.PI; beam(fan, [0, 0, .1], [Math.cos(a) * 2.98, Math.sin(a) * 2.98, .1], .017, i % 3 === 0 ? 'redLight' : 'gold'); }
  const fanEdge = ring(fan, 3.02, .055, [0, 0, .09], 'gold');
  // Remove the lower half of the ring with an actual half arc.
  fan.remove(fanEdge); mesh(fan, new T.TorusGeometry(3.02, .055, 8, 64, Math.PI), 'gold', [0, 0, .09]);
  const garland = [[-5.65, 4.78, -3.05], [-3.2, 4.18, -3.05], [0, 3.99, -3.05], [3.2, 4.18, -3.05], [5.65, 4.78, -3.05]];
  tube(backdrop, garland, .015, 'gold', 40);
  for (const [x, y, scale] of [[-5, 4.58, 1], [-3.6, 4.25, .75], [3.6, 4.25, .75], [5, 4.58, 1]]) lantern(backdrop, [x, y, -3.02], scale);
  for (let i = 0; i < 9; i++) {
    const x = -2.8 + i * .7, y = 4.0 + .18 * (x / 2.8) ** 2;
    const shape = new T.Shape(); shape.moveTo(-.18, 0); shape.lineTo(.18, 0); shape.lineTo(0, -.34); shape.closePath();
    const m = mesh(backdrop, new T.ShapeGeometry(shape), i % 2 ? 'gold' : 'red', [x, y, -3.04]); m.material.side = T.DoubleSide;
  }
  bamboo(root, [-5.95, .625, -2.8]); bamboo(root, [5.95, .625, 3.15]);

  // The costume is one continuous woven canopy with a flared skirt, not stacked body spheres.
  const costume = group('Panda-carried red and gold dragon costume');
  const cloth = group('Continuous cloth canopy and scalloped hem', costume);
  const vertices = [], clothIndices = [], rows = 90, cols = 24;
  function clothAt(t, u) {
    const c = dragonPath(t), theta = u * Math.PI;
    return [c.x, c.y + .72 * Math.sin(theta), c.z + .83 * Math.cos(theta)];
  }
  for (let i = 0; i <= rows; i++) for (let j = 0; j <= cols; j++) {
    vertices.push(...clothAt(i / rows, j / cols));
    if (i < rows && j < cols) { const k = i * (cols + 1) + j; clothIndices.push(k, k + cols + 1, k + 1, k + 1, k + cols + 1, k + cols + 2); }
  }
  const canopy = new T.BufferGeometry(); canopy.setAttribute('position', new T.Float32BufferAttribute(vertices, 3)); canopy.setIndex(clothIndices); canopy.computeVertexNormals();
  const fabric = mats.red.clone(); fabric.side = T.DoubleSide;
  // UVs follow the length of the cloth, keeping the woven texture continuous.
  const uv = []; for (let i = 0; i <= rows; i++) for (let j = 0; j <= cols; j++) uv.push(i / rows * 4, j / cols);
  canopy.setAttribute('uv', new T.Float32BufferAttribute(uv, 2)); mesh(cloth, canopy, fabric);
  const hemAt = (t, side) => { const c = dragonPath(t); return [c.x, 1.08 + .07 * Math.cos(t * Math.PI * 3) + .045 * Math.cos(t * Math.PI * 20), c.z + side * (.86 + .035 * Math.sin(t * Math.PI * 24))]; };
  const skirtAt = (t, v, side) => {
    const top = clothAt(t, side === 1 ? 0 : 1), hem = hemAt(t, side);
    return [top[0], T.MathUtils.lerp(top[1], hem[1], v), T.MathUtils.lerp(top[2], hem[2], v) + side * .045 * Math.sin(t * Math.PI * 32) * Math.sin(v * Math.PI)];
  };
  for (const side of [-1, 1]) {
    const points = [], skirtIndices = [], skirtUV = [];
    for (let i = 0; i <= rows; i++) {
      const t = i / rows;
      for (let j = 0; j <= 6; j++) {
        points.push(...skirtAt(t, j / 6, side)); skirtUV.push(t * 5, 1 - j / 6);
        if (i < rows && j < 6) { const k = i * 7 + j; skirtIndices.push(k, k + 7, k + 1, k + 1, k + 7, k + 8); }
      }
    }
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(points, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(skirtUV, 2)); g.setIndex(skirtIndices); g.computeVertexNormals();
    const mat = mats.redDeep.clone(); mat.side = T.DoubleSide; mesh(cloth, g, mat);
    tube(cloth, Array.from({ length: 101 }, (_, i) => hemAt(i / 100, side)), .035, 'gold', 100);
    tube(cloth, Array.from({ length: 101 }, (_, i) => { const p = skirtAt(i / 100, .78, side); p[2] += side * .012; return p; }), .016, 'goldLight', 100);
    for (let i = 0; i < 20; i++) {
      const t = (i + .5) / 20, at = hemAt(t, side); beam(cloth, [at[0], at[1] - .02, at[2]], [at[0], at[1] - .13, at[2]], .012, 'gold');
      // Small gold cloth diamonds sit above the hem, breaking up the red side panel.
      const p = skirtAt(t, .53, side); p[2] += side * .02;
      const badge = box(cloth, [.075, .075, .018], p, 'gold', .006); badge.rotation.z = Math.PI / 4;
    }
  }
  // Sewn scallop scales flow along the same cloth surface, with no body segmentation.
  for (let row = 0; row < 5; row++) for (let i = 0; i < 17; i++) {
    const t = .025 + (i + row % 2 * .45) / 18, u = .11 + row * .19;
    if (t > .98) continue;
    const pts = Array.from({ length: 9 }, (_, j) => { const a = j / 8 * Math.PI, p = clothAt(t + Math.cos(a) * .020, u + Math.sin(a) * .05); p[1] += .012; return p; });
    tube(cloth, pts, .010, 'goldLight', 12);
  }
  for (let i = 0; i < 12; i++) {
    const c = dragonPath(.04 + i / 12 * .92); flame(cloth, [c.x, c.y + .66, c.z], [.48, .33 + i % 3 * .035, 1], i % 2 ? 'gold' : 'redLight', Math.PI / 2);
  }
  // End drapes close the costume around its carriers, leaving the feet below the hem.
  for (const t of [0, 1]) {
    const c = dragonPath(t), hem = hemAt(t, 1)[1], profile = new T.Shape();
    profile.moveTo(-.83, hem); profile.lineTo(.83, hem); profile.lineTo(.83, c.y);
    profile.absellipse(0, c.y, .83, .72, 0, Math.PI, false, 0); profile.lineTo(-.83, hem); profile.closePath();
    const cap = mesh(cloth, new T.ShapeGeometry(profile, 32), fabric, [c.x, 0, c.z]); cap.rotation.y = Math.PI / 2;
  }
  // A long, tapered fabric tail with a three-flame gold tip.
  const end = dragonPath(1), tailPoints = [end, new T.Vector3(3.55, 2.1, 1.08), new T.Vector3(4.12, 2.28, .70), new T.Vector3(4.65, 2.65, .57)];
  const tailCurve = new T.CatmullRomCurve3(tailPoints), tailGeometry = new T.TubeGeometry(tailCurve, 36, 1, 20, false), positions = tailGeometry.attributes.position;
  // TubeGeometry's unit-radius cross-sections taper continuously to the tip.
  for (let i = 0; i <= 36; i++) {
    const t = i / 36, c = tailCurve.getPointAt(t), radius = .69 * (1 - t) + .065;
    for (let j = 0; j <= 20; j++) { const index = i * 21 + j, p = new T.Vector3().fromBufferAttribute(positions, index).sub(c).multiplyScalar(radius).add(c); positions.setXYZ(index, p.x, p.y, p.z); }
  }
  tailGeometry.computeVertexNormals(); mesh(cloth, tailGeometry, 'red');
  for (const [dy, dz, s] of [[0, 0, .72], [.18, -.15, .48], [-.1, .19, .48]]) flame(cloth, [4.55, 2.5 + dy, .57 + dz], [.65, s, 1], 'gold', -Math.PI / 2);
  // Gold stripes run down the taper, echoing the sewn scales.
  for (const side of [-1, 1]) tube(cloth, [[3.08, 2.34, end.z + side * .5], [3.6, 2.40, 1.08 + side * .35], [4.15, 2.49, .70 + side * .18], [4.6, 2.69, .57]], .021, 'gold');

  // A broad expressive dragon head: long muzzle, antler horns, ears, mane, whiskers and beard.
  const head = group('Friendly horned dragon head', costume, [-3.12, 2.43, 1.52]); head.rotation.y = -Math.PI / 2;
  const mane = group('Layered golden flame mane', head, [0, .02, -.35]);
  for (let i = 0; i < 13; i++) {
    const a = (i / 12 * 1.7 + .15) * Math.PI, x = Math.cos(a) * .68, y = Math.sin(a) * .63;
    const f = flame(mane, [x, y - .15, -.06], [.5, .56 + i % 3 * .04, .9], i % 2 ? 'goldLight' : 'gold'); f.rotation.z = a - Math.PI / 2;
  }
  orb(head, .68, [0, .12, .05], 'red', [1.04, .94, 1.18]);
  orb(head, .48, [0, -.12, .79], 'redLight', [1.18, .60, 1.30]);
  // Lower jaw and dark smiling mouth are visibly separated from the long snout.
  orb(head, .46, [0, -.46, .84], 'gold', [1.14, .28, 1.25]);
  orb(head, .43, [0, -.29, .91], 'mouth', [1.18, .15, 1.20]);
  orb(head, .36, [0, -.40, 1.01], 'redLight', [.85, .12, 1]);
  for (const x of [-.37, .37]) orb(head, .09, [x, -.31, 1.08], 'cream', [.7, .9, .7]);
  orb(head, .30, [0, -.01, 1.24], 'gold', [1.45, .67, .65]);
  for (const x of [-.24, .24]) {
    orb(head, .065, [x, .055, 1.38], 'redDeep', [1, .65, .45]);
    tube(head, [[x * .85, -.04, 1.42], [x * 1.6, -.11, 1.45], [x * 2.05, -.03, 1.38]], .023, 'goldLight');
  }
  for (const [side, sign] of [['L', 1], ['R', -1]]) {
    const eye = group('Curious ' + side + ' dragon eye', head, [sign * .53, .36, .40]); eye.rotation.y = sign * .38;
    orb(eye, .27, [0, 0, 0], 'gold', [1, 1.04, .62]); orb(eye, .225, [0, .008, .11], 'cream', [1, 1.05, .48]);
    orb(eye, .12, [-sign * .025, -.015, .21], 'ink', [.82, 1.08, .55]); orb(eye, .038, [-sign * .055, .04, .263], 'cream');
    tube(head, [[sign * .27, .60, .43], [sign * .54, .70, .48], [sign * .77, .57, .33]], .065, 'gold');
    const ear = flame(head, [sign * .64, .38, -.12], [.67, .65, 1], 'redLight'); ear.rotation.z = -sign * .6;
    const inner = flame(head, [sign * .64, .42, -.07], [.37, .44, .65], 'gold'); inner.rotation.z = -sign * .6;
    // Branched antler-like horns make the silhouette unmistakably dragon-shaped.
    tube(head, [[sign * .35, .65, -.10], [sign * .43, .99, -.22], [sign * .55, 1.21, -.38], [sign * .51, 1.48, -.45]], .062, 'goldLight');
    tube(head, [[sign * .44, 1.04, -.24], [sign * .73, 1.12, -.24], [sign * .85, 1.31, -.29]], .045, 'goldLight');
    orb(head, .063, [sign * .51, 1.48, -.45], 'goldLight'); orb(head, .046, [sign * .85, 1.31, -.29], 'goldLight');
    // Long pale whiskers curl away from the muzzle instead of reading as extra legs.
    tube(head, [[sign * .40, -.09, 1.18], [sign * .86, -.14, 1.15], [sign * 1.13, .02, .89], [sign * 1.04, .23, .68]], .029, 'cream', 32);
    tube(head, [[sign * .43, -.36, .73], [sign * .61, -.60, .79], [sign * .46, -.88, .93]], .035, 'goldLight');
  }
  // Cloth beard: three curved tapered strips beneath the chin.
  for (let i = -1; i <= 1; i++) tube(head, [[i * .14, -.49, .94], [i * .21, -.77, 1.04], [i * .13 + .03, -1.01, 1.14]], .047, i === 0 ? 'gold' : 'goldLight');
  // A little forehead medallion ties the warm dragon back to the jade garden.
  orb(head, .12, [0, .65, .58], 'gold', [1, 1, .28]); orb(head, .075, [0, .65, .62], 'jadeDeep', [1, 1, .25]);

  const instruments = group('The little festival band');
  const drum = group('Red barrel drum and low timber cradle', instruments, [-3.5, 1.04, -.55]);
  // Lathed barrel, taut cream skin, gold bands and individually placed studs.
  const profile = [[.40, .21], [.48, .28], [.54, .48], [.55, .62], [.49, .88]].map(p => new T.Vector2(...p));
  mesh(drum, new T.LatheGeometry(profile, 40), 'red'); cyl(drum, .49, .045, [0, .90, 0], 'cream');
  for (const y of [.27, .86]) { const r = ring(drum, .49, .03, [0, y, 0], 'gold'); r.rotation.x = Math.PI / 2; }
  for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; for (const y of [.31, .82]) orb(drum, .022, [Math.sin(a) * .50, y, Math.cos(a) * .50], 'gold'); }
  for (const x of [-.4, .4]) { beam(drum, [x, .03, -.36], [x, .34, .30], .045, 'timber'); beam(drum, [x, .03, .36], [x, .34, -.30], .045, 'timber'); }
  // A double-sided bronze gong in a bamboo frame, placed beside its panda.
  const gong = group('Bronze gong in a red-and-gold bamboo frame', instruments, [4.12, 1.04, -.83]);
  for (const x of [-.85, .85]) { beam(gong, [x, .06, 0], [x, 2.22, 0], .06, 'red'); box(gong, [.38, .07, .48], [x, .035, 0], 'honey'); }
  beam(gong, [-1.02, 2.21, 0], [1.02, 2.21, 0], .08, 'gold');
  const bronze = mats.gold.clone(); bronze.roughness = .58; bronze.metalness = .42;
  const gongDisc = cyl(gong, .65, .055, [0, 1.27, 0], bronze); gongDisc.rotation.x = Math.PI / 2;
  ring(gong, .59, .028, [0, 1.27, .043], 'goldLight'); orb(gong, .19, [0, 1.27, .059], 'gold', [1, 1, .45]);
  for (const x of [-.37, .37]) beam(gong, [x, 1.81, 0], [x, 2.19, 0], .015, 'redDeep');
  for (const x of [-.97, .97]) { orb(gong, .045, [x, 2.15, .06], 'red'); for (const dx of [-.03, 0, .03]) beam(gong, [x + dx, 2.1, .06], [x + dx, 1.85, .06], .008, 'gold'); }
  // A spare folded fan and little bao-shaped lucky charm beside the band.
  const lucky = group('Easter egg — a festival bao with a tiny drum', root, [-5.12, .84, -.66]);
  orb(lucky, .17, [0, 0, 0], 'cream', [1, .8, 1]);
  for (const x of [-.05, .05]) orb(lucky, .013, [x, .02, .16], 'ink');
  tube(lucky, [[-.04, -.03, .155], [0, -.05, .17], [.04, -.03, .155]], .006, 'ink', 8);
  cyl(lucky, .10, .09, [0, -.09, .23], 'red'); cyl(lucky, .105, .012, [0, -.04, .23], 'goldLight');
  beam(lucky, [-.11, 0, .12], [-.04, .04, .27], .012, 'timber');

  // Batch static assemblies by material, retaining independent costume/arch visibility.
  root.updateMatrixWorld(true);
  const assemblies = [stage, backdrop, cloth, head, instruments, lucky, ...root.children.filter(g => g.name === 'Bamboo and blossoms')];
  for (const assembly of assemblies) {
    const batches = new Map(), inverse = assembly.matrixWorld.clone().invert(), old = [];
    assembly.traverse(node => {
      if (!node.isMesh) return;
      const g = node.geometry.index ? node.geometry.toNonIndexed() : node.geometry.clone(); g.applyMatrix4(inverse.clone().multiply(node.matrixWorld));
      // Every batch uses the same attributes, even hand-built cloth surfaces.
      if (!g.attributes.uv) g.setAttribute('uv', new T.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      const cast = castsShadow(node), key = node.material.uuid + (cast ? ':cast' : ''), batch = batches.get(key) || { material: node.material, cast, parts: [] }; batch.parts.push(g); batches.set(key, batch); old.push(node);
    });
    for (const node of old) node.removeFromParent();
    for (const { material, cast, parts } of batches.values()) { const merged = mergeGeometries(parts, false); const m = mesh(assembly, merged, material); m.name = `${assembly.name} · material batch`; m.castShadow = cast; m.receiveShadow = true; m.userData.noShadow = !cast; parts.forEach(g => g.dispose()); }
  }
  const retained = new Set(); root.traverse(node => { if (node.geometry) retained.add(node.geometry); });
  for (const g of sources) if (!retained.has(g)) g.dispose();
  function dispose() {
    const geometries = new Set(), materials = new Set(Object.values(mats)), textures = new Set([wood, weave]);
    root.traverse(node => { if (node.geometry) geometries.add(node.geometry); if (node.material) materials.add(node.material); });
    for (const mat of materials) { for (const v of Object.values(mat)) if (v?.isTexture) textures.add(v); mat.dispose(); }
    textures.forEach(t => t.dispose()); geometries.forEach(g => g.dispose()); root.removeFromParent();
  }
  const carrierPositions = [.08, .49, .88].map(t => { const c = dragonPath(t); return [c.x, .635, c.z]; });
  return { root, stage, backdrop, costume, head, cloth, instruments, carrierPositions, dispose,
    musicians: [
      { id: 'drummer', position: [-3.5, 1.055, -1.76], yaw: 0, color: colors.red },
      { id: 'cymbals', position: [0, 1.055, -2.0], yaw: 0, color: colors.jadeDeep },
      { id: 'gong', position: [2.75, 1.055, -1.85], yaw: .45, color: colors.redLight },
    ],
    setBackdropVisible(visible) { backdrop.visible = visible; },
    setCostumeLifted(lifted) { costume.position.y = lifted ? 2.45 : 0; },
    pose(time) { head.rotation.z = .025 * Math.sin(time * 2.2); },
  };
}
