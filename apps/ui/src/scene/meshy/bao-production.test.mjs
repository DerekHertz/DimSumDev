import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as T from 'three';
import { readGlbGeometry } from "../../../assets-src/den/read-glb-geometry.mjs";
import { createBalancedPandaRig } from './panda-rig.mjs';
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
  assert.equal(asset.textures.length, 1, 'selected Meshy finish remains a colour texture');
  assert.ok(asset.textures[0].width <= 512 && asset.textures[0].height <= 512);
  for (const p of primitives) assert.ok(p.attributes.TEXCOORD_0 !== undefined, 'source UVs preserve face and robe');
  for (const m of gltf.materials) {
    assert.ok(m.pbrMetallicRoughness.baseColorTexture);
    assert.equal(m.normalTexture, undefined);
    assert.equal(m.pbrMetallicRoughness.metallicRoughnessTexture, undefined);
  }
  for (const m of gltf.materials) {
    assert.ok(m.pbrMetallicRoughness.roughnessFactor >= .9);
    assert.equal(m.pbrMetallicRoughness.metallicFactor, 0);
  }
  assert.ok(manifest.assets.bao, 'existing body remains for failed loads and rollback');
});

test('Bao ships its matching cached portrait while retaining the existing rollback portrait and Jiao', () => {
  assert.equal(ROLE_PORTRAITS.orchestrator,'/den/portraits/bao-jade.webp');
  assert.equal(ROLE_PORTRAITS['codex:orchestrator'],'/den/portraits/orchestrator-jiao.webp');
  assert.equal(ROLE_PORTRAIT_FALLBACKS['codex:orchestrator'],'/den/portraits/codex-orchestrator.webp');
  assert.equal(ROLE_PORTRAIT_FALLBACKS.orchestrator,'/den/portraits/orchestrator.webp');
  const portraitBytes=readFileSync(new URL('../../../public'+ROLE_PORTRAITS.orchestrator,import.meta.url)).length;
  assert.ok(portraitBytes>1000 && portraitBytes<=40*1024, `${portraitBytes} portrait bytes, cap 40 KiB`);
  assert.ok(readFileSync(new URL('../../../public'+ROLE_PORTRAIT_FALLBACKS.orchestrator,import.meta.url)).length>1000);
});

