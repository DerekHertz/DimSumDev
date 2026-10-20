import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createMeshyActors} from './actors.mjs';
import {createBalancedPandaRig, WADDLE} from './panda-rig.mjs';
import {RESIDENTS as definitions,boundAgentKey} from '../../shell/resident-inventory.mjs';
function fixture(){
 const body=new T.Mesh(new T.BoxGeometry(2,3,1),new T.MeshStandardMaterial());body.position.y=1.5;
 const den={residents:new T.Group(),pandaRigs:new Map(),propManifest:definitions,roleWorkspaces:{workspaces:new Map()},walkWorld:{floorRadius:70,obstacles:[],navigation:{groundAt:()=>.26}}};
 den.createPanda=(role,{runtime='claude'}={})=>{const rig=createBalancedPandaRig(body);rig.model.scale.setScalar(.68);rig.model.userData={roleId:role,actorKey:role,runtime};den.pandaRigs.set(rig.model,{rig});return{model:rig.model,rig};};
 den.destroyPanda=model=>{den.pandaRigs.get(model)?.rig.dispose();den.pandaRigs.delete(model);};
 for(const[i,d]of definitions.entries()){const panda=den.createPanda(d.role,{runtime:d.runtime});panda.model.userData.actorKey=d.id;panda.model.position.set((i%7-3)*3,.26,-8-Math.floor(i/7)*4);den.residents.add(panda.model);den.roleWorkspaces.workspaces.set(d.id,{person:panda.model});}
 den.routineSpots=[{id:'tea',kind:'tea',position:new T.Vector3(0,.26,-2),face:new T.Vector3(0,.26,-3)},{id:'pond',kind:'pond',position:new T.Vector3(3,.26,-2),face:new T.Vector3(3,.26,-3)},{id:'greeting',kind:'greeting',position:new T.Vector3(-3,.26,-2),face:new T.Vector3(-3,.26,-3)}];
 let feeds=0;den.feedKoi=()=>feeds++;
 const actors=createMeshyActors(den);return{den,actors,get feeds(){return feeds;},dispose(){actors.dispose();for(const model of [...den.pandaRigs.keys()])den.destroyPanda(model);body.geometry.dispose();body.material.dispose();}};
}
test('visitors retain live identities and own skeletons, and release them when their work ends',()=>{
 const f=fixture();try{
  const {actors,den}=f;actors.applyLive([{role:'developer',ref:'work/1'},{role:'developer',ref:'work/2'}]);
  const resident=actors.actors.get('developer'),visitor=actors.actors.get('developer#work/2');
  assert.notEqual(visitor.panda.rig.skeleton,resident.panda.rig.skeleton);assert.equal(visitor.live.ref,'work/2');
  const before=visitor.panda.model.position.clone();actors.update(.1);assert.ok(visitor.panda.model.position.distanceTo(before)>0);assert.notEqual(visitor.panda.rig.bones.Hip_L.quaternion.w,1,'walking deforms the legs');
  actors.applyLive([]);assert.equal(den.pandaRigs.size,32);assert.equal(visitor.panda.model.parent,null);
 }finally{f.dispose();}
});
test('split visitors inherit matching runtime and meetings keep Claude participants',()=>{
 const f=fixture();try{
  const {actors}=f,resident=actors.actors.get('developer'),codex=actors.actors.get('codex:developer');
  actors.applyLive([{role:'developer',ref:'work/1'},{role:'developer',runtime:'codex',ref:'work/1'},{role:'developer',runtime:'codex',ref:'work/2'}]);
  const visitor=actors.actors.get('codex:developer#work/2');
  assert.equal(visitor.panda.model.userData.runtime,'codex');assert.equal(visitor.panda.model.userData.actorKey,'codex:developer#work/2');
  assert.equal(codex.live.ref,'work/1');assert.notEqual(visitor.panda.rig.skeleton,codex.panda.rig.skeleton);
  actors.applyMeeting({id:'meeting/1',ref:'work/meeting',state:'running',seats:[{role:'developer'}]});
  const guest=actors.actors.get('meeting:developer');
  assert.equal(guest.panda.model.userData.runtime,'claude');assert.equal(guest.panda.model.userData.actorKey,'meeting:developer');
  assert.equal(codex.seat,undefined);
  assert.notEqual(guest.panda.rig.skeleton,resident.panda.rig.skeleton);
 }finally{f.dispose();}
});
test('same-ticket runtime pairs have independent selection and live anchors',()=>{
 const f=fixture();try{
  const {actors}=f,claude={role:'developer',runtime:'claude',ref:'work/01'},codex={role:'developer',runtime:'codex',ref:'work/01'};
  actors.applyLive([claude,codex]);actors.setSelected({...codex});
  assert.equal(actors.actors.get('codex:developer').panda.model.userData.selected,true);
  assert.equal(actors.actors.get('developer').panda.model.userData.selected,false);
  const figures=actors.liveFigures();assert.equal(figures.size,2);
  assert.equal(figures.get(boundAgentKey(codex)).model,actors.actors.get('codex:developer').panda.model);
  assert.equal(figures.get(boundAgentKey(claude)).model,actors.actors.get('developer').panda.model);
  actors.setSelected('work/01');assert.equal(actors.actors.get('codex:developer').panda.model.userData.selected,false,'legacy ticket selection remains Claude');
 }finally{f.dispose();}
});
function advance(actors,seconds,reduced=false){for(let t=0;t<seconds;t+=.1)actors.update(.1,reduced);}
test('arrivals, leisure walks and returns, meeting guests and returns travel at .78 scene units per second',()=>{
 const checkStep=(actors,a,label)=>{
  const before=a.panda.model.position.clone(),gait=a.gait||0;
  actors.update(.1);
  const moved=Math.hypot(a.panda.model.position.x-before.x,a.panda.model.position.z-before.z);
  assert.ok(Math.abs(moved-.078)<1e-7,label+' travels 20% faster than .65');
  const gaitDistance=(a.gait-gait)/WADDLE.duration*WADDLE.stride*a.panda.model.scale.x;
  assert.ok(Math.abs(gaitDistance-moved)<1e-7,label+' gait follows distance');
 };
 const f=fixture();try{
  const {actors}=f;
  actors.applyLive([{role:'developer',ref:'work/1'},{role:'developer',ref:'work/2'}]);
  checkStep(actors,actors.actors.get('developer#work/2'),'visitor arrival');
  actors.applyMeeting({id:'meeting/1',ref:'work/meeting',state:'running',seats:[{role:'developer'}]});
  const guest=actors.actors.get('meeting:developer');checkStep(actors,guest,'meeting guest');
  actors.update(.1,true);actors.applyMeeting(null);checkStep(actors,guest,'meeting return');
 }finally{f.dispose();}
 const leisure=fixture();try{
  const {actors}=leisure;
  advance(actors,2.1);const a=[...actors.actors.values()].find(a=>a.routine?.stage==='outbound');assert.ok(a);
  checkStep(actors,a,'optional leisure walk');
  // Work interrupts the same trip and routes it home through the common traveller.
  actors.applyLive([{role:a.role,ref:'work/1'}]);assert.equal(a.leaving,true);
  checkStep(actors,a,'interrupted leisure return');
 }finally{leisure.dispose();}
});
test('idle residents stagger capped visits, sip, feed and greet, then return home and rotate',()=>{
 const f=fixture();try{
  const {actors}=f,bao=actors.actors.get('orchestrator'),baoHome=bao.home.clone(),visits=new Set(),returns=new Set(),started=new Set();
  advance(actors,3);assert.ok([...actors.actors.values()].some(a=>a.routine),'early departure');
  for(let t=0;t<6000;t++){
   actors.update(.1);const touring=[...actors.actors.values()].filter(a=>a.routine);
   assert.ok(touring.length<=3);assert.equal(new Set(touring.filter(a=>a.routine.stage!=='return').map(a=>a.routine.spot.id)).size,touring.filter(a=>a.routine.stage!=='return').length);
   for(const a of actors.actors.values()){
    if(a.routine){started.add(a.role);if(a.routine.stage==='visit'){
     visits.add(a.routine.spot.kind);
     if(a.routine.spot.kind==='tea')assert.equal(a.gesture.cup.visible,true);
     if(a.routine.spot.kind==='pond')assert.ok(a.panda.rig.bones.Head.rotation.x>.1);
     if(a.routine.spot.kind==='greeting')assert.ok(a.panda.rig.bones.Shoulder_L.rotation.z<-1.4);
    }}
    else if(started.has(a.role)&&a.panda.model.position.distanceTo(a.home)<.01)returns.add(a.role);
    assert.equal(a.live,null);assert.equal(a.state,'idle');
   }
  }
  assert.deepEqual([...visits].sort(),['greeting','pond','tea']);assert.ok(returns.size>=3);assert.ok(f.feeds>0);assert.deepEqual(bao.panda.model.position,baoHome);
 }finally{f.dispose();}
});
test('work starting during a meeting returns the resident and seats an independent meeting guest',()=>{
 const f=fixture();try{
  const {actors}=f;actors.applyMeeting({id:'m/1',ref:'m/1',state:'running',seats:[{role:'developer'}]});actors.update(.1,true);
  actors.applyLive([{role:'developer',ref:'work/1',state:'needs-you'}]);
  actors.applyMeeting({id:'m/1',ref:'m/1',state:'running',seats:[{role:'developer'}]});
  const a=actors.actors.get('developer'),guest=actors.actors.get('meeting:developer');
  assert.ok(guest);assert.equal(a.seat,null);assert.equal(a.leaving,true);assert.notEqual(a.panda.rig.skeleton,guest.panda.rig.skeleton);
  actors.update(.1,true);assert.ok(a.panda.model.position.distanceTo(a.home)<.01);assert.equal(actors.seatModels().get('developer'),guest.panda.model);
 }finally{f.dispose();}
});
test('work interrupts a held excursion, releases its spot, and returns the same panda home when the card closes',()=>{
 const f=fixture();try{
  const {actors}=f;advance(actors,4);const a=[...actors.actors.values()].find(a=>a.routine),key=a.role,p=a.panda.model;
  actors.hold(key);const at=p.position.clone(),paw=a.panda.rig.bones.Shoulder_L.quaternion.clone();advance(actors,5);assert.deepEqual(p.position,at);assert.ok(a.panda.rig.bones.Shoulder_L.quaternion.equals(paw));
  actors.applyLive([{role:key,ref:'work/1',state:'blocked',activity:'Waiting for input'}]);assert.equal(a.routine,null);assert.equal(a.state,'blocked');assert.equal(a.live.ref,'work/1');
  actors.hold(null);advance(actors,100);assert.ok(p.position.distanceTo(a.home)<.01);assert.equal(actors.liveFigures().get(boundAgentKey(a.live)).model,p);assert.equal(a.routine,null);
 }finally{f.dispose();}
});
test('holding a tea visitor pauses the sip and its visit clock until the same card closes',()=>{
 const f=fixture();try{
  const {actors}=f;let a;
  for(let i=0;i<1500&&!a;i++){actors.update(.1);a=[...actors.actors.values()].find(a=>a.routine?.stage==='visit'&&a.routine.spot.kind==='tea');}
  assert.ok(a);actors.hold(a.role);const elapsed=a.routine.elapsed,paw=a.panda.rig.bones.paw_L.matrixWorld.clone();
  advance(actors,20);assert.equal(a.routine.elapsed,elapsed);assert.ok(a.panda.rig.bones.paw_L.matrixWorld.equals(paw));assert.equal(a.gesture.cup.visible,true);
  actors.hold(null);advance(actors,1);assert.ok(a.routine.elapsed>elapsed);assert.ok(!a.panda.rig.bones.paw_L.matrixWorld.equals(paw));
 }finally{f.dispose();}
});
test('meetings route an excursion from its actual position and leisure resumes only after returning',()=>{
 const f=fixture();try{
  const {actors}=f;advance(actors,4);const a=[...actors.actors.values()].find(a=>a.routine),at=a.panda.model.position.clone();
  actors.applyMeeting({id:'m/1',ref:'m/1',state:'running',seats:[{role:a.role}]});assert.equal(a.routine,null);assert.deepEqual(a.panda.model.position,at);assert.ok(a.path.length);
  advance(actors,1);assert.ok(a.panda.model.position.distanceTo(at)<1);
  actors.update(.1,true);assert.ok(a.panda.model.position.distanceTo(new T.Vector3(a.seat.x,.26,a.seat.z))<.001);
  actors.applyMeeting(null);advance(actors,1);assert.equal(a.routine,null);actors.update(.1,true);assert.ok(a.panda.model.position.distanceTo(a.home)<.001);
  advance(actors,150);assert.ok([...actors.actors.values()].some(p=>p.routine));
 }finally{f.dispose();}
});
test('reduced motion settles routines home and holds them; unreachable trips wait between bounded retries',()=>{
 const f=fixture();try{
  const {actors,den}=f;advance(actors,4);actors.update(.1,true);
  for(const a of actors.actors.values()){assert.equal(a.routine,null);assert.ok(a.panda.model.position.distanceTo(a.home)<.001);}
  advance(actors,100,true);for(const a of actors.actors.values())assert.equal(a.routine,null);
  let queries=0;den.walkWorld.navigation.groundAt=()=>{queries++;return null;};
  advance(actors,2.1);const first=queries;advance(actors,1);assert.equal(queries,first,'no frame-by-frame search');advance(actors,20);assert.ok(queries<300,'bounded small failed searches');
  for(const a of actors.actors.values())assert.ok(a.panda.model.position.distanceTo(a.home)<.001);
 }finally{f.dispose();}
});
test('unreachable meeting travel retries at most twice, holds position, and reduced motion settles its seat',()=>{
 const f=fixture();try{
  const {actors,den}=f;den.routineSpots.length=0;let queries=0;den.walkWorld.navigation.groundAt=()=>{queries++;return null;};
  const a=actors.actors.get('developer'),home=a.home.clone();actors.applyMeeting({id:'m/1',ref:'m/1',state:'running',seats:[{role:'developer'}]});
  const first=queries;advance(actors,7);assert.equal(queries,first);advance(actors,2);assert.ok(queries>first);advance(actors,30);assert.equal(queries,first*3);assert.deepEqual(a.panda.model.position,home);
  actors.update(.1,true);assert.equal(a.panda.model.position.x,a.seat.x);assert.equal(a.panda.model.position.z,a.seat.z);
 }finally{f.dispose();}
});
test('busy residents keep working while independent meeting guests walk, sit and return home',()=>{
 const f=fixture();try{
  const {actors,den}=f;actors.applyLive([{role:'developer',ref:'work/1'}]);
  const resident=actors.actors.get('developer'),home=resident.panda.model.position.clone();
  actors.applyMeeting({id:'meeting/1',ref:'work/meeting',state:'running',seats:[{role:'developer'}]});
  const guest=actors.actors.get('meeting:developer');assert.ok(guest.path.length);assert.notEqual(guest.panda.rig.skeleton,resident.panda.rig.skeleton);
  actors.update(.1);assert.ok(guest.panda.model.position.distanceTo(home)>0);assert.deepEqual(resident.panda.model.position,home);
  actors.update(.1,true);assert.equal(guest.path,null);assert.equal(actors.seatOf('meeting:developer').role,'developer');
  const still=guest.panda.rig.bones.Chest.scale.clone();actors.update(1,true);assert.deepEqual(guest.panda.rig.bones.Chest.scale,still);
  actors.applyMeeting(null);actors.update(.1);assert.equal(guest.leaving,true);
  actors.applyMeeting({id:'meeting/2',ref:'work/next',state:'running',seats:[{role:'developer'}]});
  assert.equal(actors.actors.get('meeting:developer'),guest,'a returning guest joins the next meeting without leaking a copy');assert.equal(den.pandaRigs.size,33);
  actors.applyMeeting(null);actors.update(.1,true);assert.equal(actors.actors.has('meeting:developer'),false);assert.equal(den.pandaRigs.size,32);
 }finally{f.dispose();}
});
