// Research-only structural timing observer. No event payload is persisted.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),readline=require('node:readline');
const CATEGORIES=['toplevel','devtools.timeline','v8','blink.user_timing'];
function project(e){
 const categories=typeof e.cat==='string'?e.cat.split(','):[];
 const task=e.ph==='X'&&categories.some(c=>CATEGORIES.includes(c));
 const mark=categories.includes('blink.user_timing')&&['bao24-cpu-start','bao24-cpu-end'].includes(e.name);
 if(!(task||mark)||!['pid','tid','ts'].every(k=>Number.isFinite(e[k]))||typeof e.name!=='string')return null;
 const out={ph:e.ph,cat:e.cat,name:e.name};for(const k of ['pid','tid','ts','dur','tts','tdur','id','bind_id'])if(Number.isFinite(e[k]))out[k]=e[k];
 // Chrome sometimes represents IDs as strings. Keep IDs only; never args.
 for(const k of ['id','bind_id'])if(typeof e[k]==='string')out[k]=e[k];if(e.id2&&typeof e.id2==='object'){out.id2={};for(const k of ['global','local'])if(Number.isFinite(e.id2[k])||typeof e.id2[k]==='string')out.id2[k]=e.id2[k];}return out;
}
// Adapted from retained summarize-trace.readEvents; nested JSON and escaping are
// handled before projection. At most one <=1MiB event and one IO chunk live here.
async function parseEvents(input,visit){
 let begun=false,ended=false,header='',record='',depth=0,quoted=false,escaped=false;
 for await(let chunk of input){if(!begun){header+=chunk;const m=/"traceEvents"\s*:\s*\[/.exec(header);if(!m){assert.ok(header.length<1024,'Expected trace event array header');continue;}chunk=header.slice(m.index+m[0].length);header='';begun=true;}
  for(const c of chunk){if(!depth){if(c===']'){ended=true;break;}if(c===','||/\s/.test(c))continue;assert.equal(c,'{','trace event object');depth=1;record='{';continue;}
   record+=c;if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='{'||c==='[')depth++;else if(c==='}'||c===']')depth--;
   assert.ok(record.length<1048576,'trace event exceeds1MiB parser bound');if(!depth){visit(JSON.parse(record));record='';}
  }if(ended)break;
 }assert.ok(begun&&ended,'complete trace event array');
}
class OutputBudget{
 constructor(root,cap=67108864,reserve=65536){this.root=root;this.cap=cap;this.reserve=reserve;this.sizes=new Map();this.bytes=0;for(const name of fs.readdirSync(root)){const item=fs.statSync(path.join(root,name));assert.ok(item.isFile(),'flat diagnostic directory');this.sizes.set(name,item.size);this.bytes+=item.size;}assert.ok(this.bytes<=cap-reserve,'initial output cap');}
 charge(name,size,reserved){const total=this.bytes-(this.sizes.get(name)||0)+size;if(total>this.cap-(reserved?0:this.reserve))throw Error('64MiB total output cap exceeded; partial retained');this.bytes=total;this.sizes.set(name,size);}
 write(name,text,reserved=false){const size=Buffer.byteLength(text);this.charge(name,size,reserved);fs.writeFileSync(path.join(this.root,name),text);}
 append(name,text){const size=(this.sizes.get(name)||0)+Buffer.byteLength(text);this.charge(name,size,false);fs.appendFileSync(path.join(this.root,name),text);}
 remove(name){fs.unlinkSync(path.join(this.root,name));this.bytes-=this.sizes.get(name)||0;this.sizes.delete(name);}
}
class TaskLog{
 constructor(sink,prefix,check=()=>{}){this.sink=sink;this.prefix=prefix;this.check=check;this.spool=prefix+'-structural.partial.ndjson';this.marks={};this.seen=0;}
 visit(event){this.check();this.seen++;const e=project(event);if(!e)return;this.sink.append(this.spool,JSON.stringify(e)+'\n');if(e.name==='bao24-cpu-start'||e.name==='bao24-cpu-end'){assert.ok(!this.marks[e.name],'unique sample mark');this.marks[e.name]=e;}}
 async finish(){
  const start=this.marks['bao24-cpu-start'],end=this.marks['bao24-cpu-end'];assert.ok(start&&end&&start.pid===end.pid&&start.tid===end.tid&&end.ts-start.ts>=29000000,'renderer sample clock marks');
  const coverage={rendererPid:start.pid,rendererTid:start.tid,startTraceUs:start.ts,endTraceUs:end.ts,tasks:0,missing:{dur:0,tts:0,tdur:0},seenTraceEvents:this.seen};
  const input=fs.createReadStream(path.join(this.sink.root,this.spool)),lines=readline.createInterface({input,crlfDelay:Infinity});
  try{for await(const line of lines){this.check();const e=JSON.parse(line);if(e.pid!==start.pid||e.tid!==start.tid)continue;this.sink.append(this.prefix+'-tasks.ndjson',line+'\n');if(e.ph==='X'){coverage.tasks++;for(const k of ['dur','tts','tdur'])if(!Number.isFinite(e[k]))coverage.missing[k]++;}}}finally{lines.close();input.destroy();}
  assert.ok(coverage.tasks,'renderer task coverage');this.sink.remove(this.spool);return coverage;
 }
}
function alignQuery(query,anchor,spans){
 const beginUs=anchor.traceUs+(query.beginAt-anchor.pageMs)*1000,endUs=anchor.traceUs+(query.endAt-anchor.pageMs)*1000;
 const enclosing=spans.filter(e=>e.ph==='X'&&e.pid===anchor.pid&&e.tid===anchor.tid&&e.ts<=beginUs&&e.ts+e.dur>=endUs).sort((a,b)=>b.dur-a.dur||a.ts-b.ts);
 return {beginUs,endUs,enclosingCount:enclosing.length,outermostEnclosing:enclosing[0]??null};
}
async function persistThenFinalize(row,persist,finalize){persist(row);return finalize(row);}
async function closeOwnedServer(server,ms=5000){
 let timer;try{await Promise.race([server.close(),new Promise(resolve=>{timer=setTimeout(()=>{server.process().kill();resolve();},ms);})]);}catch{server.process().kill();}finally{clearTimeout(timer);}
}
class DeadlineScope{
 constructor(ms){this.ms=ms;this.aborted=false;this.resources=[];}
 check(){if(this.aborted)throw Error('CPU diagnostic deadline/abort');}
 cancel(error){this.aborted=true;this.reject?.(error);}
 async own(promise){const resource=await promise;if(this.aborted){await resource.close();throw Error('CPU diagnostic deadline: late acquisition closed');}this.resources.push(resource);return resource;}
 async run(work,finalize){
  let timer;const expired=new Promise((_,reject)=>{this.reject=reject;timer=setTimeout(()=>this.cancel(Error('CPU diagnostic deadline')),this.ms);});
  try{return await Promise.race([work(),expired]);}finally{this.aborted=true;clearTimeout(timer);try{await finalize();}finally{await Promise.allSettled(this.resources.map(r=>r.close()));}}
 }
}
function once(source,before,after){assert.equal(source.split(before).length,2,'expected one '+before);return source.replace(before,after);}
function correlate(source){
 source=once(source,'const p={den,','const p={queryMeta:new WeakMap(),querySamples:[],den,');
 source=once(source,'if(q)gl.beginQuery(ext.TIME_ELAPSED_EXT,q);','if(q){p.queryMeta.set(q,{queryId:p.seq,frameId:p.records.length,beginAt:performance.now()});gl.beginQuery(ext.TIME_ELAPSED_EXT,q);}');
 source=once(source,'gl.endQuery(ext.TIME_ELAPSED_EXT);p.pending.push(q);','gl.endQuery(ext.TIME_ELAPSED_EXT);p.queryMeta.get(q).endAt=performance.now();p.pending.push(q);');
 return once(source,'p.gpu.push(gl.getQueryParameter(next,gl.QUERY_RESULT)/1e6)','((elapsedMs)=>{p.gpu.push(elapsedMs);p.querySamples.push({...p.queryMeta.get(next),elapsedMs,resolvedAt:performance.now(),resolveFrame:p.records.length-1});})(gl.getQueryParameter(next,gl.QUERY_RESULT)/1e6)');
}
module.exports={CATEGORIES,project,parseEvents,OutputBudget,TaskLog,alignQuery,persistThenFinalize,closeOwnedServer,DeadlineScope,once,correlate};
