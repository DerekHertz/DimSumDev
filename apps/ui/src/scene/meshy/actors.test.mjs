import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createMeshyActors} from './actors.mjs';
import {createBalancedPandaRig,createRig} from './panda-rig.mjs';
import {RESIDENTS as definitions,boundAgentKey} from '../../shell/resident-inventory.mjs';
import {RED_PANDA} from './character-profiles.mjs';
import {walk} from '../procedural/walk.mjs';
function fixture({water=false,profiles=false}={}){
 const body=new T.Mesh(new T.BoxGeometry(2,3,1),new T.MeshStandardMaterial());body.position.y=1.5;
 const den={residents:new T.Group(),pandaRigs:new Map(),propManifest:definitions,roleWorkspaces:{workspaces:new Map()},walkWorld:{floorRadius:70,obstacles:water?[{type:'circle',x:0,z:-5,radius:.6}]:[],navigation:{groundAt:(x,z,y,r=0)=>water&&Math.abs(z+5)<.5+r&&Math.abs(x)>=2.5?null:.26}}};
 den.createPanda=(role,{runtime='claude'}={})=>{const rig=profiles&&role==='developer'?createRig(body,RED_PANDA):createBalancedPandaRig(body);rig.model.scale.setScalar(.68);rig.model.userData={roleId:role,actorKey:role,runtime};den.pandaRigs.set(rig.model,{rig});return{model:rig.model,rig};};
 den.destroyPanda=model=>{den.pandaRigs.get(model)?.rig.dispose();den.pandaRigs.delete(model);};
 for(const[i,d]of definitions.entries()){const panda=den.createPanda(d.role,{runtime:d.runtime});panda.model.userData.actorKey=d.id;panda.model.position.set((i%7-3)*3,.26,-8-Math.floor(i/7)*4);den.residents.add(panda.model);den.roleWorkspaces.workspaces.set(d.id,{person:panda.model});}
 den.routineSpots=[...[-20,0,20].map(x=>({id:'tea:'+x,kind:'tea',group:'tea:'+x,position:new T.Vector3(x,.26,-2),face:new T.Vector3(x,.26,-3)})),...[-20,0,20].map(x=>({id:'pond:'+x,kind:'pond',group:'pond:'+x,position:new T.Vector3(x,.26,12),face:new T.Vector3(x,.26,11)}))];
 // Station and library slots stand in a row at z=0, four per group, facing the residents' desks; a team's slots carry its label as "team".
 for(const [g,team]of['The Pass','Steamers','Tea','Pantry','Front of House','Library'].entries())for(let i=0;i<4;i++){const kind=team==='Library'?'library':'station',x=-12+g*4.4+i*1.1;den.routineSpots.push({id:kind+':'+team+':'+i,kind,group:kind+':'+team,team,position:new T.Vector3(x,.26,0),face:new T.Vector3(x,.26,-3)});}
 let feeds=0;den.feedKoi=()=>feeds++;
 const actors=createMeshyActors(den);return{den,actors,get feeds(){return feeds;},dispose(){actors.dispose();for(const model of [...den.pandaRigs.keys()])den.destroyPanda(model);body.geometry.dispose();body.material.dispose();}};
}

