import test from 'node:test';
import assert from 'node:assert/strict';
import {makeBridge,openSse,send,until} from './host-test-helpers.mjs';
import {createToolReplayFilter} from './tool-replay-filter.mjs';

test('42 active correlation eviction withdraws only that live assertion without inventing a completion', {timeout:20000}, async t=>{
 const b=await makeBridge(),sse=openSse(b.bridge);await sse.opened;
 t.after(async()=>{
  sse.close();b.fake.spawns[0]?.exit();
  await until(async()=>(await b.state()).agents.every(a=>a.state!=='working'),{what:'runtime exit'});
  await send(b.bridge,{path:'/conversations/architect?runtime=claude&project=den&limit=100',headers:b.headers});await b.close();
 });
 const started=await b.dispatch('architect');assert.equal(started.status,201);
 const proc=b.fake.spawns[0],start=id=>({type:'tool-start',id,name:'Read',summary:id,input:{path:'safe.txt'}});
 proc.emit(start('long-call'));
 const first=await sse.next(f=>f.data.entry?.invocationId==='long-call');
 for(let i=0;i<205;i++)proc.emit(start(`concurrent-${i}`));
 proc.emit({type:'text',text:'retention-barrier'});
 await sse.next(f=>f.data.entry?.text==='retention-barrier');
 const revisions=sse.frames.filter(f=>f.data.entry?.invocationId==='long-call').map(f=>f.data.entry);
 assert.equal(revisions.at(-1).status,'unknown','losing correlation must withdraw the old assertion');
 assert.deepEqual(revisions.at(-1).source,first.data.entry.source);
 assert.equal(revisions.at(-1).result,undefined,'retention is no proof of a result or success');
 assert.equal((await b.state()).transcripts[started.body.agent.id].entries.some(e=>e.id===first.data.entry.id),false,'withdrawal does not resurrect a scrolling row');
 let before='',kept;
 for(let page=0;page<5&&!kept;page++){
  const history=await send(b.bridge,{path:`/conversations/architect?runtime=claude&project=den&limit=100${before}`,headers:b.headers});
  kept=history.body.entries.find(e=>e.id===first.data.entry.id);
  if(!history.body.more)break;before=`&before=${history.body.before}`;
 }
 assert.equal(kept.status,'unknown');assert.deepEqual(kept.source,first.data.entry.source);
 assert.equal(sse.frames.some(f=>f.data.entry?.invocationId==='concurrent-204'&&f.data.entry.status==='running'),true,'unrelated latest call remains active');
});

test('42 replay-filter ambiguity records an uncorrelated observation and preserves unrelated terminal truth', {timeout:30000},async t=>{
 // Find a deterministic false positive using the real fixed-size membership
 // filter, then drive that sequence through the public host runtime boundary.
 const filter=createToolReplayFilter(),ids=[];let ambiguous;
 for(let i=0;i<10000;i++){const id=`collision42-${i}`;if(filter.seen(id)){ambiguous=id;break;}ids.push(id);}
 assert.ok(ambiguous,'the fixture exercises an actual membership collision');
 assert.equal(filter.seen('survivor42'),false);
 const b=await makeBridge(),sse=openSse(b.bridge);await sse.opened;
 t.after(async()=>{
  sse.close();b.fake.spawns[0]?.exit();
  await until(async()=>(await b.state()).agents.every(a=>a.state!=='working'),{what:'runtime exit'});
  await send(b.bridge,{path:'/conversations/architect?runtime=claude&project=den&limit=100',headers:b.headers});await b.close();
 });
 const started=await b.dispatch('architect');assert.equal(started.status,201);
 const proc=b.fake.spawns[0],start=id=>({type:'tool-start',id,name:'Read',summary:id,input:{path:'safe.txt'}});
 for(const id of ids){proc.emit(start(id));proc.emit({type:'tool-result',id,ok:true,text:'observed result'});}
 proc.emit(start('survivor42'));proc.emit(start(ambiguous));proc.emit({type:'tool-result',id:'survivor42',ok:false,text:'recorded failure'});
 proc.emit({type:'text',text:'collision-barrier'});await sse.next(f=>f.data.entry?.text==='collision-barrier',20000);
 const entries=(await b.state()).transcripts[started.body.agent.id].entries;
 const observed=entries.find(e=>e.summary===ambiguous);
 assert.ok(observed,'collision cannot discard a real observed request');
 assert.equal(observed.invocationId,undefined,'ambiguity cannot become a correlated live assertion');
 assert.deepEqual(observed.input,{path:'safe.txt'});
 const survivor=entries.find(e=>e.invocationId==='survivor42');
 assert.equal(survivor.status,'failed');assert.equal(survivor.result,'recorded failure');
 const history=await send(b.bridge,{path:'/conversations/architect?runtime=claude&project=den&limit=100',headers:b.headers});
 assert.deepEqual(history.body.entries.find(e=>e.id===observed.id)?.source,observed.source,'uncorrelated observation retains durable exact inspection');
 t.diagnostic(`Real host collision after ${ids.length} distinct observations; unrelated failure and safe durable source preserved.`);
});
