import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as T from 'three';
import { readGlbGeometry } from '../../../assets-src/den/read-glb-geometry.mjs';
import { createPandaAppearanceFactory } from './panda-appearance.mjs';
import { createLeisureGesture } from './leisure-gesture.mjs';
import { CAST, castCharacterId } from './cast.mjs';
import { CAST_DRAFTS, CAST_PROFILES } from './cast-profiles.mjs';
import { CHARACTER_PROFILES } from './character-profiles.mjs';

// team-and-den-ux/25-35 slice 2a: rig, envelope, pose and binding tests for the species that have a profile.
const manifest = JSON.parse(readFileSync(new URL('../../../public/den/manifest.json', import.meta.url))).assets;
const load = id => readGlbGeometry(gunzipSync(readFileSync(new URL('../../../public' + manifest['characters.' + id].url, import.meta.url))));
const ROLE_OF = Object.fromEntries(Object.entries(CAST).filter(([, v]) => typeof v === 'string').map(([role, id]) => [id, role]));
const v = new T.Vector3();

function posed(rig) {
  rig.model.updateMatrixWorld(true);
  return rig.meshes.map(m => Array.from({ length: m.geometry.attributes.position.count }, (_, i) => m.applyBoneTransform(i, new T.Vector3().fromBufferAttribute(m.geometry.attributes.position, i)).applyMatrix4(m.matrixWorld)));
}
function stretch(rig, points) {
  let worst = 0;
  rig.meshes.forEach((m, k) => {
    const pos = m.geometry.attributes.position, index = m.geometry.index;
    for (let i = 0; i < index.count; i += 3) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const ai = index.getX(i + a), bi = index.getX(i + b), rest = v.fromBufferAttribute(pos, ai).distanceTo(new T.Vector3().fromBufferAttribute(pos, bi));
      if (rest > .03) worst = Math.max(worst, points[k][ai].distanceTo(points[k][bi]) / rest);
    }
  });
  return worst;
}

// Drafts run only when asked (CAST_DRAFTS=1); live profiles always run.
for (const [id, profile] of Object.entries(process.env.CAST_DRAFTS ? CAST_DRAFTS : CAST_PROFILES)) {
  test(`${id} fits its structural budgets and keeps motion inside its envelopes`, () => {
    const factory = createPandaAppearanceFactory({ characters: { [id]: load(id) }, castProfiles: { [id]: profile } }), { rig, model } = factory.createPanda(profile.role, { runtime: profile.runtime });
    model.scale.setScalar(1);
    const gesture = createLeisureGesture(rig);
    try {
      assert.equal(model.userData.species, profile.id);
      assert.ok(rig.skeleton.bones.length <= 32, `${rig.skeleton.bones.length} bones`);
      const geometryBytes = rig.meshes.reduce((n, m) => n + m.geometry.index.array.byteLength + Object.values(m.geometry.attributes).reduce((s, a) => s + a.array.byteLength, 0), 0);
      assert.ok(geometryBytes <= 2 * 1048576, `${geometryBytes} rig bytes`);
      assert.ok(rig.meshes.filter(m => m.castShadow).reduce((n, m) => n + m.geometry.index.count / 3, 0) <= 8000);
      for (const m of rig.meshes) { const w = m.geometry.attributes.skinWeight; for (let i = 0; i < w.count; i++) assert.ok(Math.abs(w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i) - 1) < 1e-5); }
      let worst = 0;
      const check = (label, kind) => {
        const points = posed(rig); let radius = 0, top = 0, low = Infinity;
        for (const group of points) for (const p of group) { radius = Math.max(radius, Math.hypot(p.x, p.z)); top = Math.max(top, p.y); low = Math.min(low, p.y); }
        assert.ok(radius <= profile.envelope[kind].radius, `${label} radius ${radius}`);
        assert.ok(top <= profile.envelope[kind].height, `${label} top ${top}`);
        assert.ok(low >= -.02, `${label} penetrates ground: ${low}`);
        worst = Math.max(worst, stretch(rig, points));
      };
      for (const t of [0, .2, .4, .6, .8, 1]) { rig.poseWaddle(t); check('walk ' + t, 'moving'); }
      for (const t of [0, 1.2, 2.4]) { rig.poseIdle(t); check('idle ' + t, 'standing'); rig.poseSit(t); check('sit ' + t, 'seated'); }
      for (const kind of ['tea', 'greeting', 'pond', 'mahjong']) { rig.poseIdle(1); gesture.pose(kind, 1); check(kind, 'standing'); }
      assert.ok(worst < 3, `an edge stretches ${worst} times`);
      // The hello is visible on the actual surface (not just a bone), while fused arms stay still against the chest.
      rig.poseIdle(.3); const before = posed(rig).flat(), arm = () => rig.bones.Chest.matrixWorld.clone().invert().multiply(rig.bones.paw_L.matrixWorld).elements;
      const still = arm(); gesture.pose('greeting', .3); model.updateMatrixWorld(true);
      const moved = Math.max(...posed(rig).flat().map((p, i) => p.distanceTo(before[i])));
      assert.ok(moved > .15, `greeting moves the surface ${moved}`);
      if (profile.greeting === 'body') arm().forEach((x, i) => assert.ok(Math.abs(x - still[i]) < 1e-9, 'fused paw stays on the chest'));
      gesture.pose(null, 0);
      // Reduced motion is static in idle and sit.
      for (const pose of ['poseIdle', 'poseSit']) {
        rig[pose](0, { reducedMotion: true }); const rest = rig.bones.Head.matrixWorld.clone();
        rig[pose](2.4, { reducedMotion: true }); assert.deepEqual(rig.bones.Head.matrixWorld.elements, rest.elements, pose);
      }
    } finally { gesture.dispose(); factory.dispose(); }
  });
}

