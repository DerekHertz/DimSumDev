// CPU-only fitting evidence on actual packaged geometry. Not a GPU benchmark.
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createPandaAppearanceFactory } from '../../../apps/ui/src/scene/meshy/panda-appearance.mjs';
import { createLeisureGesture } from '../../../apps/ui/src/scene/meshy/leisure-gesture.mjs';
import { RESIDENTS } from '../../../apps/ui/src/shell/resident-inventory.mjs';
const assetRoot=new URL('../../../apps/ui/public/',import.meta.url),manifest=JSON.parse(fs.readFileSync(new URL('./den/manifest.json',assetRoot)));
const a=manifest.assets['characters.bao'],b=gunzipSync(fs.readFileSync(new URL('.'+a.url,assetRoot)));
const source=(await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'')).scene;
const factory=createPandaAppearanceFactory({characters:{bao:source}}),{model,rig}=factory.createPanda('orchestrator'),gesture=createLeisureGesture(rig);
model.scale.setScalar(1);
function sample(){
  model.updateMatrixWorld(true);const point=new T.Vector3();let radius=0,top=-Infinity,bottom=Infinity,headRadius=0;
  model.traverse(m=>{if(!m.isMesh||!m.visible||m.parent===gesture.cup&&!gesture.cup.visible)return;const p=m.geometry.attributes.position;
    for(let i=0;i<p.count;i++){point.fromBufferAttribute(p,i);if(m.isSkinnedMesh)m.applyBoneTransform(i,point);point.applyMatrix4(m.matrixWorld);radius=Math.max(radius,Math.hypot(point.x,point.z));top=Math.max(top,point.y);bottom=Math.min(bottom,point.y);if(point.y>2.1)headRadius=Math.max(headRadius,Math.hypot(point.x,point.z));}
  });return {radius,top,bottom,headRadius};
}
const poses=[];
for(const kind of ['idle','sit','walk','tea','greeting','pond','mahjong'])for(let t=0;t<4.8;t+=.2){
  gesture.pose(null,0);if(kind==='sit')rig.poseSit(t);else if(kind==='walk')rig.poseWaddle(t);else {rig.poseIdle(t);gesture.pose(kind==='idle'?null:kind,t);}
  poses.push({kind,t:+t.toFixed(1),...sample()});
}
const all=[];model.traverse(m=>{if(m.isMesh)all.push(m);});
const geometryBytes=rig.meshes.reduce((n,m)=>n+m.geometry.index.array.byteLength+Object.values(m.geometry.attributes).reduce((s,a)=>s+a.array.byteLength,0),0);
const grouped=Object.fromEntries(['idle','sit','walk','tea','greeting','pond','mahjong'].map(kind=>{const rows=poses.filter(p=>p.kind===kind);return [kind,{radius:Math.max(...rows.map(p=>p.radius)),top:Math.max(...rows.map(p=>p.top)),bottom:Math.min(...rows.map(p=>p.bottom)),headRadius:Math.max(...rows.map(p=>p.headRadius))}];}));
const result={kind:'CPU posed geometry; no hardware/performance claim',asset:a,rig:{bones:rig.skeleton.bones.length,weights:4,geometryBytes,baseDraws:rig.meshes.length,maxDrawsWithCup:all.length,baseTriangles:a.triangles,maxTrianglesWithCup:all.reduce((n,m)=>n+(m.geometry.index?.count??m.geometry.attributes.position.count)/3,0),shadowTriangles:all.filter(m=>m.castShadow).reduce((n,m)=>n+(m.geometry.index?.count??m.geometry.attributes.position.count)/3,0)},residentInventory:{total:RESIDENTS.length,bao:RESIDENTS.filter(r=>r.role==='orchestrator'&&r.runtime==='claude'),jiao:RESIDENTS.filter(r=>r.role==='orchestrator'&&r.runtime==='codex')},rigUnitEnvelopes:rig.profile.envelope,sceneScale:1.35,measuredPoses:grouped,poses};
fs.writeFileSync(new URL('fitting.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({rig:result.rig,measuredPoses:grouped},null,2));gesture.dispose();factory.dispose();
