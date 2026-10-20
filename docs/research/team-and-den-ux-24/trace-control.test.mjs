import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const { correlate,traceSource }=require('./trace-control.cjs');
test('empty discovery requests fixed declared categories and actual event coverage is authoritative',()=>{
 const {categoryPolicy,traceCoverage}=require('./trace-control.cjs');
 assert.deepEqual(categoryPolicy([]).selected,categoryPolicy(['unrelated']).selected);
 assert.ok(categoryPolicy([]).selected.includes('devtools.timeline'));
 const events=[{ph:'M',name:'thread_name',pid:1,tid:2,args:{name:'CrRendererMain'}},{ph:'R',cat:'blink.user_timing',name:'bao24-sample-start',pid:1,tid:2,ts:1000000},{ph:'R',cat:'blink.user_timing',name:'bao24-sample-end',pid:1,tid:2,ts:31000000},{ph:'X',cat:'toplevel',name:'RunTask',pid:1,tid:2,ts:1000001,dur:100}];
 const coverage=traceCoverage({traceEvents:events});assert.equal(coverage.gpuServiceObserved,false);assert.equal(coverage.rendererTasks,1);assert.equal(coverage.clockAnchorTraceUs,1000000);
 assert.throws(()=>traceCoverage({traceEvents:events.filter(e=>e.name!=='bao24-sample-end')}),/sample clock marks/);
 assert.throws(()=>traceCoverage({traceEvents:events.filter(e=>e.name!=='RunTask')}),/renderer main-thread tasks/);
 assert.throws(()=>traceCoverage({traceEvents:events.filter(e=>e.name!=='thread_name')}),/renderer main-thread/);
});
test('diagnostic correlation retains query calls and reports elapsed/submission/availability with frame identities',()=>{
 const text=fs.readFileSync(new URL('./capture-review.cjs',import.meta.url),'utf8');
 const source=text.slice(text.indexOf('function instrumentation()'),text.indexOf('\nfunction fixture('));
 const after=correlate(source);
 for(const name of ['beginQuery','endQuery','getQueryParameter','getParameter','deleteQuery'])assert.equal(after.split('gl.'+name+'(').length,source.split('gl.'+name+'(').length,name);
 assert.doesNotMatch(after,/gl\.(flush|finish)\(/);
 for(const key of ['frameId','queryId','beginAt','endAt','resolvedAt','resolveFrame','elapsedMs'])assert.ok(after.includes(key),key);
 assert.throws(()=>correlate(source.replace('p.pending.push(q)','p.pending.push(other)')),/expected one/);
});
test('trace harness is limited to two original-only samples and bounded owned-browser streams',()=>{
 const after=traceSource(fs.readFileSync(new URL('./native-performance.cjs',import.meta.url),'utf8'));
 assert.match(after,/reps:1/);assert.match(after,/bound=180000/);assert.match(after,/totalTraceBytes>268435456/);assert.match(after,/ReturnAsStream/);
 assert.match(after,/if\(p==='\/den\/manifest.json'\)\{/);assert.match(after,/assert.equal\(item.baoSpecies,null\)/);
 assert.ok(!after.includes('await page.screenshot'));
 assert.doesNotMatch(after,/gl\.(flush|finish)\(/);
 assert.match(after,/blink.user_timing/);assert.match(after,/traceAnchorAt=performance.mark/);
 assert.ok(after.indexOf('results.scenarios.push(item);save();')<after.indexOf('item.trace=await finishTrace'),'persist observations before fallible trace finalization');
});
