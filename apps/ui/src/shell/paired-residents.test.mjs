import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, existsSync} from 'node:fs';
import {ROLE_PORTRAITS} from './role-portraits.mjs';
import {RESIDENTS, residentKey, boundAgentKey} from './resident-inventory.mjs';
import {deskResidents, deskActivity} from './desk-model.mjs';
import {liveActorsFromSnapshot} from '../review/live-actors.mjs';
import {actorBindings} from '../scene/meshy/layout.mjs';
import {agentFor,pickedCard} from '../overlay/proximity-card.mjs';

test('one inventory covers every continuing recipe in both runtimes',()=>{
 const recipes=readdirSync(new URL('../../../../.codex/agents/',import.meta.url)).filter(f=>f.endsWith('.toml')).map(f=>f.slice(0,-5)).filter(r=>!['default','explorer','worker'].includes(r)).map(r=>r==='chief-of-staff'?'orchestrator':r);
 for(const runtime of ['claude','codex'])assert.deepEqual(RESIDENTS.filter(r=>r.runtime===runtime&&r.dispatchable).map(r=>r.role).sort(),recipes.sort());
 assert.equal(RESIDENTS.length,24);assert.equal(new Set(RESIDENTS.map(r=>r.id)).size,24);
 assert.equal(RESIDENTS.filter(r=>!r.dispatchable).length,0);
 assert.equal(RESIDENTS.find(r=>r.id==='codex:orchestrator').name,'Jiao');
 assert.equal(deskResidents(null).length,24);assert.equal(deskActivity(null).resting,24);
});

test('live takeover, visitors and tasks isolate runtime, role and project; unknown and ended runs stay idle',()=>{
 const snapshot={agents:[
  {id:'a',role:'developer',ref:'same/01',state:'working'},
  {id:'b',role:'developer',runtime:'codex',ref:'same/01',state:'working'},
  {id:'c',role:'developer',runtime:'codex',ref:'same/02',state:'waiting_on_user'},
  {id:'elsewhere',role:'developer',runtime:'codex',projectId:'other',ref:'same/03',state:'working'},
  {id:'bad',role:'qa',runtime:'unknown',ref:'same/04',state:'working'},
  {id:'ended',role:'runner',runtime:'codex',ref:'same/05',state:'done'},
  {id:'unknown',role:'runner',runtime:'codex',ref:'same/06',state:'mystery'},
 ]};
 const live=liveActorsFromSnapshot(snapshot),bindings=actorBindings(live);
 assert.equal(bindings.get('developer').agentId,'a');
 assert.equal(bindings.get('codex:developer').agentId,'b');
 assert.equal(bindings.get('codex:developer#same/02').agentId,'c');
 assert.equal(live.length,3);
 const rows=deskResidents(snapshot);assert.equal(rows.find(r=>r.id==='codex:runner').ref,null);
 assert.deepEqual(deskActivity(snapshot),{working:2,waiting:1,blocked:0,resting:22,visitors:1});
 const selected=liveActorsFromSnapshot(snapshot,{projectId:'other'});
 assert.deepEqual(selected.map(a=>a.agentId),['elsewhere']);
 const old=new Map([['codex:developer',bindings.get('codex:developer#same/02')]]);
 assert.equal(actorBindings(live,old).get('codex:developer').agentId,'c');
 assert.equal(residentKey('developer','codex'),'codex:developer');
});

test('new charter residents expose their own cached portraits and exact live cards in both runtimes',()=>{
 const roles=['code-reviewer','release-manager','sre','technical-writer'];
 const agents=roles.flatMap(role=>['claude','codex'].map(runtime=>({id:runtime+'-'+role,role,runtime,ref:'cast/01',state:'working',capabilities:{send:true}})));
 const snapshot={agents:[...agents,{id:'other-project',role:'release-manager',runtime:'claude',projectId:'elsewhere',ref:'cast/01',state:'working'}]};
 const bindings=actorBindings(liveActorsFromSnapshot(snapshot));
 assert.equal(bindings.size,8);
 for(const agent of agents){
  const id=residentKey(agent.role,agent.runtime),resident=deskResidents(snapshot).find(row=>row.id===id);
  assert.equal(resident.agentId,agent.id);assert.equal(resident.state,'working');
  const card=pickedCard([{...resident,agent:agentFor(resident,snapshot.agents)}],[],id);
  assert.equal(card.role,agent.role);assert.equal(card.runtime,agent.runtime);
  if(agent.runtime==='claude'){assert.equal(card.agentId,agent.id);assert.equal(card.threadId,agent.id);assert.equal(card.actions.T.enabled,true);}
  else{assert.equal(card.agentId,null);assert.ok(Object.values(card.actions).every(action=>!action.enabled));}
  const portrait=ROLE_PORTRAITS[id];
  assert.ok(portrait,id+' has its own portrait URL');
  assert.ok(existsSync(new URL('../../public'+portrait,import.meta.url)),id+' portrait is packaged');
 }
 assert.equal(RESIDENTS.filter(row=>row.name==='The Drummer').length,0,'the old festival identity is not a second release manager');
 const ended=deskResidents({agents:agents.map(row=>({...row,state:'done'}))});
 for(const row of ended.filter(row=>roles.includes(row.role)))assert.equal(row.state,'resident');
});

