import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import { RESIDENTS } from '../../shell/resident-inventory.mjs';
import { activeResidents, workDocks, OFFICE_PLOT, leisurePlaces } from './approved-plan.mjs';
import { createDailyRoutines } from './daily-routines.mjs';
import { createRoofPreference } from './roof-preference.mjs';

test('55-B/K: 22 unique team docks plus two staged executive homes; legacy authority remains in inventory',()=>{
 const roster=activeResidents(RESIDENTS),docks=workDocks(roster);
 assert.equal(roster.length,24);assert.equal(docks.length,24);
 assert.equal(docks.filter(d=>!d.staged).length,22);
 assert.equal(new Set(docks.map(d=>d.slotId)).size,24);
 assert.ok(RESIDENTS.length>roster.length);
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

test('55-C/F: reserve before departure, one local destination, 3 units/sec, settled 45s then owned home',()=>{
 const f=fixture();tick(f,2.1);const a=[...f.actors.values()].find(a=>a.outing);assert.ok(a);
 assert.ok(a.outing.spot);assert.equal(f.routines.reservations.get(a.outing.spot.id),a.id);
 const at=a.panda.model.position.clone();tick(f,1);assert.ok(Math.abs(at.distanceTo(a.panda.model.position)-3)<.05);
 tick(f,3);assert.equal(a.outing.stage,'visit');assert.equal(a.moved,0);
 tick(f,46);assert.ok(!a.outing||a.outing.stage==='return');tick(f,20);assert.equal(a.outing,null);assert.deepEqual(a.panda.model.position,a.home);
 assert.ok(a.nextOuting>=f.routines.time+100);f.routines.dispose();assert.equal(f.routines.reservations.size,0);
});

test('55-C/F/M: unavailable or over-60-unit destination leaves resident at home',()=>{
 const f=fixture({blocked:true});tick(f,30);assert.ok([...f.actors.values()].every(a=>!a.outing));f.routines.dispose();
 const g=fixture();g.den.routineSpots[0].position.z=100;tick(g,30);assert.ok([...g.actors.values()].every(a=>!a.outing));g.routines.dispose();
});

test('55-G: work preempts a settled activity immediately and returns without teleporting',()=>{
 const f=fixture();tick(f,6);const a=[...f.actors.values()].find(a=>a.outing);assert.ok(a);a.live={state:'working'};
 const slot=a.outing.spot.id,at=a.panda.model.position.clone();tick(f,.1);assert.equal(a.outing.stage,'return');assert.ok(at.distanceTo(a.panda.model.position)<=.401);assert.notEqual(f.routines.reservations.get(slot),a.id);
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
