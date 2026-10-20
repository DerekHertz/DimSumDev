// Control labels A/B both mean original Bao; never feed these rows to acceptance.
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {validateMetadata,validateRow,combinedCpu,namedAnimations}=require('./performance-resume.cjs');
const q=(a,p)=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*p)-1];
const d=a=>({n:a.length,min:Math.min(...a),p50:q(a,.5),p95:q(a,.95),max:Math.max(...a)});
const compare=(a,b)=>({A:a,B:b,percent:100*(b/a-1),apparentRegressionAbove5Percent:b>a*1.05});
function summarize(raw,reference){
 validateMetadata(reference,raw);assert.equal(raw.scenarios.length,6);assert.ok(raw.finishedAt);assert.ok(!raw.failure);assert.deepEqual(raw.errors,[]);assert.deepEqual(raw.writes,[]);
 const runs=raw.scenarios.map((r,i)=>{
  assert.equal(r.rep,Math.floor(i/2)+1);assert.equal(r.baseline,[true,false,false,true,true,false][i]);assert.equal(r.name,'meeting-light');
  // The baseline flag is a label in A/A; normalize only the validator input,
  // never alter raw bytes or pretend label B contains the replacement asset.
  assert.equal(r.baoSpecies,null);validateRow({...r,baseline:true});assert.equal(r.identity.manifestHasBao,false);assert.ok(r.identity.requests.includes('/den/models/bao.glb.gz'));assert.ok(!r.identity.requests.includes('/den/models/characters/bao.glb.gz'));
  assert.deepEqual(r.camera,raw.scenarios[0].camera);assert.equal(r.visitors,4);assert.equal(r.meetingGuests,6);assert.deepEqual(r.scene,raw.scenarios[0].scene);
  const animations=namedAnimations(r),animationSums=r.records.map((_,i)=>animations.slice(i*3,i*3+3).reduce((n,a)=>n+a.ms,0));
  const clocks=r.clocks.flatMap(c=>c.csv.split('\n')).map(s=>{const x=s.split(',').map(x=>x.trim());return {pstate:x[1],graphicsMHz:Number(x[2]),memoryMHz:Number(x[3]),powerW:Number(x[4]),temperatureC:Number(x[5]),gpuPercent:Number(x[6]),memoryPercent:Number(x[7])};});assert.ok(clocks.every(c=>Number.isFinite(c.gpuPercent)&&Number.isFinite(c.memoryPercent)));
  return {rep:r.rep,label:r.baseline?'A':'B',originalAsset:true,frames:r.records.length,gpu:d(r.gpuMs),renderCpu:d(r.records.map(f=>f.cpuMs)),animationCpu:d(animationSums),combinedCpu:d(combinedCpu(r)),components:Object.fromEntries(['agents.update','ambient.pose','koi.update'].map(n=>[n,d(animations.filter(a=>a.name===n).map(a=>a.ms))])),clocks};
 });
 const comparisons=Object.fromEntries(['gpu','renderCpu','animationCpu','combinedCpu'].map(key=>[key,compare(q(runs.filter(r=>r.label==='A').map(r=>r[key].p95),.5),q(runs.filter(r=>r.label==='B').map(r=>r[key].p95),.5))]));
 const pairs=[1,2,3].map(rep=>{const rows=runs.filter(r=>r.rep===rep),a=rows.find(r=>r.label==='A'),b=rows.find(r=>r.label==='B');return {rep,order:rows.map(r=>r.label),p95:Object.fromEntries(['gpu','renderCpu','animationCpu','combinedCpu'].map(key=>[key,compare(a[key].p95,b[key].p95)]))};});
 return {kind:'Original/original diagnostic ONLY; acceptance gates remain failed',browser:raw.browser,source:raw.meta,observed:{camera:raw.scenarios[0].camera,actors:42,visitors:4,meetingGuests:6,scene:raw.scenarios[0].scene},runs,pairs,medianOfThreeP95:comparisons,gpuP95Spread:d(runs.map(r=>r.gpu.p95)),limitations:['Identical assets can expose measurement instability but cannot absolve the selected asset or establish a causal host/driver/timer fault.','GPU elapsed intervals are not continuous GPU busy time; utilization is total device sampling, not per-frame or per-process attribution.','No failed60/quiet6 samples are replaced; no acceptance threshold changes.']};
}
module.exports={summarize};
if(require.main===module){const file=process.argv[2],reference=JSON.parse(fs.readFileSync(process.argv[3])),raw=fs.readFileSync(file),summary=summarize(JSON.parse(raw),reference);summary.rawSha256=crypto.createHash('sha256').update(raw).digest('hex');fs.writeFileSync(process.argv[4],JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({comparison:summary.medianOfThreeP95,runs:summary.runs.map(({rep,label,gpu,renderCpu,animationCpu,combinedCpu})=>({rep,label,gpu,renderCpu,animationCpu,combinedCpu})),pairs:summary.pairs},null,2));}
