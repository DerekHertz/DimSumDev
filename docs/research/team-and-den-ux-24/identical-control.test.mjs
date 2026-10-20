import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const { controlSource }=require('./identical-control.cjs');
test('both control labels select the original manifest and portrait, without changing timing collectors',()=>{
 const original=fs.readFileSync(new URL('./native-performance.cjs',import.meta.url),'utf8'),source=controlSource(original);
 assert.match(source,/if\(p==='\/den\/manifest.json'\)\{/);
 assert.match(source,/if\(p==='\/den\/portraits\/bao-jade.webp'\)\{/);
 assert.match(source,/assert.equal\(item.baoSpecies,null\)/);
 assert.match(source,/assert.ok\(identity.requests.includes\('\/den\/models\/bao.glb.gz'\)\)/);
 assert.match(source,/assert.ok\(!identity.requests.includes\('\/den\/models\/characters\/bao.glb.gz'\)\)/);
 assert.match(source,/const cases=\[\['meeting-light'/);
 assert.match(source,/bound=420000/);
 assert.match(source,/for\(const baseline of rep%2\?\[true,false\]:\[false,true\]\)/);
 assert.equal(source.slice(source.indexOf('let source=reference'),source.indexOf('const fixture=')),original.slice(original.indexOf('let source=reference'),original.indexOf('const fixture=')));
 assert.match(source,/warmupMs:preflight\?0:10000,sampleMs:preflight\?1000:30000/);
});
test('control preparation refuses drift in the known baseline selector',()=>{
 const original=fs.readFileSync(new URL('./native-performance.cjs',import.meta.url),'utf8');
 assert.throws(()=>controlSource(original.replace("p==='/den/manifest.json'&&baseline","p==='/den/manifest.json'&&false")),/expected one/);
});
test('A/A summary preserves labels and raw data, exposes false regressions, and rejects identity or sequence drift',()=>{
 const {summarize}=require('./summarize-control.cjs');
 const metadata={browser:'same',viewport:{width:1440,height:900},canvas:{width:1384,height:856},dpr:1,frameCap:30,warmupMs:10000,sampleMs:30000,gpu:{devices:[],auxAttributes:{glRenderer:'same',glImplementationParts:'same'}},meta:{commit:'same',hooks:4,instrumentedProductionBuild:true}};
 const raw={...metadata,finishedAt:'done',errors:[],writes:[],scenarios:[true,false,false,true,true,false].map((baseline,i)=>({rep:Math.floor(i/2)+1,baseline,name:'meeting-light',theme:'light',reducedMotion:false,walkMode:false,actorCount:42,visitors:4,meetingGuests:6,baoSpecies:null,bao:{failed:[]},identity:{manifestHasBao:false,requests:['/den/models/bao.glb.gz']},renderer:'NVIDIA RTX3060 Ti',camera:{drawingBuffer:{width:1384,height:856}},css:{width:1384,height:856},scene:{triangles:123},records:Array.from({length:801},(_,j)=>({at:j*37.4+3,cpuMs:2})),animationCpu:Array.from({length:801},(_,j)=>[{key:'update',at:j*37.4,ms:.1},{key:'pose',at:j*37.4+1,ms:.2},{key:'update',at:j*37.4+2,ms:.3}]).flat(),gpuMs:Array(251).fill([1,1.2,1.4,1.3,1.1,1.3][i]),disjoint:0,pendingQueries:0,clocks:[{csv:'timestamp,P0,1755,9701,82,44,14,3'}]}))};
 const untouched=structuredClone(raw),summary=summarize(raw,metadata);
 assert.deepEqual(raw,untouched);assert.equal(summary.medianOfThreeP95.gpu.A,1.1);assert.equal(summary.medianOfThreeP95.gpu.B,1.3);assert.equal(summary.medianOfThreeP95.gpu.apparentRegressionAbove5Percent,true);assert.deepEqual(summary.pairs.map(p=>p.order),[['A','B'],['B','A'],['A','B']]);assert.equal(summary.runs[0].combinedCpu.p95,2.6);
 for(const mutate of [r=>r.scenarios[1].baoSpecies='giant-panda',r=>r.scenarios[1].identity.requests.push('/den/models/characters/bao.glb.gz'),r=>r.scenarios[1].baseline=true,r=>r.scenarios.pop()]){const bad=structuredClone(raw);mutate(bad);assert.throws(()=>summarize(bad,metadata));}
});
