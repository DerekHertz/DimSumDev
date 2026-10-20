const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {controlSource}=require('./identical-control.cjs');
function once(source,before,after){assert.equal(source.split(before).length,2,'expected one '+before);return source.replace(before,after);}
function correlate(source){
 source=once(source,'const p={den,','const p={queryMeta:new WeakMap(),querySamples:[],den,');
 source=once(source,'if(q)gl.beginQuery(ext.TIME_ELAPSED_EXT,q);',"if(q){p.queryMeta.set(q,{queryId:p.seq,frameId:p.records.length,beginAt:performance.now()});gl.beginQuery(ext.TIME_ELAPSED_EXT,q);}");
 source=once(source,'gl.endQuery(ext.TIME_ELAPSED_EXT);p.pending.push(q);','gl.endQuery(ext.TIME_ELAPSED_EXT);p.queryMeta.get(q).endAt=performance.now();p.pending.push(q);');
 source=once(source,'p.gpu.push(gl.getQueryParameter(next,gl.QUERY_RESULT)/1e6)',"((elapsedMs)=>{p.gpu.push(elapsedMs);p.querySamples.push({...p.queryMeta.get(next),elapsedMs,resolvedAt:performance.now(),resolveFrame:p.records.length-1});})(gl.getQueryParameter(next,gl.QUERY_RESULT)/1e6)");
 return source;
}
async function startTrace(){
 await traceCDP.send('Tracing.start',{categories:'-*,'+results.traceCategories.join(','),options:'record-until-full',transferMode:'ReturnAsStream'});
}
function categoryPolicy(discovered){
 assert.ok(Array.isArray(discovered),'category discovery array');
 const selected=['devtools.timeline','v8','gpu','disabled-by-default-gpu.service','blink.user_timing','toplevel'];
 return {discovered,selected,emptyDiscovery:discovered.length===0};
}
function traceCoverage(trace){
 const events=trace.traceEvents;assert.ok(Array.isArray(events),'trace events');
 const rendererThreads=new Set(events.filter(e=>e.ph==='M'&&e.name==='thread_name'&&e.args?.name==='CrRendererMain').map(e=>e.pid+':'+e.tid));
 const start=events.find(e=>e.name==='bao24-sample-start'&&rendererThreads.has(e.pid+':'+e.tid)),end=events.find(e=>e.name==='bao24-sample-end'&&rendererThreads.has(e.pid+':'+e.tid));
 assert.ok(rendererThreads.size,'renderer main-thread metadata');assert.ok(start&&end&&end.ts-start.ts>=29000000,'sample clock marks');
 const inside=events.filter(e=>e.ts>=start.ts&&e.ts<=end.ts),tasks=inside.filter(e=>e.pid===start.pid&&e.tid===start.tid&&e.ph==='X'&&e.dur>0&&e.cat?.split(',').some(c=>['toplevel','devtools.timeline'].includes(c)));
 assert.ok(tasks.length,'renderer main-thread tasks');
 const counts={};for(const e of inside)for(const c of (e.cat||'').split(','))if(c)counts[c]=(counts[c]||0)+1;
 return {clockAnchorTraceUs:start.ts,clockEndTraceUs:end.ts,rendererPid:start.pid,rendererTid:start.tid,rendererTasks:tasks.length,categoryEventCounts:counts,gpuServiceObserved:Object.keys(counts).some(c=>c.includes('gpu.service')),gpuEventsObserved:Object.keys(counts).some(c=>c==='gpu'||c.includes('gpu.service')),gpuBusyAttribution:'Not inferred from category presence; service tasks may be CPU-side command processing'};
}
async function finishTrace(file){
 const completed=new Promise(resolve=>traceCDP.once('Tracing.tracingComplete',resolve));await traceCDP.send('Tracing.end');const receipt=await completed;assert.ok(receipt.stream);assert.ok(!receipt.dataLossOccurred,'trace data loss');let bytes=0;
 const handle=fs.openSync(file,'wx');
 try{for(;;){const part=await traceCDP.send('IO.read',{handle:receipt.stream,size:1048576}),data=Buffer.from(part.data,part.base64Encoded?'base64':'utf8');totalTraceBytes+=data.length;if(totalTraceBytes>268435456)throw Error('256MiB total trace cap exceeded');fs.writeSync(handle,data);bytes+=data.length;if(part.eof)break;}}finally{fs.closeSync(handle);await traceCDP.send('IO.close',{handle:receipt.stream});}
 return {file:file.split('/').at(-1),bytes,dataLossOccurred:receipt.dataLossOccurred||false,coverage:traceCoverage(JSON.parse(fs.readFileSync(file,'utf8')))};
}
function traceSource(original){
 let source=controlSource(original);
 source=once(source,'const instrumentation=new Function',"source=("+correlate.toString()+")(source);\nconst instrumentation=new Function");
 // correlate uses this exact one-match helper in the native program.
 source=once(source,"const {plan,validateMetadata}=require('./performance-resume.cjs');", "const {plan,validateMetadata}=require('./performance-resume.cjs');\n"+once.toString());
 source=once(source,'reps:preflight?1:3','reps:1');source=once(source,'bound=420000','bound=180000');
 source=once(source,"'Original/original control ONLY; never acceptance or replacement samples'","'Owned-browser native trace ONLY; two original Bao samples; never acceptance'");
 source=once(source,"recipe:'meeting-light x 3 original/original pairs x 10s warmup + 30s sample; label order AB/BA/AB'","recipe:'meeting-light x two original-only runs x 10s warmup + 30s sample; diagnostic trace overhead'");
 source=once(source,'(async()=>{let browser;', 'let traceCDP,totalTraceBytes=0;\n'+categoryPolicy.toString()+'\n'+traceCoverage.toString()+'\n'+startTrace.toString()+'\n'+finishTrace.toString()+'\n(async()=>{let browser;');
 source=once(source,'results.browser=browser.version();',"results.browser=browser.version();traceCDP=await browser.newBrowserCDPSession();results.availableTraceCategories=(await traceCDP.send('Tracing.getCategories')).categories;results.traceCategoryPolicy=categoryPolicy(results.availableTraceCategories);results.traceCategories=results.traceCategoryPolicy.selected;results.tracePrivacy='Owned synthetic browser only; minimal categories; no screenshots/network bodies/input/env/credentials';");
 source=once(source,'const clocks=[clock()]','await startTrace();const clocks=[clock()]');
 source=once(source,'p.records=[];p.gpu=[];p.anim=[];p.disjoint=0;p.collect=true;',"p.records=[];p.gpu=[];p.anim=[];p.disjoint=0;p.querySamples=[];p.traceAnchorAt=performance.mark('bao24-sample-start').startTime;p.collect=true;");
 source=once(source,'()=>__cast22.collect=false',"()=>{__cast22.collect=false;__cast22.traceEndAt=performance.mark('bao24-sample-end').startTime;}");
 source=once(source,'return {actorCount:p.agents.actors.size','return {querySamples:p.querySamples,traceAnchorAt:p.traceAnchorAt,traceEndAt:p.traceEndAt,actorCount:p.agents.actors.size');
 source=once(source,'results.scenarios.push(item);save();',"results.scenarios.push(item);save();item.trace=await finishTrace(output+'/trace-'+(baseline?'A':'B')+'.json');save();");
 source=once(source,"await page.screenshot({path:output+'/perf-'+(baseline?'before':'after')+'-'+name+'-'+rep+'.png'});",'');
 return source;
}
function prepare(output){
 assert.ok(output);assert.ok(!fs.existsSync(output),'refuse existing trace directory');const source=traceSource(fs.readFileSync(__dirname+'/native-performance.cjs','utf8'));
 const plan={recordedAt:new Date().toISOString(),kind:'Diagnostic native trace only; preserves failed60/quiet6/identical6',runs:2,originalOnly:true,scenario:'meeting-light',warmupMs:10000,sampleMs:30000,overallBoundMs:180000,totalTraceCapBytes:268435456,queryStrategy:'Unchanged begin/end/query-frequency/availability polling; diagnostic CPU timestamps and IDs added without new GL calls',categories:['devtools.timeline','v8','gpu','disabled-by-default-gpu.service','blink.user_timing','toplevel'],privacy:'Owned synthetic browser only; no screenshots, bodies, input, env, credentials, unrelated apps',sourceCommit:'efbb225f9569abeb269cd052236dac426c4d9af4',harnessSha256:crypto.createHash('sha256').update(source).digest('hex')};
 fs.mkdirSync(output,{recursive:true});fs.writeFileSync(output+'/native-performance.cjs',source);for(const n of ['capture-review.cjs','performance-resume.cjs'])fs.copyFileSync(__dirname+'/'+n,output+'/'+n);fs.writeFileSync(output+'/trace-plan.json',JSON.stringify(plan,null,2)+'\n');return plan;
}
module.exports={correlate,traceSource,prepare,categoryPolicy,traceCoverage};
if(require.main===module)console.log(JSON.stringify(prepare(process.argv[2]),null,2));
