import * as T from 'three';

// Shared rig: Balanced Bao (PR #314), feet=0, crown=3, front=+Z.
// The original continuous mesh, indices, UVs and texture maps are retained.
const REST = [
  ['Root', null, [0, 0, 0]], ['Pelvis', 'Root', [0, .85, 0]],
  ['Spine', 'Pelvis', [0, 1.35, -.03]], ['Chest', 'Spine', [0, 1.88, -.03]],
  ['Neck', 'Chest', [0, 2.10, 0]], ['Head', 'Neck', [0, 2.40, .02]],
  ['Jaw', 'Head', [0, 2.17, .48]], ['hat', 'Head', [0, 2.91, -.03]],
];
for (const [side, sign] of [['L', 1], ['R', -1]]) REST.push(
  ['Ear_' + side, 'Head', [sign * .56, 2.83, -.04]],
  ['Shoulder_' + side, 'Chest', [sign * .65, 1.96, .01]],
  ['Elbow_' + side, 'Shoulder_' + side, [sign * 1.04, 1.53, .06]],
  ['Wrist_' + side, 'Elbow_' + side, [sign * 1.30, 1.19, .12]],
  ['paw_' + side, 'Wrist_' + side, [sign * 1.35, 1.12, .17]],
  ['Hip_' + side, 'Pelvis', [sign * .49, .65, -.01]],
  ['Knee_' + side, 'Hip_' + side, [sign * .49, .37, .12]],
  ['Ankle_' + side, 'Knee_' + side, [sign * .49, .105, .04]],
  ['Toe_' + side, 'Ankle_' + side, [sign * .49, .075, .27]],
);
export const PANDA_BONE_NAMES = Object.freeze(REST.map(([name]) => name));
export const WADDLE = Object.freeze({ stride: .56, duration: 1.20, lift: .095, sway: .065, stance: .60 });
export const IDLE = Object.freeze({ duration: 4.8 });
const BAO_FOOT = Object.freeze({ x: .49, y: .105, z: .04 });
const clamp = T.MathUtils.clamp;
const smooth = (a, b, value) => T.MathUtils.smoothstep(value, a, b);
const modulo = value => ((value % 1) + 1) % 1;
const point = value => new T.Vector3(...value);
const torso = [['Pelvis', .65], ['Spine', 1.3], ['Chest', 1.87], ['Neck', 2.08], ['Head', 2.25]];

// Deliberate anatomical bands for this specific mesh. Equal-position UV seams
// always receive equal weights; no distance-to-bone/heat weighting crosses the belly.
function weightsFor(position, headOnly = false) {
  if (headOnly) return [['Head', 1]];
  const { x, y, z } = position, ax = Math.abs(x), side = x >= 0 ? 'L' : 'R';
  const weights = new Map();
  const add = (name, weight) => { if (weight > 1e-7) weights.set(name, (weights.get(name) || 0) + weight); };
  const armBoundary = .98 - .45 * clamp((y - 1.25) / .75, 0, 1);
  // Include the whole lower paw so the broader swing cannot leave its tips on the torso.
  const arm = smooth(armBoundary, armBoundary + .22, ax) * smooth(.75, .95, y) * (1 - smooth(1.98, 2.18, y));
  // Even the inner edge of each sole belongs fully to its foot; only the upper
  // leg blends toward the central belly. Otherwise body bob pulls toes below ground.
  const leg = (1 - smooth(.43, .76, y)) * T.MathUtils.lerp(1, smooth(.17, .34, ax), smooth(.17, .42, y));
  const core = Math.max(0, 1 - arm - leg);
  let low = torso[0], high = low;
  for (let i = 0; i < torso.length - 1; i++) if (y >= torso[i][1]) { low = torso[i]; high = torso[i + 1]; }
  if (y >= torso.at(-1)[1]) low = high = torso.at(-1);
  const blend = low === high ? 0 : smooth(low[1], high[1], y);
  add(low[0], core * (1 - blend)); add(high[0], core * blend);
  if (arm > 0) {
    if (y >= 1.53) {
      const t = smooth(1.53, 1.94, y); add('Elbow_' + side, arm * (1 - t)); add('Shoulder_' + side, arm * t);
    } else {
      const t = smooth(1.18, 1.53, y); add('Wrist_' + side, arm * (1 - t)); add('Elbow_' + side, arm * t);
    }
  }
  if (leg > 0) {
    if (y > .32) {
      const t = smooth(.32, .59, y); add('Knee_' + side, leg * (1 - t)); add('Hip_' + side, leg * t);
    } else {
      const t = smooth(.17, .32, y);
      const toe = (1 - t) * smooth(.15, .32, z);
      add('Knee_' + side, leg * t); add('Ankle_' + side, leg * (1 - t - toe)); add('Toe_' + side, leg * toe);
    }
  }
  const top = [...weights].sort((a, b) => b[1] - a[1]).slice(0, 4), total = top.reduce((n, [, w]) => n + w, 0);
  return top.map(([name, weight]) => [name, weight / total]);
}

