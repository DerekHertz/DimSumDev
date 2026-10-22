import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import * as T from 'three';
import {readGlbGeometry} from '../../../assets-src/den/read-glb-geometry.mjs';
import {createPandaAppearanceFactory} from './panda-appearance.mjs';
import {createMeshyActors} from './actors.mjs';
import {actorBindings} from './layout.mjs';
import {fitRoleAsset} from './role-wardrobe.mjs';
import {liveActorsFromSnapshot} from '../../review/live-actors.mjs';
import {deskResidents} from '../../shell/desk-model.mjs';
import {agentFor,pickedCard} from '../../overlay/proximity-card.mjs';
const manifest=JSON.parse(readFileSync(new URL('../../../public/den/manifest.json',import.meta.url)));
const load=id=>readGlbGeometry(gunzipSync(readFileSync(new URL('../../../public'+manifest.assets[id].url,import.meta.url))));
function fixture(selected=true){
 const body=load('bao'),source=load('characters.bao'),vest=fitRoleAsset(load('wardrobe.developer-vest'),'developer-vest'),factory=createPandaAppearanceFactory({body,vest,characters:selected?{bao:source}:{}});
 const den={...factory,pandaRigs:factory.instances,residents:new T.Group(),propManifest:[{id:'orchestrator'},{id:'codex:orchestrator'}],roleWorkspaces:{workspaces:new Map()},walkWorld:{floorRadius:70,obstacles:[],navigation:{groundAt:()=>.26}},routineSpots:[]};
 for(const [id,runtime,x]of [['orchestrator','claude',-1.75],['codex:orchestrator','codex',1.75]]){const p=factory.createPanda('orchestrator',{runtime});p.model.userData.actorKey=id;p.model.position.set(x,.29,-.6);den.residents.add(p.model);den.roleWorkspaces.workspaces.set(id,{person:p.model});}
 const actors=createMeshyActors(den);return{den,actors,factory,dispose(){actors.dispose();factory.dispose();}};
}
test('delivered Bao keeps resident identity, authored lift and deferred-run Team action sources',()=>{
 for(const selected of [false,true]){const f=fixture(selected);try{
  const agents=[{id:'host',role:'orchestrator',runtime:'claude',ref:'cast/24',state:'working',capabilities:{send:true}},
   {id:'visitor',role:'orchestrator',runtime:'claude',ref:'cast/24',state:'waiting_on_user',capabilities:{send:true,approve:true}},
   {id:'jiao',role:'orchestrator',runtime:'codex',ref:'cast/24',state:'working',capabilities:{send:true}},
   {id:'foreign',role:'orchestrator',runtime:'claude',projectId:'foreign',ref:'cast/24',state:'working'}];
  const snapshot={agents,approvals:[{id:'own',agentId:'visitor',status:'pending'},{id:'foreign-approval',agentId:'foreign',status:'pending'}]},rows=liveActorsFromSnapshot(snapshot),bindings=actorBindings(rows);
  f.actors.applyLive(rows,bindings);f.actors.update(.1,true);
  const host=f.actors.actors.get('orchestrator'),jiao=f.actors.actors.get('codex:orchestrator');
  assert.equal(host.panda.model.userData.species,selected?'giant-panda':undefined);assert.equal(jiao.panda.model.userData.species,undefined);
  assert.equal(f.actors.actors.size,2);assert.equal(f.den.pandaRigs.size,2);
  assert.deepEqual(host.panda.model.position.toArray(),[-1.75,.29,-.6]);
  assert.equal(f.actors.places.get(jiao.homePlace).owner,jiao.identity);assert.ok(host.home.distanceTo(jiao.home)>=host.envelope.radius+jiao.envelope.radius+.049);
  const roster=deskResidents(snapshot,{bindings,scenePresentations:f.actors.presentationRows()}),visitor=roster.find(r=>r.agentId==='visitor');
  assert.match(visitor.sceneNotes.join(' '),/visitor deferred/);
  const pandas=roster.map(row=>({...row,agent:agentFor(row,agents)})),card=pickedCard(pandas,snapshot.approvals,visitor.id);
  assert.equal(card.agentId,'visitor');assert.equal(card.threadId,'visitor');assert.equal(card.approval.id,'own');assert.equal(card.actions.T.enabled,true);assert.equal(card.actions.E.enabled,true);
  assert.equal(pickedCard(pandas,snapshot.approvals,'codex:orchestrator').actions.T.enabled,false);
  f.actors.setSelected(rows.find(r=>r.agentId==='visitor'));assert.equal(jiao.panda.model.userData.selected,false);
  f.actors.applyLive([rows.find(r=>r.agentId==='visitor')]);assert.equal(host.live.agentId,'visitor');
  f.actors.applyMeeting({id:'m24',ref:'cast/meeting',state:'running',seats:[{role:'orchestrator'}]});
  assert.equal(f.actors.seatModels().size,0);assert.deepEqual(host.panda.model.position.toArray(),[-1.75,.29,-.6]);
 }finally{f.dispose();}}
});

test('five delivered Bao creation/destruction cycles release each live geometry, material and bone texture once while source stays cached',()=>{
 const source=load('characters.bao'),factory=createPandaAppearanceFactory({characters:{bao:source}});let sourceDisposals=0;
 source.traverse(m=>m.geometry?.addEventListener('dispose',()=>sourceDisposals++));
 try{for(let cycle=0;cycle<5;cycle++){
  const actors=Array.from({length:3},()=>factory.createPanda('orchestrator')),disposals=[];
  for(const {rig}of actors){rig.poseIdle(.4);rig.skeleton.computeBoneTexture();for(const resource of [...rig.meshes.flatMap(m=>[m.geometry,m.material]),rig.skeleton.boneTexture]){const counter={n:0};resource.addEventListener('dispose',()=>counter.n++);disposals.push(counter);}}
  for(const {model}of actors)factory.destroyPanda(model);
  assert.equal(factory.instances.size,0);assert.ok(disposals.every(c=>c.n===1),'all owned rig resources dispose exactly once');assert.equal(sourceDisposals,0,'source geometry has an external asset owner');
 }}finally{factory.dispose();}
});
test('Bao authoring sit clears the actual Product stool at its center and floor anchor',{timeout:120000},()=>{
 const output='/tmp/bao24-chair-test-'+process.pid+'.json';
 try{
  execFileSync(process.execPath,[new URL('../../../assets-src/den/bao-clearance.mjs',import.meta.url).pathname,output,'--assert-chair'],{timeout:90000,stdio:'pipe'});
  const proof=JSON.parse(readFileSync(output));
  assert.equal(proof.authoringChair[0].actualSolidCrossingTriangles,0);
  assert.equal(proof.authoringChair[0].anchor[1],proof.authoringDesk[0].at[1],'root stays on the existing pavilion floor');
  for(const frame of proof.seatedContactCycle){assert.equal(frame.crossings,0);assert.ok(frame.nudgedCrossings>0,'pelvis is supported within 0.000135 scene units, not hovering');assert.ok(frame.floor>=proof.authoringChair[0].anchor[1]);}
  assert.equal(proof.conversation.bodyOverlapTriangles,0);assert.ok(proof.conversation.route.length>0);
  assert.equal(proof.summary.hostCollisionSamples.length,0);assert.equal(proof.summary.authoringSeatCollisionProbes.length,0);
 }finally{rmSync(output,{force:true});}
});
