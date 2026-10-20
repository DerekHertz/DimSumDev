// CPU-only fitting evidence on actual packaged geometry. Not a GPU benchmark.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import * as T from 'three';
import { readGlbGeometry } from '../../../apps/ui/assets-src/den/read-glb-geometry.mjs';
import { createPandaAppearanceFactory } from '../../../apps/ui/src/scene/meshy/panda-appearance.mjs';
import { createLeisureGesture } from '../../../apps/ui/src/scene/meshy/leisure-gesture.mjs';
import { RESIDENTS } from '../../../apps/ui/src/shell/resident-inventory.mjs';
const assetRoot=new URL('../../../apps/ui/public/',import.meta.url),manifest=JSON.parse(fs.readFileSync(new URL('./den/manifest.json',assetRoot)));
const a=manifest.assets['characters.bao'],b=gunzipSync(fs.readFileSync(new URL('.'+a.url,assetRoot)));
const source=readGlbGeometry(b);
const factory=createPandaAppearanceFactory({characters:{bao:source}}),{model,rig}=factory.createPanda('orchestrator'),gesture=createLeisureGesture(rig);
model.scale.setScalar(1);
const surfaces=rig.meshes.map(mesh=>{
  const pos=mesh.geometry.attributes.position,index=mesh.geometry.index,edges=[];
  for(let i=0;i<index.count;i+=3)for(const [a,b]of [[0,1],[1,2],[2,0]]){
    const ai=index.getX(i+a),bi=index.getX(i+b),rest=new T.Vector3().fromBufferAttribute(pos,ai).distanceTo(new T.Vector3().fromBufferAttribute(pos,bi));
    if(rest>.03)edges.push([ai,bi,rest]);
  }
  return {mesh,pos,edges};
});
function sample(){
  model.updateMatrixWorld(true);const point=new T.Vector3();let radius=0,top=-Infinity,bottom=Infinity,headRadius=0;
  model.traverse(m=>{if(!m.isMesh||!m.visible||m.parent===gesture.cup&&!gesture.cup.visible)return;const p=m.geometry.attributes.position;
    for(let i=0;i<p.count;i++){point.fromBufferAttribute(p,i);const upperHead=m.isSkinnedMesh&&point.y>2.1;if(m.isSkinnedMesh)m.applyBoneTransform(i,point);point.applyMatrix4(m.matrixWorld);radius=Math.max(radius,Math.hypot(point.x,point.z));top=Math.max(top,point.y);bottom=Math.min(bottom,point.y);if(upperHead)headRadius=Math.max(headRadius,Math.hypot(point.x,point.z));}
  });
  let maxEdgeStretch=0,pawCount=0;const paw=new T.Vector3();
  for(const {mesh,pos,edges}of surfaces){
    const posed=Array.from({length:pos.count},(_,i)=>mesh.applyBoneTransform(i,new T.Vector3().fromBufferAttribute(pos,i)));
    for(const [a,b,rest]of edges)maxEdgeStretch=Math.max(maxEdgeStretch,posed[a].distanceTo(posed[b])/rest);
    for(let i=0;i<pos.count;i++)if(pos.getX(i)>1.25&&pos.getY(i)>1&&pos.getY(i)<1.4){paw.add(posed[i]);pawCount++;}
  }
  return {radius,top,bottom,headRadius,maxEdgeStretch,leftPaw:paw.divideScalar(pawCount).toArray()};
}
const poses=[];
const kinds=['idle','work','sit','walk','tea','greeting','pond','mahjong'];
for(const kind of kinds)for(let frame=0;frame<=24;frame++){
  const t=frame*.2;
  gesture.pose(null,0);if(kind==='sit')rig.poseSit(t);else if(kind==='walk')rig.poseWaddle(t);else {rig.poseIdle(t);gesture.pose(['idle','work'].includes(kind)?null:kind,t);}
  const measured={kind,t:+t.toFixed(1),...sample()},envelope=rig.profile.envelope[kind==='sit'?'seated':kind==='walk'?'moving':'standing'];
  assert.ok(measured.radius<=envelope.radius&&measured.top<=envelope.height&&measured.bottom>=-.02,`${kind} ${t}: envelope/floor`);
  assert.ok(measured.headRadius<=rig.profile.envelope.head.radius,`${kind} ${t}: head envelope`);
  assert.ok(measured.maxEdgeStretch<3,`${kind} ${t}: edge stretch ${measured.maxEdgeStretch}`);
  poses.push(measured);
}
const all=[];model.traverse(m=>{if(m.isMesh)all.push(m);});
const geometryBytes=rig.meshes.reduce((n,m)=>n+m.geometry.index.array.byteLength+Object.values(m.geometry.attributes).reduce((s,a)=>s+a.array.byteLength,0),0);
const grouped=Object.fromEntries(kinds.map(kind=>{const rows=poses.filter(p=>p.kind===kind);return [kind,{radius:Math.max(...rows.map(p=>p.radius)),top:Math.max(...rows.map(p=>p.top)),bottom:Math.min(...rows.map(p=>p.bottom)),headRadius:Math.max(...rows.map(p=>p.headRadius)),maxEdgeStretch:Math.max(...rows.map(p=>p.maxEdgeStretch))}];}));
const result={kind:'CPU posed geometry; no chair clearance or hardware/performance claim',commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),asset:a,rig:{bones:rig.skeleton.bones.length,weights:4,geometryBytes,baseDraws:rig.meshes.length,maxDrawsWithCup:all.length,baseTriangles:a.triangles,maxTrianglesWithCup:all.reduce((n,m)=>n+(m.geometry.index?.count??m.geometry.attributes.position.count)/3,0),shadowTriangles:all.filter(m=>m.castShadow).reduce((n,m)=>n+(m.geometry.index?.count??m.geometry.attributes.position.count)/3,0)},residentInventory:{total:RESIDENTS.length,bao:RESIDENTS.filter(r=>r.role==='orchestrator'&&r.runtime==='claude'),jiao:RESIDENTS.filter(r=>r.role==='orchestrator'&&r.runtime==='codex')},rigUnitEnvelopes:rig.profile.envelope,sceneScale:1.35,measuredPoses:grouped,poses};
fs.writeFileSync(process.argv[2]||new URL('fitting.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({rig:result.rig,measuredPoses:grouped},null,2));gesture.dispose();factory.dispose();