/** Continuous foot paths with matching velocity at lift-off and touchdown. */
export function sampleWaddle(time, settings = {}) {
  const config = { ...WADDLE, foot: BAO_FOOT, ...settings };
  if (!Number.isFinite(time) || !Number.isFinite(config.duration) || config.duration <= 0 || !Number.isFinite(config.stride) || config.stride < 0 || config.stride > .72 || !Number.isFinite(config.lift) || config.lift < 0 || config.lift > .16 || !Number.isFinite(config.sway) || Math.abs(config.sway) > .07) throw Error('Invalid panda gait settings');
  const cycles = time / config.duration, stride = config.stride, stance = WADDLE.stance;
  const feet = {};
  for (const [side, offset, sign] of [['L', 0, 1], ['R', .5, -1]]) {
    const phase = modulo(cycles + offset), planted = phase < stance;
    let z, lift = 0, outward = 0;
    if (planted) z = stride * (stance / 2 - phase);
    else {
      const s = (phase - stance) / (1 - stance), back = -stride * stance / 2, front = -back, tangent = -stride * (1 - stance);
      z = (2*s**3-3*s**2+1)*back + (s**3-2*s**2+s)*tangent + (-2*s**3+3*s**2)*front + (s**3-s**2)*tangent;
      lift = config.lift * Math.sin(Math.PI * s) ** 2; outward = .018 * Math.sin(Math.PI * s) ** 2;
    }
    feet[side] = { position: [sign * (config.foot.x + outward), config.foot.y + lift, config.foot.z + z], planted, phase };
  }
  return { cycles, distance: cycles * stride, feet, config };
}

/** The shared rig's per-species data; Bao's is the original Balanced Bao contract. */
export const BAO_PROFILE = Object.freeze({ id: 'bao', label: 'Balanced Bao', rest: REST, weightsFor, height: 3, offset: [0, 0], foot: BAO_FOOT });

/** Build an independent skeleton and skinned meshes from the approved GLTF scene. */
export function createBalancedPandaRig(source) { return createRig(source, BAO_PROFILE); }

/**
 * One rig builder for every species: a profile supplies the rest skeleton (which must
 * include the shared bone names), vertex weights, normalised height/centre and foot origin.
 * Optional `animate(bones, motion)` adds species motion (tails); optional `sit` enables poseSit.
 */
