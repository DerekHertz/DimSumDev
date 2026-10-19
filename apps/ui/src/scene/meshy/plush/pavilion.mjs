/** Standalone appearance study: a shared home for Developer + Scout.
 * +Y up, +Z entrance. Owns architecture/furniture only; no scene, lights or pandas.
 */
import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { castsShadow } from './garden-kit.mjs';

export const PAVILION_PALETTE = Object.freeze({
  jade: '#79aa8b', jadeDeep: '#39735d', jadeLight: '#b5d1a6', cream: '#fff6df',
  timber: '#af784d', honey: '#d9ac73', paleWood: '#edcea0', ink: '#34574b',
  blue: '#638caf', blueLight: '#bbd4dc', coral: '#d97f66', gold: '#e7bd65',
  sand: '#d4b67b', lilac: '#b7a7c9', tea: '#76523b', glass: '#c3dbc6',
});
export function createPavilion() {
  const root = new T.Group(); root.name = 'Steamers — shared garden pavilion study';
  root.userData = { assetId: 'shared-pavilion-study', reviewOnly: false, entrance: '+Z', roles: ['developer', 'scout'] };
  const colors = PAVILION_PALETTE;
  const materials = Object.fromEntries(Object.entries(colors).map(([name, color]) => [name, new T.MeshStandardMaterial({ color, roughness: .86 })]));
  const grainCanvas = document.createElement('canvas'); grainCanvas.width = grainCanvas.height = 256;
  const grain = grainCanvas.getContext('2d'); grain.fillStyle = '#fffdf4'; grain.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 65; i++) {
    grain.strokeStyle = `rgba(115,77,45,${.035 + i % 3 * .018})`; grain.lineWidth = .7; grain.beginPath();
    for (let j = 0; j <= 24; j++) { const x = i * 4 + Math.sin(j * .4 + i) * 1.5; j ? grain.lineTo(x, j * 11) : grain.moveTo(x, 0); } grain.stroke();
  }
  const wood = new T.CanvasTexture(grainCanvas); wood.colorSpace = T.SRGBColorSpace;
  for (const key of ['timber', 'honey', 'paleWood']) materials[key].map = wood;
  const primitives = new Map();
  const cached = (key, factory) => { if (!primitives.has(key)) primitives.set(key, factory()); return primitives.get(key); };
  function group(name, parent = root, at = [0, 0, 0]) { const g = new T.Group(); g.name = name; g.position.fromArray(at); parent.add(g); return g; }
  function mesh(parent, geometry, color, at = [0, 0, 0]) {
    const m = new T.Mesh(geometry, materials[color] || color); m.position.fromArray(at); parent.add(m); return m;
  }
  function box(parent, size, at, color, radius = .055) {
    const r = Math.min(radius, ...size.map(v => v * .24)), key = `box:${size}:${r}`;
    return mesh(parent, cached(key, () => new RoundedBoxGeometry(...size, 2, r)), color, at);
  }
  function cyl(parent, r, h, at, color, top = r) { return mesh(parent, cached(`c:${r}:${top}:${h}`, () => new T.CylinderGeometry(top, r, h, 20)), color, at); }
  function orb(parent, r, at, color, scale = [1, 1, 1]) { const m = mesh(parent, cached(`s:${r}`, () => new T.SphereGeometry(r, 20, 12)), color, at); m.scale.fromArray(scale); return m; }
  function beam(parent, a, b, r, color) {
    const start = new T.Vector3(...a), end = new T.Vector3(...b), m = cyl(parent, r, start.distanceTo(end), start.clone().add(end).multiplyScalar(.5).toArray(), color);
    m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), end.sub(start).normalize()); return m;
  }
  function tube(parent, points, r, color, segments = 24) { return mesh(parent, new T.TubeGeometry(new T.CatmullRomCurve3(points.map(p => new T.Vector3(...p))), segments, r, 6, false), color); }
  function ring(parent, r, t, at, color) { return mesh(parent, cached(`ring:${r}:${t}`, () => new T.TorusGeometry(r, t, 8, 32)), color, at); }
  function panel(parent, size, at, draw) {
    const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = Math.round(768 * size[1] / size[0]);
    draw(canvas.getContext('2d'), canvas.width, canvas.height);
    const map = new T.CanvasTexture(canvas); map.colorSpace = T.SRGBColorSpace; map.anisotropy = 4;
    return mesh(parent, new T.PlaneGeometry(...size), new T.MeshStandardMaterial({ map, roughness: .9 }), at);
  }
  function sign(parent, text, at, width, color = 'jadeDeep') {
    box(parent, [width + .14, .41, .1], [at[0], at[1], at[2] - .045], 'paleWood');
    return panel(parent, [width, .30], [at[0], at[1], at[2] + .012], (c, w, h) => {
      c.fillStyle = colors[color]; c.fillRect(0, 0, w, h); c.fillStyle = color === 'sand' ? colors.ink : colors.cream;
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = `600 ${h * .50}px sans-serif`; c.fillText(text, w / 2, h * .53, w - 40);
    });
  }
  function mug(parent, at, color) {
    const g = group('A well-loved tea mug', parent, at); cyl(g, .105, .18, [0, .09, 0], color, .12);
    cyl(g, .104, .008, [0, .184, 0], 'tea'); ring(g, .065, .02, [.135, .09, 0], color); return g;
  }
  function book(parent, at, color, width = .35, height = .5) {
    box(parent, [width, height, .21], at, color, .025);
    box(parent, [width - .05, .035, .012], [at[0], at[1] + height * .21, at[2] + .11], 'gold', .003);
  }
  function lantern(parent, at, color = 'cream') {
    const g = group('Ribbed paper lantern', parent, at);
    beam(g, [0, 0, 0], [0, -.25, 0], .014, 'timber'); orb(g, .28, [0, -.56, 0], color, [1, 1.1, 1]);
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; tube(g, [[Math.cos(a) * .11, -.27, Math.sin(a) * .11], [Math.cos(a) * .282, -.56, Math.sin(a) * .282], [Math.cos(a) * .11, -.86, Math.sin(a) * .11]], .007, 'paleWood', 12); }
    for (const y of [-.27, -.86]) cyl(g, .115, .045, [0, y, 0], 'honey');
    beam(g, [0, -.9, 0], [0, -1.07, 0], .02, 'coral');
  }
  function bamboo(parent, at, scale = 1) {
    const g = group('Bamboo in a rounded stoneware pot', parent, at); g.scale.setScalar(scale);
    cyl(g, .29, .44, [0, .22, 0], 'cream', .38); const lip = ring(g, .36, .025, [0, .44, 0], 'honey'); lip.rotation.x = Math.PI / 2;
    cyl(g, .32, .018, [0, .44, 0], 'tea');
    for (let i = 0; i < 3; i++) {
      const x = (i - 1) * .15, h = [1.65, 2.05, 1.8][i]; beam(g, [x, .43, 0], [x, h, .03], .04, 'jade');
      for (let y = .7; y < h; y += .32) cyl(g, .049, .025, [x, y, 0], 'jadeDeep');
      for (let j = 0; j < 5; j++) { const a = i * 2 + j * 2.1, end = [x + Math.cos(a) * .43, h - j * .15, Math.sin(a) * .3]; beam(g, [x, h - j * .15 - .08, 0], end, .012, 'jadeDeep'); const leaf = orb(g, .18, end, 'jade', [.35, .17, 1.6]); leaf.rotation.y = a + Math.PI / 2; }
    }
  }

  const deck = group('Low timber deck and broad entrance steps');
  box(deck, [12, .29, 8.2], [0, .025, 0], 'timber', .13);
  box(deck, [11.85, .13, 8.05], [0, .235, 0], 'honey');
  for (let i = 0; i < 29; i++) {
    const x = -5.6 + i * .4; box(deck, [.388, .08, 7.8], [x, .34, 0], i % 5 === 0 ? 'paleWood' : 'honey', .014);
    for (const z of [-3.55, 3.55]) cyl(deck, .014, .008, [x, .383, z], 'timber');
  }
  for (const [z, y, w] of [[4.32, .20, 4.3], [4.75, .05, 4.8]]) box(deck, [w, .16, .75], [0, y, z], 'paleWood');
  // A clear central approach; personal work areas are kept in the two side bays.
  box(deck, [2.15, .015, 6.7], [0, .39, -.1], 'jadeLight', .007);
  for (const x of [-.99, .99]) box(deck, [.03, .009, 6.5], [x, .402, -.1], 'cream', .002);
  for (let i = 0; i < 7; i++) {
    const petal = orb(deck, .07, [Math.sin(i * 2.4) * .24, .405, 2.5 - i * .62], 'cream', [1, .06, 1.35]); petal.rotation.y = i;
  }
  const frame = group('Rounded timber frame — open on three sides');
  for (const x of [-5.35, 5.35]) for (const z of [-3.3, 3.3]) {
    cyl(frame, .21, .18, [x, .48, z], 'jadeDeep', .18);
    cyl(frame, .125, 4.18, [x, 2.66, z], 'timber');
    cyl(frame, .16, .1, [x, .66, z], 'honey');
    box(frame, [.46, .18, .44], [x, 4.61, z], 'paleWood');
    tube(frame, [[x - Math.sign(x) * .82, 4.65, z], [x - Math.sign(x) * .5, 4.53, z], [x - Math.sign(x) * .18, 4.23, z], [x, 4.16, z]], .062, 'honey');
    const peg = cyl(frame, .045, .025, [x, 4.35, z + Math.sign(z) * .14], 'gold'); peg.rotation.x = Math.PI / 2;
  }
  for (const z of [-3.3, 3.3]) box(frame, [10.95, .23, .24], [0, 4.61, z], 'timber');
  for (const x of [-5.35, 5.35]) box(frame, [.24, .22, 6.7], [x, 4.61, 0], 'timber');
  // Rear half-wall, bamboo lattice, and low side rails keep the silhouette airy.
  box(frame, [10.7, .73, .16], [0, .78, -3.3], 'jadeLight');
  for (const x of [-5.2, -1.2, 1.2, 5.2]) cyl(frame, .07, 2.02, [x, 1.42, -3.3], 'honey');
  for (const side of [-1, 1]) {
    box(frame, [3.85, .09, .17], [side * 3.25, 2.35, -3.3], 'honey');
    for (let i = 0; i < 9; i++) {
      const x = side * 3.25 - 1.65 + i * .41;
      beam(frame, [x, 1.2, -3.3], [x, 2.3, -3.3], .022, 'honey');
    }
    for (const y of [1.45, 1.82, 2.18]) beam(frame, [side * 3.25 - 1.88, y, -3.3], [side * 3.25 + 1.88, y, -3.3], .019, 'paleWood');
    for (const z of [-2.5, -.9, .7]) cyl(frame, .045, .73, [side * 5.35, .76, z], 'jadeDeep');
    beam(frame, [side * 5.35, 1.13, -3.3], [side * 5.35, 1.13, 1.4], .06, 'honey');
  }
  sign(frame, 'STEAMERS', [0, 4.26, 3.5], 2.45);
  for (const x of [-4.35, 4.35]) lantern(frame, [x, 4.57, 3.32]);
  // A tiny bamboo wind chime hangs by the entrance.
  const chime = group('Bamboo wind chime', frame, [1.75, 4.57, 3.28]);
  beam(chime, [0, 0, 0], [0, -.3, 0], .012, 'timber'); cyl(chime, .16, .08, [0, -.32, 0], 'jade');
  for (let i = 0; i < 5; i++) { const a = i * Math.PI * 2 / 5, x = Math.cos(a) * .13, z = Math.sin(a) * .13, h = .28 + i % 3 * .07; beam(chime, [x, -.35, z], [x, -.56 - h, z], .025, 'paleWood'); }

  const roof = group('Lift-off jade tiled roof — attached to the timber frame');
  const roofY = (x, z) => 4.48 + 1.02 * (1 - Math.abs(z) / 4.4) + .30 * (Math.abs(z) / 4.4) ** 8 + .22 * (Math.abs(x) / 6.4) ** 8;
  const verts = [], indices = [], nx = 48, nz = 32;
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
    const x = (i / nx - .5) * 12.8, z = (j / nz - .5) * 8.8; verts.push(x, roofY(x, z), z);
    if (i < nx && j < nz) { const k = j * (nx + 1) + i; indices.push(k, k + nx + 1, k + 1, k + 1, k + nx + 1, k + nx + 2); }
  }
  const geometry = new T.BufferGeometry(); geometry.setAttribute('position', new T.Float32BufferAttribute(verts, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
  const underside = materials.jade.clone(); underside.side = T.DoubleSide; mesh(roof, geometry, underside);
  // Tile sheets are real rounded barrel surfaces, batched at the end rather than hundreds of draw calls.
  const tones = [materials.jade, materials.jade.clone(), materials.jade.clone()];
  tones[1].color.lerp(new T.Color(colors.jadeLight), .22); tones[2].color.lerp(new T.Color(colors.jadeDeep), .15);
  for (const mat of tones) mat.side = T.DoubleSide;
  const tiles = [[], [], []];
  for (const side of [-1, 1]) for (let row = 0; row < 8; row++) for (let col = 0; col < 38; col++) {
    const tile = tiles[(col * 7 + row * 3) % 19 < 3 ? 1 : (col + row) % 13 === 0 ? 2 : 0];
    const at = (i, j) => { const x = -6.4 + (col + j / 2) / 38 * 12.8, z = side * Math.min(4.4, (row + i / 2) / 8 * 4.4 + .015); return [x, roofY(x, z) + .02 + .035 * Math.sin(j / 2 * Math.PI) + i * .009, z]; };
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1); tile.push(...a, ...b, ...d, ...b, ...c, ...d); }
  }
  tiles.forEach((positions, i) => { const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(positions, 3)); g.computeVertexNormals(); mesh(roof, g, tones[i]); });
  for (const z of [-4.4, 4.4]) tube(roof, Array.from({ length: 33 }, (_, i) => { const x = (i / 32 - .5) * 12.8; return [x, roofY(x, z) - .02, z]; }), .1, 'jadeDeep');
  for (const x of [-6.4, 6.4]) tube(roof, Array.from({ length: 25 }, (_, i) => { const z = (i / 24 - .5) * 8.8; return [x, roofY(x, z), z]; }), .095, 'jadeDeep');
  tube(roof, [[-6.5, 5.83, 0], [-5, 5.57, 0], [0, 5.56, 0], [5, 5.57, 0], [6.5, 5.83, 0]], .12, 'jadeDeep');
  for (let x = -6.2; x <= 6.2; x += .36) { const cap = cyl(roof, .13, .035, [x, roofY(x, 0) + .03, 0], 'jadeLight'); cap.rotation.z = Math.PI / 2; }
  // Curved rafters physically meet the roof underside and side crossbeams.
  for (const x of [-5.35, -2.68, 0, 2.68, 5.35]) {
    tube(roof, Array.from({ length: 25 }, (_, i) => { const z = (i / 24 - .5) * 8.5; return [x, roofY(x, z) - .1, z]; }), .075, 'paleWood');
  }
  for (const z of [-2.4, 0, 2.4]) {
    const y = roofY(0, z) - .14; box(roof, [10.7, .15, .12], [0, y, z], 'honey');
  }

  const developer = group('Developer — the little makers bench', root, [-3.25, .39, -.65]);
  const scout = group('Scout — the curiosity table', root, [3.25, .39, -.65]);
  // Two patterned wool mats define personal territory, without walling the pandas off.
  for (const [area, accent] of [[developer, 'blueLight'], [scout, 'sand']]) {
    box(area, [3.95, .025, 4.45], [0, .025, .1], accent, .012);
    for (const x of [-1.8, 1.8]) box(area, [.035, .008, 4.18], [x, .043, .1], 'cream', .002);
    for (let i = 0; i < 13; i++) for (const z of [-2.16, 2.36]) beam(area, [-1.7 + i * .28, .035, z], [-1.7 + i * .28, .035, z + Math.sign(z) * .09], .008, 'cream');
  }
  // Developer's deep rounded desktop, drawers and footrest.
  box(developer, [3.25, .18, 1.35], [0, 1.16, -.15], 'paleWood', .09);
  for (const x of [-1.28, 1.28]) for (const z of [-.58, .27]) cyl(developer, .065, 1.03, [x, .58, z], 'timber');
  box(developer, [.75, .71, .95], [1.03, .70, -.15], 'blue');
  for (const y of [.5, .72, .94]) {
    box(developer, [.67, .18, .045], [1.03, y, .35], 'blueLight'); const pull = ring(developer, .042, .012, [1.03, y, .38], 'gold'); pull.scale.x = 1.4;
  }
  beam(developer, [-1.3, .32, .2], [1.3, .32, .2], .045, 'timber');
  // Rounded terminal with readable illustrated code, never a live status display.
  const terminal = group('Rounded coding terminal', developer, [-.40, 1.25, -.43]);
  box(terminal, [.56, .055, .38], [0, .028, 0], 'blue'); box(terminal, [.10, .23, .10], [0, .15, -.07], 'honey');
  box(terminal, [1.43, .94, .16], [0, .69, -.07], 'blue', .075);
  box(terminal, [1.30, .81, .025], [0, .69, .022], 'ink');
  panel(terminal, [1.22, .72], [0, .70, .038], (c, w, h) => {
    c.fillStyle = '#27483e'; c.fillRect(0, 0, w, h); c.fillStyle = colors.jadeLight; c.font = '25px monospace'; c.fillText('a little good work', 30, 42);
    const lines = ['function grow() {', '  plant("bamboo");', '  await aGoodIdea();', '  return somethingNice;', '}'];
    c.font = '29px monospace'; lines.forEach((line, i) => { c.fillStyle = [colors.blueLight, colors.gold, colors.cream, colors.coral, colors.blueLight][i]; c.fillText(line, 35, 100 + i * 40); });
  });
  orb(terminal, .022, [.57, .30, .025], 'gold');
  const keyboard = group('Chunky cream keyboard', developer, [-.35, 1.28, .31]);
  box(keyboard, [1.28, .075, .36], [0, 0, 0], 'blueLight', .03);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 11; col++) box(keyboard, [.085, .027, .07], [-.51 + col * .1, .05, -.11 + row * .1], col === 10 ? 'coral' : 'cream', .008);
  box(developer, [.16, .065, .24], [.46, 1.29, .32], 'cream', .04); mug(developer, [1.13, 1.26, -.23], 'coral');
  tube(developer, [[-.4, 1.45, -.6], [-.65, 1.2, -.9], [-1.1, .2, -.9], [-1.3, .12, -.7]], .015, 'ink');
  // Small wall-free tool rack behind the desk.
  const tools = group('Personal tool rack and things in progress', developer, [-.1, 1.35, -1.92]);
  box(tools, [3.1, 1.4, .11], [0, .75, 0], 'honey');
  for (let x = -1.3; x <= 1.31; x += .26) for (let y = .28; y <= 1.22; y += .23) orb(tools, .014, [x, y, .066], 'timber', [1, 1, .2]);
  for (const x of [-1.05, -.66]) { beam(tools, [x, .42, .13], [x, 1.03, .13], .035, 'blue'); const end = ring(tools, .09, .025, [x, 1.08, .13], 'gold'); end.scale.y = .8; }
  box(tools, [.45, .10, .12], [.05, 1.1, .16], 'blue'); beam(tools, [.05, 1.1, .16], [.05, .56, .16], .034, 'timber');
  box(tools, [3.35, .10, .48], [0, .15, .17], 'paleWood');
  for (let i = 0; i < 4; i++) book(tools, [.67 + i * .17, .45, .17], ['blue', 'coral', 'jade', 'cream'][i], .14, .46 + i % 2 * .1);
  sign(developer, 'DEVELOPER', [0, 2.98, -1.93], 1.85, 'blue');
  // Half-built bamboo rover: four little wheels and a wonky antenna.
  const rover = group('Unfinished bamboo rover — developer keepsake', developer, [-1.25, .165, 1.17]);
  box(rover, [.56, .16, .42], [0, .08, 0], 'jade');
  for (const x of [-.29, .29]) for (const z of [-.18, .18]) { const wheel = cyl(rover, .12, .06, [x, 0, z], 'timber'); wheel.rotation.z = Math.PI / 2; }
  orb(rover, .16, [0, .3, 0], 'cream', [1.15, .8, .9]);
  for (const x of [-.06, .06]) orb(rover, .022, [x, .31, .135], 'ink');
  beam(rover, [0, .40, 0], [.09, .64, .02], .014, 'gold'); orb(rover, .04, [.09, .64, .02], 'coral');

  // Scout's tilted map table has a warm ochre frame and rolled survey edges.
  for (const x of [-1.25, 1.25]) {
    beam(scout, [x, .08, -.78], [x, 1.16, -.47], .07, 'timber'); beam(scout, [x, .08, .73], [x, 1.16, .42], .07, 'timber');
    beam(scout, [x, .3, -.71], [x, .3, .66], .04, 'honey');
  }
  const mapTable = group('Tilted survey map — hand-drawn bamboo trails', scout, [0, 1.27, -.12]); mapTable.rotation.x = .12;
  box(mapTable, [3.25, .13, 1.55], [0, 0, 0], 'paleWood', .075);
  const map = panel(mapTable, [2.69, 1.26], [0, .074, 0], (c, w, h) => {
    c.fillStyle = '#f4e5bc'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#d4c799'; c.lineWidth = 2;
    for (let x = 25; x < w; x += 55) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    for (let y = 25; y < h; y += 55) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    c.strokeStyle = '#a9c5ae'; c.lineWidth = 32; c.beginPath(); c.moveTo(w * .12, 0); c.bezierCurveTo(w * .58, h * .35, w * .12, h * .7, w * .68, h); c.stroke();
    c.strokeStyle = colors.coral; c.lineWidth = 5; c.setLineDash([10, 9]); c.beginPath(); c.moveTo(90, h - 60); c.bezierCurveTo(120, 20, 450, h, w - 100, 80); c.stroke(); c.setLineDash([]);
    for (const [x, y] of [[160, 95], [430, 180], [600, 70], [340, 280]]) { c.fillStyle = colors.jade; c.beginPath(); c.arc(x, y, 16, 0, 7); c.fill(); c.fillStyle = colors.jadeDeep; c.fillRect(x - 3, y - 5, 6, 35); }
    c.strokeStyle = colors.ink; c.lineWidth = 3; c.beginPath(); c.moveTo(w - 55, h - 35); c.lineTo(w - 55, h - 105); c.moveTo(w - 68, h - 84); c.lineTo(w - 55, h - 105); c.lineTo(w - 42, h - 84); c.stroke();
    c.fillStyle = colors.ink; c.font = '21px serif'; c.fillText('N', w - 64, h - 116); c.font = 'italic 22px serif'; c.fillText('a path worth following', 30, h - 20);
  }); map.rotation.x = -Math.PI / 2;
  for (const x of [-1.44, 1.44]) { const roll = cyl(mapTable, .065, 1.30, [x, .13, 0], 'cream'); roll.rotation.x = Math.PI / 2; }
  for (const [x, z, color] of [[-.8, .3, 'coral'], [.5, -.3, 'blue'], [.82, .24, 'gold']]) { cyl(mapTable, .014, .1, [x, .13, z], 'timber'); orb(mapTable, .037, [x, .20, z], color); }
  const compass = group('Pocket compass', mapTable, [.99, .103, .45]); cyl(compass, .13, .045, [0, 0, 0], 'gold'); cyl(compass, .108, .007, [0, .026, 0], 'cream'); const needle = box(compass, [.025, .014, .16], [0, .038, 0], 'coral', .003); needle.rotation.y = .5;
  // Reference shelf with field journals, labeled specimen trays, and small finds.
  const shelf = group('Field collection and reference shelf', scout, [0, .05, -1.95]);
  for (const x of [-1.5, 1.5]) box(shelf, [.11, 2.42, .48], [x, 1.25, 0], 'timber');
  for (const y of [.2, .95, 1.72, 2.49]) box(shelf, [3.16, .10, .65], [0, y, .06], 'paleWood');
  for (let i = 0; i < 6; i++) book(shelf, [-1.12 + i * .21, 1.27, .07], ['jade', 'sand', 'coral', 'cream', 'blue', 'lilac'][i], .18, .44 + i % 3 * .09);
  for (let i = 0; i < 3; i++) {
    box(shelf, [.77, .26, .52], [-.97 + i * .97, .39, .08], 'sand'); box(shelf, [.24, .08, .012], [-.97 + i * .97, .42, .35], 'cream', .005);
    cyl(shelf, .09, .27, [-1.05 + i * .72, 1.9, .08], 'glass', .1); cyl(shelf, .10, .045, [-1.05 + i * .72, 2.06, .08], 'honey');
  }
  // A treasured polished stone, leaf specimen, and binoculars.
  orb(shelf, .16, [1, 1.12, .08], 'lilac', [1.15, .75, .85]);
  const leaf = orb(shelf, .16, [.9, 1.96, .08], 'jade', [.4, 1, .16]); leaf.rotation.z = -.5;
  for (const x of [.72, 1.01]) { const lens = cyl(shelf, .11, .36, [x, 2.67, .06], 'jadeDeep', .13); lens.rotation.x = Math.PI / 2; const rim = ring(shelf, .12, .02, [x, 2.67, .25], 'gold'); }
  beam(shelf, [.72, 2.67, .02], [1.01, 2.67, .02], .045, 'timber');
  sign(scout, 'SCOUT', [0, 2.98, -1.93], 1.65, 'sand');
  const journal = box(mapTable, [.42, .065, .58], [-1.10, .11, .16], 'jadeDeep'); journal.rotation.y = -.2;
  beam(mapTable, [-1.17, .155, -.01], [-.92, .155, .31], .012, 'gold');
  mug(mapTable, [1.20, .09, -.43], 'jade');
  const bag = group('Scout satchel — ready for the next wander', scout, [1.39, .155, 1.18]);
  box(bag, [.55, .46, .28], [0, .12, 0], 'sand', .08); box(bag, [.51, .22, .04], [0, .26, .16], 'honey'); box(bag, [.07, .11, .025], [0, .19, .19], 'gold', .008);
  tube(bag, [[-.24, .29, 0], [-.32, .68, 0], [.26, .7, 0], [.24, .29, 0]], .025, 'timber');

  const shared = group('Shared pinboard, tea shelf, and a little breathing room');
  const board = group('Shared ideas pinboard', shared, [0, 2.31, -3.04]);
  box(board, [2.08, 1.72, .12], [0, 0, 0], 'honey'); box(board, [1.9, 1.54, .025], [0, 0, .073], 'sand');
  sign(board, 'LITTLE IDEAS', [0, .98, .01], 1.8);
  for (const [x, y, color, angle] of [[-.48, .33, 'cream', -.12], [.37, .30, 'blueLight', .1], [-.43, -.36, 'jadeLight', .06], [.47, -.39, 'cream', -.08]]) {
    const note = group('Pinned sketch', board, [x, y, .095]); note.rotation.z = angle;
    box(note, [.63, .51, .012], [0, 0, 0], color, .004); orb(note, .027, [0, .19, .021], 'coral', [1, 1, .5]);
    for (let i = 0; i < 3; i++) box(note, [.37 - i * .07, .012, .006], [-i * .02, .06 - i * .09, .01], 'honey', .002);
  }
  tube(board, [[-.43, .30, .13], [0, .1, .15], [.45, -.35, .13]], .009, 'coral');
  const tea = group('Tea for two', shared, [0, .39, -2.6]);
  box(tea, [1.85, .13, .76], [0, .97, 0], 'paleWood');
  for (const x of [-.76, .76]) for (const z of [-.22, .22]) cyl(tea, .045, .9, [x, .48, z], 'timber');
  const tray = cyl(tea, .43, .025, [0, 1.06, .02], 'honey'); tray.scale.z = .7;
  orb(tea, .18, [0, 1.22, -.04], 'jade', [1.15, .85, 1]); cyl(tea, .1, .035, [0, 1.36, -.04], 'jadeDeep'); orb(tea, .027, [0, 1.4, -.04], 'gold');
  tube(tea, [[.16, 1.20, -.04], [.29, 1.23, -.04], [.32, 1.32, -.04]], .035, 'jade'); ring(tea, .1, .025, [-.23, 1.23, -.04], 'jade');
  mug(tea, [-.62, 1.05, .12], 'blue'); mug(tea, [.62, 1.05, .12], 'sand');
  // A tiny lucky bao hiding under the tea shelf, with a leaf for a hat.
  const secret = group('Easter egg — the tea-shelf lucky bao', shared, [.49, .72, -2.39]);
  orb(secret, .15, [0, 0, 0], 'cream', [1, .8, 1]);
  for (const x of [-.045, .045]) orb(secret, .012, [x, .01, .14], 'ink');
  tube(secret, [[-.035, -.03, .14], [0, -.045, .15], [.035, -.03, .14]], .006, 'ink', 8);
  const hat = orb(secret, .11, [0, .13, .01], 'jade', [1.1, .12, .7]); hat.rotation.z = -.2;
  bamboo(root, [-5.0, .39, 2.72], .78); bamboo(root, [5.0, .39, 2.72], .9);
  for (const side of [-1, 1]) {
    const planter = group('Low garden flowers', root, [side * 4.6, .39, -3.65]);
    box(planter, [1.5, .30, .49], [0, .15, 0], 'cream', .07);
    for (let i = 0; i < 5; i++) {
      const x = -.55 + i * .27, y = .55 + i % 2 * .1; beam(planter, [x, .3, 0], [x, y, 0], .012, 'jadeDeep');
      for (let j = 0; j < 5; j++) { const a = j / 5 * Math.PI * 2; orb(planter, .045, [x + Math.cos(a) * .05, y + Math.sin(a) * .05, .01], i % 2 ? 'coral' : 'cream', [1, 1, .5]); }
      orb(planter, .025, [x, y, .04], 'gold');
    }
  }

  // Batch each assembly independently, preserving roof visibility and personal bay groups.
  // One material batch per assembly keeps detailed scenery cheap enough to orbit.
  root.updateMatrixWorld(true);
  const sourceGeometries = new Set();
  for (const assembly of [...root.children]) {
    const batches = new Map(), inverse = assembly.matrixWorld.clone().invert(), old = [];
    assembly.traverse(node => {
      if (!node.isMesh) return;
      sourceGeometries.add(node.geometry);
      const geometry = node.geometry.index ? node.geometry.toNonIndexed() : node.geometry.clone();
      geometry.applyMatrix4(inverse.clone().multiply(node.matrixWorld));
      const cast = castsShadow(node), key = node.material.uuid + (cast ? ':cast' : ''), batch = batches.get(key) || { material: node.material, cast, parts: [] }; batch.parts.push(geometry); batches.set(key, batch); old.push(node);
    });
    for (const node of old) node.removeFromParent();
    for (const { material, cast, parts } of batches.values()) {
      const merged = mergeGeometries(parts, false); const m = mesh(assembly, merged, material); m.name = `${assembly.name} · material batch`; m.castShadow = cast; m.receiveShadow = true; m.userData.noShadow = !cast;
      for (const part of parts) part.dispose();
    }
  }
  for (const g of sourceGeometries) g.dispose();
  function dispose() {
    const geometries = new Set(), mats = new Set(Object.values(materials)), textures = new Set([wood]);
    root.traverse(node => { if (node.geometry) geometries.add(node.geometry); if (node.material) mats.add(node.material); });
    for (const m of mats) { for (const value of Object.values(m)) if (value?.isTexture) textures.add(value); m.dispose(); }
    for (const t of textures) t.dispose(); for (const g of geometries) g.dispose(); root.removeFromParent();
  }
  return { root, roof, developer, scout, deck, frame, shared, dispose,
    residents: { developer: { position: [-3.2, .41, 1.45], yaw: .15 }, scout: { position: [3.2, .41, 1.45], yaw: -.17 } },
    setRoofVisible(visible) { roof.visible = visible; },
  };
}
