import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createRuntimeOrnaments} from './runtime-ornaments.mjs';
test('55-L: shared decorative marks hide behind an arch, suppress crowd overlap and clean up removed models',()=>{
 const world=new T.Group(),model=new T.Group();model.userData.runtime='codex';world.add(model);
 const geometry=new T.BoxGeometry(.66,.66,.04),materials=[new T.MeshBasicMaterial()],art={codex:{geometry,materials}};
 const den={world,pandaRigs:new Map([[model,{rig:{profile:{envelope:{head:{top:3}}}}}]]),garden:{roofMode:'cutaway',footprints:[],assets:{}},walkWorld:{physicalObstacles:[{min:[-1,0,4],max:[1,6,5],name:'Entrance arch'}]}};
 const camera=new T.OrthographicCamera(-10,10,10,-10,.1,100);camera.position.set(0,4,10);camera.lookAt(0,3,0);camera.updateMatrixWorld(true);
 const marks=createRuntimeOrnaments(den,art);try{
  marks.update(camera,800);const mark=world.children.find(n=>n.name==='codex runtime ornament');assert.ok(mark);assert.equal(mark.visible,false,'arch hides decorative mark');
  den.walkWorld.physicalObstacles=[];marks.update(camera,800);assert.equal(mark.visible,true);assert.equal(mark.castShadow,false);
  const second=model.clone();world.add(second);den.pandaRigs.set(second,den.pandaRigs.get(model));marks.update(camera,800);
  assert.equal(world.children.filter(n=>n.name==='codex runtime ornament'&&n.visible).length,1,'crowded marks do not pile up over a face');
  den.pandaRigs.delete(model);marks.update(camera,800);assert.equal(mark.parent,null);
 }finally{marks.dispose();}
});

test('badge occlusion stays bounded across thousands of obstacles and respects removed blockers',()=>{
 const world=new T.Group(),pandaRigs=new Map();
 for(let i=0;i<6;i++){const model=new T.Group();model.userData.runtime='codex';model.position.x=i*.02;world.add(model);pandaRigs.set(model,{rig:{profile:{}}});}
 const arch={min:[-1,0,4],max:[1,6,5]};
 const obstacles=Array.from({length:8000},(_,i)=>({min:[100+i%100,0,Math.floor(i/100)],max:[100.5+i%100,6,.5+Math.floor(i/100)]}));
 obstacles.push(arch);
 const den={world,pandaRigs,garden:{assets:{}},walkWorld:{physicalObstacles:obstacles}};
 const marks=createRuntimeOrnaments(den,{codex:{geometry:new T.BoxGeometry(.66,.66,.04),materials:[new T.MeshBasicMaterial()]}});
 const camera=new T.OrthographicCamera(-10,10,10,-10,.1,100);camera.position.set(0,4,10);camera.lookAt(0,3,0);camera.updateMatrixWorld(true);
 const original=T.Ray.prototype.intersectBox;let checks=0;
 T.Ray.prototype.intersectBox=function(...args){checks++;return original.apply(this,args);};
 try{
  marks.update(camera,800);
  assert.equal(world.children.filter(n=>n.name==='codex runtime ornament'&&n.visible).length,0,'the nearby arch still hides every badge');
  assert.ok(checks<600,`visibility must prune distant obstacles; performed ${checks} box checks`);
  obstacles.pop();checks=0;marks.update(camera,800);
  assert.equal(world.children.filter(n=>n.name==='codex runtime ornament'&&n.visible).length,1,'removing the arch reveals one uncrowded badge');
  assert.ok(checks<600,`removed blockers must not force a full scan; performed ${checks} box checks`);
 }finally{T.Ray.prototype.intersectBox=original;marks.dispose();}
});

test('roof clipping and camera movement still change badge visibility',()=>{
 const world=new T.Group(),model=new T.Group();model.userData.runtime='codex';world.add(model);
 const material=new T.MeshBasicMaterial(),roof=new T.Mesh(new T.BoxGeometry(4,6,.5),material);roof.position.set(0,3,4);
 const den={world,pandaRigs:new Map([[model,{rig:{profile:{}}}]]),garden:{assets:{building:{roof}}},walkWorld:{physicalObstacles:[]}};
 const marks=createRuntimeOrnaments(den,{codex:{geometry:new T.BoxGeometry(.66,.66,.04),materials:[new T.MeshBasicMaterial()]}});
 const camera=new T.OrthographicCamera(-10,10,10,-10,.1,100);camera.position.set(0,4,10);camera.lookAt(0,3,0);camera.updateMatrixWorld(true);
 try{
  marks.update(camera,800);const mark=world.children.find(n=>n.name==='codex runtime ornament');assert.equal(mark.visible,false);
  material.clippingPlanes=[new T.Plane(new T.Vector3(0,0,-1),0)];marks.update(camera,800);assert.equal(mark.visible,true,'cutaway reveals badge');
  material.clippingPlanes=[];camera.position.set(0,4,-10);camera.lookAt(0,3,0);camera.updateMatrixWorld(true);marks.update(camera,800);assert.equal(mark.visible,true,'a roof behind the badge cannot hide it');
 }finally{marks.dispose();roof.geometry.dispose();material.dispose();}
});

test('grouped bounds match exhaustive occlusion while the camera and panda move',()=>{
 let seed=42;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
 const obstacles=Array.from({length:256},()=>{const min=[random()*40-20,random()*8,random()*40-20];return {min,max:min.map(n=>n+.5+random()*3)};});
 const world=new T.Group(),model=new T.Group();model.userData.runtime='codex';world.add(model);
 const den={world,pandaRigs:new Map([[model,{rig:{profile:{}}}]]),garden:{assets:{}},walkWorld:{physicalObstacles:obstacles}};
 const marks=createRuntimeOrnaments(den,{codex:{geometry:new T.BoxGeometry(.66,.66,.04),materials:[new T.MeshBasicMaterial()]}});
 const camera=new T.PerspectiveCamera(60,1,.1,100),raycaster=new T.Raycaster(),hit=new T.Vector3();
 try{
  for(let i=0;i<60;i++){
   model.position.set(random()*4-2,0,random()*4-2);world.updateMatrixWorld(true);
   camera.position.set(Math.sin(i)*15,2+random()*10,Math.cos(i)*15);camera.lookAt(model.position);camera.updateMatrixWorld(true);
   marks.update(camera,800);const mark=world.children.find(n=>n.name==='codex runtime ornament'),projected=mark.position.clone().project(camera);
   raycaster.setFromCamera(new T.Vector2(projected.x,projected.y),camera);const length=raycaster.ray.origin.distanceTo(mark.position);
   const blocked=obstacles.some(o=>raycaster.ray.intersectBox(new T.Box3(new T.Vector3(...o.min),new T.Vector3(...o.max)),hit)&&raycaster.ray.origin.distanceTo(hit)<length-.1);
   assert.equal(mark.visible,!blocked,`camera/panda pose ${i}`);
  }
 }finally{marks.dispose();}
});
