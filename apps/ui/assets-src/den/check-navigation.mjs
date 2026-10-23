// Offline verification against the shipped geometry, without images or WebGL.
import * as THREE from 'three';
import { createSurfaceNavigation } from '../../src/scene/meshy/navigation.mjs';
import { createStylizedStructure } from './test-fixtures/legacy-stylized-structures.mjs';
import { protectPond } from './legacy-collisions.mjs';

export function geometry(id) {
 return createStylizedStructure(id);
}
export const SITES=[
 {id:'library',x:0,z:-17.6,turn:0},
 {id:'steamers',x:-9.5,z:-8.7,turn:.28,target:[.85,0,-.20],minimumGround:.30},
 {id:'pavilion',x:-20,z:10.2,turn:0,target:[0,0,1.2]},
 {id:'festival',x:20,z:-12.2,turn:0},
];
export function siteGeometry(site){
 const root=new THREE.Group();root.position.set(site.x,0,site.z);root.rotation.y=site.turn;
 root.add(geometry(site.id));root.updateMatrixWorld(true);root.userData.navigationTarget=site.target;root.userData.minimumGround=site.minimumGround??.1;return root;
}
export function routeToInterior(root,navigation,{step=.12,includePath=false}={}){
 const bounds=new THREE.Box3().setFromObject(root),target=root.localToWorld(new THREE.Vector3(...(root.userData.navigationTarget||[0,0,0])));
 const localBounds=new THREE.Box3(),inverse=root.matrixWorld.clone().invert();
 root.traverse(mesh=>{
  if(!mesh.isMesh)return;
  mesh.geometry.computeBoundingBox();
  localBounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse,mesh.matrixWorld)));
 });
 // The pavilion's long arrival bridge is asymmetric around the building origin.
 // Start beyond its actual front extent, rather than halfway across the stairs.
 const seed=root.localToWorld(new THREE.Vector3(0,0,localBounds.max.z+1));
 const queue=[{x:seed.x,z:seed.z,y:0}],seen=new Set();let best=Infinity,highest=0;
 for(let cursor=0;cursor<queue.length&&cursor<45000;cursor++){
  const p=queue[cursor],d=Math.hypot(p.x-target.x,p.z-target.z);best=Math.min(best,d);highest=Math.max(highest,p.y);
  if(d<.35&&p.y>=root.userData.minimumGround){
   const result={ok:true,ground:p.y,steps:cursor,best,highest};
   if(includePath){const path=[];for(let at=cursor;at!=null;at=queue[at].previous)path.push(queue[at]);result.path=path.reverse();}
   return result;
  }
  for(const [dx,dz]of [[step,0],[-step,0],[0,step],[0,-step]]){
   const x=p.x+dx,z=p.z+dz;if(x<bounds.min.x-1||x>bounds.max.x+1||z<bounds.min.z-1||z>bounds.max.z+1)continue;
   const y=navigation.groundAt(x,z,p.y);if(y===null)continue;
   const key=`${Math.round(x/step)},${Math.round(z/step)},${Math.round(y*100)}`;if(seen.has(key))continue;seen.add(key);queue.push({x,z,y,previous:cursor});
  }
 }
 return {ok:false,best,highest,visited:seen.size};
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 for(const site of SITES){const root=siteGeometry(site),raw=createSurfaceNavigation([root]),nav=site.id==='pavilion'?protectPond(raw,root):raw;console.log(site.id,JSON.stringify(routeToInterior(root,nav)));}
}
