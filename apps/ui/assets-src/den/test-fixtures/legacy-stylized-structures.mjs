import * as T from 'three';
import {dragon} from '../../../src/scene/meshy/garden.mjs';
import {craftedPalette, box, cyl, orb, line, ring, roundedDisc, lantern, lattice,
  timberFrame, craftedRoof as roof, bakeCrafted as bake} from '../../../src/scene/meshy/crafted-architecture.mjs';

// Author directly in walking-world units. +Z is the public/front approach;
// kiosks also have an unobstructed entrance on their right (+X) side.
export const STYLIZED_STRUCTURE_IDS = Object.freeze([
  'center', 'steamers', 'front', 'tea', 'pantry', 'pavilion', 'games',
  'training', 'festival', 'dining', 'dragon', 'library', 'gate',
]);

const bounds = (min, max) => ({min, max});
function platform(g, m, w, d, y) {
  box(g, [w, y - .06, d], m.stone, [0, (y - .06) / 2, 0], .045);
  box(g, [w - .05, .042, d - .05], m.wood, [0, y - .039, 0], .016);
  const count = Math.round(w / .40), spacing = (w - .15) / count;
  for (let i = 0; i < count; i++)
    box(g, [spacing - .012, .018, d - .12], i % 4 === 0 ? m.bamboo : m.wood,
      [-w / 2 + .075 + spacing * (i + .5), y - .009, 0], .005);
}

function step(g, m, meta, size, at) {
  box(g, size, m.stone, at);
  meta.steps.push({...bounds(at.map((v, i) => v - size[i] / 2), at.map((v, i) => v + size[i] / 2)), top: at[1] + size[1] / 2});
}

function frontSteps(g, m, meta, edge, width, rise = meta.floorY) {
  const count = Math.ceil(rise / .2);
  // Broad, flat treads overlap the platform edge so there is no tiny gap.
  for (let i = 1; i < count; i++) {
    const top = rise * (count - i) / count;
    step(g, m, meta, [width, top, .55], [0, top / 2, edge + (i - .5) * .5]);
  }
}

function post(g, m, x, z, floor, top) {
  box(g, [.23, top - floor - .08, .23], m.wood, [x, (floor + top - .08) / 2, z], .05);
  box(g, [.34, .15, .34], m.stone, [x, floor + .075, z], .04);
  box(g, [.34, .11, .34], m.bamboo, [x, top - .24, z], .025);
  box(g, [.39, .12, .38], m.wood, [x, top - .10, z], .03);
  const dowel = cyl(g, .035, .018, m.darkwood, [x, top - .34, z + (z < 0 ? -.124 : .124)], 10);
  dowel.rotation.x = Math.PI / 2;
}

function teaSet(g, m, x, y, z, scale = 1) {
  const set = new T.Group(); set.position.set(x, y, z); set.scale.setScalar(scale); g.add(set);
  roundedDisc(set, .23, .035, m.bamboo, [0, .0175, 0], 1, 24);
  ring(set, .21, .009, m.endgrain, [0, .033, 0]);
  orb(set, .12, m.jade, [0, .13, 0], [1, .8, 1]);
  cyl(set, .085, .025, m.jade, [0, .235, 0], 16);
  orb(set, .025, m.bamboo, [0, .26, 0]);
  line(set, [[.1, .15, 0], [.19, .19, 0]], .035, m.jade);
  line(set, [[-.09, .08, 0], [-.18, .14, 0], [-.10, .20, 0]], .018, m.jade);
  for (const dx of [-.29, .29]) {
    cyl(set, .065, .06, m.ivory, [dx, .05, .08], 14);
    cyl(set, .05, .006, m.endgrain, [dx, .083, .08], 14);
  }
}

function stool(g, m, x, z, seatY = .48) {
  roundedDisc(g, .26, .09, m.wood, [x, seatY - .045, z], 1, 24);
  roundedDisc(g, .22, .035, m.jade, [x, seatY - .0075, z], 1, 24);
  for (const [dx, dz] of [[-.12, -.12], [.12, -.12], [-.12, .12], [.12, .12]])
    box(g, [.055, seatY - .09, .055], m.darkwood, [x + dx, (seatY - .09) / 2, z + dz]);
  for (const dz of [-.12, .12]) box(g, [.28, .045, .045], m.wood, [x, seatY * .35, z + dz], .008);
}