test('Jiao cannot inherit Bao desk, transcript, permissions, or task actions even with reported capabilities',()=>{
 const agents=[{id:'bao',role:'orchestrator',state:'working',ref:'desk/01'},
  {id:'jiao',role:'orchestrator',runtime:'codex',state:'working',ref:'desk/01',capabilities:{send:true,approve:true}},
  {id:'foreign',role:'orchestrator',runtime:'codex',projectId:'other',state:'working',ref:'desk/01'}];
 const jiao=RESIDENTS.find(r=>r.id==='codex:orchestrator');
 assert.equal(agentFor(jiao,agents).id,'jiao');
 assert.equal(agentFor({...jiao,projectId:'missing'},agents),null);
 const card=pickedCard([{...jiao,agent:agentFor(jiao,agents)}],[],'codex:orchestrator');
 assert.equal(card.threadId,null);assert.equal(card.start,false);assert.equal(card.runtime,'codex');
 for(const action of Object.values(card.actions)){assert.equal(action.enabled,false);assert.match(action.reason,/Codex.*unavailable/i);}
 const bao=pickedCard([{id:'orchestrator',role:'orchestrator'}],[],'orchestrator');
 assert.equal(bao.actions.R.enabled,true);assert.ok(bao.threadId);
 assert.equal(pickedCard([{id:'runner',role:'runner'}],[],'runner').actions.T.enabled,false);
});

test('reported idle or throttled agents do not inflate working counts, and foreign bindings cannot hide a Claude result',()=>{
 const snapshot={agents:[{id:'idle',role:'runner',runtime:'codex',state:'idle',ref:'work/01'},{id:'throttled',role:'developer',state:'throttled',ref:'work/02'}]};
 assert.equal(deskActivity(snapshot).working,0);
 assert.equal(deskResidents(snapshot).find(r=>r.id==='codex:runner').state,'idle');
 const last={id:'last',role:'developer',state:'done',ref:'same/01'};
 const bound=new Set([boundAgentKey({role:'developer',runtime:'codex',ref:'same/01'})]);
 assert.equal(agentFor({role:'developer'},[last],bound),last);
});

test('a holder lock without a matching recognized live process keeps its resident idle',()=>{
 for(const runtime of ['claude','codex'])for(const state of [undefined,'done','mystery']){
  const snapshot={tickets:[{ref:'work/01',status:'claimed',holder: { role:'developer',runtime}}],placements:[],agents:state?[{id:'a',ref:'work/01',role:'developer',runtime,state,capabilities:{send:true}}]:[]};
  assert.equal(liveActorsFromSnapshot(snapshot).length,0);
  assert.equal(deskResidents(snapshot).find(r=>r.id===residentKey('developer',runtime)).state,'resident');
 }
 const mystery={id:'m',role:'developer',state:'mystery',capabilities:{send:true}};
 assert.equal(agentFor({role:'developer'},[mystery]),mystery);
 const card=pickedCard([{id:'developer',role:'developer',agent:mystery}],[],'developer');
 assert.equal(card.agentId,null);assert.ok(Object.values(card.actions).every(a=>!a.enabled));
});

test('retired roles cannot reappear as Team residents or live visitors in either runtime',()=>{
 const roles=['scout','herald','debugger','knowledge-keeper','docs-writer','stem-cub'];
 const agents=roles.flatMap(role=>['claude','codex'].map(runtime=>({id:runtime+role,role,runtime,ref:'history/01',state:'working'})));
 assert.deepEqual(liveActorsFromSnapshot({agents}),[]);
 assert.ok(deskResidents({agents}).every(row=>!roles.includes(row.role)));
 assert.equal(deskActivity({agents}).resting,24);
});
