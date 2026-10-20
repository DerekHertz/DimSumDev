// Read-only statistics over every retained run; never filters poor scenarios.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {combinedCpu,namedAnimations,validateRow,plan}=createRequire(import.meta.url)('./performance-resume.cjs');
const input=process.argv[2],output=process.argv[3];
if(!input||!output)throw Error('Usage: node summarize-performance.mjs raw.json summary.json');
const bytes=fs.readFileSync(input),raw=JSON.parse(bytes),rows=raw.scenarios;
assert.equal(rows.length,60,'full approved recipe only');
assert.ok(!raw.failure,'successful assembled capture');assert.ok(raw.finishedAt,'capture finished');assert.deepEqual(raw.errors,[]);assert.deepEqual(raw.writes,[]);
rows.forEach((row,i)=>{const expected=plan(0).all[i];for(const key of ['name','rep','baseline'])assert.equal(row[key],expected[key],'full paired recipe order');validateRow(row);});
const median=xs=>quantile(xs,.5);
function quantile(xs,p){if(!xs.length)return null;const sorted=[...xs].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)];}
const distribution=xs=>({n:xs.length,min:xs.length?Math.min(...xs):null,p50:quantile(xs,.5),p95:quantile(xs,.95),p99:quantile(xs,.99),max:xs.length?Math.max(...xs):null,mean:xs.length?xs.reduce((s,v)=>s+v,0)/xs.length:null});
const change=(before,after)=>({before,after,percent:before?100*(after/before-1):null});
function clocks(row){return row.clocks.flatMap(c=>c.csv.split('\n').map(line=>{const xs=line.split(',').map(s=>s.trim());return {timestamp:xs[0],pstate:xs[1],graphicsMHz:Number(xs[2]),memoryMHz:Number(xs[3]),powerW:Number(xs[4]),temperatureC:Number(xs[5])};}));}
function fps(row){const records=row.records;return 1000*(records.length-1)/(records.at(-1).at-records[0].at);}
const evaluated=rows.map(row=>({...row,combined:combinedCpu(row),namedAnimations:namedAnimations(row),clockSamples:clocks(row)}));
function report(list){return {
 runs:list.length,frames:list.reduce((n,r)=>n+r.records.length,0),gpuMs:distribution(list.flatMap(r=>r.gpuMs)),renderCpuMs:distribution(list.flatMap(r=>r.records.map(f=>f.cpuMs))),renderAndAnimationCpuMs:distribution(list.flatMap(r=>r.combined)),
 frameIntervalMs:distribution(list.flatMap(r=>r.records.slice(1).map((f,i)=>f.at-r.records[i].at))),
 animationCallbacks:Object.fromEntries(['agents.update','ambient.pose','koi.update'].map(key=>[key,distribution(list.flatMap(r=>r.namedAnimations.filter(a=>a.name===key).map(a=>a.ms)))])),
 deliveredFps:distribution(list.map(fps)),perRunGpuP95:distribution(list.map(r=>quantile(r.gpuMs,.95))),perRunCombinedCpuP95:distribution(list.map(r=>quantile(r.combined,.95))),heapBytes:distribution(list.map(r=>r.heap.used)),
 calls:distribution(list.flatMap(r=>r.records.map(f=>f.calls))),sceneTriangles:distribution(list.map(r=>r.scene.triangles)),geometryBufferBytes:distribution(list.map(r=>r.scene.geometryBufferBytes)),estimatedRgbaTextureBytes:distribution(list.map(r=>r.scene.estimatedRgbaTextureBytes)),
 disjointQueries:list.reduce((n,r)=>n+(r.disjoint||0),0),pendingQueries:list.reduce((n,r)=>n+r.pendingQueries,0),clockMHz:distribution(list.flatMap(r=>r.clockSamples.map(c=>c.graphicsMHz))),memoryClockMHz:distribution(list.flatMap(r=>r.clockSamples.map(c=>c.memoryMHz))),temperatureC:distribution(list.flatMap(r=>r.clockSamples.map(c=>c.temperatureC))),powerW:distribution(list.flatMap(r=>r.clockSamples.map(c=>c.powerW))),pstates:[...new Set(list.flatMap(r=>r.clockSamples.map(c=>c.pstate)))],
};}
const summary={rawSha256:crypto.createHash('sha256').update(bytes).digest('hex'),meta:raw.meta,recipe:raw.recipe,startedAt:raw.startedAt,finishedAt:raw.finishedAt,complete:rows.length===60&&!raw.failure,failure:raw.failure||null,hardware:raw.gpu,browser:raw.browser,viewport:raw.viewport,dpr:raw.dpr,frameCap:raw.frameCap,errors:raw.errors,writes:raw.writes,
 percentileMethod:'Nearest rank: sorted[ceil(n*p)-1]; the middle repetition is the median of three per-run p95 values. Pooled distributions retain every measured sample.',
 cpuMethod:'renderer.render CPU plus agents.update, den.ambient.pose and koi.update callbacks timestamp-aligned between successive rendered frames; excludes unrelated browser/UI/React work. Legacy update/pose/update tags are named by the unchanged, validated production callback sequence; all callbacks must be assigned.',
 pooled:{before:report(evaluated.filter(r=>r.baseline)),after:report(evaluated.filter(r=>!r.baseline))},scenarios:[],runs:[],limitations:['Texture memory is a material-dimension RGBA+mipmap estimate; observed Bao GL texStorage2D allowance is a separate exact requested-storage metric, not driver VRAM.','NVIDIA clocks are observed, never pinned or modified; all three repetitions remain in the verdict.']};
