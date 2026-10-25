import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import { RESIDENTS } from '../../shell/resident-inventory.mjs';
import { activeResidents, workDocks, OFFICE_PLOT, leisurePlaces } from './approved-plan.mjs';
import { routeLength, routeSeconds, createDailyRoutines } from './daily-routines.mjs';
import { createRoofPreference } from './roof-preference.mjs';

test('55-B/K: 22 unique team docks plus two staged executive homes match the continuing inventory',()=>{
 const roster=activeResidents(RESIDENTS),docks=workDocks(roster);
 assert.equal(roster.length,24);assert.equal(docks.length,24);
 assert.equal(docks.filter(d=>!d.staged).length,22);
 assert.equal(new Set(docks.map(d=>d.slotId)).size,24);
 assert.deepEqual(RESIDENTS,roster,'Team and the active cast share the complete continuing inventory');
 assert.deepEqual(OFFICE_PLOT,{x:0,z:-32,width:26,depth:17});
 for(const d of docks){assert.equal(d.slotId,'work:'+d.id);assert.ok(d.approach.length>=1);}
 assert.equal(leisurePlaces().length,20);
});

function fixture({blocked=false,random=()=>0}={}){
 const actors=new Map();
 for(let i=0;i<4;i++){
  const model=new T.Group();model.position.set(i*7,.36,0);
  actors.set('a'+i,{id:'a'+i,index:i,teamId:'pass',home:model.position.clone(),baseYaw:Math.PI,identity:'a'+i,envelope:{radius:.6,height:2},panda:{model},state:'idle',live:null});
 }
 const spot={id:'leisure:tea:0',kind:'tea',group:'tea',position:new T.Vector3(0,.36,9),face:new T.Vector3(0,.36,6)};
 const den={routineSpots:[spot],walkWorld:{navigation:{groundAt:()=>blocked?null:.36},obstacles:[]},routineRoute:(_a,from,to)=>blocked?[]:[{...to}],routineClear:()=>!blocked};
 return {actors,den,routines:createDailyRoutines(den,actors,{random})};
}
const tick=(f,seconds,reduced=false)=>{for(let t=0;t<Math.round(seconds*10);t++)f.routines.update(.1,reduced,null);};

test('55-M: reduced motion safely returns active outings and schedules no new departures or catch-up',()=>{
 const f=fixture();try{
  tick(f,3);const a=[...f.actors.values()].find(a=>a.outing);assert.ok(a);
  assert.ok(a.panda.model.position.distanceTo(a.home)>.1);
  tick(f,.1,true);assert.deepEqual(a.panda.model.position,a.home);assert.equal(a.outing,null);
  const clock=f.routines.time,positions=[...f.actors.values()].map(a=>a.panda.model.position.toArray());
  tick(f,300,true);assert.equal(f.routines.time,clock);
  assert.deepEqual([...f.actors.values()].map(a=>a.panda.model.position.toArray()),positions);
  assert.ok([...f.actors.values()].every(a=>!a.outing&&a.moved===0));
  tick(f,.1);assert.equal(f.routines.time,clock+.1);
 }finally{f.routines.dispose();}
});

test('55-M: an obstructed reduced-motion return retains the last safe position and truthful return ownership',()=>{
 const f=fixture();try{
  tick(f,3);const a=[...f.actors.values()].find(a=>a.outing),at=a.panda.model.position.clone();
  f.den.routineClear=()=>false;
  tick(f,.1,true);assert.deepEqual(a.panda.model.position,at);assert.equal(a.outing.stage,'return');
  tick(f,10,true);assert.deepEqual(a.panda.model.position,at);
  assert.equal(a.moved,0);assert.deepEqual([...f.actors.values()].filter(b=>b.outing).map(b=>b.id),[a.id]);
  f.den.routineClear=()=>true;tick(f,.1,true);assert.deepEqual(a.panda.model.position,a.home);assert.equal(a.outing,null);
 }finally{f.routines.dispose();}
});