test('homes-first keeps all 24 continuing homes fixed through idle, live rebinding, tea and meeting observations',()=>{
 const f=fixture();try{
  const {actors,den}=f,homes=new Map([...actors.actors].map(([id,a])=>[id,a.home.clone()]));
  assert.equal(actors.actors.size,24);
  for(const a of actors.actors.values()){
   assert.equal(a.panda.model.visible,true);assert.equal(actors.places.get(a.homePlace).owner,a.identity);
   for(const b of actors.actors.values())if(a!==b)assert.ok(a.home.distanceTo(b.home)>=a.envelope.radius+b.envelope.radius+.049);
  }
  const rows=[{role:'developer',ref:'work/one',agentId:'one'},{role:'developer',ref:'work/two',agentId:'two'},{role:'developer',runtime:'codex',ref:'work/one',agentId:'codex'}];
  let queries=0;den.walkWorld.navigation.groundAt=()=>{queries++;throw Error('reduced-motion home updates must not search terrain');};
  actors.applyLive(rows);actors.applyMeeting({id:'meeting',ref:'work/two',state:'running',seats:[{role:'developer'}]});
  for(let i=0;i<800;i++)actors.update(.1,true);
  assert.equal(queries,0);assert.equal(actors.actors.size,24);assert.equal(den.pandaRigs.size,24);
  assert.equal(actors.liveFigures().size,2,'extra run has no borrowed scene anchor');
  assert.equal(actors.seatModels().size,0);assert.equal(actors.seatOf('developer'),null);
  assert.match(actors.presentationRows().find(p=>p.ref==='work/two').presentation,/visitor deferred/);
  const firstOwner=actors.actors.get('developer').identity;
  actors.applyLive([{role:'developer',agentId:'replacement',projectId:'other',ref:'work/new'}]);
  assert.notEqual(actors.actors.get('developer').identity,firstOwner);
  for(const [id,a]of actors.actors){assert.deepEqual(a.home,homes.get(id));assert.deepEqual(a.panda.model.position,homes.get(id));assert.equal(actors.places.get(a.homePlace).owner,a.identity);}
  actors.applyLive([]);assert.equal(actors.actors.size,24);
 }finally{f.dispose();assert.equal([...f.actors.places.values()].length,0);}
});

