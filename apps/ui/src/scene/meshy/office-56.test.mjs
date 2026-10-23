import test from 'node:test';
import assert from 'node:assert/strict';
import {approvedFixture} from './approved.test-fixture.mjs';

test('56-B: the usable native office replaces staging with two reserved executive desks',()=>{
 const f=approvedFixture();try{
  const g=f.den.garden;
  assert.ok(g.assets.office,'native office installed before homes move');
  assert.equal(f.actors.actors.size,24);
  for(const [id,slot,position]of [['orchestrator','work:bao',[-6.4,.36,-36.9]],['codex:orchestrator','work:jiao',[6.4,.36,-36.75]]]){
   const a=f.actors.actors.get(id);
   assert.deepEqual(a.home.toArray(),position);assert.equal(a.homePlace,slot);
   assert.ok(a.panda.model.visible);assert.equal(a.panda.model.scale.x,1.35);
   assert.equal(f.actors.places.get(slot).owner,a.identity);
   assert.ok(f.den.walkWorld.fits(a.home,a.envelope,a.baseYaw));
  }
  f.tick(10);assert.ok([...f.actors.actors.values()].filter(a=>a.role==='orchestrator').every(a=>!a.outing));
 }finally{f.dispose();}
});

test('56-B/M: roof changes preserve office ownership and missing executive models retain truthful text actions',()=>{
 const f=approvedFixture({missing:['bao','jiao']});try{
  const executives=['orchestrator','codex:orchestrator'].map(id=>f.actors.actors.get(id));
  const leases=executives.map(a=>f.actors.places.get(a.homePlace));
  const g=f.den.garden;
  g.setRoofMode('cutaway');
  assert.ok(g.assets.office.roof.children.some(n=>n.material?.clippingPlanes?.length));
  f.actors.applyLive(executives.map(a=>({role:a.role,runtime:a.runtime,ref:'work/56-error',agentId:a.id,state:'working'})));
  f.tick(1,true);g.setRoofMode('full');
  executives.forEach((a,i)=>{
   assert.ok(a.panda.model.userData.modelUnavailable);assert.ok(a.stationary);
   assert.match(a.presentation,/Model unavailable/);assert.equal(a.live.ref,'work/56-error');
   assert.equal(f.actors.places.get(a.homePlace),leases[i]);assert.equal(leases[i].owner,a.identity);
   assert.deepEqual(a.panda.model.position,a.home);assert.equal(a.outing,null);
  });
  f.actors.dispose();assert.equal(f.actors.places.values().next().done,true);assert.equal(f.den.guestActors.size,0);
 }finally{f.dispose();}
});

test('56-C/M: both office visitors settle independently, preserve executive through travel and clean up on real work',()=>{
 const f=approvedFixture();try{
  const bao=f.actors.actors.get('orchestrator'),jiao=f.actors.actors.get('codex:orchestrator');
  const guests=['product','architect'].map(id=>f.actors.actors.get(id));
  for(const a of f.actors.actors.values())if(!guests.includes(a))a.stationary=true;
  f.den.routineSpots=[];const friend=f.den.friendPlace;
  f.den.friendPlace=(a,h)=>(a===guests[0]&&h===bao||a===guests[1]&&h===jiao)?friend(a,h):null;
  f.tick(45);
  for(const [i,a]of guests.entries()){
   assert.equal(a.outing?.stage,'visit',a.name+' settled');
   assert.equal(a.outing.spot.id,i?'visitor:jiao:0':'visitor:bao:0');
   assert.ok(f.den.walkWorld.supported(a,a.panda.model.position,a.yaw));
   const extra=f.actors.places.define({id:'extra:'+i,kind:'visitor',position:a.panda.model.position});
   assert.equal(f.actors.places.reserve(extra.id,'extra',a.envelope),null,'full place refuses another body');
  }
  for(const a of [bao,jiao]){
   const to={x:0,y:.46,z:-11},path=f.den.routineRoute(a,a.home,to);
   assert.ok(path.length,a.name+' has a swept through-lane with both visitors occupied');
   assert.ok(f.den.routineRoute(a,to,a.home).length,a.name+' can return with both visitors occupied');
  }
  const snapshots=guests.map(a=>a.panda.model.position.clone());f.actors.setHidden(true);f.tick(5);
  guests.forEach((a,i)=>assert.deepEqual(a.panda.model.position,snapshots[i]));
  f.actors.applyLive(guests.map(a=>({role:a.role,runtime:a.runtime,ref:'work/56',agentId:a.id,state:'working'})));
  assert.ok(guests.every(a=>a.live?.ref==='work/56'),'execution ownership is immediate while hidden');
  f.actors.setHidden(false);f.tick(30,true);
  for(const a of guests){assert.equal(a.outing,null);assert.deepEqual(a.panda.model.position,a.home);assert.equal(a.moved,0);}
  assert.equal(bao.hosting,null);assert.equal(jiao.hosting,null);
  assert.ok(['visitor:bao:0','visitor:jiao:0'].every(id=>!f.actors.places.get(id).owner));
 }finally{f.dispose();}
});

