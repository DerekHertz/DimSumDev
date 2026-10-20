import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as T from 'three';
import { createRig, PANDA_BONE_NAMES } from './panda-rig.mjs';
import { CHARACTER_PROFILES } from './character-profiles.mjs';
import { createPandaAppearanceFactory } from './panda-appearance.mjs';
import { createLeisureGesture } from './leisure-gesture.mjs';

// team-and-den-ux/23: the red panda engineer and cloud dragon writer, exercised on the shipped meshes.
const manifest = JSON.parse(readFileSync(new URL('../../../public/den/manifest.json', import.meta.url), 'utf8')).assets;

function loadSource(role) {
  const asset = manifest['characters.' + role];
  const bytes = gunzipSync(readFileSync(new URL('../../../public' + asset.url, import.meta.url)));
  const jsonLength = bytes.readUInt32LE(12), gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength)), bin = bytes.subarray(28 + jsonLength);
  const attribute = index => {
    const accessor = gltf.accessors[index], view = gltf.bufferViews[accessor.bufferView];
    const width = { SCALAR: 1, VEC2: 2, VEC3: 3 }[accessor.type], Type = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array }[accessor.componentType];
    const offset = view.byteOffset + (accessor.byteOffset || 0), data = bin.subarray(offset, offset + accessor.count * width * Type.BYTES_PER_ELEMENT);
    return new T.BufferAttribute(new Type(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)), width);
  };
  const primitive = gltf.meshes[0].primitives[0], geometry = new T.BufferGeometry();
  for (const [key, name] of [['POSITION', 'position'], ['NORMAL', 'normal'], ['TEXCOORD_0', 'uv']]) geometry.setAttribute(name, attribute(primitive.attributes[key]));
  geometry.setIndex(attribute(primitive.indices));
  const source = new T.Group(); source.add(new T.Mesh(geometry, new T.MeshStandardMaterial({ map: new T.Texture() })));
  return { asset, gltf, source };
}
const sources = Object.fromEntries(Object.keys(CHARACTER_PROFILES).map(role => [role, loadSource(role)]));

function posedBounds(rig) {
  rig.model.updateMatrixWorld(true);
  const box = new T.Box3(), v = new T.Vector3();
  for (const mesh of rig.meshes) {
    const position = mesh.geometry.attributes.position;
    for (let i = 0; i < position.count; i++) box.expandByPoint(mesh.applyBoneTransform(i, v.fromBufferAttribute(position, i)).applyMatrix4(mesh.matrixWorld));
  }
  return box;
}
function footprint(rig) {
  const v = new T.Vector3(); let radius = 0;
  for (const mesh of rig.meshes) {
    const position = mesh.geometry.attributes.position;
    for (let i = 0; i < position.count; i++) { mesh.applyBoneTransform(i, v.fromBufferAttribute(position, i)).applyMatrix4(mesh.matrixWorld); radius = Math.max(radius, Math.hypot(v.x, v.z)); }
  }
  return radius;
}

for (const [role, profile] of Object.entries(CHARACTER_PROFILES)) {
  const { asset, gltf, source } = sources[role];

  test(`${profile.label}: the shipped asset meets the proof budgets`, () => {
    assert.equal(asset.roleId, role);
    assert.ok(asset.triangles <= 12000, `${asset.triangles} triangles, cap 12,000 including props`);
    assert.equal(asset.textures.length, 1, 'one colour map, no normal or roughness maps');
    assert.ok(asset.textures[0].width <= 512 && asset.textures[0].height <= 512);
    const material = gltf.materials[0];
    assert.equal(material.normalTexture, undefined);
    assert.equal(material.pbrMetallicRoughness.metallicRoughnessTexture, undefined);
    const rig = createRig(source, profile), geometryBytes = rig.meshes.reduce((n, m) => n + Object.values(m.geometry.attributes).reduce((s, a) => s + a.array.byteLength, 0) + m.geometry.index.array.byteLength, 0);
    assert.ok(geometryBytes <= 2 * 1048576, `${geometryBytes} geometry bytes per actor, cap 2 MiB`);
    assert.ok(rig.skeleton.bones.length <= 32, `${rig.skeleton.bones.length} bones, cap 32`);
    rig.dispose();
  });

  test(`${profile.label}: one skeleton with the shared bone names and normalised weights`, () => {
    const rig = createRig(source, profile), names = rig.skeleton.bones.map(b => b.name);
    for (const name of PANDA_BONE_NAMES) assert.ok(names.includes(name), name);
    assert.ok(['Tail1', 'Tail2', 'Tail3', 'TailTip'].every(n => names.includes(n)));
    const weights = rig.meshes[0].geometry.attributes.skinWeight;
    for (let i = 0; i < weights.count; i++) assert.ok(Math.abs(weights.getX(i) + weights.getY(i) + weights.getZ(i) + weights.getW(i) - 1) < 1e-5);
    const rest = posedBounds(rig);
    assert.ok(Math.abs(rest.min.y) < .01 && Math.abs(rest.max.y - profile.height) < .01, 'feet at 0, crown at the profile height');
    rig.dispose();
  });

  test(`${profile.label}: soles and tail stay above the floor through a waddle, idle and the seated pose`, () => {
    const rig = createRig(source, profile);
    for (let t = 0; t < 1.2; t += .1) { rig.poseWaddle(t); const low = posedBounds(rig).min.y; assert.ok(low > -.02, `waddle t=${t.toFixed(1)}: lowest point ${low.toFixed(3)}`); }
    rig.poseIdle(2.4); assert.ok(posedBounds(rig).min.y > -.02, 'idle');
    for (const t of [0, 1.2, 2.4]) {
      rig.poseSit(t);
      const box = posedBounds(rig);
      assert.ok(box.min.y > -.02, `seated t=${t}: lowest point ${box.min.y.toFixed(3)}`);
      assert.ok(box.max.y < profile.height - .05, `seated top ${box.max.y.toFixed(2)} is lower than standing`);
    }
    rig.poseSit(1, { reducedMotion: true });
    assert.ok(rig.bones.Pelvis.position.y < rig.bones.Pelvis.parent.position.y + profile.rest.find(r => r[0] === 'Pelvis')[2][1], 'reduced motion still sits');
    rig.dispose();
  });

  test(`${profile.label}: every pose fits the published envelopes, props included`, () => {
    const rig = createRig(source, profile), gesture = createLeisureGesture(rig), { envelope } = profile;
    const check = (label, kind) => {
      const box = posedBounds(rig), limit = envelope[kind], radius = footprint(rig);
      assert.ok(radius <= limit.radius, `${label}: footprint ${radius.toFixed(2)} > ${limit.radius}`);
      assert.ok(box.max.y <= limit.height, `${label}: height ${box.max.y.toFixed(2)} > ${limit.height}`);
      assert.ok(box.max.y <= envelope.head.top);
    };
    rig.resetPose(); check('rest', 'standing');
    for (const t of [0, 1.2, 2.4, 3.6]) { rig.poseIdle(t); check('idle ' + t, 'standing'); }
    for (let t = 0; t < 1.2; t += .15) { rig.poseWaddle(t); check('waddle ' + t.toFixed(2), 'moving'); }
    for (const kind of ['tea', 'pond', 'greeting', 'mahjong']) for (const t of [0, 1.25, 2.5]) { rig.poseIdle(t); gesture.pose(kind, t); check(kind + ' ' + t, 'standing'); }
    for (const t of [0, 2.4]) { rig.poseSit(t); check('seated ' + t, 'seated'); }
    gesture.dispose(); rig.dispose();
  });
}

