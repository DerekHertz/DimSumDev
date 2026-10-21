import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createMeshyActors} from './actors.mjs';
import {createBalancedPandaRig} from './panda-rig.mjs';
import {RESIDENTS as definitions,boundAgentKey} from '../../shell/resident-inventory.mjs';
import {RED_PANDA} from './character-profiles.mjs';
import {walk} from '../procedural/walk.mjs';
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

test('homes-first keeps all 32 homes fixed through idle, live rebinding, tea and meeting observations',()=>{
 const f=fixture();try{
  const {actors,den}=f,homes=new Map([...actors.actors].map(([id,a])=>[id,a.home.clone()]));
  assert.equal(actors.actors.size,32);
  for(const a of actors.actors.values()){
   assert.equal(a.panda.model.visible,true);assert.equal(actors.places.get(a.homePlace).owner,a.identity);
   for(const b of actors.actors.values())if(a!==b)assert.ok(a.home.distanceTo(b.home)>=a.envelope.radius+b.envelope.radius+.049);
  }
  const rows=[{role:'developer',ref:'work/one',agentId:'one'},{role:'developer',ref:'work/two',agentId:'two'},{role:'developer',runtime:'codex',ref:'work/one',agentId:'codex'}];
  let queries=0;den.walkWorld.navigation.groundAt=()=>{queries++;throw Error('home rebinding/update must not search terrain');};
  actors.applyLive(rows);actors.applyMeeting({id:'meeting',ref:'work/two',state:'running',seats:[{role:'developer'}]});
  for(let i=0;i<800;i++)actors.update(.1,i%2===0);
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
