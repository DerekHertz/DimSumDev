import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createMeshyActors} from './actors.mjs';
import {createBalancedPandaRig} from './panda-rig.mjs';
import {RESIDENTS as definitions,boundAgentKey} from '../../shell/resident-inventory.mjs';
import {RED_PANDA} from './character-profiles.mjs';
import {walk} from '../procedural/walk.mjs';
function fixture({water=false}={}){
 const body=new T.Mesh(new T.BoxGeometry(2,3,1),new T.MeshStandardMaterial());body.position.y=1.5;
 const den={residents:new T.Group(),pandaRigs:new Map(),propManifest:definitions,roleWorkspaces:{workspaces:new Map()},walkWorld:{floorRadius:70,obstacles:water?[{type:'circle',x:0,z:-5,radius:.6}]:[],navigation:{groundAt:(x,z,y,r=0)=>water&&Math.abs(z+5)<.5+r&&Math.abs(x)>=2.5?null:.26}}};
 den.createPanda=(role,{runtime='claude'}={})=>{const rig=createBalancedPandaRig(body);rig.model.scale.setScalar(.68);rig.model.userData={roleId:role,actorKey:role,runtime};den.pandaRigs.set(rig.model,{rig});return{model:rig.model,rig};};
 den.destroyPanda=model=>{den.pandaRigs.get(model)?.rig.dispose();den.pandaRigs.delete(model);};
 for(const[i,d]of definitions.entries()){const panda=den.createPanda(d.role,{runtime:d.runtime});panda.model.userData.actorKey=d.id;panda.model.position.set((i%7-3)*3,.26,-8-Math.floor(i/7)*4);den.residents.add(panda.model);den.roleWorkspaces.workspaces.set(d.id,{person:panda.model});}
 den.routineSpots=[{id:'tea',kind:'tea',position:new T.Vector3(0,.26,-2),face:new T.Vector3(0,.26,-3)},{id:'pond',kind:'pond',position:new T.Vector3(3,.26,-2),face:new T.Vector3(3,.26,-3)},{id:'greeting',kind:'greeting',position:new T.Vector3(-3,.26,-2),face:new T.Vector3(-3,.26,-3)}];
 // Station and library slots stand in a row at z=0, four per group, facing the residents' desks; a team's slots carry its label as "team".
 for(const [g,team]of['The Pass','Steamers','Tea','Pantry','Front of House','Library'].entries())for(let i=0;i<4;i++){const kind=team==='Library'?'library':'station',x=-12+g*4.4+i*1.1;den.routineSpots.push({id:kind+':'+team+':'+i,kind,group:kind+':'+team,team,position:new T.Vector3(x,.26,0),face:new T.Vector3(x,.26,-3)});}
 let feeds=0;den.feedKoi=()=>feeds++;
 const actors=createMeshyActors(den);return{den,actors,get feeds(){return feeds;},dispose(){actors.dispose();for(const model of [...den.pandaRigs.keys()])den.destroyPanda(model);body.geometry.dispose();body.material.dispose();}};
}