test('Bao selects the replacement in every Claude instance while Jiao and failed loads retain their appearance', async () => {
  const a = manifest.assets['characters.bao'];
  const b = gunzipSync(readFileSync(new URL('../../../public' + a.url, import.meta.url)));
  const baoSource = readGlbGeometry(b);
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
  const source = readGlbGeometry(b);
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

test('Bao reproducible source is the user-selected Meshy A rather than the rejected local route', () => {
  const provenance=JSON.parse(readFileSync(new URL('../../../assets-src/den/bao-provenance.json',import.meta.url)));
  assert.equal(provenance.selectedSourceTask,'01a15a76-e214-75bf-a510-25c77230a8a2');
  assert.equal(provenance.remeshTask,'01a15a82-843f-740c-a650-be1b2ad33877');
  assert.equal(provenance.meshyCredits,65);
  assert.equal(provenance.purchases,0);
});

test('Bao wave raises the outer paw beside its head instead of folding it into the torso', () => {
  const a=manifest.assets['characters.bao'],b=gunzipSync(readFileSync(new URL('../../../public'+a.url,import.meta.url)));
  const factory=createPandaAppearanceFactory({characters:{bao:readGlbGeometry(b)}}),{rig,model}=factory.createPanda('orchestrator');model.scale.setScalar(1);
  const gesture=createLeisureGesture(rig),samples=[],p=new T.Vector3();
  try{
    rig.poseIdle(.4);
    for(const mesh of rig.meshes){const position=mesh.geometry.attributes.position;for(let i=0;i<position.count;i++){
      p.fromBufferAttribute(position,i);
      if(p.x>1.25&&p.y>1&&p.y<1.4){samples.push({mesh,i});}
    }}
    assert.ok(samples.length>10,'the actual outer paw has sampled vertices');
    gesture.pose('greeting',.4);
    let x=0,y=0;for(const {mesh,i}of samples){p.fromBufferAttribute(mesh.geometry.attributes.position,i);mesh.applyBoneTransform(i,p);x+=p.x;y+=p.y;}
    assert.ok(y/samples.length>2.2,`wave paw height ${y/samples.length}`);
    assert.ok(x/samples.length>.8,`wave paw stays beside head: ${x/samples.length}`);
    for(const mesh of rig.meshes){
      const pos=mesh.geometry.attributes.position,posed=Array.from({length:pos.count},(_,i)=>mesh.applyBoneTransform(i,new T.Vector3().fromBufferAttribute(pos,i)));
      for(let i=0;i<mesh.geometry.index.count;i+=3)for(const [a,b]of [[0,1],[1,2],[2,0]]){
        const ai=mesh.geometry.index.getX(i+a),bi=mesh.geometry.index.getX(i+b),v=new T.Vector3().fromBufferAttribute(pos,ai),w=new T.Vector3().fromBufferAttribute(pos,bi),rest=v.distanceTo(w);
        if(rest>.03)assert.ok(posed[ai].distanceTo(posed[bi])/rest<3,`wave stretches sleeve edge ${posed[ai].distanceTo(posed[bi])/rest} times from ${v.toArray()} to ${w.toArray()}`);
      }
    }
  }finally{gesture.dispose();factory.dispose();}
});

test('Bao reduced motion keeps its fitted resting arms in idle, work and stopped walking', () => {
  const source=readGlbGeometry(gunzipSync(readFileSync(new URL('../../../public'+manifest.assets['characters.bao'].url,import.meta.url))));
  const factory=createPandaAppearanceFactory({characters:{bao:source}}),{rig}=factory.createPanda('orchestrator');
  function vertices(){return rig.meshes.flatMap(mesh=>Array.from({length:mesh.geometry.attributes.position.count},(_,i)=>mesh.applyBoneTransform(i,new T.Vector3().fromBufferAttribute(mesh.geometry.attributes.position,i)).toArray()));}
  function equalPose(actual,expected,label){const delta=Math.max(...actual.flatMap((p,i)=>p.map((v,j)=>Math.abs(v-expected[i][j]))));assert.ok(delta<1e-8,`${label}: maximum vertex displacement ${delta}`);}
  try{
    rig.poseIdle(0);const neutral=vertices();
    rig.poseIdle(0,{reducedMotion:true});const still=vertices();
    equalPose(still,neutral,'reduced motion retains the normal resting posture');
    rig.poseIdle(2.4,{reducedMotion:true});equalPose(vertices(),still,'idle/work posture has no ambient motion');
    rig.poseWaddle(.4,{reducedMotion:true});equalPose(vertices(),still,'stopped walking uses the same resting posture');
    for(const sign of [-1,1]){
      const paw=[];
      for(const mesh of rig.meshes){const pos=mesh.geometry.attributes.position;for(let i=0;i<pos.count;i++)if(sign*pos.getX(i)>1.25&&pos.getY(i)>1&&pos.getY(i)<1.4)paw.push(mesh.applyBoneTransform(i,new T.Vector3().fromBufferAttribute(pos,i)));}
      const center=paw.reduce((sum,p)=>sum.add(p),new T.Vector3()).divideScalar(paw.length);
      assert.ok(sign*center.x<1.3&&sign*center.x>.85,`resting paw beside robe: ${center.x}`);
      assert.ok(center.y<1.15&&center.y>.7,`resting paw below shoulder: ${center.y}`);
    }
  }finally{factory.dispose();}
});

test('Bao pose cycles keep the actual sleeves, collar, pouch and robe connected without stretched edges', () => {
  const source=readGlbGeometry(gunzipSync(readFileSync(new URL('../../../public'+manifest.assets['characters.bao'].url,import.meta.url))));
  const factory=createPandaAppearanceFactory({characters:{bao:source}}),{rig}=factory.createPanda('orchestrator'),gesture=createLeisureGesture(rig);
  const surfaces=rig.meshes.map(mesh=>{
    const pos=mesh.geometry.attributes.position,index=mesh.geometry.index,edges=[];
    for(let i=0;i<index.count;i+=3)for(const [a,b]of [[0,1],[1,2],[2,0]]){
      const ai=index.getX(i+a),bi=index.getX(i+b),rest=new T.Vector3().fromBufferAttribute(pos,ai).distanceTo(new T.Vector3().fromBufferAttribute(pos,bi));
      if(rest>.03)edges.push([ai,bi,rest]);
    }
    return {mesh,pos,edges};
  });
  try{
    for(const kind of ['idle','work','walk','sit','greeting','tea','pond','mahjong'])for(let frame=0;frame<=24;frame++){
      const time=frame*.2;gesture.pose(null,0);
      if(kind==='walk')rig.poseWaddle(time);else if(kind==='sit')rig.poseSit(time);else {rig.poseIdle(time);if(!['idle','work'].includes(kind))gesture.pose(kind,time);}
      let worst=0;
      for(const {mesh,pos,edges}of surfaces){
        const posed=Array.from({length:pos.count},(_,i)=>mesh.applyBoneTransform(i,new T.Vector3().fromBufferAttribute(pos,i)));
        for(const [a,b,rest]of edges)worst=Math.max(worst,posed[a].distanceTo(posed[b])/rest);
      }
      assert.ok(worst<3,`${kind} at ${time.toFixed(1)} stretches a surface edge ${worst} times`);
    }
  }finally{gesture.dispose();factory.dispose();}
});
