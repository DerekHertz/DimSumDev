import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const core=require('./cpu-diagnostic-core.cjs');
const root=()=>fs.mkdtempSync(path.join(os.tmpdir(),'bao24-cpu-test-'));
const event=(extra={})=>({ph:'X',cat:'toplevel',name:'RunTask',pid:1,tid:2,ts:100,dur:0,...extra});
test('structural projection keeps zero/negative durations and every present numeric thread field, discards payloads',()=>{
 assert.deepEqual(core.project(event({tts:20,tdur:0,args:{secret:'discard'},stack:'discard'})),event({tts:20,tdur:0}));
 assert.equal(core.project(event({cat:'gpu.service'})),null);
 assert.equal(core.project(event({ph:'B'})),null);
 assert.equal(core.project(event({dur:-1})).dur,-1);
 assert.equal(core.project(event({dur:undefined})).dur,undefined);
 assert.equal(core.project(event({ts:NaN})),null);
 assert.equal(core.project(event({cat:'v8',name:'MinorGC'})).name,'MinorGC');
 assert.equal(core.project(event({ph:'I',cat:'blink.user_timing',name:'bao24-cpu-start'})).ph,'I');
});
test('stream parser handles nested/escaped payloads across single-character chunks; rejects truncated traces',async()=>{
 const events=[event({args:{nested:[{text:'a\\"}[]'}]}}),event({dur:200000})],seen=[];
 async function* chunks(text){yield* text;}
 await core.parseEvents(chunks(JSON.stringify({traceEvents:events})),e=>seen.push(e));
 assert.deepEqual(seen,events);
 await assert.rejects(core.parseEvents(chunks('{"traceEvents":[{"ph":"X"'),()=>{}),/complete/);
});
test('clock mapping preserves missing CPU times; enclosing outermost task avoids nested double counting',()=>{
 const spans=[event({ts:1000,dur:1000,tts:10,tdur:400}),event({ts:1100,dur:600,tts:20,tdur:300})];
 const result=core.alignQuery({beginAt:10.2,endAt:10.4}, {traceUs:1000,pageMs:10,pid:1,tid:2},spans);
 assert.equal(result.outermostEnclosing.ts,1000);assert.equal(result.outermostEnclosing.tdur,400);assert.equal(result.enclosingCount,2);
 assert.equal(core.alignQuery({beginAt:10.2,endAt:10.4},{traceUs:1000,pageMs:10,pid:1,tid:2},[event({ts:1000,dur:1000})]).outermostEnclosing.tdur,undefined);
});
test('shared output budget counts replacements and files; cap retains partial and reserved status',()=>{
 const dir=root(),sink=new core.OutputBudget(dir,200,40);
 sink.write('raw.json','12345');sink.append('tasks.ndjson','x'.repeat(150));
 assert.throws(()=>sink.append('tasks.ndjson','x'.repeat(6)),/output cap/);
 sink.write('status.json','partial',true);assert.equal(fs.readFileSync(path.join(dir,'tasks.ndjson'),'utf8').length,150);
 assert.ok(sink.bytes<=200);fs.rmSync(dir,{recursive:true});
});
test('numeric spool finalizes all renderer spans irrespective of duration and counts missing thread fields',async()=>{
 const dir=root(),sink=new core.OutputBudget(dir,1024*1024,1000),filter=new core.TaskLog(sink,'block1');
 [event({dur:0}),event({pid:9}),event({dur:900000,tts:1,tdur:50}),event({ph:'I',cat:'blink.user_timing',name:'bao24-cpu-start',ts:100}),event({ph:'I',cat:'blink.user_timing',name:'bao24-cpu-end',ts:30000100})].forEach(e=>filter.visit(e));
 const coverage=await filter.finish();assert.equal(coverage.tasks,2);assert.equal(coverage.missing.tts,1);assert.equal(coverage.missing.tdur,1);
 const rows=fs.readFileSync(path.join(dir,'block1-tasks.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,4);assert.ok(rows.every(e=>e.pid===1));assert.equal(coverage.endTraceUs-coverage.startTraceUs,30000000);
 fs.rmSync(dir,{recursive:true});
});
test('raw row persists before fallible trace finalization; failure retains row',async()=>{
 const order=[];await assert.rejects(core.persistThenFinalize({x:1},r=>order.push(['save',r]),()=>{order.push(['finalize']);throw Error('trace failed');}),/trace failed/);
 assert.deepEqual(order,[['save',{x:1}],['finalize']]);
});
test('generated block runner saves actual row before failing finalizer',async()=>{
 const source=require('./cpu-diagnostic-prepare.cjs').nativeSource(),module={exports:{}};new Function('require','__dirname','module',source)(require,path.dirname(new URL(import.meta.url).pathname),module);
 const order=[];await assert.rejects(module.exports.runBlocks({blocks:[{label:'A'}],warmupMs:10000,sampleMs:30000},{switchBody:async()=>{},warm:async()=>{},sample:async()=>{},drain:async()=>{},read:async()=>({row:1}),persist:r=>order.push(['raw',r]),validate:()=>{},finalize:async()=>{order.push(['finalize']);throw Error('trace failure');}}),/trace failure/);assert.deepEqual(order,[['raw',{row:1}],['finalize']]);
});
test('runtime streams compact renderer coverage and closes acquired IO; explicit abort cleanup ends trace',async()=>{
 const {Diagnostic}=require('./cpu-diagnostic-runtime.cjs'),dir=root(),scope={check(){},cancel(e){throw e;}},diagnostic=new Diagnostic(dir,scope),cdp=new EventEmitter(),calls=[];
 const events=[event({dur:1,tts:5,tdur:1}),event({ph:'I',cat:'blink.user_timing',name:'bao24-cpu-start',ts:100}),event({ph:'I',cat:'blink.user_timing',name:'bao24-cpu-end',ts:30000100})];
 cdp.send=async(method,args)=>{calls.push([method,args]);if(method==='Tracing.end')queueMicrotask(()=>cdp.emit('Tracing.tracingComplete',{stream:'owned-stream',dataLossOccurred:false}));if(method==='IO.read')return {data:JSON.stringify({traceEvents:events}),eof:true};return {};};
 await diagnostic.start(cdp);const row={};await diagnostic.finish(row);assert.equal(row.taskTiming.tasks,1);assert.ok(calls.some(([method])=>method==='IO.close'));
 diagnostic.active=true;diagnostic.stream='owned-stream';await diagnostic.close();assert.equal(calls.filter(([method])=>method==='Tracing.end').length,2);assert.equal(calls.filter(([method])=>method==='IO.close').length,2);fs.rmSync(dir,{recursive:true});
});
test('CPU counter processes run only as awaited pre/post brackets; warmup/sample refuses a live logger',async()=>{
 const {Diagnostic}=require('./cpu-diagnostic-runtime.cjs'),dir=root(),scope={check(){},cancel(e){throw e;}},children=[];
 const spawn=(file,args)=>{assert.equal(file,'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');assert.deepEqual(args.slice(-2),['-DurationSeconds','10']);const child=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.stderr=new EventEmitter();child.kill=()=>{};children.push(child);return child;};
 const diagnostic=new Diagnostic(dir,scope,spawn),collect=diagnostic.collectCounters('pre');assert.equal(children.length,1);assert.throws(()=>diagnostic.assertNoCounters(),/counter logger/);
 children[0].stdout.emit('data',JSON.stringify({source:'Win32_PerfFormattedData_Counters_ProcessorInformation'})+'\n');children[0].stdout.emit('data',JSON.stringify({source:'Win32_PerfFormattedData_Counters_ProcessorInformation'})+'\n');children[0].emit('close',0);await collect;diagnostic.assertNoCounters();assert.equal(diagnostic.logger,null);
 const rows=fs.readFileSync(path.join(dir,'cpu-counters.ndjson'),'utf8').trim().split('\n').map(JSON.parse);assert.ok(rows.every(row=>row.bracket==='pre'));
 const source=require('./cpu-diagnostic-prepare.cjs').nativeSource();assert.ok(source.includes("await diagnostic.collectCounters('pre')"));assert.ok(source.includes("await diagnostic.collectCounters('post')"));assert.ok(source.includes('warm:ms=>{diagnostic.assertNoCounters();'));fs.rmSync(dir,{recursive:true});
});
test('owned browser server cleanup kills only its retained process when protocol close stalls',async()=>{
 let killed=0;await core.closeOwnedServer({close:()=>new Promise(()=>{}),process:()=>({kill:()=>{killed++;}})},5);assert.equal(killed,1);
 await core.closeOwnedServer({close:async()=>{throw Error('disconnected');},process:()=>({kill:()=>{killed++;}})},5);assert.equal(killed,2);
});
test('deadline reaches finally and closes owned browser; delayed acquisition is also closed',async()=>{
 let closed=0,finalized=false;const scope=new core.DeadlineScope(10);
 await assert.rejects(scope.run(async()=>{await scope.own(new Promise(resolve=>setTimeout(()=>resolve({close:async()=>{closed++;}}),35)));},async()=>{finalized=true;}),/deadline/);
 await new Promise(resolve=>setTimeout(resolve,45));assert.equal(closed,1);assert.equal(finalized,true);
 const next=new core.DeadlineScope(10);await assert.rejects(next.run(async()=>{await next.own(Promise.resolve({close:async()=>{closed++;}}));await new Promise(()=>{});},async()=>{}),/deadline/);assert.equal(closed,2);
});
test('generated native driver compiles, has six-block order and unchanged GL call inventory',async()=>{
 const driver=require('./cpu-diagnostic-prepare.cjs'),source=driver.nativeSource();new Function(source);
 assert.ok(source.includes('await diagnostic.finish(row)'));assert.ok(source.includes('await scope.run('));
 const original=require('./same-context-calibration.cjs').loadCollectors().instrumentation.toString(),instrumented=core.correlate(original);
 const calls=s=>s.match(/gl\.[A-Za-z]+\(/g);
 assert.deepEqual(calls(instrumented),calls(original));new Function('return ('+instrumented+')');
 const dir=root();fs.rmdirSync(dir);const plan=await driver.prepare(dir);assert.deepEqual(plan.blocks.map(b=>b.label),['A','B','B','A','A','B']);assert.equal(plan.overallBoundMs,420000);assert.equal(plan.totalOutputCapBytes,67108864);assert.equal(plan.sampleMs,30000);assert.equal(plan.warmupMs,10000);
 const refused=spawnSync(process.execPath,[path.join(dir,'native-cpu-diagnostic.cjs'),dir],{encoding:'utf8',timeout:5000});assert.equal(refused.status,1);assert.match(refused.stderr,/Fresh user quiet-host readiness/);assert.equal(fs.existsSync(path.join(dir,'capture-attempt.json')),false);fs.rmSync(dir,{recursive:true});
});