test('each role picks its species for both runtimes; Jiao is the codex orchestrator and unprofiled species keep the old panda', () => {
  assert.equal(castCharacterId('orchestrator', 'claude'), 'bao');
  assert.equal(castCharacterId('orchestrator', 'codex'), 'jiao');
  for (const [id, role] of Object.entries(ROLE_OF)) for (const runtime of ['claude', 'codex']) assert.equal(castCharacterId(role, runtime), id);
  assert.equal(castCharacterId('developer'), undefined, 'the red panda and dragon keep their own tables');
  assert.ok(!('jiao' in CAST_DRAFTS) && !Object.keys({ ...CAST_DRAFTS, ...CAST_PROFILES }).some(id => id in CHARACTER_PROFILES), 'cast profiles stay out of CHARACTER_PROFILES');
  const body = new T.Mesh(new T.BoxGeometry(1, 3, 1).translate(0, 1.5, 0), new T.MeshStandardMaterial());
  const characters = Object.fromEntries(Object.keys(CAST_PROFILES).map(id => [id, load(id)]));
  characters.jiao = load('jiao');
  const factory = createPandaAppearanceFactory({ body, vest: body, characters, castProfiles: CAST_PROFILES });
  try {
    for (const profile of Object.values(CAST_PROFILES).filter(p => p.id !== 'jiao')) for (const runtime of ['claude', 'codex']) {
      const a = factory.createPanda(profile.role, { runtime });
      assert.equal(a.model.userData.species, profile.id); assert.equal(a.model.userData.runtime, runtime); assert.equal(a.model.scale.x, .68);
    }
    const jiao = factory.createPanda('orchestrator', { runtime: 'codex' });
    assert.equal(jiao.model.userData.species, 'jiao'); assert.equal(jiao.model.userData.runtime, 'codex'); assert.equal(jiao.model.scale.x, 1.35, 'Jiao matches Bao so the two hosts read as a pair');
    assert.notEqual(factory.createPanda('orchestrator').model.userData.species, 'jiao', 'the claude orchestrator is never Jiao');
    assert.equal(factory.createPanda('orchestrator').model.scale.x, 1.35);
  } finally { factory.dispose(); }
  const failed = createPandaAppearanceFactory({ body, vest: body, characters: {}, castProfiles: CAST_PROFILES });
  try { for (const profile of Object.values(CAST_PROFILES)) assert.equal(failed.createPanda(profile.role).model.userData.species, undefined, profile.role + ' falls back to its old panda'); } finally { failed.dispose(); }
});

// team-and-den-ux/35: the whole live cast through the factory, every role on both runtimes plus Bao and Jiao.
test('the whole live cast instantiated together stays inside the structural budgets, per character and in total', () => {
  const ids = [...Object.keys(CAST_PROFILES), 'bao'], characters = Object.fromEntries(ids.map(id => [id, load(id)]));
  const factory = createPandaAppearanceFactory({ characters, castProfiles: CAST_PROFILES });
  const total = { characters: 0, draws: 0, shadowTriangles: 0, bones: 0, rigBytes: 0 }, per = {};
  try {
    for (const role of Object.keys(CAST)) for (const runtime of ['claude', 'codex']) {
      const { rig, model } = factory.createPanda(role, { runtime }), name = model.userData.species + '/' + runtime;
      const draws = rig.meshes.length, bones = rig.skeleton.bones.length, shadow = rig.meshes.filter(m => m.castShadow).reduce((n, m) => n + m.geometry.index.count / 3, 0);
      const bytes = rig.meshes.reduce((n, m) => n + m.geometry.index.array.byteLength + Object.values(m.geometry.attributes).reduce((s, a) => s + a.array.byteLength, 0), 0);
      const maps = new Set(rig.meshes.map(m => m.material.map).filter(Boolean));
      assert.ok(draws <= 6 && bones <= 32 && shadow <= 8000 && bytes <= 2 * 1048576, `${name}: ${draws} draws, ${bones} bones, ${shadow} shadow tris, ${bytes} bytes`);
      assert.equal(maps.size, 1, name + ' has one colour texture'); const tex = manifest['characters.' + castCharacterId(role, runtime)].textures; assert.deepEqual(tex.map(t => [t.width, t.height]), [[512, 512]]);
      per[name] = { draws, bones, shadow, bytes }; total.characters++; total.draws += draws; total.shadowTriangles += shadow; total.bones += bones; total.rigBytes += bytes;
    }
    assert.equal(total.characters, 20, '9 roles x 2 runtimes plus Bao and Jiao');
    assert.ok(total.draws <= 20 * 6 && total.shadowTriangles <= 20 * 8000 && total.rigBytes <= 20 * 2 * 1048576, JSON.stringify(total));
    console.log('cast aggregate', JSON.stringify(total), JSON.stringify(per));
  } finally { factory.dispose(); }
});