function roundTable(g, m, width, depth, height) {
  roundedDisc(g, width / 2, .10, m.wood, [0, height - .05, 0], depth / width, 48);
  roundedDisc(g, width / 2 - .08, .04, m.bamboo, [0, height + .02, 0], depth / width, 48);
  const apron = cyl(g, width / 2 - .12, .13, m.endgrain, [0, height - .15, 0], 40); apron.scale.z = depth / width;
  for (const [x, z] of [[-.26, -.24], [.26, -.24], [-.26, .24], [.26, .24]])
    box(g, [.13, height - .10, .13], m.darkwood, [x * width / 2, (height - .10) / 2, z * depth / 2]);
  for (const z of [-.24, .24]) box(g, [width * .30, .08, .07], m.wood, [0, height * .30, z * depth / 2], .018);
}

function kiosk(g, m, meta, id) {
  const color = {steamers: 'blue', front: 'jade', tea: 'jade', pantry: 'slate'}[id];
  meta.floorY = .36; meta.footprint = {width: 5.6, depth: 4.6};
  platform(g, m, 4.8, 3.7, meta.floorY);
  for (const x of [-2.18, 2.18]) for (const z of [-1.58, 1.58]) post(g, m, x, z, .36, 3.32);
  timberFrame(g, m, 2.18, 1.58, 3.32);
  // Ivory infill surrounds real openings; no solid wall behind the lattice.
  box(g, [4.30, .70, .13], m.ivory, [0, .76, -1.62], .035);
  box(g, [4.30, .32, .13], m.ivory, [0, 2.91, -1.62], .035);
  for (const x of [-2.01, 0, 2.01]) box(g, [.22, 1.68, .15], m.ivory, [x, 1.92, -1.62]);
  for (const x of [-1.02, 1.02]) lattice(g, m, 1.73, 1.45, [x, 1.98, -1.59]);
  box(g, [.13, .67, 2.65], m.ivory, [-2.18, .74, -.17]);
  lattice(g, m, 2.42, 1.48, [-2.18, 1.96, -.17], Math.PI / 2);
  box(g, [.13, .62, .71], m.ivory, [2.18, .72, 1.10]);
  box(g, [.20, .16, 2.03], m.wood, [2.18, 2.99, -.32], .035);
  // The service counter remains intact. Access is through the side frame.
  box(g, [4.35, .89, .40], m.wood, [0, .805, 1.37]);
  box(g, [4.65, .12, .74], m.bamboo, [0, 1.31, 1.37]);
  for (const x of [-1.9, -1.4, -.9, -.4, .1, .6, 1.1, 1.6])
    box(g, [.045, .72, .025], m.darkwood, [x, .79, 1.585]);
  // A shallow cabinet inhabits the rear corner without duplicating any role desk.
  box(g, [1.27, .69, .45], m.jade, [1.15, .735, -1.21], .045);
  for (const x of [.85, 1.45]) {
    box(g, [.52, .52, .035], m.jade, [x, .75, -.966], .035);
    orb(g, .027, m.bamboo, [x + .16, .78, -.938]);
  }
  box(g, [1.38, .10, .56], m.bamboo, [1.15, 1.12, -1.18], .035);
  box(g, [1.34, .08, .36], m.wood, [1.12, 2.36, -1.27], .02);
  for (const x of [.65, 1.12, 1.59]) {
    cyl(g, .14, .20, x === 1.12 ? m.red : m.ivory, [x, 2.51, -1.27], 12);
    cyl(g, .15, .027, m.bamboo, [x, 2.625, -1.27], 12);
  }
  roof(g, m, 5.6, 4.6, 3.32, .72, color);
  for (const x of [-1.93, 1.93]) lantern(g, m, [x, 2.75, 1.63]);
  box(g, [1.78, .39, .13], m.wood, [0, 2.96, 1.63], .055);
  box(g, [1.61, .27, .025], m.ivory, [0, 2.96, 1.71], .035);
  if (id === 'steamers') {
    for (const x of [-1.45, 1.45]) for (let i = 0; i < 3; i++) {
      const y = 1.435 + i * .135;
      cyl(g, .23, .112, m.bamboo, [x, y, 1.37], 22);
      ring(g, .23, .012, m.endgrain, [x, y + .045, 1.37]);
      ring(g, .23, .009, m.endgrain, [x, y - .045, 1.37]);
      if (i === 2) box(g, [.12, .05, .07], m.endgrain, [x, y + .09, 1.37], .018);
    }
    cyl(g, .28, .07, m.bamboo, [0, 1.41, 1.37], 22);
    for (const [x, z] of [[-.11, 1.43], [.11, 1.43], [0, 1.26]]) orb(g, .095, m.ivory, [x, 1.50, z], [1, .78, 1]);
  } else if (id === 'tea') teaSet(g, m, -.8, 1.37, 1.37);
  else box(g, [.42, .025, .35], m.ivory, [-1.1, 1.385, 1.38]);
  meta.doors.push({side: 'right', ...bounds([2.04, .36, -1.20], [2.5, 2.96, .65])});
  step(g, m, meta, [.45, .24, 1.70], [2.60, .12, -.32]);
  step(g, m, meta, [.45, .12, 1.70], [3.03, .06, -.32]);
}

