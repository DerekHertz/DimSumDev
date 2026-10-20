import test from 'node:test';
import assert from 'node:assert/strict';
import { observeTools, reconcileTools, toolActivityFor } from './tool-activity.mjs';
import { liveActorsFromSnapshot } from '../review/live-actors.mjs';
import {actorBindings} from '../scene/meshy/layout.mjs';
const agent = { id:'run42', role:'developer', runtime:'claude', project:'den', state:'working', ref:'fx/42' };
const tool = (id, extra={}) => ({id,kind:'tool',name:'Bash',summary:`echo ${id}`,invocationId:`call-${id}`,status:'running',source:{project:'den',runtime:'claude',role:'developer',runId:'run42',entryId:id},...extra});
const observe = (state, entry) => observeTools(state, agent.id, entry);
const view = (state, who=agent, phase='live') => toolActivityFor(state, who, {phase});
test('42 active set selects newest; duplicates, end, failure, refusal and stop remove only their invocation',()=>{
 let s=observe(observe({},tool(1)),tool(2));s=observe(s,tool(2));
 assert.equal(view(s).count,2);assert.match(view(s).text,/echo 2.*\+1/);
 for(const status of ['ended','failed','refused','stopped','done']){
  let ended=observe(s,tool(2,{status}));ended=observe(ended,tool(2));
  assert.equal(view(ended).count,1);assert.equal(view(ended).sources[0].entryId,1);
 }
});
test('42 terminal before start, late result, unknown result and authoritative run end never revive or erase another call',()=>{
 let s=observe({},tool(2,{status:'ended'}));s=observe(s,tool(2));s=observe(s,tool(1));s=observe(s,tool(99,{status:'failed'}));
 assert.deepEqual(view(s).sources.map(s=>s.entryId),[1]);
 s=observe(s,{kind:'ended',state:'terminated'});s=observe(s,tool(3));assert.equal(view(s),null);
});
test('42 malformed, missing and ambiguous invocation attribution suppresses specific assertions without tool-name guessing',()=>{
 for(const change of [{invocationId:undefined},{source:undefined},{source:{...tool(1).source,runId:'other'}},{id:2}])assert.equal(view(observe({},tool(1,change))),null);
 let s=observe({},tool(1));s=observe(s,tool(2,{invocationId:'call-1'}));assert.equal(view(s),null);
 const s2=observe({},tool(1));for(const change of [{runtime:'codex'},{project:'other'},{id:'other'},{role:'qa'}])assert.equal(view(s2,{...agent,...change}),null);
});
test('42 permission is waiting; offline requires authoritative reconciliation and completed snapshots do not replay active calls',()=>{
 let s=reconcileTools({}, {agents:[agent],transcripts:{run42:{entries:[tool(1),tool(2)]}}});
 assert.match(view(s,{...agent,state:'waiting_on_user'}).text,/Waiting on you/);
 for(const phase of ['offline','reconnecting','connecting'])assert.equal(view(s,agent,phase),null);
 s=reconcileTools(s,{agents:[agent],transcripts:{run42:{entries:[tool(1,{status:'failed'})]}}});assert.equal(view(s),null);
 s=reconcileTools(s,{agents:[agent],transcripts:{run42:{entries:[tool(1)]}}});assert.equal(view(s),null);
});
test('42 sanitizes the complete preview before clipping to 64 including count, without exposed raw input/result',()=>{
 const secret='sk-proj-'+ 'A'.repeat(80);const s=observe(observe({},tool(1)),tool(2,{summary:'x'.repeat(48)+secret,input:{secret},result:undefined}));
 const v=view(s);assert.ok([...v.text].length<=64);assert.equal(JSON.stringify(v).includes(secret.slice(0,12)),false);assert.ok(v.text.endsWith('+1'));
});
test('42 real runs and paired visitors keep their own activity; agent.tool alone supplies no bubble',()=>{
 const other={...agent,id:'other42',ref:'fx/43'},codex={...agent,id:'cx42',runtime:'codex',ref:'fx/44'};
 let activity=observe({},tool(1));activity=observeTools(activity,other.id,tool(2,{source:{...tool(2).source,runId:other.id}}));
 const snapshot={agents:[agent,other,codex],tickets:[],placements:[]};
 const rows=liveActorsFromSnapshot(snapshot,{toolActivity:activity,connection:{phase:'live'}});
 assert.equal(rows[0].toolActivity.sources[0].runId,agent.id);assert.equal(rows[1].toolActivity.sources[0].runId,other.id);assert.equal(rows[2].bubble,'');
 assert.equal(liveActorsFromSnapshot({...snapshot,agents:[{...agent,tool:{name:'Fake',summary:'guessed'}}]})[0].bubble,'');
 const sameRef=liveActorsFromSnapshot({...snapshot,agents:[agent,{...other,ref:agent.ref}]},{toolActivity:activity,connection:{phase:'live'}});
 assert.equal(sameRef.length,2);assert.equal(actorBindings(sameRef).size,2);assert.deepEqual([...actorBindings(sameRef).values()].map(r=>r.toolActivity.sources[0].runId),['run42','other42']);
});
test('42 run ledger is bounded and prototype-like identities cannot alias another run',()=>{
 let state={};for(let i=0;i<250;i++)state=observeTools(state,`run-${i}`,tool(1,{source:{...tool(1).source,runId:`run-${i}`}}));
 assert.ok(Object.keys(state).length<=200);
 assert.equal(view(state,{...agent,id:'run-249'}),null,'saturation suppresses new run assertions until authoritative pruning');
 for(const id of ['constructor','__proto__']){const s=observeTools({},id,tool(1,{source:{...tool(1).source,runId:id}}));assert.equal(view(s,{...agent,id}).count,1);}
});
test('42 evicted completed invocation cannot revive after more than200 newer terminal entries',()=>{
 let s=observe({},tool(1,{status:'done'}));for(let id=2;id<=250;id++)s=observe(s,tool(id,{status:'ended'}));
 assert.equal(s.run42.rows.some(row=>row.source.entryId===1),false);
 s=observe(s,tool(1));assert.equal(view(s),null);assert.ok(s.run42.floor>=1);
});
