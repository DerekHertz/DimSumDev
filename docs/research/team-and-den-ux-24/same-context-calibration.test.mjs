import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{loadCollectors,runBlocks,summarizeCalibration}=require('./same-context-calibration.cjs');
test('calibration keeps the acceptance collector byte-for-byte and uses one page/context outside the block loop',()=>{
 const source=fs.readFileSync(new URL('./native-performance.cjs',import.meta.url),'utf8'),reference=fs.readFileSync(new URL('./capture-review.cjs',import.meta.url),'utf8');
 const expected=new Function('reference',source.slice(source.indexOf('let source=reference'),source.indexOf('const fixture='))+'return instrumentation;')(reference);
 assert.equal(loadCollectors().instrumentation.toString(),expected.toString());
 const driver=fs.readFileSync(new URL('./same-context-calibration.cjs',import.meta.url),'utf8');
 assert.equal(driver.match(/browser.newContext\(/g).length,1);assert.equal(driver.match(/context.newPage\(/g).length,1);assert.equal(driver.match(/page.goto\(/g).length,1);assert.doesNotMatch(driver,/page.reload\(/);
 assert.match(driver,/--ready-confirmed/);assert.match(driver,/collect=false/);assert.match(driver,/250/);assert.match(driver,/pendingQueries/);
});
test('block orchestration is AB/BA/AB, null original both labels, save-before-validation with no retries',async()=>{
 const events=[],rows=[];await runBlocks({blocks:['A','B','B','A','A','B'].map((label,i)=>({label,body:'original',pair:Math.floor(i/2)+1})),warmupMs:10000,sampleMs:30000},{switchBody:async b=>events.push(['switch',b.label,b.body]),warm:async ms=>events.push(['warm',ms]),sample:async ms=>{events.push(['sample',ms]);return {};},drain:async()=>events.push(['drain']),read:async()=>({raw:'kept'}),persist:row=>rows.push(row),validate:()=>events.push(['validate'])});
 assert.deepEqual(events.filter(e=>e[0]==='switch').map(e=>e.slice(1)),[['A','original'],['B','original'],['B','original'],['A','original'],['A','original'],['B','original']]);assert.equal(rows.length,6);assert.ok(rows.every(r=>r.raw==='kept'));assert.ok(events.filter(e=>e[0]==='warm').every(e=>e[1]===10000));assert.ok(events.filter(e=>e[0]==='sample').every(e=>e[1]===30000));
 let saved=0;await assert.rejects(()=>runBlocks({blocks:[{},{}],warmupMs:10000,sampleMs:30000},{switchBody:async()=>{},warm:async()=>{},sample:async()=>{},drain:async()=>{},read:async()=>({}),persist:()=>saved++,validate:()=>{throw Error('invalid query guard');}}),/invalid query guard/);assert.equal(saved,1);
});
test('calibration summary keeps every row and fails paired instability even when median passes',()=>{
 const rows=['A','B','B','A','A','B'].map((label,i)=>({label,rep:Math.floor(i/2)+1,name:'meeting-light',baseline:true,theme:'light',reducedMotion:false,walkMode:false,actorCount:42,baoSpecies:null,bao:{failed:[]},disjoint:0,pendingQueries:0,renderer:'NVIDIA RTX3060 Ti',camera:{drawingBuffer:{width:1384,height:856}},css:{width:1384,height:856},records:Array.from({length:801},(_,j)=>({at:j*37.4+3,cpuMs:2})),animationCpu:Array.from({length:801},(_,j)=>[{key:'update',at:j*37.4,ms:.1},{key:'pose',at:j*37.4+1,ms:.2},{key:'update',at:j*37.4+2,ms:.3}]).flat(),gpuMs:Array(251).fill([1,1.2,1,1,1,1][i])}));
 const frozen=structuredClone(rows),result=summarizeCalibration(rows);assert.deepEqual(rows,frozen);assert.equal(result.medianOfThree.gpu.percent,0);assert.equal(result.allPairedRepeatabilityWithinFivePercent,false);assert.equal(result.calibrationPass,false);assert.equal(result.pairs.length,3);assert.equal(result.acceptanceVerdict,'Original failed60 remains failed; this calibration cannot accept Bao');
});
