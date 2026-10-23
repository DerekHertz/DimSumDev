import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createMeetingResidents} from './meeting-residents.mjs';
import {createPlaceRegistry} from './places.mjs';
function fixture(busy=false){
 const model=new T.Group(),rig={poseIdle(){},poseWaddle(){},poseSit(){}};model.position.set(-10,.36,-10);
 const a={id:'qa',identity:'resident:qa',role:'qa',runtime:'claude',home:model.position.clone(),baseYaw:0,envelope:{radius:.6,height:2},panda:{model,rig},live:busy?{ref:'other-run',state:'working'}:null};
 const actors=new Map([['qa',a]]),den={residents:new T.Group(),walkWorld:{navigation:{groundAt:(_x,_z,y)=>y},nodes:[{x:-6,y:.36,z:-10}]},routineRoute:(_a,_from,to)=>[{...to}],routineClear:()=>true,createPanda(){return {model:new T.Group(),rig:{...rig}};},destroyPanda(model){model.removeFromParent();}};
 const places=createPlaceRegistry(den.walkWorld,{getBodies:()=>[...actors.values(),...(den.guestActors?.values()||[])].map(a=>({owner:a.identity,position:a.panda.model.position,envelope:a.envelope}))});
 places.define({id:'work:qa',kind:'work',position:a.home});places.reserve('work:qa',a.identity,a.envelope);places.occupy('work:qa',a.identity);a.homePlace='work:qa';
 const meeting=createMeetingResidents(den,actors,places,{transfer(){}}),m={id:'m1',ref:'meeting-run',state:'running',seats:[{role:'qa'}]};
 return {a,den,places,meeting,m};
}
const tick=(f,s)=>{for(let i=0;i<s*10;i++)f.meeting.update(.1,false);};
test('55-H: idle resident travels to its meeting seat while home remains reserved; paused and briefed preserve it',()=>{
 const f=fixture();f.meeting.apply(f.m);assert.equal(f.a.meetingOwned,true);assert.equal(f.places.get('work:qa').owner,f.a.identity);tick(f,10);
 assert.equal(f.meeting.seatModels().get('qa'),f.a.panda.model);const at=f.a.panda.model.position.clone();f.meeting.apply({...f.m,state:'paused'});tick(f,1);assert.deepEqual(f.a.panda.model.position,at);f.meeting.apply({...f.m,state:'briefed'});assert.equal(f.a.meetingOwned,true);
 f.meeting.apply({...f.m,state:'closed'});tick(f,10);assert.equal(f.a.meetingTrip,null);assert.ok(f.a.panda.model.position.distanceTo(f.a.home)<.001);f.meeting.dispose();f.places.dispose();
});
test('55-H/M: busy specialist keeps working at home while a separately owned guest attends and cleans up',()=>{
 const f=fixture(true),home=f.a.home.clone();f.meeting.apply(f.m);assert.equal(f.den.guestActors.size,1);assert.equal(f.a.meetingOwned,undefined);assert.equal(f.a.live.ref,'other-run');tick(f,10);
 const guest=f.meeting.seatModels().get('qa');assert.ok(guest);assert.notEqual(guest,f.a.panda.model);assert.deepEqual(f.a.panda.model.position,home);
 f.meeting.apply({...f.m,state:'closed'});tick(f,10);assert.equal(f.den.guestActors.size,0);assert.equal([...f.places.values()].filter(p=>p.owner&&p.kind!=='work').length,0);f.meeting.dispose();f.places.dispose();
});

test('55 pace: physical meeting travel covers 3.6 units per second and live return 4.8',()=>{
 const f=fixture();f.meeting.apply(f.m);const start=f.a.panda.model.position.clone();tick(f,1);
 assert.ok(Math.abs(start.distanceTo(f.a.panda.model.position)-3.6)<.001);
 tick(f,10);f.meeting.apply({...f.m,state:'closed'});f.a.live={ref:'new-work'};
 const seated=f.a.panda.model.position.clone();tick(f,1);assert.ok(Math.abs(seated.distanceTo(f.a.panda.model.position)-4.8)<.001);
 f.meeting.dispose();f.places.dispose();
});
