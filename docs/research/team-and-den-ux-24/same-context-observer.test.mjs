import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createSameContextBaoObserver,calibrationPlan} from './same-context-observer.mjs';

function fixture(){
 const residents=new T.Group(),world=new T.Group();world.add(residents);
 const calls={original:0,selected:0},disposed={original:0,selected:0};
 function panda(kind){const model=new T.Group(),bone=new T.Bone(),mesh=new T.Mesh(new T.BoxGeometry(),new T.MeshStandardMaterial());mesh.castShadow=true;model.add(bone,mesh);model.scale.setScalar(1.35);model.userData={roleId:'orchestrator',runtime:'claude',actorKey:'orchestrator',...(kind==='selected'?{species:'giant-panda'}:{})};return {model,rig:{model,poseIdle(t,options){calls[kind]++;bone.rotation.y=t;this.last=[t,options];},skeleton:{update(){}},dispose(){disposed[kind]++;}}};}
 const original=panda('original'),selected=panda('selected');residents.add(selected.model);selected.model.position.set(1,2,3);selected.model.rotation.y=.7;selected.model.userData.ticketRef='example/24';
 const gestures=[];function createGesture(rig){const g={rig,calls:0,disposed:0,pose(){this.calls++;},dispose(){this.disposed++;}};gestures.push(g);return g;}
 const actor={id:'orchestrator',role:'orchestrator',runtime:'claude',stationary:true,index:3,panda:selected,gesture:createGesture(selected.rig),home:new T.Vector3(1,2,3),state:'working',live:{ref:'example/24'},path:null,routine:null};
 const state={time:12,held:null},agents={actors:new Map([['orchestrator',actor]]),__bao24State:()=>state};
 const den={world,residents,pandaRigs:new Map([[selected.model,{rig:selected.rig,tool:null}]]),roleWorkspaces:{workspaces:new Map([['orchestrator',{person:selected.model}]])}};
 return {world,den,actor,agents,state,calls,disposed,original,selected,gestures,observer:createSameContextBaoObserver({den,agents,original,createGesture})};
}

test('real and null switches preserve identity/state/transform and park the other body without animation or disposal',()=>{
 const f=fixture(),home=f.actor.home,live=f.actor.live,oldGesture=f.actor.gesture,oldPosition=f.selected.model.position.toArray();
 f.observer.switchTo('original');
 assert.equal(f.actor.panda,f.original);assert.equal(f.actor.gesture.rig,f.original.rig);
 assert.deepEqual(f.original.model.position.toArray(),oldPosition);assert.equal(f.original.model.rotation.y,.7);assert.equal(f.original.model.scale.x,1.35);assert.equal(f.original.model.userData.ticketRef,'example/24');assert.equal(f.original.model.userData.species,undefined);
 assert.equal(f.actor.home,home);assert.equal(f.actor.live,live);assert.equal(f.actor.state,'working');assert.equal(f.state.time,12);
 assert.equal(f.den.roleWorkspaces.workspaces.get('orchestrator').person,f.original.model);assert.equal(f.den.pandaRigs.get(f.original.model).rig,f.original.rig);
 assert.equal(f.selected.model.parent,null);assert.equal(f.selected.model.visible,false);assert.equal(oldGesture.calls,0);assert.deepEqual(f.disposed,{original:0,selected:0});
 assert.deepEqual(f.original.rig.last,[13.89,{reducedMotion:false}]);
 const receipt=f.observer.switchTo('original');assert.equal(receipt.nullSwitch,true);assert.equal(receipt.activeBodyRoots,1);assert.equal(receipt.activeShadowMeshes,1);assert.equal(receipt.parkedAttached,false);
 f.observer.switchTo('selected');assert.equal(f.actor.gesture,oldGesture);assert.equal(f.original.model.parent,null);assert.equal(f.original.model.visible,false);assert.equal(f.actor.panda.model.userData.species,'giant-panda');
 assert.deepEqual(f.disposed,{original:0,selected:0});
});
test('pose and skeleton ownership counters expose parked-rig updates and teardown only disposes inactive gesture',()=>{
 const f=fixture();f.observer.switchTo('original');const before=f.observer.snapshot();
 f.actor.panda.rig.poseIdle(14);f.actor.panda.rig.skeleton.update();f.actor.gesture.pose(null,0);
 const after=f.observer.snapshot();assert.equal(after.updates.original.pose-before.updates.original.pose,1);assert.equal(after.updates.original.skeleton-before.updates.original.skeleton,1);assert.equal(after.updates.selected.pose,before.updates.selected.pose);
 f.selected.rig.poseIdle(14);assert.throws(()=>f.observer.assertNoParkedUpdates(after),/parked rig received/);
 f.observer.dispose();f.observer.dispose();assert.equal(f.gestures[0].disposed,1);assert.equal(f.actor.gesture.disposed,0);assert.deepEqual(f.disposed,{original:0,selected:0});
});
test('unsupported locomotion, held pose, wrong identity and collection-time switching refuse before mutation',()=>{
 for(const change of [f=>f.actor.path=[{}],f=>f.actor.seat={},f=>f.actor.arriving=true,f=>f.actor.routine={},f=>f.state.held='orchestrator',f=>f.actor.runtime='codex',f=>f.observer.setCollecting(true)]){
  const f=fixture();change(f);assert.throws(()=>f.observer.switchTo('original'));assert.equal(f.actor.panda,f.selected);assert.equal(f.original.model.parent,null);assert.equal(f.selected.model.parent,f.den.residents);
 }
});
test('coverage names all Claude Bao representations and refuses selected leakage beyond the host for later A/B',()=>{
 const f=fixture();f.agents.actors.set('visitor:bao',{...f.actor,id:'visitor:bao',visitor:true,panda:{...f.selected,model:f.selected.model.clone()}});
 assert.deepEqual(f.observer.snapshot().baoRepresentations.map(a=>a.id),['orchestrator','visitor:bao']);assert.throws(()=>f.observer.assertHostOnlyCoverage(),/additional Claude Bao/);
});
test('predeclared A/A recipe uses one switch entry point, original for both labels, fixed AB/BA/AB and original budgets',()=>{
 const plan=calibrationPlan();assert.deepEqual(plan.blocks.map(b=>b.label),['A','B','B','A','A','B']);assert.ok(plan.blocks.every(b=>b.body==='original'));assert.equal(plan.warmupMs,10000);assert.equal(plan.sampleMs,30000);assert.equal(plan.repetitions,3);assert.equal(plan.acceptancePercent,5);assert.equal(plan.pairedGuardIsDiagnosticOnly,true);assert.equal(plan.resourceAcceptance,'Separate cold single-family loads only');assert.equal(plan.freshQuietHostRequired,true);
});