function library(g, m, meta) {
  meta.floorY = .4; meta.footprint = {width: 8.5, depth: 6};
  platform(g, m, 7.45, 4.9, .4);
  for (const x of [-3.4, 3.4]) for (const z of [-2.17, 2.17]) post(g, m, x, z, .4, 3.50);
  timberFrame(g, m, 3.4, 2.17, 3.50);
  box(g, [6.9, 2.95, .12], m.ivory, [0, 1.875, -2.2]);
  for (const x of [-3.4, 3.4]) {
    box(g, [.12, .87, 4.35], m.ivory, [x, .835, 0]);
    box(g, [.12, .56, 4.35], m.ivory, [x, 3.08, 0]);
    for (const z of [-1.99, 0, 1.99]) box(g, [.14, 1.54, .20], m.ivory, [x, 2.035, z]);
    for (const z of [-1.0, 1.0]) lattice(g, m, 1.68, 1.42, [x, 2.04, z], Math.PI / 2);
  }
  // Front wing panels leave a 2.6 m opening, with no sill or bar across it.
  for (const x of [-2.37, 2.37]) {
    box(g, [2.0, .87, .12], m.ivory, [x, .835, 2.17]);
    box(g, [2.0, .47, .12], m.ivory, [x, 2.965, 2.17]);
    for (const dx of [-.90, .90]) box(g, [.20, 1.56, .12], m.ivory, [x + dx, 2.0, 2.17]);
    lattice(g, m, 1.55, 1.4, [x, 2.0, 2.20]);
  }
  for (const x of [-2.27, 2.27]) {
    box(g, [1.65, 2.1, .16], m.wood, [x, 1.45, -1.88]);
    for (const y of [.67, 1.28, 1.89, 2.5]) {
      box(g, [1.65, .07, .43], m.wood, [x, y, -1.70]);
      if (y < 2.5) for (let i = 0; i < 6; i++)
        box(g, [.12 + (i % 2) * .025, .35 + (i % 3) * .025, .22], m[['jade', 'ivory', 'blue', 'bamboo'][i % 4]], [x - .62 + i * .24, y + .23, -1.68]);
    }
    for (const dx of [-.78, .78]) box(g, [.09, 2.18, .47], m.wood, [x + dx, 1.52, -1.7]);
    box(g, [1.70, .10, .49], m.bamboo, [x, 2.57, -1.7]);
  }
  box(g, [2.2, .36, .1], m.wood, [0, 3.08, 2.25]);
  box(g, [1.94, .23, .035], m.ivory, [0, 3.08, 2.32]);
  roof(g, m, 8.5, 6, 3.5, .8, 'jade');
  for (const x of [-1.7, 1.7]) lantern(g, m, [x, 2.9, 2.40]);
  meta.doors.push({side: 'front', ...bounds([-1.30, .4, 2.05], [1.30, 2.9, 2.55])});
  frontSteps(g, m, meta, 2.45, 2.5);
}

