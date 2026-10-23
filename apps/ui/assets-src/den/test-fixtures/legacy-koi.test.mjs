import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createTeaGarden} from '../../../src/scene/meshy/plush/tea-garden.mjs';

// Geometry tests use a drawing stub; browser coverage checks the rendered scene.
globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};
test('all three assembled koi retain moving bodies and tails, stay submerged and inside the rim',()=>{
 const garden=createTeaGarden();try{
  const koi=garden.koi;assert.equal(koi.fish.length,3);
  const starts=koi.fish.map(f=>f.model.position.clone());
  for(let i=0;i<1800;i++){
   koi.update(.1);garden.root.updateMatrixWorld(true);
   for(const {model,tail} of koi.fish){
    assert.ok(model.parent&&model.children.some(n=>n.isMesh));assert.ok(tail.parent);
    const bounds=new T.Box3().setFromObject(model);
    assert.ok(bounds.max.y<.252,'complete fish is below water');
    for(const x of [bounds.min.x,bounds.max.x])for(const z of [bounds.min.z,bounds.max.z])assert.ok((x-2.18)**2/1.77**2+(z-.75)**2/1.48**2<1,'complete fish stays inside rim');
   }
  }
  koi.fish.forEach((f,i)=>assert.ok(f.model.position.distanceTo(starts[i])>.05));
  const before=koi.fish.map(f=>[f.model.position.clone(),f.tail.quaternion.clone()]);
  koi.update(100,true);koi.update(100,true);
  koi.fish.forEach((f,i)=>{assert.deepEqual(f.model.position,before[i][0]);assert.ok(f.tail.quaternion.equals(before[i][1]));});
 }finally{garden.dispose();}
});
test('feeding safely gathers koi, faces their actual travel, then releases them without a jump',()=>{
 const garden=createTeaGarden();try{
  const koi=garden.koi;koi.update(1);koi.feed();
  const point=new T.Vector3(2.18,.211,.05);
  for(let i=0;i<60;i++){
   const last=koi.fish.map(f=>f.model.position.clone());koi.update(.1);
   koi.fish.forEach((f,j)=>{const motion=f.model.position.clone().sub(last[j]);assert.ok(motion.length()<.15);if(motion.length()>.0001)assert.ok(new T.Vector3(0,0,1).applyQuaternion(f.model.quaternion).dot(motion.normalize())>.98);});
   garden.root.updateMatrixWorld(true);
   for(const {model}of koi.fish){const b=new T.Box3().setFromObject(model);assert.ok(b.max.y<.252);for(const x of[b.min.x,b.max.x])for(const z of[b.min.z,b.max.z])assert.ok((x-2.18)**2/1.77**2+(z-.75)**2/1.48**2<1);}
  }
  assert.ok(koi.fish.every(f=>f.model.position.distanceTo(point)<.55));
  for(let i=0;i<200;i++)koi.update(.1);
  assert.ok(koi.fish.some(f=>f.model.position.distanceTo(point)>.7));
 }finally{garden.dispose();}
});
test('garden disposal owns every movable koi mesh, tail and feeding effect resource',()=>{
 const garden=createTeaGarden(),resources=new Set();
 for(const {model}of garden.koi.fish)model.traverse(n=>{if(n.isMesh){resources.add(n.geometry);resources.add(n.material);}});
 garden.root.getObjectByName('Koi feeding ripples and crumbs').traverse(n=>{if(n.isMesh){resources.add(n.geometry);resources.add(n.material);}});
 const disposed=new Set();for(const r of resources)r.addEventListener('dispose',()=>disposed.add(r));
 garden.dispose();assert.equal(disposed.size,resources.size);
});
