import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createMeetingResidents} from './meeting-residents.mjs';
import {createPlaceRegistry} from './places.mjs';
import {createFrameWork} from './frame-work.mjs';
import {CHAIR_SPOT} from './meeting-table.mjs';
function fixture(busy=false,work=null){
 const model=new T.Group(),rig={poseIdle(){},poseWaddle(){},poseSit(){}};model.position.set(-10,.36,-10);
 const a={id:'qa',identity:'resident:qa',role:'qa',runtime:'claude',home:model.position.clone(),baseYaw:0,envelope:{radius:.6,height:2},panda:{model,rig},live:busy?{ref:'other-run',state:'working'}:null};
 const actors=new Map([['qa',a]]),den={residents:new T.Group(),walkWorld:{navigation:{groundAt:(_x,_z,y)=>y},nodes:[{x:-6,y:.36,z:-10}]},routineRoute:(_a,_from,to)=>[{...to}],routineClear:()=>true,createPanda(){return {model:new T.Group(),rig:{...rig}};},destroyPanda(model){model.removeFromParent();}};
 const places=createPlaceRegistry(den.walkWorld,{getBodies:()=>[...actors.values(),...(den.guestActors?.values()||[])].map(a=>({owner:a.identity,position:a.panda.model.position,envelope:a.envelope}))});
 places.define({id:'work:qa',kind:'work',position:a.home});places.reserve('work:qa',a.identity,a.envelope);places.occupy('work:qa',a.identity);a.homePlace='work:qa';
 if(work)den.routineRouteSteps=function*(...args){yield;yield;return den.routineRoute(...args);};
 const meeting=createMeetingResidents(den,actors,places,{transfer(){}},work),m={id:'m1',ref:'meeting-run',state:'running',seats:[{role:'qa'}]};
 return {a,actors,den,places,meeting,m};
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

test('meeting waits truthfully on an empty blocked replan and retries after a neighbor moves, retaining final yaw and owned places',()=>{
 const f=fixture(),neighbor={panda:{model:new T.Group()},envelope:{radius:.6,height:2}};
 f.actors.set('neighbor',neighbor);
 let blocked=false,calls=0;
 const route=f.den.routineRoute;
 f.den.routineRoute=(...args)=>{calls++;return blocked?[]:route(...args);};
 f.den.routineClear=()=>!blocked;
 f.meeting.apply(f.m);blocked=true;tick(f,5);
 assert.equal(f.a.meetingTrip.blocked,true);assert.equal(f.a.meetingTrip.stage,'outbound');
 assert.equal(f.meeting.seatModels().size,0);
 assert.equal(f.places.get(f.a.meetingPlace).owner,f.a.identity);
 const attempts=calls,waiting=f.a.panda.model.position.clone();tick(f,5);
 assert.equal(calls,attempts,'an unchanged blocked scene does not repeatedly search routes');
 assert.deepEqual(f.a.panda.model.position,waiting,'waiting never moves through the neighbor');
 blocked=false;neighbor.panda.model.position.x+=2;tick(f,2.1);
 assert.equal(f.a.meetingTrip.path.at(-1).yaw,f.a.meetingTrip.spot.yaw,'replanned destination retains its required final yaw');
 tick(f,15);
 assert.equal(f.a.meetingTrip.stage,'seated');assert.equal(f.a.yaw,f.a.meetingTrip.spot.yaw);
 f.meeting.apply({...f.m,state:'closed'});tick(f,20);assert.equal(f.a.meetingTrip,null);
 f.meeting.dispose();f.places.dispose();
});


test('cancelling a meeting during budgeted planning releases its seat and cannot complete later',()=>{
 let clock=0;const work=createFrameWork({now:()=>++clock,budgetMs:2}),f=fixture(false,work);
 f.meeting.apply(f.m);work.update();
 assert.equal(f.a.meetingTrip.planning,true);assert.ok(f.a.meetingPlace);
 f.meeting.apply({...f.m,state:'closed'});
 for(let i=0;i<30;i++){work.update();f.meeting.update(1/60);}
 assert.equal(f.a.meetingTrip,null);assert.equal(f.a.meetingOwned,false);
 assert.equal([...f.places.values()].filter(p=>p.owner&&p.kind!=='work').length,0);
 assert.deepEqual(f.a.panda.model.position,f.a.home);
 f.meeting.dispose();work.dispose();f.places.dispose();
});

test('closing a meeting removes a guest whose route is still being planned',()=>{
 let clock=0;const work=createFrameWork({now:()=>++clock,budgetMs:2}),f=fixture(true,work);
 f.meeting.apply(f.m);work.update();assert.equal(f.den.guestActors.size,1);
 f.meeting.apply({...f.m,state:'closed'});for(let i=0;i<30;i++)work.update();
 assert.equal(f.den.guestActors.size,0);
 assert.equal([...f.places.values()].filter(p=>p.owner&&p.kind!=='work').length,0);
 assert.equal(f.a.live.ref,'other-run');f.meeting.dispose();work.dispose();f.places.dispose();
});

test('permanent chair arrivals and dismounted returns use budgeted planning',()=>{
 let clock=0;const work=createFrameWork({now:()=>++clock,budgetMs:2}),f=fixture(false,work);
 let routes=0;const route=f.den.routineRoute;
 f.den.routineRoute=(...args)=>{routes++;return route(...args);};
 f.den.walkWorld.meetingApproach=(_a,spot)=>[{...spot}];
 f.meeting.apply(f.m);work.update();
 assert.equal(routes,0,'chair route yields before doing route work');
 assert.equal(f.a.meetingTrip.planning,true);
 for(let i=0;i<30;i++){work.update();f.meeting.update(1,true);}
 assert.equal(f.a.meetingTrip.stage,'seated');
 f.meeting.apply({...f.m,state:'closed'});
 const trip=f.a.meetingTrip;trip.dismounted=true;
 for(let i=0;i<30;i++){work.update();f.meeting.update(1,true);}
 assert.equal(f.a.meetingTrip,null);assert.deepEqual(f.a.panda.model.position,f.a.home);
 assert.ok(routes>=2);f.meeting.dispose();work.dispose();f.places.dispose();
});

test('Jiao moderates from the permanent chair with Codex participants',()=>{
 const f=fixture();f.a.runtime='codex';
 const model=new T.Group();model.position.set(10,.36,-10);
 const moderator={...f.a,id:'codex:orchestrator',identity:'resident:jiao',role:'orchestrator',panda:{...f.a.panda,model},home:model.position.clone(),homePlace:'work:jiao'};
 f.actors.set(moderator.id,moderator);
 f.meeting.apply({...f.m,moderator:'jiao'});tick(f,20);
 assert.equal(f.meeting.seatModels().get('orchestrator'),model);
 assert.equal(moderator.meetingTrip.spot.x,CHAIR_SPOT.x);
 assert.equal(moderator.meetingTrip.spot.z,CHAIR_SPOT.z);
 assert.equal(f.meeting.seatModels().get('qa'),f.a.panda.model);
 f.meeting.dispose();f.places.dispose();
});

test('a chair guest waits for a transiently blocked budgeted arrival instead of disappearing',()=>{
 let clock=0;const work=createFrameWork({now:()=>++clock,budgetMs:2}),f=fixture(true,work);
 let blocked=true;const route=f.den.routineRoute;
 f.den.walkWorld.meetingApproach=(_a,spot)=>[{...spot}];
 f.den.routineRoute=(...args)=>blocked?[]:route(...args);
 f.meeting.apply(f.m);for(let i=0;i<10;i++)work.update();
 assert.equal(f.den.guestActors.size,1);
 const guest=[...f.den.guestActors.values()][0];
 assert.equal(guest.meetingTrip.blocked,true);assert.equal(f.meeting.seatModels().size,0);
 assert.equal(f.places.get(guest.meetingPlace).owner,guest.identity);
 blocked=false;
 for(let i=0;i<80;i++){work.update();f.meeting.update(.1,true);}
 assert.equal(f.meeting.seatModels().get('qa'),guest.panda.model);
 assert.equal(f.a.live.ref,'other-run');f.meeting.dispose();work.dispose();f.places.dispose();
});
