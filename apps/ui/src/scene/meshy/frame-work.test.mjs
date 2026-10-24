import test from 'node:test';
import assert from 'node:assert/strict';
import {createFrameWork} from './frame-work.mjs';

test('planning yields to later frames and shares the frame budget fairly',()=>{
 let clock=0;const work=createFrameWork({now:()=>++clock,budgetMs:2}),events=[];
 function* job(name){events.push(name+'1');yield;events.push(name+'2');yield;}
 work.submit('a',job('a'));work.submit('b',job('b'));
 work.update();assert.deepEqual(events,['a1']);work.update();assert.deepEqual(events,['a1','b1']);
 work.update();work.update();assert.deepEqual(events,['a1','b1','a2','b2']);
 work.update();work.update();assert.equal(work.has('a'),false);assert.equal(work.has('b'),false);
});

test('cancellation and disposal run cleanup and prevent late completion',()=>{
 let clock=0,completed=0,cleaned=0;const work=createFrameWork({now:()=>++clock,budgetMs:2});
 function* job(){try{yield;completed++;}finally{cleaned++;}}
 work.submit('one',job());work.update();work.cancel('one');work.update();assert.equal(completed,0);assert.equal(cleaned,1);
 work.submit('two',job());work.update();work.dispose();work.update();assert.equal(completed,0);assert.equal(cleaned,2);
});

test('a job may be replaced while running without losing its replacement',()=>{
 let clock=0,oldCleaned=false,newRan=false;const work=createFrameWork({now:()=>++clock,budgetMs:2});
 function* replacement(){newRan=true;}
 function* original(){try{work.submit('key',replacement());yield;}finally{oldCleaned=true;}}
 work.submit('key',original());work.update();assert.equal(oldCleaned,true);assert.equal(work.has('key'),true);work.update();assert.equal(newRan,true);
});

test('a failed job is removed and does not strand unrelated work',()=>{
 let clock=0,ran=false;const work=createFrameWork({now:()=>++clock,budgetMs:2});
 work.submit('bad',(function*(){throw Error('failed');})());work.submit('good',(function*(){ran=true;})());
 assert.throws(()=>work.update(),/failed/);assert.equal(work.has('bad'),false);work.update();assert.equal(ran,true);
});

test('waiting work sleeps without spending the frame budget or blocking ready work',()=>{
 let clock=0,ready=false,resumed=false,otherRan=false;const work=createFrameWork({now:()=>++clock,budgetMs:2});
 work.submit('waiting',(function*(){yield {ready:()=>ready};resumed=true;})());work.update();
 work.submit('other',(function*(){otherRan=true;})());work.update();work.update();assert.equal(otherRan,true);assert.equal(resumed,false);
 ready=true;work.update();assert.equal(resumed,true);
});
