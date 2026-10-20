import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as T from 'three';
import { createBalancedPandaRig } from './panda-rig.mjs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createPandaAppearanceFactory } from './panda-appearance.mjs';
import { createLeisureGesture } from './leisure-gesture.mjs';
import { ROLE_PORTRAITS, ROLE_PORTRAIT_FALLBACKS } from '../../shell/role-portraits.mjs';

const manifest = JSON.parse(readFileSync(new URL('../../../public/den/manifest.json', import.meta.url)));

test('Bao ships a complete matte replacement within the approved geometry and texture budgets', () => {
  const asset = manifest.assets['characters.bao'];
  assert.ok(asset, 'Bao replacement is packaged separately from the rollback body');
  assert.equal(asset.roleId, 'orchestrator');
  assert.equal(asset.runtime, 'claude', 'Jiao is a separate identity');
  const bytes = gunzipSync(readFileSync(new URL('../../../public' + asset.url, import.meta.url)));
  const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)));
  const primitives = gltf.meshes.flatMap(m => m.primitives);
  const triangles = primitives.reduce((n, p) => n + gltf.accessors[p.indices].count / 3, 0);
  assert.ok(triangles <= 8000, `${triangles} complete/shadow triangles, target 8k`);
  assert.ok(primitives.length <= 6, 'at most six main-pass draw calls');
  assert.ok((gltf.images || []).length <= 1);
  assert.deepEqual(asset.textures, [], 'flat vertex colours add no unique texture allocation');
  for (const p of primitives) assert.ok(p.attributes.COLOR_0 !== undefined, 'painted panda face and sash colours are packaged');
  for (const m of gltf.materials) {
    assert.ok(m.pbrMetallicRoughness.roughnessFactor >= .9);
    assert.equal(m.pbrMetallicRoughness.metallicFactor, 0);
  }
  assert.ok(manifest.assets.bao, 'existing body remains for failed loads and rollback');
});

test('Bao ships its matching cached portrait while retaining the existing rollback portrait and Jiao', () => {
  assert.equal(ROLE_PORTRAITS.orchestrator,'/den/portraits/bao-jade.webp');
  assert.equal(ROLE_PORTRAITS['codex:orchestrator'],'/den/portraits/codex-orchestrator.webp');
  assert.equal(ROLE_PORTRAIT_FALLBACKS.orchestrator,'/den/portraits/orchestrator.webp');
  assert.ok(readFileSync(new URL('../../../public'+ROLE_PORTRAITS.orchestrator,import.meta.url)).length>1000);
  assert.ok(readFileSync(new URL('../../../public'+ROLE_PORTRAIT_FALLBACKS.orchestrator,import.meta.url)).length>1000);
});

test('Bao selects the replacement in every Claude instance while Jiao and failed loads retain their appearance', async () => {
  const a = manifest.assets['characters.bao'];
  const b = gunzipSync(readFileSync(new URL('../../../public' + a.url, import.meta.url)));
  const baoSource = (await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '')).scene;
  const body = new T.Mesh(new T.BoxGeometry(1, 3, 1).translate(0, 1.5, 0), new T.MeshStandardMaterial());
  const factory = createPandaAppearanceFactory({ body, vest: body, characters: { bao: baoSource } });
  try {
    const bao = factory.createPanda('orchestrator'), visitor = factory.createPanda('orchestrator');
    const jiao = factory.createPanda('orchestrator', { runtime: 'codex' });
    assert.equal(bao.model.userData.species, 'giant-panda');
    assert.equal(visitor.model.userData.species, 'giant-panda');
    assert.equal(jiao.model.userData.species, undefined);
    assert.deepEqual(bao.model.scale.toArray(), jiao.model.scale.toArray());
    assert.equal(bao.model.userData.roleId, 'orchestrator');
    assert.equal(bao.model.userData.runtime, 'claude');
    assert.notEqual(bao.rig.skeleton, visitor.rig.skeleton);
    assert.ok(bao.rig.meshes.reduce((n, m) => n + m.geometry.index.count / 3, 0) <= 8000, 'complete model has no extra old costume');
  } finally { factory.dispose(); }
  const rollback = createPandaAppearanceFactory({ body, vest: body });
  try {
    const old = rollback.createPanda('orchestrator');
    assert.equal(old.rig.profile.id, 'bao');
    assert.equal(old.model.scale.x, 1.35);
    assert.ok(old.rig.bones.paw_R.children.length > 0, 'fallback keeps existing tool/action anchor');
  } finally { rollback.dispose(); }
});

test('the shared rig preserves authored matte colours when weight inspection is toggled', () => {
  const g = new T.BoxGeometry(1, 3, 1).translate(0, 1.5, 0);
  const colour = new Float32Array(g.attributes.position.count * 3).fill(.25);
  g.setAttribute('color', new T.BufferAttribute(colour, 3));
  const source = new T.Mesh(g, new T.MeshStandardMaterial({ vertexColors: true }));
  const rig = createBalancedPandaRig(source);
  try {
    const skin = rig.meshes[0];
    assert.equal(skin.geometry.attributes.color.getX(0), .25);
    rig.setWeightColors(true);
    assert.notEqual(skin.geometry.attributes.color.getX(0), .25);
    rig.setWeightColors(false);
    assert.equal(skin.geometry.attributes.color.getX(0), .25);
    assert.equal(source.geometry.attributes.color.getX(0), .25, 'source stays immutable');
  } finally { rig.dispose(); g.dispose(); source.material.dispose(); }
});