test('the dragon keeps its fused book on the chest and its brush in the left paw', () => {
  const profile = CHARACTER_PROFILES['technical-writer'], rig = createRig(sources['technical-writer'].source, profile), mesh = rig.meshes[0];
  const position = mesh.geometry.attributes.position, skinIndex = mesh.geometry.attributes.skinIndex, skinWeight = mesh.geometry.attributes.skinWeight;
  const chest = rig.skeleton.bones.indexOf(rig.bones.Chest), paw = rig.skeleton.bones.indexOf(rig.bones.paw_L);
  const rigid = (bone) => [...Array(position.count).keys()].filter(i => skinIndex.getX(i) === bone && skinWeight.getX(i) === 1);
  const book = rigid(chest), brush = rigid(paw);
  assert.ok(book.length > 50 && brush.length > 20, `${book.length} book and ${brush.length} brush vertices bound rigidly`);
  const gesture = createLeisureGesture(rig);
  assert.equal(gesture.cup.visible, false);
  gesture.pose('tea', 1); assert.equal(gesture.cup.visible, false, 'no cup in a paw that already holds a prop');
  rig.poseWaddle(.4); gesture.pose('mahjong', 1);
  assert.ok(Math.abs(rig.bones.Shoulder_R.rotation.x) < 1e-9 && Math.abs(rig.bones.Shoulder_R.rotation.z) < 1e-9, 'the book arm does not gesture');
  gesture.dispose(); rig.dispose();
});

test('the appearance factory gives these two roles their species in both runtimes and leaves other roles as pandas', () => {
  const body = new T.Group(); body.add(new T.Mesh(new T.BoxGeometry(1, 3, 1).translate(0, 1.5, 0), new T.MeshStandardMaterial()));
  const factory = createPandaAppearanceFactory({ body, characters: { developer: sources.developer.source, 'technical-writer': sources['technical-writer'].source } });
  for (const runtime of ['claude', 'codex']) {
    const engineer = factory.createPanda('developer', { runtime }), writer = factory.createPanda('technical-writer', { runtime });
    assert.equal(engineer.model.userData.species, 'red-panda'); assert.equal(writer.model.userData.species, 'cloud-dragon');
    assert.equal(engineer.model.userData.runtime, runtime); assert.equal(engineer.model.userData.roleId, 'developer');
    assert.equal(engineer.rig.bones.paw_R.children.length, 0, 'no procedural tool: the pouch is the tool');
    factory.destroyPanda(engineer.model); factory.destroyPanda(writer.model);
  }
  assert.equal(factory.instances.size, 0);
  factory.dispose();
});

test('a role whose species failed to load keeps its panda appearance and tool', () => {
  const body = new T.Group(); body.add(new T.Mesh(new T.BoxGeometry(1, 3, 1).translate(0, 1.5, 0), new T.MeshStandardMaterial()));
  const factory = createPandaAppearanceFactory({ body, vest: body.clone(), characters: { 'technical-writer': sources['technical-writer'].source } });
  const engineer = factory.createPanda('developer');
  assert.equal(engineer.model.userData.species, undefined);
  assert.equal(engineer.rig.profile.id, 'bao');
  assert.ok(engineer.rig.bones.paw_R.children.length > 0, 'the developer tool is attached');
  factory.dispose();
});
