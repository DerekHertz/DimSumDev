import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createActorHomes} from './actor-homes.mjs';
import {startWalk,walk,WALK} from '../procedural/walk.mjs';

function fixture(groundAt){
 const actors=new Map(),den={walkWorld:{navigation:{groundAt}},walkStart:{x:0,z:0,groundY:0,yaw:0}},homes=createActorHomes(den,actors);
 const resources=[];
 const actor=(id,x=0)=>{const model=new T.Group(),geometry=new T.BoxGeometry(1,2,1),material=new T.MeshBasicMaterial(),mesh=new T.Mesh(geometry,material);mesh.position.y=1;model.add(mesh);resources.push(geometry,material);return{id,role:'developer',runtime:'claude',home:new T.Vector3(x,0,0),panda:{model,rig:{profile:{},poseIdle(){},poseWaddle(){}}}};};
 return {den,actors,homes,actor,dispose(){homes.dispose();for(const r of resources)r.dispose();}};
}

for(const kind of ['work','staging'])test(`homes-first ${kind} owns a fitting footprint clear of the actual walker entry`,()=>{
 const f=fixture(kind==='work'?()=>0:x=>x>=-8&&x<=8?0:null);try{
  const a=f.actor('one',kind==='work'?0:-50);assert.equal(f.homes.prepare(a),true);f.actors.set(a.id,a);
  const lease=f.homes.places.get(a.homePlace);assert.equal(lease.kind,kind);assert.equal(lease.owner,a.identity);assert.equal(lease.occupied,true);
  assert.ok(Math.hypot(a.home.x,a.home.z)>=Math.max(.65,a.envelope.radius+WALK.radius+.05));
  const start=startWalk(f.den.walkStart),next=walk(start,{forward:1},.1,{...f.den.walkWorld,avoid:[{x:a.home.x,z:a.home.z,r:.65}]});
  assert.ok(Math.hypot(next.x-start.x,next.z-start.z)>.1);
  const b=f.actor('two',a.home.x);assert.equal(f.homes.prepare(b),true);f.actors.set(b.id,b);
  assert.ok(a.home.distanceTo(b.home)>=a.envelope.radius+b.envelope.radius+.049);
 }finally{f.dispose();}
});

test('homes-first rejects unsupported/full-height footprints and truthfully releases failed placement',()=>{
 let calls=0;const f=fixture((x,z,y,r,h)=>{calls++;assert.ok(r>.5);assert.ok(h>=2);return null;});try{
  const a=f.actor('no-room');assert.equal(f.homes.prepare(a),false);assert.equal(a.homePlace,null);assert.equal(a.panda.model.visible,false);assert.equal(a.presentation,'Scene place unavailable');
  assert.equal([...f.homes.places.values()].some(p=>p.owner===a.identity),false);assert.ok(calls<=258,'home plus staging is bounded');
 }finally{f.dispose();}
});