test('Bao supports the shared motions inside conservative head, garment and prop envelopes', async () => {
  const a = manifest.assets['characters.bao'];
  const b = gunzipSync(readFileSync(new URL('../../../public' + a.url, import.meta.url)));
  const source = (await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '')).scene;
  const factory = createPandaAppearanceFactory({ characters: { bao: source } });
  const { rig, model } = factory.createPanda('orchestrator'); model.scale.setScalar(1);
  const gesture = createLeisureGesture(rig), v = new T.Vector3();
  function check(label, kind) {
    model.updateMatrixWorld(true); let radius = 0, top = 0, low = Infinity;
    for (const m of rig.meshes) for (let i = 0; i < m.geometry.attributes.position.count; i++) {
      m.applyBoneTransform(i, v.fromBufferAttribute(m.geometry.attributes.position, i)).applyMatrix4(m.matrixWorld);
      radius = Math.max(radius, Math.hypot(v.x, v.z)); top = Math.max(top, v.y); low = Math.min(low, v.y);
    }
    assert.ok(radius <= rig.profile.envelope[kind].radius, `${label} radius ${radius}`);
    assert.ok(top <= rig.profile.envelope[kind].height, `${label} top ${top}`);
    assert.ok(low >= -.02, `${label} penetrates ground: ${low}`);
  }
  try {
    const geometryBytes = rig.meshes.reduce((n,m) => n + m.geometry.index.array.byteLength + Object.values(m.geometry.attributes).reduce((s,a) => s+a.array.byteLength,0),0);
    assert.ok(geometryBytes <= 2*1048576, `${geometryBytes} bytes`);
    assert.ok(rig.skeleton.bones.length <= 32);
    const meshes=[];model.traverse(m=>{if(m.isMesh)meshes.push(m);});
    assert.ok(meshes.length<=6, 'complete model and optional cup stay within six draws');
    assert.ok(meshes.reduce((n,m)=>n+(m.geometry.index?.count??m.geometry.attributes.position.count)/3,0)<=8000, 'even optional cup stays within 8k target');
    assert.ok(meshes.filter(m=>m.castShadow).reduce((n,m)=>n+(m.geometry.index?.count??m.geometry.attributes.position.count)/3,0)<=8000);
    assert.equal(rig.profile.envelope.head.labelTop,3, 'existing Bao bubble crown anchor stays fixed');
    for(const m of rig.meshes) for(let i=0;i<m.geometry.attributes.skinWeight.count;i++) {
      const w=m.geometry.attributes.skinWeight;
      assert.equal(w.itemSize,4);
      assert.ok(Math.abs(w.getX(i)+w.getY(i)+w.getZ(i)+w.getW(i)-1)<1e-5);
    }
    for(const t of [0,.2,.4,.6,.8,1]) {rig.poseWaddle(t);check('walk '+t,'moving');}
    for(const t of [0,1.2,2.4]) {rig.poseIdle(t);check('idle '+t,'standing');rig.poseSit(t);check('sit '+t,'seated');}
    for(const kind of ['tea','greeting','pond','mahjong']) {rig.poseIdle(1);gesture.pose(kind,1);check(kind,'standing');}
    rig.poseIdle(0,{reducedMotion:true});const rest=rig.bones.Head.matrixWorld.clone();
    rig.poseIdle(2.4,{reducedMotion:true});assert.deepEqual(rig.bones.Head.matrixWorld.elements,rest.elements);
    rig.poseSit(0,{reducedMotion:true});const sit=rig.bones.Head.matrixWorld.clone();
    rig.poseSit(2.4,{reducedMotion:true});assert.deepEqual(rig.bones.Head.matrixWorld.elements,sit.elements);check('reduced sit','seated');
  } finally {gesture.dispose();factory.dispose();}
});

test('Bao keeps the source panda cream forehead instead of sampling the opposite side of its atlas', async () => {
  const a=manifest.assets['characters.bao'],b=gunzipSync(readFileSync(new URL('../../../public'+a.url,import.meta.url)));
  const source=(await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'')).scene;
  let count=0,cream=0;
  source.traverse(m=>{if(!m.isMesh||m.userData.attachBone)return;const p=m.geometry.attributes.position,c=m.geometry.attributes.color;
    for(let i=0;i<p.count;i++)if(Math.abs(p.getX(i))<.22&&p.getY(i)>2.65&&p.getZ(i)>.25){count++;if(c.getX(i)>.55&&c.getY(i)>.5)cream++;}
  });
  assert.ok(count>10);
  assert.ok(cream/count>.85, `${cream}/${count} forehead vertices are cream (brow edges excluded by tolerance)`);
});