test('homes-first retains independent runtime selection and primary live anchors',()=>{
 const f=fixture();try{
  const claude={role:'developer',runtime:'claude',ref:'work/01'},codex={role:'developer',runtime:'codex',ref:'work/01'};
  f.actors.applyLive([claude,codex]);f.actors.setSelected(codex);
  assert.equal(f.actors.actors.get('codex:developer').panda.model.userData.selected,true);
  assert.equal(f.actors.actors.get('developer').panda.model.userData.selected,false);
  for(const row of [claude,codex])assert.equal(f.actors.liveFigures().get(boundAgentKey(row)).model,f.actors.actors.get(row.runtime==='codex'?'codex:developer':'developer').panda.model);
  f.actors.setSelected('work/01');assert.equal(f.actors.actors.get('codex:developer').panda.model.userData.selected,false);
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

// team-and-den-ux/55 sections 7–9/11: leisure outings on top of owned homes.
const away=a=>a.panda.model.position.distanceTo(a.home)>1e-9;
const frames=(f,seconds,each=()=>{},reduced=false)=>{for(let t=0;t<seconds;t+=.1){f.actors.update(.1,reduced);each(t);}};
const rowText=(f,ref)=>f.actors.presentationRows().find(p=>p.ref===ref)?.presentation;
const everyone=f=>[...f.actors.actors.values()];
test('leisure props exist before the first visit so their materials can be prepared at load time',()=>{
 const f=fixture();try{
  for(const actor of everyone(f).filter(a=>!a.stationary)){
   assert.ok(actor.gesture,'leisure gesture is prepared with its resident');
   assert.equal(actor.gesture.cup.visible,false);
  }
 }finally{f.dispose();}
});
// Home -> away transitions, in seconds, plus the spots each resident visits on each roam (a roam ends at home).
function watch(f,seconds,{reduced=false,each=()=>{}}={}){
 const was=new Map(),departures=[],roams=[],open=new Map();
 frames(f,seconds,t=>{
  for(const a of everyone(f)){
   const out=away(a);
   if(out&&!was.get(a.id)){departures.push(t);open.set(a.id,[]);}
   if(!out&&was.get(a.id)){roams.push({a,stops:open.get(a.id)});open.delete(a.id);}
   was.set(a.id,out);
   const r=a.outing;if(r?.stage==='visit'){const stops=open.get(a.id);if(stops&&stops.at(-1)!==r.spot.id)stops.push(r.spot.id);}
   each(a,t);
  }
 },reduced);
 return {departures,roams};
}

test('55 section 7: capped and staggered departures leave live workers and both executives at home',()=>{
 const f=fixture();try{
  const busy=['developer','qa','designer'];
  f.actors.applyLive([...busy.map(role=>({role,ref:'work/'+role,agentId:role})),{role:'orchestrator',runtime:'claude',ref:'work/bao',agentId:'bao'},{role:'orchestrator',runtime:'codex',ref:'work/jiao',agentId:'jiao'}]);
  let most=0;const {departures}=watch(f,600,{each:(a,t)=>{
   if(a.live)assert.equal(away(a),false,a.id+' stays at home at '+t);
   most=Math.max(most,everyone(f).filter(away).length);
  }});
  assert.ok(departures.length>0,'at least one resident departs');
  assert.ok(most<=3,'no more than three residents are away: '+most);
  for(let k=1;k<departures.length;k++)assert.ok(departures[k]-departures[k-1]>=4,'departures are at least four seconds apart: '+departures.slice(k-1,k+1));
 }finally{f.dispose();}
});

test('55 section 8: a real tea or pond visit settles, gestures, avoids water and obstacles, and returns home',()=>{
 const f=fixture({water:true,profiles:true});try{
  const {den,actors}=f,seen=new Map(),visited=new Set(),returned=new Set(),ground=den.walkWorld.navigation.groundAt;
  frames(f,1800,()=>{
   for(const a of actors.actors.values()){
    const p=a.panda.model.position;
    assert.notEqual(ground(p.x,p.z),null,a.id+' stands in water');
    assert.ok(Math.hypot(p.x,p.z+5)>.6,a.id+' is inside the obstacle');
    const r=a.outing;
    if(r?.stage==='visit'){
     assert.ok(Math.hypot(p.x-r.spot.position.x,p.z-r.spot.position.z)<.05,'plays the gesture at its spot');
     if(['tea','pond'].includes(r.spot.kind)){visited.add(a.id);seen.set(a.id,{kind:r.spot.kind,gesture:a.gesture,spot:r.spot.id});}
     if(r.spot.kind==='pond'&&f.feeds>0)seen.set(a.id,{kind:'pond',gesture:a.gesture,spot:r.spot.id});
     if(r.spot.kind==='tea'&&a.gesture?.cup.visible)seen.set(a.id,{kind:'tea',gesture:a.gesture,spot:r.spot.id});
    }else if(visited.has(a.id)&&!r&&!away(a))returned.add(a.id);
   }
  });
  const visits=[...seen.values()];assert.ok(visits.some(v=>v.kind==='tea'||v.kind==='pond'),'observed a real tea or pond destination');
  assert.ok(visits.some(v=>v.kind==='tea'&&v.gesture?.cup.visible)||visits.some(v=>v.kind==='pond'&&f.feeds>0),'the settled visit performs its tea or pond gesture');
  assert.ok(visits.every(v=>v.spot!=='greeting'),'only actual tea and pond destinations count');
  assert.ok(returned.size>0,'completed visitors return to their owned homes');
 }finally{f.dispose();}
});

test('55 section 9: live runs reclaim residents during outbound travel and a settled visit',()=>{
 for(const phase of ['outbound','visit']){
  const f=fixture({profiles:true});try{
   const a=f.actors.actors.get('developer');let found=false;
   for(let i=0;i<12000&&!found;i++){
    f.actors.update(.1);found=a.outing?.stage===phase&&(phase==='visit'||away(a));
   }
   assert.ok(found,'an actual resident reaches '+phase);
   const row={role:a.role,runtime:a.runtime,ref:'work/live/'+phase,agentId:'live-maker',state:'working',activity:'Implementing the ticket'};f.actors.applyLive([row]);
   assert.equal(rowText(f,row.ref),'Working · returning to desk');
   let last=a.panda.model.position.distanceTo(a.home);assert.ok(last>0);
   for(let i=0;i<600&&away(a);i++){
    f.actors.update(.1);const d=a.panda.model.position.distanceTo(a.home);
    assert.ok(d<=last+1e-6,'resident returns monotonically to its own desk');last=d;
    if(away(a))assert.equal(rowText(f,row.ref),'Working · returning to desk');
    else assert.notEqual(rowText(f,row.ref),'Working · returning to desk');
   }
   assert.equal(away(a),false,'resident reaches its owned home');assert.equal(a.outing,null);
   assert.equal(rowText(f,row.ref),undefined);assert.equal(f.actors.liveFigures().get(boundAgentKey(row))?.model,a.panda.model,'scene return does not block the live binding');
  }finally{f.dispose();}
 }
});

test('55 section 11: reduced motion preserves homes and causes no gait or path searches',()=>{
 const f=fixture();try{
  const homes=new Map(everyone(f).map(a=>[a.id,a.home.clone()]));let queries=0;
  const ground= f.den.walkWorld.navigation.groundAt;f.den.walkWorld.navigation.groundAt=(...args)=>{queries++;return ground(...args);};
  frames(f,60,()=>{},true);
  assert.equal(queries,0,'reduced motion performs no path/terrain searches');
  for(const a of everyone(f)){
   assert.equal(away(a),false,a.id+' remains at home');assert.deepEqual(a.panda.model.position,homes.get(a.id));
   assert.equal(a.gait||0,0,a.id+' does not gait');assert.equal(a.outing,null,a.id+' has no newly scheduled outing');
  }
  // An actual active legacy excursion may freeze safely with its owned home intact.
  const a=everyone(f).find(x=>!x.stationary);let found=false;
  for(let i=0;i<12000&&!found;i++){f.actors.update(.1);found=!!a.outing;}
  assert.ok(found,'an actual excursion started');
  const before=a.panda.model.position.clone(),stage=a.outing.stage,path=a.path?.map(p=>({...p}));
  frames(f,10,()=>{},true);
  assert.deepEqual(a.panda.model.position,before);assert.equal(a.outing.stage,stage);assert.deepEqual(a.path,path);assert.equal(f.actors.places.get(a.homePlace).owner,a.identity);
 }finally{f.dispose();}
});

test('55 section 8: every current visit faces its actual target and owns its destination',()=>{
 const f=fixture();try{
  let visits=0;
  frames(f,1200,()=>{
   for(const a of everyone(f)){
    const r=a.outing;if(r?.stage==='visit'&&r.elapsed>0&&r.spot){
     visits++;
     const p=a.panda.model.position,want=Math.atan2(r.spot.face.x-p.x,r.spot.face.z-p.z);
     assert.ok(Math.abs(Math.atan2(Math.sin(a.panda.model.rotation.y-want),Math.cos(a.panda.model.rotation.y-want)))<.05,a.id+' faces '+r.spot.id);
     const place=f.actors.places.get(r.spot.id);assert.equal(place?.owner,a.identity,a.id+' owns '+r.spot.id);
    }
   }
  });
  assert.ok(visits>0,'observed at least one settled current destination');
 }finally{f.dispose();}
});

test('55 section 8: completed outings settle once for 45–90 seconds and honor the 120-second home cooldown',()=>{
 const f=fixture();try{
  const active=new Map(),completed=[];let time=0;
  for(;time<1800&&completed.length<3;time+=.1){
   f.actors.update(.1);
   for(const a of everyone(f)){
    const r=a.outing,old=active.get(a.id);
    if(r&&!old)active.set(a.id,{spot:r.spot?.id,visitStarted:r.stage==='visit'?time:null,visitSeconds:null});
    else if(r&&old){if(r.spot)assert.equal(r.spot.id,old.spot,'one destination per outing');if(r.stage==='visit'&&old.visitStarted===null)old.visitStarted=time;if(r.stage==='return'&&old.visitStarted!==null&&old.visitSeconds===null)old.visitSeconds=time-old.visitStarted;}
    else if(!r&&old&&!away(a)){
     if(old.visitStarted!==null){old.visitSeconds??=time-old.visitStarted;assert.ok(old.visitSeconds>=45&&old.visitSeconds<=90.2,'settled duration '+old.visitSeconds);assert.ok(a.nextOuting-f.actors.routines.time>=120,'home cooldown is at least 120 seconds');completed.push(old);}
     active.delete(a.id);
    }
   }
  }
  assert.ok(completed.length>0,'observed at least one completed, settled outing');
 }finally{f.dispose();}
});
