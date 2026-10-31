import test from 'node:test';
import assert from 'node:assert/strict';
import {approvedFixture} from './approved.test-fixture.mjs';
import {seatSpots} from './meeting-table.mjs';

// portable-den/16 (F51): a follower stops 2 units behind a walker at a dock
// throat; the walker's in-place turn then sweeps into the follower, no route
// exists for either, and replanning never frees them.
test('a walker at its dock throat still routes out when the walker behind it is too close for an in-place turn',()=>{
 const f=approvedFixture();try{
  const actor=role=>[...f.actors.actors.values()].find(a=>a.role===role&&a.runtime==='claude');
  const leader=actor('technical-writer'),follower=actor('designer');
  leader.panda.model.position.set(30.5,.36,19.5);
  follower.panda.model.position.set(30.5,.36,21.52);follower.yaw=Math.PI;
  const walkWorld=f.den.walkWorld,seat=seatSpots(5)[4],mount=walkWorld.meetingApproach(leader,{...seat,y:walkWorld.supportAt(seat.x,seat.z)+.045});
  assert.ok(mount?.length,'the chair has a mount path');
  const route=f.den.routineRoute(leader,leader.panda.model.position,mount[0]);
  assert.ok(route.length>0,'the leader finds a route north out of the throat');
  assert.ok(route.at(-1).x===mount[0].x&&route.at(-1).z===mount[0].z,'the route reaches the chair approach');
 }finally{f.dispose();}
});

test('two meetings in a row seat every specialist when route planning is slow (the F51 CI flake)',()=>{
 const f=approvedFixture({workStepMs:.2});try{
  const specialists=[...f.actors.actors.values()].filter(a=>a.runtime==='claude'&&a.role!=='orchestrator');
  for(const a of f.actors.actors.values())a.stationary=true;
  f.den.routineSpots=[];
  for(const offset of [0,6]){
   const group=specialists.slice(offset,offset+6),meeting={id:'slow-'+offset,ref:'meeting/slow',state:'running',seats:group.map(a=>({role:a.role}))};
   f.actors.applyMeeting(meeting);f.tick(90);
   assert.deepEqual(group.filter(a=>a.meetingTrip?.stage!=='seated').map(a=>a.role),[],'every specialist arrived');
   f.actors.applyMeeting({...meeting,state:'closed'});f.tick(90);
  }
 }finally{f.dispose();}
});