test('55-C/F: reserve before departure, one local destination, 3.6 units/sec, settled 45s then owned home',()=>{
 const f=fixture();tick(f,2.1);const a=[...f.actors.values()].find(a=>a.outing);assert.ok(a);
 assert.ok(a.outing.spot);assert.equal(f.routines.reservations.get(a.outing.spot.id),a.id);
 const at=a.panda.model.position.clone();tick(f,1);assert.ok(Math.abs(at.distanceTo(a.panda.model.position)-3.6)<.05);
 tick(f,3);assert.equal(a.outing.stage,'visit');assert.equal(a.moved,0);
 assert.equal(a.outing.duration,45);
 for(let i=0;i<460&&a.outing?.stage==='visit';i++)tick(f,.1);assert.equal(a.outing.stage,'return');
 for(let i=0;i<200&&a.outing;i++)tick(f,.1);assert.equal(a.outing,null);assert.deepEqual(a.panda.model.position,a.home);
 assert.ok(Math.abs(a.nextOuting-f.routines.time-120)<1e-9);f.routines.dispose();assert.equal(f.routines.reservations.size,0);
});

test('55-C/F/M: unavailable or over-60-unit destination leaves resident at home',()=>{
 const f=fixture({blocked:true});tick(f,30);assert.ok([...f.actors.values()].every(a=>!a.outing));f.routines.dispose();
 const g=fixture();g.den.routineSpots[0].position.z=100;tick(g,30);assert.ok([...g.actors.values()].every(a=>!a.outing));g.routines.dispose();
});

test('55-G: work preempts a settled activity immediately and returns without teleporting',()=>{
 const f=fixture();tick(f,6);const a=[...f.actors.values()].find(a=>a.outing);assert.ok(a);a.live={state:'working'};
 const slot=a.outing.spot.id,at=a.panda.model.position.clone();tick(f,.1);assert.equal(a.outing.stage,'return');assert.ok(at.distanceTo(a.panda.model.position)<=.481);assert.notEqual(f.routines.reservations.get(slot),a.id);
 tick(f,8);assert.equal(a.outing,null);assert.deepEqual(a.panda.model.position,a.home);tick(f,300);assert.equal(a.outing,null);f.routines.dispose();
});

test('55-M: hidden presentation freezes scheduling; reduced motion commits only revalidated routes',()=>{
 const f=fixture();f.routines.setHidden(true);tick(f,100);assert.equal(f.routines.time,0);assert.ok([...f.actors.values()].every(a=>!a.outing));
 f.routines.setHidden(false);tick(f,3,true);assert.ok([...f.actors.values()].every(a=>a.moved===0));f.routines.dispose();
});

test('55-J: full roofs first, safe local persistence and storage failure fallback',()=>{
 const values=new Map(),store={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 const roof=createRoofPreference(store);assert.equal(roof.mode,'full');roof.set('cutaway');assert.equal(createRoofPreference(store).mode,'cutaway');
 values.clear();values.set('den.roof-mode','bogus');assert.equal(createRoofPreference(store).mode,'full');
 const broken=createRoofPreference({getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}});assert.equal(broken.mode,'full');broken.set('cutaway');assert.equal(broken.mode,'cutaway');
});

test('55-D: friend host and guest face each other, and host work cancels the owned visit',()=>{
 const f=fixture(),host=f.actors.get('a1'),guest=f.actors.get('a0');host.teamId='pantry';f.den.routineSpots=[];
 f.den.friendPlace=(a,h)=>a===guest&&h===host?{id:'visitor:'+host.id+':0',position:new T.Vector3(3,.36,0),face:host.home.clone()}:null;
 tick(f,5);assert.equal(guest.outing.stage,'visit');assert.equal(host.hosting,guest.id);assert.ok(Math.abs(guest.yaw-Math.PI/2)<.001);assert.ok(Math.abs(host.yaw+Math.PI/2)<.001);
 host.live={state:'working'};tick(f,.1);assert.equal(guest.outing.stage,'return');assert.equal(host.hosting,null);f.routines.dispose();
});

