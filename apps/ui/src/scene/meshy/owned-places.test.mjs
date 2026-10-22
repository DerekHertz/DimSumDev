import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlaceRegistry,actorIdentity} from './places.mjs';

const flat={navigation:{groundAt:(x,z)=>Math.abs(x)>30||Math.abs(z)>30?null:0}};
const body={radius:.4,height:1.8};
const identity=(agentId,runtime='claude',projectId='one')=>({role:'developer',runtime,projectId,agentId,ref:'work/1'});
test('one registry owns every place kind by full actor identity and retains home during a trip',()=>{
 const places=createPlaceRegistry(flat),one=actorIdentity(identity('one')),two=actorIdentity(identity('two'));
 assert.notEqual(one,two);assert.notEqual(one,actorIdentity(identity('one','codex')));assert.notEqual(one,actorIdentity(identity('one','claude','two')));
 for(const [i,kind]of ['work','meeting','leisure','visitor','staging'].entries())places.define({id:kind,kind,position:{x:i*3,y:0,z:0}});
 assert.ok(places.reserve('work',one,body));places.occupy('work',one);
 assert.ok(places.reserve('leisure',one,body));assert.equal(places.reserve('leisure',two,body),null);
 assert.equal(places.get('work').owner,one);assert.equal(places.get('leisure').owner,one);
});
test('occupied places survive cancellation until their body clears; unoccupied leases and disposal release',()=>{
 const places=createPlaceRegistry(flat);places.define({id:'tea',kind:'leisure',position:{x:0,y:0,z:0}});
 places.reserve('tea','one',body);places.occupy('tea','one');places.release('tea','one');
 assert.equal(places.get('tea').owner,'one');assert.equal(places.reserve('tea','two',body),null);
 places.clearDeparted('one',{x:.3,y:0,z:0},body);assert.equal(places.get('tea').owner,'one');
 places.clearDeparted('one',{x:3,y:0,z:0},body);assert.equal(places.get('tea').owner,null);
 places.reserve('tea','two',body);places.cancel('two');assert.equal(places.get('tea').owner,null);
 places.reserve('tea','one',body);places.occupy('tea','one');places.disposeActor('one');assert.equal(places.get('tea').owner,null);
});
test('paired runtimes and concurrent visitors receive distinct fitting places or unavailable, never a shared fallback',()=>{
 const places=createPlaceRegistry(flat),allocated=[];
 for(const id of ['claude','codex','visitor1','visitor2']){
  const place=places.find({id,kind:'visitor',near:{x:0,y:0,z:0},owner:id,envelope:body});assert.ok(place);allocated.push(place);places.occupy(place.id,id);
 }
 for(const a of allocated)for(const b of allocated)if(a!==b)assert.ok(Math.hypot(a.position.x-b.position.x,a.position.z-b.position.z)>=.8);
 const blocked=createPlaceRegistry({navigation:{groundAt:()=>null}});
 assert.equal(blocked.find({id:'no-room',kind:'staging',near:{x:0,y:0,z:0},owner:'one',envelope:body}),null);
});
