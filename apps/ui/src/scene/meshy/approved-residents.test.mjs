import test from 'node:test';
import assert from 'node:assert/strict';
import {approvedFixture} from './approved.test-fixture.mjs';
import {routeLength} from './daily-routines.mjs';

test('55-C/E/F/G: assembled residents reach a supported activity, return to their owned desk and stop under live work',()=>{
 const f=approvedFixture();try{
  f.tick(24);const visitors=[...f.actors.actors.values()].filter(a=>a.outing?.stage==='visit');assert.ok(visitors.length);
  for(const a of visitors)assert.ok(f.den.walkWorld.supported(a,a.panda.model.position,a.yaw),a.id+' planted at activity');
  const a=visitors[0],home=a.home.clone();
  f.actors.applyLive([{role:a.role,runtime:a.runtime,ref:'test/55',agentId:'working-55',state:'working'}]);
  assert.equal(a.live.ref,'test/55');f.tick(.1);assert.equal(a.outing.stage,'return');
  assert.match(f.actors.presentationRows().find(row=>row.id===a.id).presentation,/Working · returning/);
  f.tick(30);assert.equal(a.outing,null,'real supported reverse route reaches home');assert.deepEqual(a.panda.model.position,home);
  f.tick(30);assert.equal(a.outing,null);assert.equal(a.moved,0);assert.ok(f.actors.places.get(a.homePlace).occupied);
 }finally{f.dispose();}
});

test('55-E: each actual species has supported approach/exit candidates at the approved leisure places',()=>{
 const f=approvedFixture();try{
  const failures=[];
  for(const a of [...f.actors.actors.values()].filter(a=>a.runtime==='claude'&&!a.stationary))for(const s of f.den.routineSpots){
   const path=f.den.walkWorld.approach(a,s);
   if(!path)failures.push(a.role+'/'+s.id);
   else{assert.ok(routeLength(path[0],path)<=4.1);assert.ok(f.den.walkWorld.approach(a,s,{reverse:true}));}
  }
  assert.deepEqual(failures,[]);
  for(const a of [...f.actors.actors.values()].filter(a=>a.runtime==='claude'&&!a.stationary)){
   for(const kind of ['tea','pond','rest','games']){
    const owned=[];
    for(const s of f.den.routineSpots.filter(s=>s.kind===kind)){
     const spot=f.den.walkWorld.place(a,s),id='fit:'+a.role+':'+s.id,owner=id;
     f.actors.places.define({id,kind:'leisure',position:spot.position});
     const yaw=Math.atan2(spot.face.x-spot.position.x,spot.face.z-spot.position.z);
     assert.ok(f.actors.places.reserve(id,owner,{...a.envelope,yaw}),a.role+' with occupied neighbors at '+s.id);owned.push([id,owner]);
    }
    for(const [id,owner]of owned)f.actors.places.release(id,owner);
   }
  }
 }finally{f.dispose();}
});

test('55-H/M: actual snapshots keep six busy workers independent of meeting guests and clean up only at real end',()=>{
 const f=approvedFixture();try{
  const roles=['product','architect','developer','code-reviewer','qa','security'];
  f.actors.applyLive(roles.map(role=>({role,runtime:'claude',ref:'work/'+role,agentId:role,state:'working'})));
  const homes=new Map(roles.map(role=>[role,f.actors.actors.get(role).home.clone()]));
  const meeting={id:'actual-six',ref:'meeting/55',state:'running',seats:roles.map(role=>({role}))};
  f.actors.applyMeeting(meeting);assert.equal(f.den.guestActors.size,6,'six separate guests, never borrowed workers');
  f.tick(40);assert.equal(f.actors.seatModels().size,6,'six actual guest bodies reach seats');
  assert.equal(f.actors.actors.get('orchestrator').meetingTrip?.stage,'seated','Bao attends as chair');
  for(const role of roles){const a=f.actors.actors.get(role);assert.deepEqual(a.panda.model.position,homes.get(role));assert.equal(a.live.ref,'work/'+role);}
  const models=[...f.actors.seatModels().values()];assert.equal(new Set(models).size,6);
  f.actors.applyMeeting({...meeting,state:'paused'});f.tick(1);assert.equal(f.den.guestActors.size,6);
  f.actors.applyMeeting({...meeting,state:'briefed'});f.tick(1);assert.equal(f.den.guestActors.size,6,'closing the sheet leaves snapshot ownership intact');
  f.actors.applyMeeting({...meeting,state:'closed'});f.tick(40);assert.equal(f.den.guestActors.size,0);
  assert.equal(f.actors.actors.get('orchestrator').meetingTrip,null,'Bao returns to his owned home');
  assert.equal([...f.actors.places.values()].filter(p=>p.id.includes('actual-six')&&p.owner).length,0,'only the ended meeting leases are released');
 }finally{f.dispose();}
});

