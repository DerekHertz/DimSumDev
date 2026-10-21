import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createMeshyActors} from './actors.mjs';
import {createBalancedPandaRig, WADDLE} from './panda-rig.mjs';
import {RESIDENTS as definitions,boundAgentKey} from '../../shell/resident-inventory.mjs';
import {RED_PANDA} from './character-profiles.mjs';
import {walk} from '../procedural/walk.mjs';
import {actorBindings} from './layout.mjs';
import {agentFor,pickedCard} from '../../overlay/proximity-card.mjs';
import {observeTools} from '../../state/tool-activity.mjs';
import {liveActorsFromSnapshot} from '../../review/live-actors.mjs';
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
  console.log('36 original visitor '+JSON.stringify({id:visitor.id,identity:visitor.identity,visible:visitor.panda.model.visible,homePlace:visitor.homePlace,home:visitor.home,position:visitor.panda.model.position,travel:visitor.travel,presentation:visitor.presentation}));
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
  assert.ok(Math.abs(gaitDistance-moved)<1e-7,`${label} gait follows distance (${gaitDistance} vs ${moved}; ${gait} -> ${a.gait})`);
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
  assert.ok(a);actors.hold(a.id);const elapsed=a.routine.elapsed,paw=a.panda.rig.bones.paw_L.matrixWorld.clone();
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
test('unreachable meeting travel retries at most twice, holds position, and reduced motion preserves safe unavailability',()=>{
 const f=fixture();try{
  const {actors,den}=f;den.routineSpots.length=0;let queries=0;den.walkWorld.navigation.groundAt=()=>{queries++;return null;};
  const a=actors.actors.get('developer'),home=a.home.clone();actors.applyMeeting({id:'m/1',ref:'m/1',state:'running',seats:[{role:'developer'}]});
  const first=queries;advance(actors,7);assert.equal(queries,first);advance(actors,2);assert.ok(queries>first);advance(actors,30);assert.equal(a.travel.attempts,3);const exhausted=queries;advance(actors,30);assert.equal(queries,exhausted);assert.deepEqual(a.panda.model.position,home);
  actors.update(.1,true);assert.deepEqual(a.panda.model.position,home);assert.equal(a.travel.status,'unavailable');assert.match(a.presentation,/unavailable/i);assert.equal(a.travel.attempts,3);
 }finally{f.dispose();}
});
test('36 recovery duplicate meeting events preserve retry timing and clearing the meeting cancels rejected intent',()=>{
 const f=fixture();try{
  const {actors,den}=f;den.routineSpots.length=0;let queries=0;const good=den.walkWorld.navigation.groundAt;den.walkWorld.navigation.groundAt=()=>{queries++;return null;};
  const meeting={id:'retry-meeting',ref:'retry-meeting',state:'running',seats:[{role:'developer'}]},a=actors.actors.get('developer'),home=a.home.clone();
  actors.applyMeeting(meeting);const first=queries;advance(actors,7);actors.applyMeeting({...meeting});assert.equal(queries,first);advance(actors,2);assert.ok(queries>first);advance(actors,30);assert.equal(a.travel.attempts,3);
  const exhausted=queries;actors.applyMeeting({...meeting});advance(actors,20);assert.equal(queries,exhausted);assert.deepEqual(a.panda.model.position,home);
  actors.applyMeeting(null);den.walkWorld.navigation.groundAt=good;actors.update(.1,true);advance(actors,20,true);assert.equal(a.travel.placeId,a.homePlace);assert.equal(a.travel.status,'arrived');assert.equal(a.seat,null);assert.deepEqual(a.panda.model.position,home);assert.equal([...actors.places.values()].some(p=>p.kind==='meeting'&&p.owner===a.identity),false);
 }finally{f.dispose();}
});
test('36 recovery failed leisure resumes after navigation function replacement without firing effects on failure',()=>{
 const f=fixture();try{
  const {actors,den}=f;den.routineSpots.splice(1);const good=den.walkWorld.navigation.groundAt;advance(actors,2.1);const a=[...actors.actors.values()].find(a=>a.routine);assert.ok(a);const at=a.panda.model.position.clone();
  den.walkWorld.navigation.groundAt=()=>null;advance(actors,40);assert.equal(a.travel.status,'unavailable');assert.equal(f.feeds,0);assert.deepEqual(a.panda.model.position,at);assert.ok(a.routineFailures.has('tea'));
  for(const b of actors.actors.values())if(b!==a)b.stationary=true;
  const revision=den.walkWorld.navigation.revision;den.walkWorld.navigation.groundAt=(...args)=>good(...args);actors.update(.1,true);assert.equal(den.walkWorld.navigation.revision,revision);assert.equal(a.travel.status,'arrived');assert.equal(a.travel.placeId,a.homePlace);
  for(let i=0;i<500&&!a.routine;i++)actors.update(.1);assert.ok(a.routine,'a new function invalidates the failed leisure suppression');assert.equal(a.routine.spot.id,'tea');assert.ok(['outbound','visit','return'].includes(a.routine.stage));assert.equal(f.feeds,0);
 }finally{f.dispose();}
});
test('36 recovery initial leisure reservation rejection is bounded, quiet and never a visit',()=>{
 const f=fixture();try{
  const {actors,den}=f,a=actors.actors.get('developer');for(const b of actors.actors.values())if(b!==a)b.stationary=true;den.routineSpots.splice(1);const original=den.routineSpots[0].position;den.routineSpots[0].position=new T.Vector3(30,.26,30);
  let queries=0;const good=den.walkWorld.navigation.groundAt;den.walkWorld.navigation.groundAt=(x,...args)=>{queries++;return args[0]> -5?null:good(x,...args);};
  const at=a.panda.model.position.clone();advance(actors,4.5);assert.equal(a.routine,null,'rejected intent is not an admitted outing');assert.deepEqual(a.panda.model.position,at);advance(actors,35.5);assert.ok(a.routineFailures?.has('tea'));assert.equal(a.routine,null);assert.equal(f.feeds,0);assert.deepEqual(a.panda.model.position,at);assert.equal(a.travel.status,'arrived');assert.equal(a.travel.placeId,a.homePlace);
  const exhausted=queries;advance(actors,30);assert.equal(queries,exhausted);assert.equal([...actors.places.values()].some(p=>p.kind==='leisure'&&p.owner===a.identity),false);
  den.routineSpots[0].position=original;den.walkWorld.navigation.groundAt=(...args)=>good(...args);for(let i=0;i<400&&!a.routine;i++)actors.update(.1);assert.ok(a.routine);assert.equal(a.routine.spot.id,'tea');assert.ok(['moving','arrived'].includes(a.travel.status));assert.equal(actors.places.get(a.travel.placeId).owner,a.identity);
 }finally{f.dispose();}
});
test('36 homes, visitor overflow and leisure leases share full-identity ownership and measured envelopes',()=>{
 const f=fixture();try{
  const {actors}=f;assert.ok(actors.places);
  actors.applyLive([{role:'developer',runtime:'claude',projectId:'one',agentId:'one',ref:'work/1'},{role:'developer',runtime:'claude',projectId:'two',agentId:'two',ref:'work/2'},{role:'developer',runtime:'codex',projectId:'one',agentId:'three',ref:'work/1'}]);
  const allocated=[...actors.actors.values()].filter(a=>a.panda.model.visible);
  for(const a of allocated){const home=actors.places.get(a.homePlace);assert.equal(home.owner,a.identity);assert.ok(a.envelope.radius>0);assert.ok(a.envelope.height>0);}
  for(const a of allocated)for(const b of allocated)if(a!==b)assert.ok(a.home.distanceTo(b.home)>=a.envelope.radius+b.envelope.radius+.049);
  advance(actors,4);const outing=[...actors.actors.values()].find(a=>a.routine);assert.ok(outing);
  assert.equal(actors.places.get(outing.homePlace).owner,outing.identity);
  assert.equal(actors.places.get(outing.travel.placeId).kind,'leisure');assert.equal(actors.places.get(outing.travel.placeId).owner,outing.identity);
 }finally{f.dispose();}
});
test('36 occupied leisure destination remains owned until returning actor clears it; vanished visitor releases all leases',()=>{
 const f=fixture();try{
  const {actors}=f;let a;
  for(let i=0;i<2000&&!a;i++){actors.update(.1);a=[...actors.actors.values()].find(a=>a.routine?.stage==='visit');}
  assert.ok(a);const temporary=actors.places.get(a.travel.placeId),at=a.panda.model.position.clone();
  actors.applyLive([{role:a.role,runtime:a.runtime,projectId:'one',agentId:'new-run',ref:'work/new'}]);
  assert.deepEqual(a.panda.model.position,at);assert.equal(temporary.owner,a.identity);assert.equal(temporary.departing,true);
  assert.equal(actors.places.reserve(temporary.id,'intruder',a.envelope),null);
  advance(actors,5);assert.notEqual(temporary.owner,a.identity);assert.ok(a.panda.model.position.distanceTo(at)>a.envelope.radius*2+.1);
  actors.applyLive([{role:'developer',ref:'work/1'},{role:'developer',agentId:'visitor-run',ref:'work/2'}]);
  const visitor=actors.actors.get('developer#work/2'),owner=visitor.identity;assert.ok([...actors.places.values()].some(p=>p.owner===owner));
  actors.applyLive([]);assert.equal([...actors.places.values()].some(p=>p.owner===owner),false);
 }finally{f.dispose();}
});
test('36 a blocked leisure route never becomes a visit or fires a leisure effect',()=>{
 const f=fixture();try{
  const {actors,den}=f;advance(actors,2.1);const a=[...actors.actors.values()].find(a=>a.routine);assert.ok(a);
  const at=a.panda.model.position.clone();den.walkWorld.navigation.groundAt=()=>null;
  advance(actors,40);assert.notEqual(a.routine?.stage,'visit');assert.deepEqual(a.panda.model.position,at);assert.equal(f.feeds,0);
  assert.equal(a.travel.status,'unavailable');assert.ok(a.routineFailures.has('tea'));actors.update(.1,true);assert.deepEqual(a.panda.model.position,at);assert.notEqual(a.travel.status,'arrived');assert.match(a.presentation,/waiting|unavailable/i);
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
test('42 a meeting visitor never inherits the busy resident tool invocation',()=>{
 const f=fixture();try{
  const first={role:'developer',runtime:'claude',ref:'work/1',agentId:'run42',toolActivity:{text:'Read · own source',sources:[{runId:'run42'}]}};
  f.actors.applyLive([first,{...first,ref:'work/2',agentId:'other42',toolActivity:{text:'Read · visitor source',sources:[{runId:'other42'}]}}]);
  f.actors.applyMeeting({id:'meeting42',ref:'work/meeting',state:'running',seats:[{role:'developer'}]});
  assert.equal(f.actors.actors.get('meeting:developer').live,null);
  assert.equal(f.actors.actors.get('developer').live.toolActivity.sources[0].runId,'run42');
  assert.equal(f.actors.actors.get('developer#work/2').live.toolActivity.sources[0].runId,'other42');
 }finally{f.dispose();}
});
test('42 F3 busy-role meeting guest bubble and card resolve its own exact inspection source',()=>{
 const f=fixture();try{
  const busy={id:'busy-run42',role:'developer',runtime:'claude',project:'den',ref:'work/1',state:'working'};
  const own={...busy,id:'meeting-run42',ref:'work/meeting'};
  const source=run=>({project:'den',runtime:'claude',role:'developer',runId:run.id,entryId:1});
  let ledger={};for(const run of [busy,own])ledger=observeTools(ledger,run.id,{kind:'tool',id:1,invocationId:`call-${run.id}`,name:'Read',summary:run.ref,status:'running',source:source(run)});
  const rows=liveActorsFromSnapshot({agents:[busy,own]},{toolActivity:ledger,connection:{phase:'live'}});
  const meeting={id:'meeting42',ref:own.ref,state:'running',seats:[{role:'developer'}]};
  f.actors.applyLive(rows.filter(r=>r.agentId===busy.id));
  f.actors.applyMeeting(meeting);
  // Additive public contract: meeting context lets the binding map join the
  // scene's actual actor IDs; existing two-argument callers remain supported.
  const bindings=actorBindings(rows,new Map(),{meeting});
  f.actors.applyLive(rows,bindings);
  const guest=f.actors.actors.get('meeting:developer'),resident=f.actors.actors.get('developer');
  assert.equal(guest.live.agentId,own.id,'the production actor routes the meeting run to its guest');
  assert.equal(resident.live.agentId,busy.id,'the resident remains on its independent work');
  // MeshyDen publishes tool anchors under actual scene actor IDs. ToolBubbleLayer
  // joins those IDs to bindings; App joins the picked card ID to the same map.
  const anchors=new Set(f.actors.actors.keys());
  const bubbleIds=[...bindings].filter(([id,row])=>anchors.has(id)&&row.toolActivity).map(([id])=>id);
  const pandas=[...f.actors.actors].map(([id,a])=>{
   const identity={role:a.role,runtime:a.runtime,agentId:a.live?.agentId,ref:a.live?.ref};
   return {id,...identity,state:a.live?.state,agent:agentFor(identity,[busy,own])};
  });
  const card=pickedCard(pandas,[],guest.panda.model.userData.actorKey);
  assert.equal(card.agentId,own.id,'the actual guest card identifies its own run');
  assert.deepEqual({guestBubble:bubbleIds.includes(card.id),guestInspection:bindings.get(card.id)?.toolActivity?.sources,residentInspection:bindings.get(resident.panda.model.userData.actorKey)?.toolActivity?.sources},
   {guestBubble:true,guestInspection:[source(own)],residentInspection:[source(busy)]},'both public actor/card joins expose the guest exact source without borrowing the busy resident invocation');
 }finally{f.dispose();}
});
test('team-and-den-ux/23: a first-person walker beside a species resident can still walk away from it',()=>{
 const f=fixture();try{
  const {actors,den}=f,engineer=actors.actors.get('developer');engineer.panda.rig.profile=RED_PANDA;
  const at=engineer.panda.model.position,avoid=den.walkAvoid();
  assert.ok(avoid.every(a=>a.r<=.65),'the walker keeps a body width from every resident');
  const world={...den.walkWorld,avoid},start={x:at.x+1.5,z:at.z,groundY:.26,yaw:-Math.PI/2,pitch:0,walkTime:0};
  const next=walk(start,{forward:1},1,world);
  assert.ok(next.x-start.x>.5,`moved ${(next.x-start.x).toFixed(2)} away from the red panda`);
 }finally{f.dispose();}
});

for(const copy of ['visitor','meeting'])test(`36 ${copy} allocation clears passing bodies and failed preparation preserves truthful ownership`,()=>{
 const f=fixture();try{
  const {actors,den}=f;den.routineSpots.length=0;
  const crossing=actors.actors.get('qa');crossing.panda.model.position.set(0,.26,30);
  actors.applyLive([{role:'developer',ref:'one',agentId:'one'}]);
  if(copy==='visitor')actors.applyLive([{role:'developer',ref:'one',agentId:'one'},{role:'developer',ref:'two',agentId:'two'}]);
  else actors.applyMeeting({id:'m/36',ref:'two',state:'running',seats:[{role:'developer'}]});
  const a=actors.actors.get(copy==='visitor'?'developer#two':'meeting:developer');assert.ok(a);
  for(const b of actors.actors.values())if(b!==a&&b.panda.model.visible&&a.panda.model.visible)assert.ok(Math.hypot(a.panda.model.position.x-b.panda.model.position.x,a.panda.model.position.z-b.panda.model.position.z)>=a.envelope.radius+b.envelope.radius+.029,`${copy} starts clear of ${b.id}'s current measured body`);
  // A later arrival cannot teleport into the body's current location either.
  if(a.panda.model.visible){actors.update(.1,true);for(const b of actors.actors.values())if(b!==a&&b.panda.model.visible)assert.ok(Math.hypot(a.panda.model.position.x-b.panda.model.position.x,a.panda.model.position.z-b.panda.model.position.z)>=a.envelope.radius+b.envelope.radius+.029);}
 }finally{f.dispose();}
 const blocked=fixture();try{
  const {actors,den}=blocked;den.routineSpots.length=0;actors.applyLive([{role:'developer',ref:'one',agentId:'one'}]);den.walkWorld.navigation.groundAt=()=>null;
  if(copy==='visitor')actors.applyLive([{role:'developer',ref:'one',agentId:'one'},{role:'developer',ref:'two',agentId:'two'}]);
  else actors.applyMeeting({id:'m/36',ref:'two',state:'running',seats:[{role:'developer'}]});
  const a=actors.actors.get(copy==='visitor'?'developer#two':'meeting:developer');assert.ok(a);assert.equal(a.panda.model.visible,false);
  assert.equal(a.homePlace,null,'clone never inherits the resident home lease');
  for(let i=0;i<50;i++)actors.update(.1,i%2===0);
  assert.equal(a.panda.model.visible,false);assert.match(a.presentation,/scene place unavailable/i);assert.equal(a.travel,null,'an unplaced clone never requests a route from a foreign home');
  assert.equal([...actors.places.values()].some(p=>p.owner===a.identity),false,'failed preparation owns no foreign or temporary leases');
  assert.equal(actors.actors.get('developer').live.agentId,'one','real run remains admitted');
 }finally{blocked.dispose();}
});
