/**
 * Dim Sum Dev: the v5 kit's assembled village (den-mvp/25).
 * Supply the same THREE instance and createBao function used by your app.
 *
 * The world is `createVillage({includeResidents:false})`: ground, the team assets, promenades, bamboo, lanterns and
 * labels. This module adds what the live den needs on top of it: Bao at the Pass, the pandas the board creates for
 * tickets, the frontier baskets and the Tally's beads. Every other panda belongs to the actor controller.
 */
import { createVillage, disposeAsset, setLabels as setVillageLabels, KIT } from '../expansion/base-assets.mjs';
import { BAO_HOME, BAO_SCALE } from '../../review/site-plan.mjs';

// Where the frontier baskets wait: the kit's "Ticket baskets" stack, with a small grid of room beside it.
const FRONTIER_ORIGIN = [-20.2, -7.3], FRONTIER_COLUMNS = 4, FRONTIER_PITCH = 0.8;
const SPARE_STALLS = ['steamers', 'front', 'tea', 'pantry'];

export function createDenScene(THREE, createBao) {
  const world = createVillage({ includeResidents: false });
  world.name = 'DimSumDev';
  const pandas = [], mixers = [], obstacles = [], tallyRows = [];
  const frontier = new Map();
  const byAsset = (id) => world.children.find((o) => o.userData.assetId === id);
  // Index order is the team index the controller's placements name: steamers, front of house, tea, pantry.
  const stalls = SPARE_STALLS.map(byAsset);

  const matte = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.95 });
  function addPanda(parent, position, scale, color = '#216485') {
    const panda = createBao(THREE, { detail: 'low' });
    panda.model.position.set(...position); panda.model.scale.setScalar(scale);
    parent.add(panda.model); pandas.push(panda);
    const group = new THREE.Group(); panda.bones.Torso.add(group); group.position.y = -1.4;
    const mat = matte(color); panda.materials.scarf = mat;
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.83, 0.105, 8, 32), mat); collar.position.set(0, 2.42, 0.12); collar.rotation.x = Math.PI / 2; group.add(collar);
    const mixer = new THREE.AnimationMixer(panda.model);
    mixer.clipAction(panda.animations.find((a) => a.name === 'Breathe')).play();
    mixer.clipAction(panda.animations.find((a) => a.name === 'Blink')).play();
    mixers.push(mixer); panda.mixer = mixer;
    panda.model.traverse((m) => { if (m.isSkinnedMesh) m.castShadow = /^(Body|HeadShape|Arm_|Hand_|Foot_|Ear_)/.test(m.name); });
    return panda;
  }

  // Bao stands behind the Pass counter, where the kit's own host stands.
  const hero = createBao(THREE); hero.model.name = 'Bao — host of Dim Sum Dev';
  hero.model.position.set(BAO_HOME[0], 0.16, BAO_HOME[1]); hero.model.scale.setScalar(BAO_SCALE);
  world.add(hero.model); pandas.push(hero);
  const heroMixer = new THREE.AnimationMixer(hero.model);
  heroMixer.clipAction(hero.animations.find((a) => a.name === 'Breathe')).play();
  heroMixer.clipAction(hero.animations.find((a) => a.name === 'Blink')).play();
  mixers.push(heroMixer);

  // The kit's kitchen tally: one row of ten beads per rod. It answers a click as the Tally.
  let tallyGroup = null;
  world.traverse((o) => { if (o.userData.tally) tallyGroup = o; });
  if (tallyGroup) { tallyGroup.userData.tallyAbacus = true; tallyRows.push(...tallyGroup.userData.tally.rows); }

  function createTicketPanda(role, placement) {
    const p = addPanda(parentFor(placement), placement.position, placement.scale, { product: '#594681', architect: '#594681', qa: '#205c40', security: '#205c40' }[role] || '#1b6685');
    p.model.userData.role = role;
    return p;
  }
  function parentFor(placement) { return placement.parent.startsWith('stall:') ? stalls[Number(placement.parent.slice(6))] : world; }
  function placeTicketPanda(p, placement) {
    const parent = parentFor(placement);
    if (p.model.parent !== parent) parent.add(p.model);
    p.model.position.set(...placement.position); p.model.scale.setScalar(placement.scale);
  }
  function removeTicketPanda(p) {
    p.mixer.stopAllAction(); p.mixer.uncacheRoot(p.model);
    const geometries = new Set(), ownMaterials = new Set(Object.values(p.materials));
    p.model.traverse((o) => { if (o.geometry) geometries.add(o.geometry); });
    p.model.removeFromParent();
    for (const g of geometries) g.dispose();
    const textures = new Set();
    for (const m of ownMaterials) { for (const t of Object.values(m)) if (t?.isTexture) textures.add(t); m.dispose(); }
    for (const t of textures) t.dispose();
    p.skeleton.dispose();
    pandas.splice(pandas.indexOf(p), 1); mixers.splice(mixers.indexOf(p.mixer), 1);
  }

  function setFrontier(refs) {
    const wanted = new Set(refs.slice(0, 8));
    for (const [ref, g] of frontier) if (!wanted.has(ref)) { g.traverse((o) => o.geometry?.dispose()); g.removeFromParent(); frontier.delete(ref); }
    let index = 0;
    for (const ref of wanted) {
      let g = frontier.get(ref);
      if (!g) { g = KIT.basket(world, [0, 0, 0], 0.3, true); g.userData.ticketRef = ref; frontier.set(ref, g); }
      const i = index++;
      g.position.set(FRONTIER_ORIGIN[0] + (i % FRONTIER_COLUMNS) * FRONTIER_PITCH, 0, FRONTIER_ORIGIN[1] - Math.floor(i / FRONTIER_COLUMNS) * FRONTIER_PITCH);
    }
  }
  function setTally(rods) {
    const colors = { qi: '#177d80', alarm: '#bd3826', 'team-steamers': '#2759a2' };
    for (let row = 0; row < tallyRows.length; row++) for (let j = 0; j < 10; j++) {
      const rod = rods?.[row], count = Math.max(0, Math.min(10, rod?.counted || 0)), on = j >= 10 - count, bead = tallyRows[row][j];
      bead.material.color.set(on ? (colors[rod.color] || '#177d80') : '#d3bc86');
      bead.position.x = on ? 0.76 - (9 - j) * 0.12 : -0.77 + j * 0.17;
    }
  }
  function update(delta) { for (const mixer of mixers) mixer.update(delta); }
  function setLabels(visible) { setVillageLabels(world, visible); }
  function setLanterns(warm) {
    world.traverse((o) => { if (!o.userData.lantern) return; o.traverse((m) => { if (m.isMesh && m.material.emissive) m.material.emissiveIntensity = warm ? 1.9 : (o.userData.attention ? 0.25 : 0.03); }); });
  }
  function dispose() {
    for (const mixer of mixers) mixer.stopAllAction();
    const skeletons = new Set(pandas.map((p) => p.skeleton));
    disposeAsset(world);
    for (const s of skeletons) s.dispose();
  }
  world.updateMatrixWorld(true);
  return { world, hero, pandas, mixers, stalls, obstacles, frontier, tallyRows, createTicketPanda, placeTicketPanda, removeTicketPanda, setFrontier, setTally, update, setLabels, setLanterns, dispose };
}
