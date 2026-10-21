import test from 'node:test';
import assert from 'node:assert/strict';
import {createAllocationWork} from './allocation-work.mjs';

test('36 exact cache distinguishes replaced navigation functions without resetting the allowance',()=>{
 const work=createAllocationWork();let calls=0;
 const navigation={revision:0,groundAt:()=>{calls++;return 0;}};
 assert.equal(work.groundAt(navigation,0,0,0,.45,1),0);
 navigation.groundAt=()=>{calls++;return null;};
 assert.equal(work.groundAt(navigation,0,0,0,.45,1),null,'replacement terrain cannot reuse a stale exact hit');
 assert.equal(calls,2);
 for(let x=1;x<250001;x++)work.groundAt(navigation,x,0,0,.45,1);
 assert.equal(calls,250000,'both terrain adapters spend the same external ceiling');
});

test('36 exact cache keys navigation revisions and all phases share one query budget',()=>{
 const allocation=createAllocationWork();let calls=0;
 const navigation={revision:0,groundAt:()=>++calls};
 const primary=allocation.phase(.75),staging=allocation.phase(.9375),arrival=allocation.phase(1);
 assert.equal(primary.groundAt(navigation,0,0,0,.45,1),1);assert.equal(staging.groundAt(navigation,0,0,0,.45,1),1);
 navigation.revision++;assert.equal(arrival.groundAt(navigation,0,0,0,.45,1),2,'a terrain revision cannot reuse a stale exact hit');
 for(let x=1;x<250001;x++)arrival.groundAt(navigation,x,0,0,.45,1);
 assert.equal(calls,250000);assert.equal(primary.groundAt(navigation,-1,0,0,.45,1),null);assert.equal(staging.groundAt(navigation,-2,0,0,.45,1),null);
});