function pavilion(g, m, meta) {
  meta.floorY = .6; meta.footprint = {width: 7.7, depth: 6};
  platform(g, m, 6.3, 4.6, .6);
  for (const x of [-2.83, 2.83]) for (const z of [-1.98, 1.98]) post(g, m, x, z, .6, 3.55);
  timberFrame(g, m, 2.83, 1.98, 3.55);
  roof(g, m, 7.7, 6, 3.55, .85, 'jade');
  for (const x of [-2.80, 2.80]) {
    box(g, [.10, .10, 3.5], m.bamboo, [x, 1.25, 0]);
    for (const z of [-1.6, -.8, 0, .8, 1.6]) box(g, [.065, .60, .065], m.wood, [x, .95, z]);
    lantern(g, m, [x, 2.98, 1.95]);
    box(g, [.4, .10, 2.3], m.wood, [x - Math.sign(x) * .40, 1.06, -.15]);
    for (const z of [-.95, .65]) box(g, [.25, .41, .12], m.wood, [x - Math.sign(x) * .40, .855, z]);
  }
  // A lattice frieze occupies only the rear edge, leaving the pond route open.
  for (const x of [-1.28, 1.28]) lattice(g, m, 2.12, .62, [x, 2.83, -1.98]);
  const table = new T.Group(); table.position.set(0, .6, -.8); g.add(table);
  roundTable(table, m, 1.25, 1.25, .78); teaSet(table, m, 0, .82, 0);
  // The pale pond and bamboo bridge remain part of the pavilion arrival.
  const pond = cyl(g, 1, .035, m.water, [0, .0225, 4.03], 48); pond.scale.set(3.8, 1, 1.62);
  for (const [x, z] of [[-2.4, 3.4], [1.9, 4.6], [-1.6, 4.7]])
    cyl(g, .18, .025, m.leaf, [x, .055, z], 16);
  box(g, [1.5, .10, 3.12], m.wood, [0, .55, 3.78]);
  for (let i = 0; i < 16; i++) box(g, [1.5, .025, .18], m.bamboo, [0, .5875, 2.30 + i * .195]);
  for (const x of [-.82, .82]) {
    box(g, [.055, .065, 3.18], m.bamboo, [x, 1.25, 3.80]);
    for (const z of [2.3, 3.8, 5.3]) box(g, [.07, .70, .07], m.wood, [x, .95, z]);
    for (const z of [2.3, 3.8, 5.3]) ring(g, .045, .008, m.endgrain, [x, 1.13, z]);
  }
  step(g, m, meta, [1.5, .4, .50], [0, .20, 5.55]);
  step(g, m, meta, [1.5, .2, .50], [0, .10, 6.03]);
  meta.doors.push({side: 'front', ...bounds([-.75, .6, 1.85], [.75, 3.2, 2.5])});
  meta.bridge = {...bounds([-.75, .5, 2.22], [.75, .6, 5.34]), top: .6};
}