for(const name of [...new Set(rows.map(r=>r.name))]){
 const before=evaluated.filter(r=>r.name===name&&r.baseline),after=evaluated.filter(r=>r.name===name&&!r.baseline),b=report(before),a=report(after),gpu=change(b.perRunGpuP95.p50,a.perRunGpuP95.p50),cpu=change(b.perRunCombinedCpuP95.p50,a.perRunCombinedCpuP95.p50);
 summary.scenarios.push({name,before:b,after:a,medianRepetitionGpuP95:gpu,medianRepetitionCombinedCpuP95:cpu,gpuWithinFivePercent:gpu.percent!==null&&gpu.percent<=5,combinedCpuWithinFivePercent:cpu.percent!==null&&cpu.percent<=5,gpuHeadroomTarget:a.perRunGpuP95.p50<16.7,
 fpsMedianChange:change(b.deliveredFps.p50,a.deliveredFps.p50),fpsAfterMedianWithinBaselineRepeatRange:a.deliveredFps.p50>=b.deliveredFps.min,
 sameCounts:before.length===3&&after.length===3&&before.every(b=>after.some(a=>a.rep===b.rep&&a.actorCount===b.actorCount&&a.visitors===b.visitors&&a.meetingGuests===b.meetingGuests&&a.inputAgents===b.inputAgents)),
 repetitions:[...before,...after].map(r=>({before:r.baseline,rep:r.rep,actors:r.actorCount,visitors:r.visitors,meetingGuests:r.meetingGuests,fps:fps(r),gpuP95:quantile(r.gpuMs,.95),cpuP95:quantile(r.combined,.95),medianGraphicsMHz:median(r.clockSamples.map(c=>c.graphicsMHz)),clockRange:[Math.min(...r.clockSamples.map(c=>c.graphicsMHz)),Math.max(...r.clockSamples.map(c=>c.graphicsMHz))],heap:r.heap.used}))});
}
summary.runs=evaluated.map(r=>({name:r.name,rep:r.rep,before:r.baseline,actors:r.actorCount,renderer:r.renderer,theme:r.theme,reducedMotion:r.reducedMotion,walkMode:r.walkMode,camera:r.camera,scene:r.scene,residents:r.residents,garden:r.garden,gpu:distribution(r.gpuMs),renderCpu:distribution(r.records.map(f=>f.cpuMs)),combinedCpu:distribution(r.combined),heap:r.heap,clocks:r.clockSamples}));
const frequencies=[...new Set(evaluated.flatMap(r=>r.clockSamples.map(c=>c.graphicsMHz)))].sort((a,b)=>a-b);
let gap=null;for(let i=1;i<frequencies.length;i++){const relative=(frequencies[i]-frequencies[i-1])/Math.max(1,frequencies[i-1]);if(!gap||relative>gap.relative)gap={low:frequencies[i-1],high:frequencies[i],relative};}
summary.clockDiagnostic={frequenciesMHz:frequencies,largestRelativeGap:gap,strata:[]};
if(gap?.relative>.3){const boundary=(gap.low+gap.high)/2;for(const low of [true,false]){const list=evaluated.filter(r=>(median(r.clockSamples.map(c=>c.graphicsMHz))<boundary)===low);summary.clockDiagnostic.strata.push({kind:low?'lower-clock':'higher-clock',boundaryMHz:boundary,before:report(list.filter(r=>r.baseline)),after:report(list.filter(r=>!r.baseline))});}}
summary.verdict={all60Runs:summary.complete,allScenarioCountsMatch:summary.scenarios.every(s=>s.sameCounts),allScenarioGpuWithinFivePercent:summary.scenarios.every(s=>s.gpuWithinFivePercent),allScenarioCombinedCpuWithinFivePercent:summary.scenarios.every(s=>s.combinedCpuWithinFivePercent),allMedianGpuUnder16_7:summary.scenarios.every(s=>s.gpuHeadroomTarget),heapMedianNoIncrease:summary.pooled.after.heapBytes.p50<=summary.pooled.before.heapBytes.p50,geometryMedianNoIncrease:summary.pooled.after.geometryBufferBytes.p50<=summary.pooled.before.geometryBufferBytes.p50,trianglesMedianNoIncrease:summary.pooled.after.sceneTriangles.p50<=summary.pooled.before.sceneTriangles.p50,drawCallsMedianNoIncrease:summary.pooled.after.calls.p50<=summary.pooled.before.calls.p50};
fs.writeFileSync(output,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({verdict:summary.verdict,scenarios:summary.scenarios.map(s=>({name:s.name,gpu:s.medianRepetitionGpuP95,cpu:s.medianRepetitionCombinedCpuP95,fps:s.fpsMedianChange}))},null,2));
