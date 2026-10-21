import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlaceRegistry,actorIdentity} from './places.mjs';
import {createActorTravel} from './actor-travel.mjs';
import {gardenRoute,routeSegment} from './garden-route.mjs';

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
test('segments and final approach reject geometry, height and radius violations in either direction',()=>{
 const world={navigation:{groundAt:(x,z,y,r,h)=>Math.abs(z)<r&&x>1&&x<1.05||h>2?null:0}};
 assert.equal(routeSegment(world,{x:.9,y:0,z:0},{x:1.15,y:0,z:0},body),null);
 assert.deepEqual(gardenRoute(world,{x:.9,y:0,z:0},{x:1.02,y:0,z:0},body),[]);
 assert.deepEqual(gardenRoute(world,{x:1.15,y:0,z:0},{x:1.02,y:0,z:0},body),[]);
 assert.deepEqual(gardenRoute(world,{x:0,y:0,z:0},{x:2,y:0,z:0},{radius:.4,height:3}),[]);
});
function actor(id,x,z=0){return{id,identity:id,envelope:body,position:{x,y:0,z}};}
test('failed routes hold with bounded three attempts, release destination and never report arrival even in reduced motion',()=>{
 let calls=0;const world={navigation:{groundAt:()=>{calls++;return null;}}},places=createPlaceRegistry(world),travel=createActorTravel(world,places);
 places.define({id:'tea',kind:'leisure',position:{x:3,y:0,z:0}});
 const a=actor('one',0);travel.request(a,'tea');
 assert.equal(a.travel.status,'waiting');assert.equal(a.travel.attempts,1);
 for(let i=0;i<79;i++)travel.update([a],.1,false);const first=calls;
 travel.update([a],.1,false);assert.ok(calls>first);
 for(let i=0;i<250;i++)travel.update([a],.1,false);
 assert.equal(a.travel.attempts,3);assert.equal(places.get('tea').owner,null);const last=calls;
 for(let i=0;i<300;i++)travel.update([a],.1,true);
 assert.equal(calls,last);assert.deepEqual(a.position,{x:0,y:0,z:0});assert.equal(a.travel.status,'unavailable');
});
test('exhausted travel retains home and ignores repeated requests and unrelated leases until relevant navigation changes',()=>{
 let blocked=false;const world={navigation:{revision:0,groundAt:()=>blocked?null:0}},places=createPlaceRegistry(world),travel=createActorTravel(world,places,{speed:2});
 const a=actor('one',0);places.define({id:'home',kind:'work',position:{x:3,y:0,z:0}});places.reserve('home',a.identity,body);places.occupy('home',a.identity);a.homePlace='home';blocked=true;
 travel.request(a,'home');for(let i=0;i<400;i++)travel.update([a],.1);
 assert.equal(a.travel.status,'unavailable');assert.equal(a.travel.attempts,3);assert.equal(places.get('home').owner,a.identity);assert.equal(places.get('home').departing,false);
 places.define({id:'unrelated',kind:'leisure',position:{x:20,y:0,z:0}});
 for(let i=0;i<50;i++){travel.request(a,'home');travel.update([a],.1);}
 assert.equal(a.travel.attempts,3);assert.equal(a.travel.status,'unavailable');assert.equal(a.position.x,0);
 blocked=false;world.navigation.revision++;
 for(let i=0;i<50;i++)travel.update([a],.1);
 assert.equal(a.travel.status,'arrived');assert.equal(a.travel.attempts,1);assert.equal(places.get('home').owner,a.identity);
});
for(const reverse of [false,true])test(`two nearby moving actors yield without overlap and both arrive (reverse=${reverse})`,()=>{
 const places=createPlaceRegistry(flat),travel=createActorTravel(flat,places,{speed:2});
 const a=actor('a',-3,0),b=actor('b',0,-3);
 places.define({id:'left',kind:'leisure',position:{x:0,y:0,z:3}});places.define({id:'right',kind:'leisure',position:{x:3,y:0,z:0}});
 travel.request(a,'right');travel.request(b,'left');let yielded=false;
 for(let i=0;i<200;i++){travel.update(reverse?[b,a]:[a,b],.1,false);yielded ||= [a,b].some(a=>a.travel?.status==='yielding');assert.ok(Math.hypot(a.position.x-b.position.x,a.position.z-b.position.z)>=body.radius*2-.001);}
 assert.equal(a.travel.status,'arrived');assert.equal(b.travel.status,'arrived');
 assert.equal(yielded,true);
});
for(const end of ['cancel','dispose'])test(`a retained waiter resumes when the winner ${end}s`,()=>{
 const places=createPlaceRegistry(flat),travel=createActorTravel(flat,places,{speed:2});
 const a=actor('a',-3,0),b=actor('b',0,-3);
 places.define({id:'left',kind:'leisure',position:{x:0,y:0,z:3}});places.define({id:'right',kind:'leisure',position:{x:3,y:0,z:0}});
 travel.request(a,'right');travel.request(b,'left');
 for(let i=0;i<13;i++)travel.update([a,b],.1);
 assert.equal(b.travel.status,'yielding');assert.equal(b.travel.yieldTo,a.identity);
 if(end==='cancel')travel.cancel(a);else places.disposeActor(a.identity);
 // A cancelled actor leaves the conflict; disposal removes it entirely.
 if(end==='cancel')a.position={x:-10,y:0,z:-10};
 for(let i=0;i<200;i++)travel.update(end==='cancel'?[a,b]:[b],.1);
 assert.equal(b.travel.status,'arrived');assert.equal(b.travel.yieldTo,undefined);
});
test('a blocked narrow corridor holds actors apart without pretending either arrived',()=>{
 const world={navigation:{groundAt:(x,z,y,r)=>Math.abs(z)+r>.5?null:0}};
 const places=createPlaceRegistry(world),travel=createActorTravel(world,places,{speed:2});
 const a=actor('a',-3),b=actor('b',3);
 places.define({id:'left',kind:'leisure',position:{x:-3,y:0,z:0}});places.define({id:'right',kind:'leisure',position:{x:3,y:0,z:0}});
 travel.request(a,'right');travel.request(b,'left');let yielded=false;
 for(let i=0;i<200;i++){
  travel.update([b,a],.1);yielded ||= [a,b].some(a=>a.travel.status==='yielding');
  assert.ok(Math.hypot(a.position.x-b.position.x,a.position.z-b.position.z)>=body.radius*2-.001);
 }
 assert.equal(yielded,true);assert.equal(a.travel.status,'unavailable');assert.equal(b.travel.status,'unavailable');
 assert.equal(a.travel.attempts,3);assert.equal(b.travel.attempts,3);assert.equal(places.get('left').owner,null);assert.equal(places.get('right').owner,null);
});

test('36 reduced motion cannot report arrival through an interior solid or overhead beam',async()=>{
 const T=await import('three'),{createSurfaceNavigation}=await import('./navigation.mjs');
 for(const [height,y] of [[4,2.25],[.15,1.1]]){
  const mesh=new T.Mesh(new T.BoxGeometry(.31,height,.31));mesh.position.set(.55,y,.55);
  const world={navigation:createSurfaceNavigation([mesh],{placement:.2,baseY:0,floorRadius:20})},places=createPlaceRegistry(world),travel=createActorTravel(world,places);
  places.define({id:'target',kind:'leisure',position:{x:.01,y:0,z:0}});
  const a={id:'qa',identity:'qa',envelope:{radius:1.23,height:2.28},position:{x:0,y:0,z:0}},at={...a.position};
  assert.ok(Math.hypot(.55-.155-.01,.55-.155)<a.envelope.radius,'independent solid AABB penetrates requested destination');
  travel.request(a,'target');travel.update([a],.1,true);
  assert.notEqual(a.travel.status,'arrived');assert.deepEqual(a.position,at);assert.equal(places.get('target').occupied,false);
  mesh.geometry.dispose();mesh.material.dispose();
 }
});
