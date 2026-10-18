import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import * as T from 'three';
import { createBalancedPandaRig, sampleWaddle, WADDLE, IDLE, PANDA_BONE_NAMES } from './panda-rig.mjs';

// Exercise the shipped mesh in Node, without decoding its embedded browser images.
const compressed = await readFile(new URL('../../../public/den/models/bao.glb.gz', import.meta.url));
const bytes = gunzipSync(compressed), jsonLength = bytes.readUInt32LE(12), gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength));
const bin = bytes.subarray(28 + jsonLength);
const primitive = gltf.meshes[0].primitives[0], geometry = new T.BufferGeometry();
function attribute(index) {
  const accessor = gltf.accessors[index], view = gltf.bufferViews[accessor.bufferView];
  const width = { SCALAR: 1, VEC2: 2, VEC3: 3 }[accessor.type], Type = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array }[accessor.componentType];
  const offset = view.byteOffset + (accessor.byteOffset || 0), data = bin.subarray(offset, offset + accessor.count * width * Type.BYTES_PER_ELEMENT);
  return new T.BufferAttribute(new Type(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)), width);
}
for (const [key, name] of [['POSITION', 'position'], ['NORMAL', 'normal'], ['TEXCOORD_0', 'uv']]) geometry.setAttribute(name, attribute(primitive.attributes[key]));
geometry.setIndex(attribute(primitive.indices));
const texture = new T.Texture(), material = new T.MeshStandardMaterial({ map: texture });
const nodes = gltf.nodes.map(node => {
  const object = node.mesh === undefined ? new T.Group() : new T.Mesh(geometry, material);
  if (node.matrix) { object.matrix.fromArray(node.matrix); object.matrixAutoUpdate = false; }
  return object;
});
gltf.nodes.forEach((node, i) => node.children?.forEach(child => nodes[i].add(nodes[child])));
const source = new T.Group(); gltf.scenes[gltf.scene || 0].nodes.forEach(index => source.add(nodes[index]));

test('the source is the exact approved PR #314 Balanced Bao', () => {
  assert.equal(createHash('sha256').update(compressed).digest('hex'), '793118be3b0c3fa311a9baf21081e7482c713abf60a564333726527b06cc616c');
});

test('the shared rig preserves the original texture, UVs, topology and neutral shape', () => {
  const rig = createBalancedPandaRig(source);
  try {
    assert.deepEqual(rig.skeleton.bones.map(bone => bone.name), PANDA_BONE_NAMES);
    const mesh = rig.meshes[0], positions = mesh.geometry.attributes.position;
    assert.equal(mesh.material.map, texture); assert.deepEqual(mesh.geometry.attributes.uv.array, geometry.attributes.uv.array);
    assert.deepEqual(mesh.geometry.index.array, geometry.index.array);
    const p = new T.Vector3(); let error = 0;
    for (let i = 0; i < positions.count; i++) {
      p.fromBufferAttribute(positions, i); const posed = mesh.applyBoneTransform(i, p.clone()); error = Math.max(error, p.distanceTo(posed));
      let sum = 0;
      for (let j = 0; j < 4; j++) { const weight = mesh.geometry.attributes.skinWeight.array[i * 4 + j]; assert.ok(Number.isFinite(weight) && weight >= 0); sum += weight; }
      assert.ok(Math.abs(sum - 1) < 1e-6);
    }
    assert.ok(error < 1e-5, `neutral skin error ${error}`);
  } finally { rig.dispose(); }
});

test('planted feet hold their world position while the body advances and sways', () => {
  const rig = createBalancedPandaRig(source);
  try {
    for (const [side, start] of [['L', .04], ['R', .54]]) {
      let first;
      for (let i = 0; i <= 16; i++) {
        const time = (start + i * .028) * WADDLE.duration;
        const gait = rig.poseWaddle(time, { travel: true }); assert.ok(gait.feet[side].planted);
        const foot = rig.bones['Ankle_' + side].getWorldPosition(new T.Vector3());
        first ??= foot.clone(); assert.ok(foot.distanceTo(first) < 1e-5, `${side} planted foot slid ${foot.distanceTo(first)}`);
        assert.ok(Math.abs(foot.y - .105) < 1e-5, 'stance ankle stays at its authored sole height');
      }
    }
  } finally { rig.dispose(); }
});

test('both feet reach their targets at every phase and across the preview stride range', () => {
  const rig = createBalancedPandaRig(source);
  try {
    for (const stride of [.35, .56, .68, .72]) for (let frame = 0; frame <= 48; frame++) {
      const gait = rig.poseWaddle(frame / 48 * WADDLE.duration, { stride, travel: true });
      for (const side of ['L', 'R']) {
        const target = rig.travelRoot.localToWorld(new T.Vector3(...gait.feet[side].position));
        const actual = rig.bones['Ankle_' + side].getWorldPosition(new T.Vector3());
        assert.ok(actual.distanceTo(target) < 1e-5, `unreachable ${side} foot at stride ${stride}, phase ${frame / 48}`);
      }
    }
  } finally { rig.dispose(); }
});

