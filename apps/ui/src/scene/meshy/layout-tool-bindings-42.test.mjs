import test from 'node:test';
import assert from 'node:assert/strict';
import {actorBindings} from './layout.mjs';

test('42 a meeting guest keeps its own binding when the concurrent work ends, then releases it with the meeting',()=>{
 const busy={role:'developer',runtime:'claude',projectId:'den',agentId:'busy42',ref:'work/1'};
 const own={...busy,agentId:'meeting42',ref:'work/meeting'};
 const meeting={id:'meeting42',ref:own.ref,state:'running',seats:[{role:'developer'}]};
 let bindings=actorBindings([own,busy],new Map(),{meeting});
 assert.equal(bindings.get('developer')?.agentId,busy.agentId,'a newer meeting row cannot take the busy resident');
 assert.equal(bindings.get('meeting:developer')?.agentId,own.agentId);
 bindings=actorBindings([own],bindings,{meeting});
 assert.equal(bindings.get('meeting:developer')?.agentId,own.agentId,'the still-seated guest keeps its inspectable identity');
 assert.equal(bindings.has('developer'),false,'the freed resident cannot duplicate the guest invocation');
 bindings=actorBindings([own],bindings,{meeting:null});
 assert.equal(bindings.has('meeting:developer'),false);
 assert.equal(bindings.get('developer')?.agentId,own.agentId);
});