function festival(g, m, meta) {
  meta.floorY = .6; meta.footprint = {width: 6.7, depth: 4.8};
  platform(g, m, 5.75, 3.7, .6);
  for (const x of [-2.55, 2.55]) for (const z of [-1.55, 1.55]) post(g, m, x, z, .6, 3.48);
  timberFrame(g, m, 2.55, 1.55, 3.48);
  roof(g, m, 6.7, 4.8, 3.48, .76, 'blue');
  box(g, [4.9, 1.65, .08], m.ivory, [0, 1.425, -1.6]);
  box(g, [4.9, .15, .08], m.ivory, [0, 3.075, -1.6]);
  box(g, [1.65, .8, .08], m.ivory, [0, 2.65, -1.6]);
  for (const x of [-2.35, -.95, .95, 2.35]) box(g, [.20, .8, .08], m.ivory, [x, 2.65, -1.6]);
  for (const x of [-1.65, 1.65]) lattice(g, m, 1.12, .65, [x, 2.67, -1.52]);
  box(g, [1.15, 1.38, .055], m.red, [0, 1.97, -1.54], .035);
  for (const x of [-.63, .63]) box(g, [.055, 1.65, .07], m.bamboo, [x, 1.97, -1.49]);
  for (const x of [-1.65, 1.65]) {
    box(g, [.13, .56, .13], m.wood, [x, .88, -.65]);
    const drum = cyl(g, .36, .45, m.red, [x, 1.35, -.65], 24); drum.rotation.x = Math.PI / 2;
    const head = cyl(g, .365, .025, m.ivory, [x, 1.35, -.41], 24); head.rotation.x = Math.PI / 2;
    ring(g, .34, .018, m.bamboo, [x, 1.35, -.39], [0, 0, 0]);
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      orb(g, .017, m.darkwood, [x + Math.cos(a) * .31, 1.35 + Math.sin(a) * .31, -.385]);
    }
    lantern(g, m, [x, 2.9, 1.6], true);
  }
  frontSteps(g, m, meta, 1.85, 2.7);
  meta.doors.push({side: 'front', ...bounds([-1.35, .6, 1.45], [1.35, 3.1, 2.25])});
}

function furniture(g, m, meta, id) {
  meta.floorY = 0;
  if (id === 'center' || id === 'dining') {
    const big = id === 'center', height = big ? 1.1 : .9;
    meta.footprint = {width: big ? 5 : 3.7, depth: big ? 3.1 : 3.7};
    meta.table = {width: big ? 5 : 2, depth: big ? 3.1 : 2, top: height + .04};
    roundTable(g, m, meta.table.width, meta.table.depth, height);
    teaSet(g, m, big ? -1.4 : -.3, height + .04, big ? -.6 : -.2);
    // den-mvp/64: on the big table the baskets ride a lazy susan, which turns toward whoever speaks in a meeting.
    const susan = big ? new T.Group() : g;
    if (big) { susan.name = 'Lazy susan'; susan.position.set(.2, 0, .1); g.add(susan); cyl(susan, 1.25, .04, m.endgrain, [0, height + .06, 0], 48); }
    for (const [x, z] of big ? [[-.6, .3], [.3, -.3], [1.15, .35]] : [[.32, .22]]) {
      const [sx, sz] = big ? [x - .2, z - .1] : [x, z];
      cyl(susan, .22, .12, m.bamboo, [sx, height + .10, sz], 24);
      ring(susan, .22, .011, m.endgrain, [sx, height + .145, sz]);
      for (const dx of [-.08, .08]) orb(susan, .075, m.ivory, [sx + dx, height + .19, sz], [1, .7, 1]);
    }
    if (!big) for (const [x, z] of [[-1.5, 0], [1.5, 0], [0, -1.5], [0, 1.5]]) stool(g, m, x, z);
  } else if (id === 'games') {
    meta.footprint = {width: 3.6, depth: 3.6};
    box(g, [1.65, .11, 1.65], m.wood, [0, .845, 0]);
    box(g, [1.42, .035, 1.42], m.jade, [0, .9175, 0]);
    for (const x of [-.62, .62]) for (const z of [-.62, .62]) box(g, [.10, .79, .10], m.darkwood, [x, .395, z]);
    for (const z of [-.66, .66]) box(g, [1.35, .14, .07], m.wood, [0, .72, z]);
    for (const x of [-.66, .66]) box(g, [.07, .14, 1.35], m.wood, [x, .72, 0]);
    for (let i = 0; i < 6; i++) {
      box(g, [.11, .09, .075], m.ivory, [-.39 + i * .15, .98, -.46]);
      box(g, [.075, .09, .11], m.ivory, [.46, .98, -.39 + i * .15]);
      cyl(g, .014, .004, i % 2 ? m.red : m.jade, [-.39 + i * .15, 1.027, -.46], 8);
    }
    for (const [x, z] of [[-1.4, 0], [1.4, 0], [0, -1.4], [0, 1.4]]) stool(g, m, x, z);
    meta.table = {width: 1.65, depth: 1.65, top: .935};
  }
}