test('the textured soles stay above the floor through a complete waddle', () => {
  const rig = createBalancedPandaRig(source);
  try {
    const mesh = rig.meshes[0], positions = mesh.geometry.attributes.position;
    const soles = Array.from({ length: positions.count }, (_, i) => i).filter(i => positions.getY(i) < .04);
    assert.ok(soles.length > 50);
    for (let frame = 0; frame <= 32; frame++) {
      rig.poseWaddle(frame / 32 * WADDLE.duration, { travel: true });
      for (const i of soles) {
        const p = mesh.applyBoneTransform(i, new T.Vector3().fromBufferAttribute(positions, i)); mesh.localToWorld(p);
        assert.ok(p.y > -.0001, `sole below floor: ${p.y} at frame ${frame}`);
      }
    }
  } finally { rig.dispose(); }
});

test('resident, cub and Bao scales retain foot contact after placement and rotation', () => {
  const rig = createBalancedPandaRig(source);
  try {
    for (const scale of [.52, .68, 1.35]) {
      rig.model.scale.setScalar(scale); rig.model.position.set(3, .4, -2); rig.model.rotation.y = .6;
      for (let frame = 0; frame <= 12; frame++) {
        const gait = rig.poseWaddle(frame / 12 * WADDLE.duration, { travel: true });
        for (const side of ['L', 'R']) {
          const actual = rig.bones['Ankle_' + side].getWorldPosition(new T.Vector3());
          const target = rig.travelRoot.localToWorld(new T.Vector3(...gait.feet[side].position));
          assert.ok(actual.distanceTo(target) < 1e-5, `${side} foot missed at scale ${scale}: ${actual.distanceTo(target)}`);
        }
      }
    }
  } finally { rig.dispose(); }
});

test('touchdown is continuous and stops the foot smoothly', () => {
  for (const boundary of [.6, 1]) {
    const epsilon = 1e-5, at = sampleWaddle(boundary * WADDLE.duration), before = sampleWaddle((boundary - epsilon) * WADDLE.duration), after = sampleWaddle((boundary + epsilon) * WADDLE.duration);
    const worldZ = sample => sample.distance + sample.feet.L.position[2];
    assert.ok(Math.abs(worldZ(before) - worldZ(after)) < 1e-7);
    assert.ok(Math.abs(before.feet.L.position[1] - after.feet.L.position[1]) < 1e-7);
    assert.ok(Math.abs(worldZ(at) - worldZ(before)) / epsilon < .001);
  }
});

test('instances have independent poses, and reduced motion restores the neutral pose', () => {
  const first = createBalancedPandaRig(source), second = createBalancedPandaRig(source);
  try {
    first.poseWaddle(.27, { travel: true });
    assert.notEqual(first.skeleton, second.skeleton); assert.notEqual(first.bones.Head, second.bones.Head);
    assert.equal(second.travelRoot.position.z, 0); assert.equal(second.bones.Pelvis.position.x, 0);
    first.poseWaddle(80, { reducedMotion: true, travel: true });
    assert.equal(first.travelRoot.position.z, 0); assert.equal(first.bones.Pelvis.position.x, 0);
    for (const bone of first.skeleton.bones) assert.ok(bone.quaternion.angleTo(new T.Quaternion()) < 1e-7);
  } finally { first.dispose(); second.dispose(); }
});

test('a fitted outfit binds to the same skeleton and exposes paw and hat sockets', () => {
  const rig = createBalancedPandaRig(source), outfit = new T.Group();
  const garment = new T.Mesh(new T.BoxGeometry(.9, .6, .4), new T.MeshStandardMaterial()); garment.position.set(0, 1.7, .3); outfit.add(garment);
  const roleTint = () => {}; garment.material.onBeforeCompile = roleTint;
  try {
    rig.addOutfit(outfit); assert.equal(rig.outfits.children[0].skeleton, rig.skeleton);
    assert.equal(rig.outfits.children[0].material.onBeforeCompile, roleTint, 'the current wardrobe tint shader survives skinning');
    for (const socket of ['paw_L', 'paw_R', 'hat']) assert.ok(rig.bones[socket]?.isBone);
    rig.poseWaddle(.3); assert.ok(rig.bones.paw_L.getWorldPosition(new T.Vector3()).toArray().every(Number.isFinite));
  } finally { rig.dispose(); garment.geometry.dispose(); garment.material.dispose(); }
});