test('55-D/M: actual friend visitor and turned host face each other, hidden presentation freezes and disposal clears ownership',()=>{
 const f=approvedFixture();try{
  let guest=null,host=null;
  outer:for(const visitor of f.actors.actors.values())if(!visitor.stationary)for(const candidate of f.actors.actors.values())if(candidate.teamId!==visitor.teamId&&f.den.friendPlace(visitor,candidate)){const spot=f.den.friendPlace(visitor,candidate),path=f.den.routineRoute(visitor,visitor.home,spot.position);if(path.length&&routeLength(visitor.home,path)<=100){guest=visitor;host=candidate;break outer;}}
  assert.ok(host,'a real cross-team host has a furniture-clear visitor place');
  for(const a of f.actors.actors.values())if(a!==guest&&a!==host)a.stationary=true;
  f.den.routineSpots=[];f.tick(45);assert.equal(guest.outing?.stage,'visit');assert.equal(host.hosting,guest.id);
  const p=guest.panda.model.position,q=host.panda.model.position;
  assert.ok(Math.abs(Math.atan2(Math.sin(guest.yaw-Math.atan2(q.x-p.x,q.z-p.z)),Math.cos(guest.yaw-Math.atan2(q.x-p.x,q.z-p.z))))<.001);
  assert.ok(f.den.walkWorld.fits(q,host.envelope,host.yaw));assert.ok(f.den.walkWorld.fits(p,guest.envelope,guest.yaw));
  const at=p.clone(),time=f.actors.routines.time;f.actors.setHidden(true);f.tick(10);assert.equal(f.actors.routines.time,time);assert.deepEqual(p,at);
  f.actors.setHidden(false);f.tick(45);assert.equal(guest.outing,null);assert.deepEqual(p,guest.home);
  f.actors.dispose();assert.equal(f.actors.places.values().next().done,true);assert.equal(f.den.guestActors.size,0);
 }finally{f.dispose();}
});

test('55-I: real floor queries follow support rather than requested height and keep library/stage entrances reachable',()=>{
 const f=approvedFixture();try{
  const w=f.den.walkWorld,a=f.actors.actors.get('developer');
  assert.equal(w.navigation.groundAt(0,42,99),w.supportAt(0,42)+.045);
  for(const [x,z]of [[0,29],[-56.5,-4]]){const to={x,z,y:w.supportAt(x,z)+.045};assert.ok(w.route(a,a.home,to).length,'route to entrance '+x+','+z);}
  assert.equal(f.den.garden.landscape.metrics.plantings.length,27);assert.equal(f.den.garden.landscape.metrics.heroPillars,0);
 }finally{f.dispose();}
});

test('55-M: missing approved model stays labeled and stationary; empty/live snapshots and unmount release all owned state',()=>{
 const f=approvedFixture({missing:['tortoise']});try{
  const a=f.actors.actors.get('sre');assert.ok(a.panda.model.userData.modelUnavailable);assert.equal(a.stationary,true);
  f.actors.applyLive([{role:'sre',runtime:'claude',ref:'work/error',agentId:'sre-error',state:'waiting_on_user'}]);f.tick(5,true);
  assert.equal(a.live.ref,'work/error');assert.match(a.presentation,/Model unavailable/);assert.equal(a.outing,null);
  f.actors.applyLive([]);assert.equal(a.live,null);assert.ok([...f.actors.actors.values()].every(a=>!a.live));
  f.actors.dispose();assert.equal(f.actors.places.values().next().done,true);f.factory.dispose();assert.equal(f.factory.instances.size,0);assert.throws(()=>f.factory.createPanda('sre'),/disposed/);
 }finally{f.dispose();}
});