function training(g, m, meta) {
  meta.floorY = .12; meta.footprint = {width: 6.3, depth: 5.5};
  cyl(g, 2.75, .12, m.stone, [0, .06, 0], 48);
  for (const x of [-1.05, 1.05]) post(g, m, x, -1.3, .12, 2.7);
  box(g, [2.7, .16, .22], m.wood, [0, 2.62, -1.3]);
  const gong = cyl(g, .69, .07, m.gold, [0, 1.62, -1.3], 40); gong.rotation.x = Math.PI / 2;
  ring(g, .65, .022, m.bamboo, [0, 1.62, -1.25], [0, 0, 0]);
  ring(g, .23, .012, m.endgrain, [0, 1.62, -1.247], [0, 0, 0]);
  orb(g, .16, m.bamboo, [0, 1.62, -1.24], [1, 1, .3]);
  for (const x of [-.38, .38]) line(g, [[x, 2.55, -1.3], [x, 2.18, -1.3]], .018, m.darkwood);
  for (const x of [-1.05, 1.05]) {
    const sign = Math.sign(x);
    line(g, [[x - sign * .45, 2.55, -1.3], [x - sign * .25, 2.38, -1.3], [x, 2.12, -1.3]], .055, m.wood, 8);
  }
  cyl(g, .13, 1.6, m.wood, [1.8, .92, .6], 12);
  for (const y of [.9, 1.2, 1.5]) {
    const arm = cyl(g, .045, .54, m.bamboo, [1.8, y, .85], 10); arm.rotation.x = Math.PI / 2;
  }
}

function gate(g, m, meta) {
  meta.floorY = 0; meta.footprint = {width: 6.5, depth: 2.1};
  for (const x of [-2.38, 2.38]) {
    post(g, m, x, 0, 0, 3.28);
    lantern(g, m, [x, 2.65, .36], true);
  }
  box(g, [5.6, .2, .32], m.wood, [0, 3.12, 0]);
  box(g, [5.35, .055, .36], m.bamboo, [0, 2.98, 0]);
  for (const sign of [-1, 1]) {
    line(g, [[sign * 1.65, 3.04, 0], [sign * 1.92, 2.93, 0], [sign * 2.17, 2.65, 0], [sign * 2.38, 2.62, 0]], .075, m.wood, 9);
    box(g, [.12, .085, .35], m.endgrain, [sign * 1.70, 3.025, 0], .018);
  }
  box(g, [1.9, .54, .16], m.wood, [0, 2.97, .18], .055);
  box(g, [1.70, .41, .12], m.ivory, [0, 2.95, .22]);
  roof(g, m, 6.5, 2.1, 3.28, .72, 'slate');
  meta.doors.push({side: 'front', ...bounds([-2.15, 0, -.6], [2.15, 2.70, .6])});
}

/** No DOM, textures, asset fetches or WebGL context are required. */
export function createStylizedStructure(id) {
  if (!STYLIZED_STRUCTURE_IDS.includes(id)) throw new Error('Unknown stylized structure: ' + id);
  const source = new T.Group(), m = craftedPalette();
  const meta = {id, floorY: 0, footprint: null, doors: [], steps: [], bridge: null};
  if (['steamers', 'front', 'tea', 'pantry'].includes(id)) kiosk(source, m, meta, id);
  else if (id === 'library') library(source, m, meta);
  else if (id === 'pavilion') pavilion(source, m, meta);
  else if (id === 'festival') festival(source, m, meta);
  else if (id === 'gate') gate(source, m, meta);
  else if (id === 'training') training(source, m, meta);
  else if (id === 'dragon') {
    const display = dragon(m);
    display.position.y = .025; // The reused support poles extend .025 below their old origin.
    source.add(display); meta.footprint = {width: 8.4, depth: 1.1};
  } else furniture(source, m, meta, id);
  const group = bake(source);
  group.name = id + ' · stylized timber structure';
  group.userData = {source: 'Procedural Three.js', stylizedStructure: true, structure: meta};
  return group;
}