test('55-E: mahjong starts with two owned places, and losing a partner sends both home',()=>{
 const f=fixture();for(const a of f.actors.values())a.teamId='pantry';
 f.den.routineSpots=Array.from({length:4},(_,i)=>({id:'games:'+i,kind:'games',group:'games:0',position:new T.Vector3(i*3,.89,9),face:new T.Vector3(4,.89,9)}));
 tick(f,2.1);const players=[...f.actors.values()].filter(a=>a.outing);assert.equal(players.length,2);assert.equal(new Set(players.map(a=>a.outing.group)).size,1);assert.equal(f.routines.reservations.size,2);
 players[0].live={state:'working'};tick(f,.1);assert.ok(players.every(a=>!a.outing||a.outing.stage==='return'));assert.equal(f.routines.reservations.size,0);f.routines.dispose();
});

test('55-F/G: obstruction yields, replans once, and blocked return holds the last safe position',()=>{
 const f=fixture();tick(f,3);const a=[...f.actors.values()].find(a=>a.outing),at=a.panda.model.position.clone();for(const b of f.actors.values())if(b!==a)b.stationary=true;let plans=0;
 f.den.routineClear=()=>false;f.den.routineRoute=()=>{plans++;return [];};a.live={state:'working'};tick(f,20);
 assert.equal(a.outing.stage,'return');assert.deepEqual(a.panda.model.position,at);assert.equal(a.moved,0);assert.ok(plans<=2);f.routines.dispose();
});

test('55 pace: live work return covers 4.8 units in one second without teleporting',()=>{
 const f=fixture();tick(f,5);const a=f.actors.get('a0');assert.equal(a.outing.stage,'visit');
 a.live={state:'working'};const at=a.panda.model.position.clone();tick(f,1);
 assert.ok(Math.abs(at.distanceTo(a.panda.model.position)-4.8)<.001);assert.equal(a.outing.stage,'return');f.routines.dispose();
});

test('55 pace: planner uses 3.6 units/sec and still charges turning time',()=>{
 const f=fixture(),a=f.actors.get('a0');a.baseYaw=0;
 assert.equal(routeSeconds(a,[{x:0,z:36}]),10);
 assert.ok(Math.abs(routeSeconds(a,[{x:0,z:36,yaw:Math.PI}])-(10+Math.PI/3.5))<1e-9);f.routines.dispose();
});

test('55 pace: both game partners keep the independent 20-second cap even below 60 units',()=>{
 const f=fixture();f.den.garden={approved:true};for(const a of f.actors.values()){a.teamId='pantry';a.baseYaw=0;}for(const id of ['a2','a3'])f.actors.get(id).stationary=true;
 const spots=[0,1].map(i=>({id:'games:'+i,kind:'games',group:'games',position:new T.Vector3(i*7,.36,50),face:new T.Vector3(i*7,.36,55)}));f.den.routineSpots=spots;
 f.den.routineRoute=(a,_from,to)=>a.id==='a0'?[{...to}]:Array.from({length:10},(_,i)=>({x:7,y:.36,z:(i+1)*5,yaw:i%2?0:Math.PI}));
 const a=f.actors.get('a0'),b=f.actors.get('a1');assert.ok(routeSeconds(a,f.den.routineRoute(a,a.home,spots[0].position))<20);
 const partnerPath=f.den.routineRoute(b,b.home,spots[1].position);assert.equal(routeLength(b.home,partnerPath),50);
 assert.ok(routeSeconds(b,partnerPath)>20);tick(f,2.1);
 assert.ok([...f.actors.values()].every(a=>!a.outing));assert.equal(f.routines.reservations.size,0);f.routines.dispose();
});


test('55 pace: at most three outings and the 90-second activity and 240-second cooldown remain bounded',()=>{
 const f=fixture({random:()=>1});f.den.routineSpots=Array.from({length:4},(_,i)=>({id:'tea:'+i,kind:'tea',group:'tea',position:new T.Vector3(i*7,.36,9),face:new T.Vector3(i*7,.36,6)}));
 tick(f,15);const active=[...f.actors.values()].filter(a=>a.outing);assert.equal(active.length,3);assert.ok(active.every(a=>a.outing.stage==='visit'&&a.outing.duration===90));
 const a=active[0];for(let i=0;i<1000&&a.outing;i++)tick(f,.1);assert.equal(a.outing,null);assert.ok(Math.abs(a.nextOuting-f.routines.time-240)<1e-9);f.routines.dispose();
});
