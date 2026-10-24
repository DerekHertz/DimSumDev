import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createApprovedGarden} from './approved-garden.mjs';
import {teahouseProps} from './teahouse.test-fixture.mjs';
import {treeStructureConflicts} from './teahouse-garden.mjs';
import {buildTeahouse,fitTeahouseProp} from './teahouse.mjs';
import {gardenKit} from './approved/garden-kit-budget.mjs';

globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};

test('seat support stays inside the actual imported upholstery instead of projecting a rectangular slab',()=>{
 const props=teahouseProps(),kit=gardenKit('Upholstery footprint regression'),teahouse=buildTeahouse(kit,{props});
 try{
  for(const chair of teahouse.chairs){
   const original=fitTeahouseProp(props.chair,[chair.width,1.25,chair.depth]),pad=chair.root.getObjectByName('Fitted sage seat pad');
   original.updateWorldMatrix(true,true);pad.updateWorldMatrix(true,false);
   const ray=new T.Raycaster(new T.Vector3(),new T.Vector3(0,-1,0)),point=new T.Vector3(),positions=pad.geometry.attributes.position;
   for(let i=0;i<positions.count;i++){
    point.fromBufferAttribute(positions,i).applyMatrix4(pad.matrixWorld);chair.root.worldToLocal(point);
    ray.ray.origin.set(point.x,2,point.z);
    const hit=ray.intersectObject(original,true)[0];
    assert.ok(hit&&hit.point.y>.55&&hit.point.y<.8,'support overhangs the original cushion at '+point.x.toFixed(2)+','+point.z.toFixed(2));
   }
  }
 }finally{kit.dispose();}
});

test('approved furniture is grounded with permanent padded seats and a substantial pedestal',()=>{
 const garden=createApprovedGarden({props:teahouseProps()});
 try{
  const {chairs,table}=garden.teahouse;
  assert.equal(chairs.length,7);
  for(const chair of chairs){
   const bounds=new T.Box3().setFromObject(chair.root,true);
   assert.ok(Math.abs(bounds.min.y-.4125)<.02,'chair legs reach the circular floor');
   assert.ok(chair.supportTop>.7&&chair.supportTop<1.2,'low seat supports a crouched body');
  }
  const bounds=new T.Box3().setFromObject(table,true);
  assert.ok(bounds.min.y<=.43,'pedestal meets the floor');
  assert.ok(bounds.max.x-bounds.min.x>=6,'table has a generous circular surface');
  assert.ok(bounds.max.y>1.5&&bounds.max.y<2,'table stays below the smallest seated faces');
 }finally{garden.dispose();}
});

test('physical chair support never extends onto an invisible overhanging platform',()=>{
 const garden=createApprovedGarden({props:teahouseProps()});try{
  const ray=new T.Raycaster(new T.Vector3(),new T.Vector3(0,-1,0));
  for(const chair of garden.teahouse.chairs){
   const pad=chair.root.getObjectByName('Fitted sage seat pad');
   for(const surface of garden.surfaces.filter(s=>s.name===chair.root.name))for(const [x,z]of surface.vertices){
    ray.ray.origin.set(x,2,z);const hit=ray.intersectObject(pad,true)[0];
    assert.ok(hit&&Math.abs(hit.point.y-surface.supportTop)<.01,'physical support must lie on actual upholstery');
   }
  }
 }finally{garden.dispose();}
});

test('the local approved package retains audited geometry and shares resources until teardown',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../../../public/den/teahouse.json',import.meta.url))),props=teahouseProps(),resources=new Map();
 for(const asset of manifest.assets){
  const bytes=readFileSync(new URL('../../../public'+asset.url,import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);
  let triangles=0;props[asset.id].traverse(n=>{if(n.isMesh){triangles+=(n.geometry.index?.count??n.geometry.attributes.position.count)/3;for(const resource of [n.geometry,n.material,n.material.map].filter(Boolean))resources.set(resource,0);}});
  assert.equal(triangles,asset.triangles,'the approved source geometry survives integration');
 }
 for(const resource of resources.keys())resource.addEventListener('dispose',()=>resources.set(resource,resources.get(resource)+1));
 const garden=createApprovedGarden({props});garden.dispose();
 for(const count of resources.values())assert.equal(count,1,'each shared prop resource is released once');
});

test('whole transformed canopies clear actual structures and circulation in full and cutaway modes',()=>{
 const garden=createApprovedGarden({props:teahouseProps()});
 try{
  assert.ok(garden.gardenAccents.trees.length>=4,'outer corners carry the approved planting');
  for(const mode of ['full','cutaway']){
   garden.setRoofMode(mode);
   assert.deepEqual(treeStructureConflicts(garden.gardenAccents.trees,Object.values(garden.assets).map(a=>a.root)),[]);
   for(const tree of garden.gardenAccents.trees){
    const bounds=new T.Box3().setFromObject(tree,true);
    for(const path of garden.paths)for(let i=1;i<path.points.length;i++){
     const a=path.points[i-1],b=path.points[i],walk=new T.Box3(new T.Vector3(Math.min(a[0],b[0])-path.width/2,-1,Math.min(a[1],b[1])-path.width/2),new T.Vector3(Math.max(a[0],b[0])+path.width/2,20,Math.max(a[1],b[1])+path.width/2));
     assert.equal(bounds.intersectsBox(walk),false,'the full canopy leaves walks open');
    }
    assert.ok(Math.hypot(tree.position.x,tree.position.z+4)>35,'outer planting preserves meeting sightlines');
   }
  }
  assert.equal(garden.assets.pass.root.position.x,-30.5);assert.equal(garden.assets.pond.root.position.x,23);
  assert.ok(garden.gardenAccents.fountain.parent,'fountain stays beside the existing pond');
 }finally{garden.dispose();}
});

test('a trunk outside a building cannot hide foliage penetrating a wall or full roof',()=>{
 const structure=new T.Group(),wall=new T.Mesh(new T.BoxGeometry(4,5,4));wall.position.y=2.5;structure.add(wall);
 const tree=new T.Group(),trunk=new T.Mesh(new T.CylinderGeometry(.1,.2,3)),canopy=new T.Mesh(new T.SphereGeometry(2));
 trunk.position.y=1.5;canopy.position.set(-1.5,4,0);tree.position.set(3,0,0);tree.add(trunk,canopy);
 tree.updateWorldMatrix(true,true);
 assert.ok(new T.Box3().setFromObject(trunk).min.x>2,'trunk alone clears');
 assert.equal(treeStructureConflicts([tree],[structure]).length,1,'penetrating canopy is rejected');
 tree.rotation.y=Math.PI;tree.position.x=5;
 assert.deepEqual(treeStructureConflicts([tree],[structure]),[],'complete transformed geometry is clear after moving');
 for(const mesh of [wall,trunk,canopy]){mesh.geometry.dispose();mesh.material.dispose();}
});
