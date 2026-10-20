// Trace correlations describe CPU submission, not the GPU interval's absolute start.
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {validateRow,combinedCpu}=require('./performance-resume.cjs');
const q=(a,p)=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*p)-1],d=a=>a.length?{n:a.length,min:Math.min(...a),p50:q(a,.5),p95:q(a,.95),max:Math.max(...a)}:{n:0};
function correlation(xs,ys){const mx=xs.reduce((n,x)=>n+x,0)/xs.length,my=ys.reduce((n,x)=>n+x,0)/ys.length;let xy=0,xx=0,yy=0;xs.forEach((x,i)=>{xy+=(x-mx)*(ys[i]-my);xx+=(x-mx)**2;yy+=(ys[i]-my)**2;});return xx&&yy?xy/Math.sqrt(xx*yy):null;}
async function readEvents(file,visit){
 const input=fs.createReadStream(file,{encoding:'utf8'});let begun=false,ended=false,header='',record='',depth=0,quoted=false,escaped=false;
 try{for await(let chunk of input){if(!begun){header+=chunk;const m=/"traceEvents"\s*:\s*\[/.exec(header);if(!m){assert.ok(header.length<1024,'Expected trace event array header');continue;}chunk=header.slice(m.index+m[0].length);header='';begun=true;}
  for(const c of chunk){if(!depth){if(c===']'){ended=true;break;}if(c===','||/\s/.test(c))continue;assert.equal(c,'{','trace event object');depth=1;record='{';continue;}
   record+=c;if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='{'||c==='[')depth++;else if(c==='}'||c===']')depth--;
   if(!depth){visit(JSON.parse(record));record='';}assert.ok(record.length<1048576,'trace event exceeds1MiB parser bound');
  }if(ended)break;
 }}finally{input.destroy();}
 assert.ok(begun&&ended,'complete trace event array');
}
async function summarize(raw,folder){
 assert.ok(raw.scenarios.length>=1&&raw.scenarios.length<=2);assert.ok(raw.finishedAt||raw.failure?.includes('256MiB total trace cap exceeded'));assert.deepEqual(raw.errors,[]);assert.deepEqual(raw.writes,[]);
 const runs=[];for(const [i,r]of raw.scenarios.entries()){
  validateRow({...r,baseline:true});assert.equal(r.baseline,i===0);assert.equal(r.baoSpecies,null);assert.equal(r.identity.manifestHasBao,false);assert.ok(r.identity.requests.includes('/den/models/bao.glb.gz'));assert.ok(!r.identity.requests.includes('/den/models/characters/bao.glb.gz'));assert.equal(r.querySamples.length,r.gpuMs.length);
  const coverage=r.trace.coverage,offset=coverage.clockAnchorTraceUs/1000-r.traceAnchorAt,metadata=[],gpuNames={},gc=[],counts={};let starts=0,ends=0,tasks=0;
  await readEvents(folder+'/'+r.trace.file,e=>{
   if(e.ph==='M'&&['process_name','thread_name'].includes(e.name))metadata.push({pid:e.pid,tid:e.tid,type:e.name,name:e.args?.name});
   if(e.ts<coverage.clockAnchorTraceUs||e.ts>coverage.clockEndTraceUs||!Number.isFinite(e.ts))return;
   if(e.name==='bao24-sample-start')starts++;if(e.name==='bao24-sample-end')ends++;
   for(const c of (e.cat||'').split(','))if(c)counts[c]=(counts[c]||0)+1;
   if(e.pid===coverage.rendererPid&&e.tid===coverage.rendererTid&&e.ph==='X'&&e.dur>0&&e.cat?.split(',').some(c=>['toplevel','devtools.timeline'].includes(c)))tasks++;
   if(e.cat?.split(',').some(c=>c==='gpu'||c.includes('gpu.service')))gpuNames[e.name]=(gpuNames[e.name]||0)+1;
   if(e.ph==='X'&&e.pid===coverage.rendererPid&&e.tid===coverage.rendererTid&&/GC|Garbage/i.test(e.name))gc.push({ts:e.ts,dur:e.dur});
  });assert.ok(starts&&ends);assert.equal(tasks,coverage.rendererTasks);assert.deepEqual(counts,coverage.categoryEventCounts);
  const queries=r.querySamples.map((s,j)=>{assert.equal(s.elapsedMs,r.gpuMs[j]);assert.ok(Number.isInteger(s.frameId)&&s.frameId>=0&&s.frameId<r.records.length);assert.ok(s.endAt>=s.beginAt&&s.resolvedAt>=s.endAt&&s.resolveFrame>=s.frameId);const frame=r.records[s.frameId];assert.ok(frame.at>=s.beginAt&&frame.at<=s.endAt);const begin=(s.beginAt+offset)*1000,end=(s.endAt+offset)*1000;return {...s,cpuSubmissionMs:s.endAt-s.beginAt,renderCpuMs:frame.cpuMs,availableAfterMs:s.resolvedAt-s.endAt,availableAfterFrames:s.resolveFrame-s.frameId,gcEventsDuringCpuIssue:gc.filter(e=>e.ts<end&&e.ts+e.dur>begin).length};});
  const buckets=Object.fromEntries([['lowGpuAtMost6ms',s=>s.elapsedMs<=6],['middleGpu6to8ms',s=>s.elapsedMs>6&&s.elapsedMs<8],['highGpuAtLeast8ms',s=>s.elapsedMs>=8]].map(([n,p])=>{const a=queries.filter(p);return [n,{gpu:d(a.map(s=>s.elapsedMs)),cpuSubmission:d(a.map(s=>s.cpuSubmissionMs)),availability:d(a.map(s=>s.availableAfterMs)),gcOverlaps:a.reduce((n,s)=>n+s.gcEventsDuringCpuIssue,0)}];}));
  runs.push({label:i?'B':'A',originalAsset:true,frames:r.records.length,gpu:d(r.gpuMs),renderCpu:d(r.records.map(f=>f.cpuMs)),combinedCpu:d(combinedCpu(r)),cpuSubmission:d(queries.map(s=>s.cpuSubmissionMs)),availabilityMs:d(queries.map(s=>s.availableAfterMs)),availabilityFrames:d(queries.map(s=>s.availableAfterFrames)),pearsonGpuVsCpuSubmission:correlation(queries.map(s=>s.elapsedMs),queries.map(s=>s.cpuSubmissionMs)),coverage,clockOffsetMs:offset,metadata,gpuEventNames:gpuNames,gcEvents:gc.length,buckets,queries});
 }
 return {kind:'Original-only trace diagnostic; no acceptance verdict',completeTraces:runs.length,captureFailure:raw.failure||null,browser:raw.browser,source:raw.meta,discovery:raw.availableTraceCategories,requestedCategories:raw.traceCategories,runs,limits:['GPU elapsed queries expose durations, not absolute device execution start timestamps. CPU markers therefore cannot place GPU execution intervals on the trace clock.','GPU/service category presence and task durations do not prove continuous hardware busy time; no such attribution is claimed.','Trace overhead changes observer cost; these samples never replace failed60/quiet6/identical6.','Low≤6ms/middle6–8/high≥8 buckets describe the previously observed bimodal timer distribution; every query is retained, not a pass filter.']};
}
module.exports={summarize,correlation,readEvents};
if(require.main===module)(async()=>{const file=process.argv[2],bytes=fs.readFileSync(file),summary=await summarize(JSON.parse(bytes),require('node:path').dirname(file));summary.rawSha256=crypto.createHash('sha256').update(bytes).digest('hex');fs.writeFileSync(process.argv[3],JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({runs:summary.runs.map(({label,gpu,renderCpu,combinedCpu,cpuSubmission,availabilityMs,availabilityFrames,pearsonGpuVsCpuSubmission,coverage,gcEvents,buckets,gpuEventNames})=>({label,gpu,renderCpu,combinedCpu,cpuSubmission,availabilityMs,availabilityFrames,pearsonGpuVsCpuSubmission,coverage,gcEvents,buckets,gpuEventNames}))},null,2));})().catch(e=>{console.error(e.stack);process.exitCode=1;});