export function createRig(source, profile) {
  source.updateMatrixWorld(true);
  const arms = { drop: .32, swing: { L: 1, R: 1 }, ...profile.arms };
  const bounds = new T.Box3().setFromObject(source), size = bounds.getSize(new T.Vector3()), center = bounds.getCenter(new T.Vector3());
  if (!Number.isFinite(size.y) || size.y <= 0) throw Error(profile.label + ' has no usable geometry');
  const scale = profile.height / size.y, [offsetX, offsetZ] = profile.offset;
  const normalize = new T.Matrix4().makeTranslation(-offsetX, 0, -offsetZ).multiply(new T.Matrix4().makeScale(scale, scale, scale)).multiply(new T.Matrix4().makeTranslation(-center.x, -bounds.min.y, -center.z));
  const model = new T.Group(), travelRoot = new T.Group(); model.name = profile.label + ' — shared skeleton'; model.add(travelRoot);
  const bones = {}, boneList = [], indices = {}, restLocal = {};
  const rest = profile.rest, restAnchors = Object.fromEntries(rest.map(([name, , position]) => [name, point(position)]));
  for (const name of PANDA_BONE_NAMES) if (!restAnchors[name]) throw Error(profile.label + ' rig lacks shared bone ' + name);
  for (const [name, parent, world] of rest) {
    const bone = new T.Bone(); bone.name = name;
    bone.position.copy(point(world)).sub(parent ? restAnchors[parent] : new T.Vector3());
    restLocal[name] = bone.position.clone(); (parent ? bones[parent] : travelRoot).add(bone);
    indices[name] = boneList.length; boneList.push(bone); bones[name] = bone;
  }
  model.updateMatrixWorld(true);
  const skeleton = new T.Skeleton(boneList); skeleton.calculateInverses();
  const meshes = [], outfits = new T.Group(); outfits.name = 'Shared-rig outfit'; travelRoot.add(outfits);
  const originalMaterials = new Map();
  const weightMaterial = new T.MeshStandardMaterial({ vertexColors: true, roughness: .85 });
  let weightsVisible = false;
  function skinObject(object, parent, transform = new T.Matrix4(), headOnly = false) {
    object.updateMatrixWorld(true);
    object.traverse(node => {
      if (!node.isMesh || !node.geometry) return;
      if (node.isSkinnedMesh) throw Error('Expected an unrigged ' + profile.label + ' asset');
      const geometry = node.geometry.clone().applyMatrix4(transform.clone().multiply(node.matrixWorld));
      const positions = geometry.attributes.position, skinIndices = new Uint16Array(positions.count * 4), skinWeights = new Float32Array(positions.count * 4), colors = new Float32Array(positions.count * 3);
      const position = new T.Vector3(), color = new T.Color();
      for (let i = 0; i < positions.count; i++) {
        position.fromBufferAttribute(positions, i);
        const attachment=node.userData.attachBone;
        if(attachment&&!bones[attachment])throw Error('Unknown outfit attachment bone: '+attachment);
        const weights = attachment?[[attachment,1]]:profile.weightsFor(position, headOnly || Boolean(node.userData.headwearRole));
        weights.forEach(([name, weight], slot) => { skinIndices[i * 4 + slot] = indices[name]; skinWeights[i * 4 + slot] = weight; });
        color.setHSL((indices[weights[0][0]] * .173) % 1, .62, .57); color.toArray(colors, i * 3);
      }
      geometry.setAttribute('skinIndex', new T.Uint16BufferAttribute(skinIndices, 4));
      geometry.setAttribute('skinWeight', new T.Float32BufferAttribute(skinWeights, 4)); geometry.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
      const clone = material => {
        const result = material.clone();
        // Three's material clone omits these callbacks; the approved role colors use them.
        result.onBeforeCompile = material.onBeforeCompile; result.customProgramCacheKey = material.customProgramCacheKey;
        return result;
      };
      const materials = Array.isArray(node.material) ? node.material.map(clone) : clone(node.material);
      const mesh = new T.SkinnedMesh(geometry, materials); mesh.name = node.name || profile.label + ' skin';
      mesh.userData = {...node.userData};
      mesh.castShadow = true; mesh.receiveShadow = false; mesh.frustumCulled = false;
      parent.add(mesh); mesh.bind(skeleton, new T.Matrix4()); originalMaterials.set(mesh, materials);
      if (weightsVisible) mesh.material = weightMaterial;
      meshes.push(mesh);
    });
  }
  skinObject(source, travelRoot, normalize);
  function resetPose() {
    travelRoot.position.set(0, 0, 0);
    for (const bone of boneList) { bone.position.copy(restLocal[bone.name]); bone.quaternion.identity(); bone.scale.set(1, 1, 1); }
    model.updateMatrixWorld(true); skeleton.update();
  }
  const up = new T.Vector3(0, 0, 1), inverse = new T.Quaternion(), desired = new T.Vector3();
  function solveLeg(side, targetLocal) {
    const hip = bones['Hip_' + side], knee = bones['Knee_' + side], ankle = bones['Ankle_' + side];
    const hipWorld = hip.getWorldPosition(new T.Vector3());
    const target = travelRoot.localToWorld(point(targetLocal));
    const worldScale = travelRoot.getWorldScale(new T.Vector3()).x;
    const upper = restLocal[knee.name].length() * worldScale, lower = restLocal[ankle.name].length() * worldScale;
    const direction = target.clone().sub(hipWorld), distance = clamp(direction.length(), Math.abs(upper - lower) + .00001, upper + lower - .00001); direction.normalize();
    const forward = up.clone().transformDirection(travelRoot.matrixWorld);
    const bend = forward.addScaledVector(direction, -forward.dot(direction)).normalize();
    const along = (upper * upper - lower * lower + distance * distance) / (2 * distance), height = Math.sqrt(Math.max(0, upper * upper - along * along));
    const kneeWorld = hipWorld.clone().addScaledVector(direction, along).addScaledVector(bend, height);
    hip.parent.getWorldQuaternion(inverse).invert(); desired.copy(kneeWorld).sub(hipWorld).applyQuaternion(inverse).normalize();
    hip.quaternion.setFromUnitVectors(restLocal[knee.name].clone().normalize(), desired); hip.updateWorldMatrix(false, true);
    knee.parent.getWorldQuaternion(inverse).invert(); desired.copy(target).sub(kneeWorld).applyQuaternion(inverse).normalize();
    knee.quaternion.setFromUnitVectors(restLocal[ankle.name].clone().normalize(), desired); knee.updateWorldMatrix(false, true);
    ankle.parent.getWorldQuaternion(inverse).invert();
    ankle.quaternion.copy(inverse).multiply(travelRoot.getWorldQuaternion(new T.Quaternion())); ankle.updateWorldMatrix(false, true);
  }
  function poseWaddle(time, { travel = false, reducedMotion = false, ...settings } = {}) {
    resetPose(); if (reducedMotion) return null;
    const gait = sampleWaddle(time, { foot: profile.foot, ...settings }), phase = gait.cycles * Math.PI * 2;
    travelRoot.position.z = travel ? gait.distance : 0;
    const sway = Math.cos(phase - Math.PI * .6);
    bones.Pelvis.position.x += gait.config.sway * sway;
    bones.Pelvis.position.y += -.030 + .014 * Math.cos(phase * 2);
    bones.Pelvis.rotation.z = -.045 * sway;
    bones.Spine.rotation.z = .022 * Math.cos(phase - Math.PI * .6 - .20);
    bones.Spine.rotation.y = .035 * Math.sin(phase - .28);
    bones.Spine.rotation.x = .018 + .008 * Math.cos(phase * 2);
    bones.Chest.rotation.y = -.015 * Math.sin(phase - .48);
    bones.Head.rotation.z = .014 * Math.cos(phase - Math.PI * .6 - .35);
    bones.Head.rotation.x = -.012;
    for (const [side, sign, offset] of [['L', 1, 0], ['R', -1, Math.PI]]) {
      const swing = Math.cos(phase + offset - .16);
      bones['Shoulder_' + side].rotation.z = -sign * (arms.drop + .025 * Math.sin(phase + offset)) * arms.swing[side];
      bones['Shoulder_' + side].rotation.x = .38 * swing * arms.swing[side];
      bones['Elbow_' + side].rotation.x = (-.16 - .10 * Math.max(0, -Math.cos(phase + offset - .25))) * arms.swing[side];
      bones['Wrist_' + side].rotation.x = .045 * Math.sin(phase + offset - .35) * arms.swing[side];
    }
    model.updateMatrixWorld(true);
    // Keep short legs within reach at longer strides, instead of clamping an
    // unreachable foot and allowing its planted position to slide.
    let lowerBy = 0;
    for (const side of ['L', 'R']) {
      const hip = travelRoot.worldToLocal(bones['Hip_' + side].getWorldPosition(new T.Vector3()));
      const target = point(gait.feet[side].position);
      const reach = (restLocal['Knee_' + side].length() + restLocal['Ankle_' + side].length()) * .985;
      const vertical = Math.sqrt(Math.max(0, reach ** 2 - (hip.x - target.x) ** 2 - (hip.z - target.z) ** 2));
      lowerBy = Math.max(lowerBy, hip.y - target.y - vertical);
    }
    if (lowerBy > 0) { bones.Pelvis.position.y -= lowerBy; model.updateMatrixWorld(true); }
    for (const side of ['L', 'R']) solveLeg(side, gait.feet[side].position);
    profile.animate?.(bones, { kind: 'walk', phase });
    model.updateMatrixWorld(true); skeleton.update(); return gait;
  }
  function poseIdle(time, { reducedMotion = false } = {}) {
    resetPose(); if (reducedMotion) return null;
    if (!Number.isFinite(time)) throw Error('Invalid panda idle time');
    const cycles = time / IDLE.duration, breath = (1 - Math.cos(cycles * Math.PI * 2)) / 2;
    // Expand only the upper body. The pelvis, legs and soles stay planted;
    // garments follow these same bones instead of floating above the belly.
    bones.Spine.scale.set(1 + .008 * breath, 1 + .003 * breath, 1 + .014 * breath);
    bones.Chest.scale.set(1 + .008 * breath, 1 + .004 * breath, 1 + .012 * breath);
    bones.Chest.position.y += .006 * breath;
    bones.Head.rotation.x = -.006 * breath;
    for (const [side, sign] of [['L', 1], ['R', -1]]) {
      bones['Shoulder_' + side].rotation.z = -sign * (arms.drop - .008 * breath) * arms.swing[side];
      bones['Elbow_' + side].rotation.x = -.12 * arms.swing[side];
    }
    profile.animate?.(bones, { kind: 'idle', phase: cycles * Math.PI * 2, breath });
    model.updateMatrixWorld(true); skeleton.update();
    return { cycles, breath };
  }
  /** Seated at a table: hips lowered by the profile's drop, thighs forward, shins hanging. */
  function poseSit(time, { reducedMotion = false } = {}) {
    if (!profile.sit) throw Error(profile.label + ' has no seated pose');
    resetPose();
    const { drop, hip, knee, splay = 0 } = profile.sit, breath = reducedMotion ? 0 : (1 - Math.cos(time / IDLE.duration * Math.PI * 2)) / 2;
    bones.Pelvis.position.y -= drop;
    for (const [side, sign] of [['L', 1], ['R', -1]]) {
      // Legs come forward and splay outward, teddy-bear style, so short legs clear a round belly.
      bones['Hip_' + side].rotation.set(-hip, 0, sign * splay); bones['Knee_' + side].rotation.x = knee;
      bones['Shoulder_' + side].rotation.z = -sign * (arms.drop - .008 * breath) * arms.swing[side]; bones['Elbow_' + side].rotation.x = -.12 * arms.swing[side];
    }
    bones.Chest.scale.set(1 + .008 * breath, 1 + .004 * breath, 1 + .012 * breath);
    profile.animate?.(bones, { kind: 'sit', phase: time / IDLE.duration * Math.PI * 2, breath, reducedMotion, drop });
    model.updateMatrixWorld(true); skeleton.update();
    return { breath };
  }
  function addOutfit(outfit) {
    // Garments use the existing wardrobe factory's canonical 3-unit Bao coordinates.
    resetPose(); skinObject(outfit, outfits); return outfits;
  }
  function setWeightColors(visible) {
    weightsVisible = visible;
    for (const mesh of meshes) mesh.material = visible ? weightMaterial : originalMaterials.get(mesh);
  }
  function dispose() {
    const materials = new Set([weightMaterial]);
    for (const mesh of meshes) { mesh.geometry.dispose(); for (const material of Array.isArray(originalMaterials.get(mesh)) ? originalMaterials.get(mesh) : [originalMaterials.get(mesh)]) materials.add(material); }
    for (const material of materials) material.dispose(); skeleton.dispose(); model.removeFromParent();
  }
  return { model, travelRoot, bones, skeleton, meshes, outfits, profile, resetPose, poseWaddle, poseIdle, poseSit, addOutfit, setWeightColors, dispose };
}
