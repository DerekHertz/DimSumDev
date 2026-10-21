import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createActorPlaces} from './actor-places.mjs';

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