test('idle breathing gently moves the torso while the skinned soles stay fixed', () => {
  const rig = createBalancedPandaRig(source);
  try {
    const mesh = rig.meshes[0], positions = mesh.geometry.attributes.position;
    const soles = Array.from({ length: positions.count }, (_, i) => i).filter(i => positions.getY(i) < .04);
    const skin = i => mesh.applyBoneTransform(i, new T.Vector3().fromBufferAttribute(positions, i));
    rig.poseIdle(0);
    const feet = soles.map(skin), head = rig.bones.Head.getWorldPosition(new T.Vector3());
    for (let frame = 0; frame <= 24; frame++) {
      rig.poseIdle(frame / 24 * IDLE.duration);
      soles.forEach((i, j) => assert.ok(skin(i).distanceTo(feet[j]) < 1e-7, 'idle breathing moved a sole'));
    }
    rig.poseIdle(IDLE.duration / 2);
    const rise = rig.bones.Head.getWorldPosition(new T.Vector3()).y - head.y;
    assert.ok(rise > .005 && rise < .025, `subtle upper-body rise: ${rise}`);
    const inhale = rig.skeleton.bones.map(bone => bone.matrixWorld.clone());
    rig.poseIdle(IDLE.duration * 20.5);
    rig.skeleton.bones.forEach((bone, i) => bone.matrixWorld.elements.forEach((value, j) => assert.ok(Math.abs(value - inhale[i].elements[j]) < 1e-7, 'idle accumulated drift')));
    rig.poseIdle(IDLE.duration * 21);
    assert.ok(rig.bones.Head.getWorldPosition(new T.Vector3()).distanceTo(head) < 1e-7, 'loop did not close');
    rig.poseIdle(1, { reducedMotion: true });
    for (const bone of rig.skeleton.bones) {
      assert.ok(bone.quaternion.angleTo(new T.Quaternion()) < 1e-7);
      assert.deepEqual(bone.scale.toArray(), [1, 1, 1]);
    }
  } finally { rig.dispose(); }
});

test('approved weightier waddle relaxes arms and follows the hips without changing idle cadence', () => {
  const rig = createBalancedPandaRig(source);
  try {
    const ranges = { arm: [], hip: [], spine: [], chest: [], head: [], wrist: [], elbow: [] };
    for (let frame = 0; frame < 48; frame++) {
      rig.poseWaddle(frame / 48 * WADDLE.duration);
      const b = rig.bones;
      assert.ok(b.Shoulder_L.rotation.z < -.29 && b.Shoulder_R.rotation.z > .29, 'arms hang toward the body');
      assert.ok(Math.abs(b.Shoulder_L.rotation.x + b.Shoulder_R.rotation.x) < 1e-7, 'arms swing in opposition');
      for (const [key, value] of Object.entries({ arm: b.Shoulder_L.rotation.x, hip: b.Pelvis.position.x, spine: b.Spine.rotation.y, chest: b.Chest.rotation.y, head: b.Head.rotation.z, wrist: b.Wrist_L.rotation.x, elbow: b.Elbow_L.rotation.x })) ranges[key].push(value);
    }
    const span = key => Math.max(...ranges[key]) - Math.min(...ranges[key]);
    assert.ok(span('arm') > .75 && span('arm') < .77, 'approved broad arm swing');
    assert.ok(span('hip') > .129 && span('hip') < .131, 'approved deeper hip shift');
    assert.ok(span('spine') > .069 && span('chest') > .029 && span('head') > .027, 'torso and head follow through');
    assert.ok(span('wrist') > .089 && span('elbow') > .099, 'wrists and elbows soften the swing');
    assert.equal(IDLE.duration, 4.8);
    rig.poseIdle(0);
    assert.ok(rig.bones.Shoulder_L.rotation.z < -.31, 'idle retains relaxed arms');
    assert.ok(rig.bones.Elbow_L.rotation.x < -.11, 'idle retains soft elbows');
    assert.equal(rig.poseIdle(2.4).breath, 1);
  } finally { rig.dispose(); }
});

test('the full lower paw follows its wrist rigidly through the wider swing', () => {
  const rig = createBalancedPandaRig(source);
  try {
    const mesh = rig.meshes[0], positions = mesh.geometry.attributes.position;
    const tips = Array.from({ length: positions.count }, (_, i) => i).filter(i => Math.abs(positions.getX(i)) > 1.22 && positions.getY(i) > .95 && positions.getY(i) < 1.17);
    assert.ok(tips.length > 30, 'exercise the actual lower hand vertices');
    const skin = i => mesh.applyBoneTransform(i, new T.Vector3().fromBufferAttribute(positions, i));
    const local = i => rig.bones['Wrist_' + (positions.getX(i) > 0 ? 'L' : 'R')].worldToLocal(mesh.localToWorld(skin(i)));
    const rest = tips.map(local);
    for (let frame = 0; frame < 24; frame++) {
      rig.poseWaddle(frame / 24 * WADDLE.duration);
      tips.forEach((i, index) => assert.ok(local(i).distanceTo(rest[index]) < 1e-6, 'hand tip stretched away from its wrist'));
    }
  } finally { rig.dispose(); }
});
