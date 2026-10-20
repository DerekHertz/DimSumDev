import test from 'node:test';
import assert from 'node:assert/strict';
import {createToolReplayFilter} from './tool-replay-filter.mjs';

test('run replay membership never forgets observations after correlation-window churn',()=>{
 const filter=createToolReplayFilter();
 assert.equal(filter.seen('retired42'),false);
 for(let i=0;i<10000;i++)filter.seen(`other-${i}`);
 assert.equal(filter.seen('retired42'),true);
 assert.equal(createToolReplayFilter().seen('retired42'),false,'another run has independent replay membership');
});

test('saturation and collisions fail toward ambiguous correlation, never a fresh identity',()=>{
 const filter=createToolReplayFilter(1),observed=[];
 for(let i=0;i<128;i++){const id=`observed-${i}`;filter.seen(id);observed.push(id);}
 assert.equal(filter.seen('never-observed'),true,'a saturated filter treats new observations as ambiguous');
 for(const id of observed)assert.equal(filter.seen(id),true,'a collision cannot retire an older observation from membership');
});
