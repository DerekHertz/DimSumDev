import test from 'node:test';
import assert from 'node:assert/strict';
import {makeBridge,openSse,send,until} from '../../../bridge/agents/host-test-helpers.mjs';
import {createLiveStore} from './live-store.mjs';
import {liveActorsFromSnapshot} from '../review/live-actors.mjs';

const start=id=>({type:'tool-start',id,name:'Read',summary:id});
const result=(id,extra={})=>({type:'tool-result',id,text:'recorded completion',ok:true,...extra});

// Only the transport is adapted: production host events cross HTTP/SSE, then enter
// the real store and actor adapter exactly as the browser's connection callbacks do.
async function setup(t){
 const b=await makeBridge();let stream,sse,cursor=0,barrier=0;
 const store=createLiveStore({connect:c=>(stream=c,{close(){}}),fetchState:b.state,now:()=>0});
 t.after(async()=>{
  store.close();sse?.close();
  for(const proc of b.fake.spawns)if(!proc.exited)proc.exit();
  await until(async()=>(await b.state()).agents.every(a=>!['working','waiting_on_user'].includes(a.state)),{what:'runtime exit before conversation drain'});
  // Conversation reads wait for queued appends, including exit/ended records.
  await send(b.bridge,{path:'/conversations/architect?runtime=claude&project=den&limit=100',headers:b.headers});
  await b.close();
 });
 store.start();sse=openSse(b.bridge);await sse.opened;
 await sse.next(f=>f.event==='snapshot',8000);
 const pump=()=>{for(const f of sse.frames.slice(cursor)){
  if(f.event==='snapshot')stream.onSnapshot(f.data);
  else if(f.event==='change')stream.onChange(f.data);
 }cursor=sse.frames.length;};
 pump();
 const response=await b.dispatch('architect');assert.equal(response.status,201,response.text);
 const run=response.body.agent;
 const emit=async(...events)=>{
  for(const event of events)b.fake.spawns[0].emit(event);
  const marker=`42-host-store-barrier-${++barrier}`;
  b.fake.spawns[0].emit({type:'text',text:marker});
  await sse.next(f=>f.data.entry?.text===marker,8000);pump();
  assert.equal(store.getState().connection.phase,'live','wire sequence must remain authoritative');
 };
 const activity=()=>{const s=store.getState();return liveActorsFromSnapshot(s.snapshot,{toolActivity:s.toolActivity,connection:s.connection}).find(a=>a.agentId===run.id)?.toolActivity;};
 return {...b,sse,store,run,emit,activity};
}

test('42 F1 terminal after host transcript eviction removes only its active invocation',{timeout:60000},async t=>{
 const terminals=[
  ['success',id=>result(id)],
  ['failure',id=>result(id,{ok:false,text:'exit 1'})],
  ['refusal',id=>result(id,{text:'curl: (56) Received HTTP code 403\nX-Proxy-Error: blocked-by-allowlist\n<sandbox_violations>\ndeny network-outbound example.org:443\n</sandbox_violations>'})],
  ['end without result',id=>({type:'tool-end',id})],
 ];
 for(const [label,terminal]of terminals)await t.test(label,{timeout:15000},async t=>{
  const b=await setup(t);
  await b.emit(start('long-call'));
  const original=b.activity().sources[0];
  await b.emit(...Array.from({length:205},(_,i)=>({type:'text',text:`unrelated ${i}`})),start('survivor'));
  assert.equal((await b.state()).transcripts[b.run.id].entries.some(e=>e.id===original.entryId),false,'exercise actual host transcript eviction');
  assert.equal(b.store.getState().transcripts[b.run.id].entries.some(e=>e.id===original.entryId),false,'exercise actual UI transcript eviction');
  assert.equal(b.activity().count,2,'the active call outlives its scrolling row');
  const survivor=b.activity().sources.find(s=>s.entryId!==original.entryId);
  await b.emit(terminal('long-call'));
  assert.deepEqual(b.activity()?.sources,[survivor],`${label} must retire the exact evicted invocation and preserve the unrelated call`);
 });
});

test('42 F2 runtime invocation replay after both bounded maps cannot resurrect a completed call',{timeout:20000},async t=>{
 const b=await setup(t);
 await b.emit(start('retired'),result('retired'));
 const original=b.sse.frames.find(f=>f.data.entry?.invocationId==='retired').data.entry;
 assert.equal(b.activity(),null,'completion is observed before eviction');
 await b.emit(...Array.from({length:205},(_,i)=>[start(`other-${i}`),result(`other-${i}`)]).flat(),start('survivor'));
 assert.equal(b.store.getState().toolActivity[b.run.id].rows.some(r=>r.invocationId==='retired'),false,'retired UI tombstone has left its bounded map');
 assert.equal((await b.state()).transcripts[b.run.id].entries.some(e=>e.id===original.id),false,'old host transcript row has left its bounded map');
 const survivor=b.activity().sources[0];
 // Replay the runtime event, never an old SSE entry: the production host currently
 // assigns a fresh transcript id here after its own correlation map eviction.
 await b.emit(start('retired'));
 const replay=b.sse.frames.filter(f=>f.data.entry?.invocationId==='retired'&&f.data.entry.status==='running').at(-1).data.entry;
 assert.deepEqual(b.activity()?.sources,[survivor],`retired runtime identity must remain suppressed even if host recreates entry ${original.id} as ${replay.id}`);
});