test('56-D: executive desk routes reach the existing meeting system and return to the same reserved desk',()=>{
 const f=approvedFixture();try{
  for(const a of f.actors.actors.values())if(a.role!=='orchestrator')a.stationary=true;
  const bao=f.actors.actors.get('orchestrator'),jiao=f.actors.actors.get('codex:orchestrator');
  const destination={x:0,y:.46,z:-11};
  for(const a of [bao,jiao]){
   const path=f.den.routineRoute(a,a.home,destination);assert.ok(path.length,a.name+' desk-to-meeting route');
   const back=f.den.routineRoute(a,destination,a.home);assert.ok(back.length,a.name+' meeting-to-desk route');
  }
  const meeting={id:'office56',ref:'meeting/56',state:'running',seats:[{role:'product'}]};
  f.actors.applyMeeting(meeting);assert.equal(bao.meetingOwned,true);
  assert.equal(f.actors.places.get('work:bao').owner,bao.identity,'away desk stays owned');
  f.tick(25);assert.equal(bao.meetingTrip?.stage,'seated');
  f.actors.applyMeeting({...meeting,state:'paused'});f.tick(1);assert.equal(bao.meetingTrip.stage,'seated');
  f.actors.applyMeeting({...meeting,state:'briefed'});f.tick(1);assert.equal(bao.meetingTrip.stage,'seated');
  f.actors.applyMeeting({...meeting,state:'closed'});f.tick(25);
  assert.equal(bao.meetingTrip,null);assert.deepEqual(bao.panda.model.position,bao.home);
  assert.deepEqual(jiao.panda.model.position,jiao.home);
 }finally{f.dispose();}
});

test('56-C: all eleven actual specialist bodies can independently visit either executive with supported approaches',()=>{
 const f=approvedFixture();try{
  const hosts=['orchestrator','codex:orchestrator'].map(id=>f.actors.actors.get(id));
  const species=[...f.actors.actors.values()].filter(a=>a.runtime==='claude'&&a.role!=='orchestrator');
  assert.equal(species.length,11);
  for(const guest of species)for(const [i,host]of hosts.entries()){
   const spot=f.den.friendPlace(guest,host);
   assert.ok(spot,guest.role+' at '+host.name);
   assert.equal(spot.id,i?'visitor:jiao:0':'visitor:bao:0');
   assert.equal(spot.position.x,i?6.4:-6.4);assert.equal(spot.position.z,-27.5);
   assert.ok(spot.approachPath?.length,'supported visitor mount');
   assert.equal(spot.approachPath[0].x,0,'enter along the central aisle');
   assert.ok(spot.approachReservation.x*(i?1:-1)>0,'independent approach beside its own visitor place');
   assert.ok(f.den.walkWorld.supported(guest,spot.position,Math.PI));
   assert.ok(f.den.routineRoute(guest,guest.home,spot.position).length,'reachable '+guest.role+'/'+host.name);
  }
 }finally{f.dispose();}
});