test('homes-first keeps all 32 homes fixed through idle, live rebinding, tea and meeting observations',()=>{
 const f=fixture();try{
  const {actors,den}=f,homes=new Map([...actors.actors].map(([id,a])=>[id,a.home.clone()]));
  assert.equal(actors.actors.size,32);
  for(const a of actors.actors.values()){
   assert.equal(a.panda.model.visible,true);assert.equal(actors.places.get(a.homePlace).owner,a.identity);
   for(const b of actors.actors.values())if(a!==b)assert.ok(a.home.distanceTo(b.home)>=a.envelope.radius+b.envelope.radius+.049);
  }
  const rows=[{role:'developer',ref:'work/one',agentId:'one'},{role:'developer',ref:'work/two',agentId:'two'},{role:'developer',runtime:'codex',ref:'work/one',agentId:'codex'}];
  let queries=0;den.walkWorld.navigation.groundAt=()=>{queries++;throw Error('reduced-motion home updates must not search terrain');};
  actors.applyLive(rows);actors.applyMeeting({id:'meeting',ref:'work/two',state:'running',seats:[{role:'developer'}]});
  for(let i=0;i<800;i++)actors.update(.1,true);
  assert.equal(queries,0);assert.equal(actors.actors.size,32);assert.equal(den.pandaRigs.size,32);
  assert.equal(actors.liveFigures().size,2,'extra run has no borrowed scene anchor');
  assert.equal(actors.seatModels().size,0);assert.equal(actors.seatOf('developer'),null);
  assert.match(actors.presentationRows().find(p=>p.ref==='work/two').presentation,/visitor deferred/);
  const firstOwner=actors.actors.get('developer').identity;
  actors.applyLive([{role:'developer',agentId:'replacement',projectId:'other',ref:'work/new'}]);
  assert.notEqual(actors.actors.get('developer').identity,firstOwner);
  for(const [id,a]of actors.actors){assert.deepEqual(a.home,homes.get(id));assert.deepEqual(a.panda.model.position,homes.get(id));assert.equal(actors.places.get(a.homePlace).owner,a.identity);}
  actors.applyLive([]);assert.equal(actors.actors.size,32);
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

// den-revival/07: leisure outings on top of the owned homes.
const away=a=>a.panda.model.position.distanceTo(a.home)>1e-9;
const frames=(f,seconds,each=()=>{},reduced=false)=>{for(let t=0;t<seconds;t+=.1){f.actors.update(.1,reduced);each(t);}};
const rowText=(f,ref)=>f.actors.presentationRows().find(p=>p.ref===ref)?.presentation;
const everyone=f=>[...f.actors.actors.values()];
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

test('den-revival/07 criterion 1: any resident with no live work roams, departures are staggered, Bao keeps hosting',()=>{
 const f=fixture();try{
  const bao=f.actors.actors.get('orchestrator'),busy=['developer','qa','designer'];
  f.actors.applyLive(busy.map(role=>({role,ref:'work/'+role,agentId:role})));
  let most=0;
  const {departures}=watch(f,300,{each:(a,t)=>{
   if(a===bao||busy.includes(a.id))assert.equal(away(a),false,a.id+' stays at its desk at '+t);
   if(a.id==='architect')most=Math.max(most,everyone(f).filter(away).length);
  }});
  assert.ok(departures[0]<=6,'first departure at '+departures[0]);
  assert.ok(most>=8,'many are out at once: '+most);
  assert.ok(departures.length>=20,'most of the den roams: '+departures.length);
  for(let k=1;k<departures.length;k++)assert.ok(departures[k]-departures[k-1]>=3.5,'staggered: '+departures.slice(k-1,k+1));
  assert.equal(bao.activity,'Hosting the Den');
 }finally{f.dispose();}
});

test('den-revival/07 criterion 2: an outing reaches its spot, plays its gesture, returns home and never enters water or an obstacle',()=>{
 const f=fixture({water:true});try{
  const {den,actors}=f,seen=new Set(),visited=new Set(),home=new Set(),ground=den.walkWorld.navigation.groundAt;
  frames(f,240,()=>{
   for(const a of actors.actors.values()){
    const p=a.panda.model.position;
    assert.notEqual(ground(p.x,p.z),null,a.id+' stands in water');
    assert.ok(Math.hypot(p.x,p.z+5)>.6,a.id+' is inside the obstacle');
    const r=a.outing;
    if(r?.stage==='visit'){
     assert.ok(Math.hypot(p.x-r.spot.position.x,p.z-r.spot.position.z)<.05,'plays the gesture at its spot');
     if(r.spot.kind==='tea'&&a.gesture?.cup.visible)seen.add('tea');
     if(r.spot.kind==='greeting'&&a.gesture)seen.add('greeting');
     if(r.spot.kind==='pond'&&f.feeds>0)seen.add('pond');
     visited.add(a.id);
    }else if(visited.has(a.id)&&!r&&!away(a))home.add(a.id);
   }
  });
  assert.deepEqual([...seen].sort(),['greeting','pond','tea']);
  assert.ok(home.size>=3,'residents who visited are home again: '+home.size);
 }finally{f.dispose();}
});

test('den-revival/07 criterion 3: a live run ends the outing at once and shows the return until the resident is at its desk',()=>{
 for(const stage of ['outbound','visit']){
  const f=fixture();try{
   const a=f.actors.actors.get('developer');let t=0;
   for(;t<200&&!(a.outing?.stage===stage&&(stage==='visit'||a.panda.model.position.distanceTo(a.home)>1.5));t+=.1)f.actors.update(.1);
   assert.equal(a.outing?.stage,stage,'reached the '+stage+' stage');
   const row={role:'developer',ref:'work/live',agentId:'dev-1'};f.actors.applyLive([row]);
   assert.equal(rowText(f,'work/live'),'Working · returning to desk');
   let last=a.panda.model.position.distanceTo(a.home);assert.ok(last>.5);
   for(let i=0;i<600&&away(a);i++){
    f.actors.update(.1);const d=a.panda.model.position.distanceTo(a.home);
    assert.ok(d<=last+1e-6,'only ever walks toward the desk ('+stage+')');last=d;
    assert.equal(rowText(f,'work/live'),away(a)?'Working · returning to desk':undefined);
   }
   assert.equal(away(a),false,'back at the station');assert.equal(a.outing,null);
   assert.equal(rowText(f,'work/live'),undefined);assert.equal(a.gesture?.cup.visible??false,false);
   frames(f,60);assert.equal(away(a),false,'a live resident stays at its desk');
  }finally{f.dispose();}
 }
});

test('den-revival/07 criterion 4: reduced motion keeps everyone home, and snaps every roamer home',()=>{
 const f=fixture();try{
  const none=()=>assert.equal(everyone(f).filter(away).length,0);
  frames(f,60,none,true);
  frames(f,40);const out=everyone(f).filter(away).length;assert.ok(out>=3,'motion on: '+out+' are out');
  // Reduced motion from here on: nobody is left out, nobody leaves again, frame after frame.
  frames(f,60,none,true);
  frames(f,40);assert.ok(everyone(f).some(away),'motion on again: someone is out');
  f.actors.update(.1,true);none();
 }finally{f.dispose();}
});

test('den-revival/07 criterion 5: residents snoop at other teams\' stations and the library, face them, look around, then leave',()=>{
 const f=fixture();try{
  const kinds=new Set(),facings=new Map();
  frames(f,400,()=>{
   for(const a of everyone(f)){
    const r=a.outing;if(!r?.spot)continue;
    if(r.spot.team)assert.notEqual(r.spot.team,a.team,a.id+' visits its own team at '+r.spot.id);
    if(r.stage==='visit'&&(r.spot.kind==='station'||r.spot.kind==='library')){
     kinds.add(r.spot.kind);
     const p=a.panda.model.position,want=Math.atan2(r.spot.face.x-p.x,r.spot.face.z-p.z),seen=facings.get(a.id)??new Set();
     if(r.elapsed>1.2&&r.elapsed<1.7)assert.ok(Math.abs(Math.atan2(Math.sin(a.panda.model.rotation.y-want),Math.cos(a.panda.model.rotation.y-want)))<.05,a.id+' faces '+r.spot.id);
     seen.add(Math.round(a.panda.model.rotation.y*5));facings.set(a.id,seen);
    }
   }
  });
  assert.deepEqual([...kinds].sort(),['library','station']);
  assert.ok([...facings.values()].some(s=>s.size>=3),'turns between at least three facings');
  assert.ok(facings.size>=6,'many residents snoop: '+facings.size);
 }finally{f.dispose();}
});

test('den-revival/07 criterion 6: a roam chains two or three nearby spots, nearest first, then goes home',()=>{
 const f=fixture();try{
  const spots=f.den.routineSpots,sizes=[];let hops=0;const prev=new Map();
  const {roams}=watch(f,500,{each:a=>{
   const r=a.outing,last=prev.get(a.id);
   if(r?.spot&&last&&r.spot!==last.spot&&last.stage==='visit'){
    hops++;const from=a.panda.model.position,d=s=>Math.hypot(s.position.x-from.x,s.position.z-from.z);
    const taken=new Set(everyone(f).filter(b=>b!==a&&b.outing?.spot).map(b=>b.outing.spot.id));
    const near=Math.min(...spots.filter(s=>!taken.has(s.id)&&!r.seen.has(s.group)||s===r.spot).filter(s=>!s.team||s.team!==a.team).map(d));
    assert.ok(d(r.spot)<=near+4,a.id+' hops to the nearest spot, '+d(r.spot).toFixed(1)+' vs '+near.toFixed(1));
   }
   prev.set(a.id,r?{spot:r.spot,stage:r.stage}:null);
  }});
  for(const {stops}of roams)sizes.push(stops.length);
  assert.ok(Math.max(...sizes)<=3,'at most three spots: '+sizes);
  assert.ok(sizes.some(n=>n>=2)&&hops>0,'some roams chain: '+sizes);
 }finally{f.dispose();}
});
