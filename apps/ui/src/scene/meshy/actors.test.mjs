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

test('den-revival/07 criterion 1: an idle resident leaves within seconds, three are out at most, Bao keeps hosting',()=>{
 const f=fixture();try{
  const bao=f.actors.actors.get('orchestrator');let first=null,most=0;
  frames(f,120,t=>{const n=[...f.actors.actors.values()].filter(away).length;most=Math.max(most,n);if(n&&first===null)first=t;assert.equal(away(bao),false);});
  assert.ok(first!==null&&first<=6,'first departure at '+first);
  assert.equal(most,3,'three out, never a fourth');
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

test('den-revival/07 criterion 4: reduced motion keeps everyone home, and snaps an outing home',()=>{
 const f=fixture();try{
  frames(f,300,()=>{},true);assert.equal([...f.actors.actors.values()].filter(away).length,0);
  frames(f,20);assert.ok([...f.actors.actors.values()].some(away),'motion on: someone is out');
  f.actors.update(.1,true);assert.equal([...f.actors.actors.values()].filter(away).length,0,'reduced motion sends them home');
 }finally{f.dispose();}
});
