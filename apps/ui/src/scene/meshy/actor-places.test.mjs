import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createActorPlaces} from './actor-places.mjs';

test('36 dense no-approach allocation exhausts truthfully within a total query budget and valid movement still succeeds',()=>{
 let queries=0,blocked=true;
 const actors=new Map(),world={navigation:{groundAt:(x,z)=>{assert.ok(++queries<=250000,'one allocation never exceeds 250000 external navigation calls');return blocked&&Math.abs(x)<.3?null:0;}}},den={walkWorld:world,walkStart:{x:0,z:0,groundY:0}};
 const transport=createActorPlaces(den,actors,2),meshes=[];
 const make=(id,x,z=0)=>{const model=new T.Group(),mesh=new T.Mesh(new T.BoxGeometry(.6,1,.6));mesh.position.y=.5;model.add(mesh);model.position.set(x,0,z);meshes.push(mesh);return{id,role:'developer',home:new T.Vector3(x,0,z),panda:{model,rig:{profile:{},poseIdle(){},poseWaddle(){}}}};};
 try{
  // Dense bodies have no approach metadata. The blocked actor has an unreachable
  // landing so primary searches remain expensive; staging itself is on the barrier.
  for(let i=0;i<12;i++){const a=make('body'+i,-6+i,-3);a.identity=a.id;a.envelope={radius:.45,height:1.1};actors.set(a.id,a);}
  const unavailable=make('blocked',-10);unavailable.approach={x:10,y:0,z:0};assert.equal(transport.prepare(unavailable),false);
  assert.ok(queries>0);assert.equal(unavailable.panda.model.visible,false);assert.match(unavailable.presentation,/unavailable/i);
  assert.equal(unavailable.homePlace,null);assert.equal([...transport.places.values()].some(p=>p.owner===unavailable.identity),false);
  blocked=false;queries=0;
  const valid=make('valid',-10);assert.equal(transport.prepare(valid),true);assert.ok(queries<=250000);actors.set(valid.id,valid);
  const target=transport.destination(valid,{id:'valid-target',kind:'leisure',position:{x:-8,y:0,z:0}});assert.ok(target);assert.equal(transport.go(valid,target),true);
  const before=valid.panda.model.position.clone();transport.update(.1,false);assert.ok(valid.panda.model.position.distanceTo(before)>0);
  for(let i=0;i<30;i++)transport.update(.1,false);
  assert.equal(valid.travel.status,'arrived');assert.equal(transport.places.get(target.id).owner,valid.identity);assert.ok(valid.panda.model.position.distanceTo(new T.Vector3(-8,0,0))<.02);
 }finally{transport.dispose();for(const mesh of meshes){mesh.geometry.dispose();mesh.material.dispose();}}
});

test('36 primary home search preserves staging and arrival work',()=>{
 let queries=0;
 const actors=new Map(),world={navigation:{groundAt:x=>{assert.ok(++queries<=250000,'primary, staging and arrival share one external query ceiling');return Math.abs(x)<.3?null:0;}}};
 const transport=createActorPlaces({walkWorld:world,walkStart:{x:10,z:0,groundY:0}},actors,2);
 const model=new T.Group(),mesh=new T.Mesh(new T.BoxGeometry(.6,1,.6));mesh.position.y=.5;model.add(mesh);
 const actor={id:'fallback',role:'developer',home:new T.Vector3(-10,0,0),panda:{model,rig:{profile:{},poseIdle(){},poseWaddle(){}}}};
 try{
  // No authored approach: primary homes cannot cross the barrier to the landing,
  // but a safe staging place exists on its other side and must not be starved.
  assert.equal(transport.prepare(actor,'visitor',actor.home,{arrival:true}),true);
  const home=transport.places.get(actor.homePlace);assert.equal(home.kind,'staging');assert.equal(home.owner,actor.identity);assert.equal(home.occupied,true);
  assert.equal(model.visible,true);assert.match(actor.presentation,/safe place/);assert.equal(actor.arriving,true);assert.equal(actor.travel.status,'moving');
  actors.set(actor.id,actor);const before=model.position.clone();transport.update(.1,false);assert.ok(model.position.distanceTo(before)>0);
  for(let i=0;i<20;i++)transport.update(.1,false);
  assert.equal(actor.travel.status,'arrived');assert.equal(home.owner,actor.identity);assert.ok(model.position.distanceTo(new T.Vector3(home.position.x,home.position.y,home.position.z))<.02);
 }finally{transport.dispose();mesh.geometry.dispose();mesh.material.dispose();}
});

test('36 later allocation cannot seal an existing resident only body-width exit',()=>{
 const actors=new Map(),world={navigation:{groundAt:(x,z,y,r)=>Math.abs(z)+r>1.25||Math.abs(x)+r>12?null:0}},den={walkWorld:world,walkStart:{x:10,z:0,groundY:0}};
 const transport=createActorPlaces(den,actors,2),meshes=[];
 function actor(id,x){const model=new T.Group(),mesh=new T.Mesh(new T.BoxGeometry(1.5,2,1.5));mesh.position.y=1;model.add(mesh);model.position.x=x;meshes.push(mesh);return{id,role:'developer',runtime:'claude',home:new T.Vector3(x,0,0),panda:{model,rig:{profile:{},poseIdle(){},poseWaddle(){}}}};}
 try{
  const first=actor('first',-5);assert.equal(transport.prepare(first),true);actors.set(first.id,first);
  const later=actor('later',0);transport.prepare(later);actors.set(later.id,later);
  assert.equal(later.panda.model.visible,false,'a second body has no independent exit in the single-body corridor');assert.match(later.presentation,/unavailable/i);
  const target=transport.destination(first,{id:'exit',kind:'staging',position:{x:10,y:0,z:0},overflow:false});assert.ok(target);transport.go(first,target);
  for(let i=0;i<150;i++)transport.update(.1,false);
  assert.equal(first.travel.status,'arrived');assert.ok(Math.abs(first.panda.model.position.x-10)<.02);assert.equal(transport.places.get(target.id).owner,first.identity);
 }finally{transport.dispose();for(const mesh of meshes){mesh.geometry.dispose();mesh.material.dispose();}}
});
