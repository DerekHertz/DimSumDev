// Diagnostic for the current concurrent-Bao placement, separate from furniture.
import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import * as T from 'three';
import {readGlbGeometry} from '../../../apps/ui/assets-src/den/read-glb-geometry.mjs';
import {createPandaAppearanceFactory} from '../../../apps/ui/src/scene/meshy/panda-appearance.mjs';
import {fitRoleAsset} from '../../../apps/ui/src/scene/meshy/role-wardrobe.mjs';
const assets=JSON.parse(fs.readFileSync(new URL('../../../apps/ui/public/den/manifest.json',import.meta.url))).assets;
const load=id=>readGlbGeometry(gunzipSync(fs.readFileSync(new URL('../../../apps/ui/public'+assets[id].url,import.meta.url))));
function triangles(model){model.updateMatrixWorld(true);const out=[];model.traverse(m=>{if(!m.isMesh)return;for(let a=m;a;a=a.parent)if(!a.visible)return;const p=m.geometry.attributes.position,idx=m.geometry.index,points=Array.from({length:p.count},(_,i)=>{const v=new T.Vector3().fromBufferAttribute(p,i);if(m.isSkinnedMesh)m.applyBoneTransform(i,v);return v.applyMatrix4(m.matrixWorld);});for(let i=0;i<(idx?.count??p.count);i+=3){const tri=new T.Triangle(...[0,1,2].map(j=>points[idx?idx.getX(i+j):i+j]));out.push({tri,box:new T.Box3().setFromPoints([tri.a,tri.b,tri.c])});}});return out;}
function overlap(a,b){
 const grid=new Map(),cell=.5,keys=box=>{const keys=[];for(let x=Math.floor(box.min.x/cell);x<=Math.floor(box.max.x/cell);x++)for(let y=Math.floor(box.min.y/cell);y<=Math.floor(box.max.y/cell);y++)for(let z=Math.floor(box.min.z/cell);z<=Math.floor(box.max.z/cell);z++)keys.push(x+','+y+','+z);return keys;};
 for(const t of b)for(const key of keys(t.box)){if(!grid.has(key))grid.set(key,[]);grid.get(key).push(t);}
 const hit=new T.Vector3(),ray=new T.Ray(),direction=new T.Vector3();
 function edgeHit(one,two){for(const [p,q]of [[one.a,one.b],[one.b,one.c],[one.c,one.a]]){direction.subVectors(q,p);const length=direction.length();ray.set(p,direction.normalize());if(ray.intersectTriangle(two.a,two.b,two.c,false,hit)){const d=hit.distanceTo(p);if(d>1e-5&&d<length-1e-5)return hit.toArray();}}return null;}
 for(const t of a)for(const other of new Set(keys(t.box).flatMap(key=>grid.get(key)||[]))){if(!t.box.intersectsBox(other.box))continue;const point=edgeHit(t.tri,other.tri)||edgeHit(other.tri,t.tri);if(point)return{intersects:true,point};}return{intersects:false};
}
const results=[];
for(const selected of [false,true]){
 const body=load('bao'),vest=fitRoleAsset(load('wardrobe.developer-vest'),'developer-vest'),factory=createPandaAppearanceFactory({body,vest,characters:selected?{bao:load('characters.bao')}:{}});
 try{const host=factory.createPanda('orchestrator'),visitor=factory.createPanda('orchestrator');host.model.position.set(-1.75,.29,-.6);visitor.model.position.set(-3.0971435248300834,.26,-1.7938192172638114);host.rig.poseIdle(0,{reducedMotion:true});visitor.rig.poseIdle(0,{reducedMotion:true});const a=triangles(host.model),b=triangles(visitor.model),bounds=list=>list.reduce((box,t)=>box.union(t.box),new T.Box3()),ab=bounds(a),bb=bounds(b),intersection=ab.clone().intersect(bb),extent=intersection.getSize(new T.Vector3());results.push({selected,positions:{host:host.model.position.toArray(),visitor:visitor.model.position.toArray()},conservativeBounds:{host:{min:ab.min.toArray(),max:ab.max.toArray()},visitor:{min:bb.min.toArray(),max:bb.max.toArray()},overlapExtent:extent.toArray(),overlapBoxVolume:extent.x*extent.y*extent.z,note:'AABB overlap is conservative; not actual interpenetration volume.'},...overlap(a,b)});}finally{factory.dispose();}
}
fs.writeFileSync(process.argv[2]||new URL('pair-clearance.json',import.meta.url),JSON.stringify({method:'Non-coplanar posed triangle edge/face intersection at observed native concurrent-run positions; same original and replacement factory paths',results},null,2)+'\n');console.log(JSON.stringify(results,null,2));
