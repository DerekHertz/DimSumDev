import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {approvedFixture} from './approved.test-fixture.mjs';

function triangles(model,within=null){
 const result=[];model.updateWorldMatrix(true,true);
 model.traverse(mesh=>{
  if(!mesh.isMesh)return;
  for(let parent=mesh;parent;parent=parent.parent)if(!parent.visible)return;
  const p=mesh.geometry.attributes.position,index=mesh.geometry.index,vertices=[];
  for(let i=0;i<p.count;i++){
   const v=new T.Vector3().fromBufferAttribute(p,i);
   if(mesh.isSkinnedMesh)mesh.applyBoneTransform(i,v);
   vertices.push(v.applyMatrix4(mesh.matrixWorld));
  }
  for(let i=0;i<(index?.count??p.count);i+=3){
   const points=[0,1,2].map(k=>vertices[index?index.getX(i+k):i+k]);
   if(!within||points.every(p=>within.containsPoint(p)))result.push(new T.Triangle(...points));
  }
 });return result;
}
function intersects(triangle,planes){
 let points=[triangle.a,triangle.b,triangle.c];
 for(const plane of planes){
  const clipped=[];
  for(let i=0;i<points.length;i++){
   const a=points[i],b=points[(i+1)%points.length],da=plane.distanceToPoint(a),db=plane.distanceToPoint(b);
   if(da<=1e-8)clipped.push(a);
   if((da<0)!==(db<0))clipped.push(a.clone().lerp(b,da/(da-db)));
  }
  points=clipped;if(!points.length)return false;
 }return true;
}

test('native meeting seating clears the actual assembled table with every specialist body and preserves ownership through return',()=>{
 const f=approvedFixture();try{
  const box=new T.Box3(new T.Vector3(-2.001,1.229,-5.181),new T.Vector3(2.001,1.411,-2.819));
  const table=triangles(f.den.garden.root,box);
  assert.ok(table.length>=32,'actual table triangles retained by batching');
  const center=new T.Vector3(0,1.32,-4),planes=[];
  for(const tri of table){
   const plane=new T.Plane().setFromCoplanarPoints(tri.a,tri.b,tri.c);
   if(plane.normal.lengthSq()<.9)continue;
   if(plane.distanceToPoint(center)>0)plane.negate();
   if(!planes.some(p=>p.normal.distanceTo(plane.normal)<1e-5&&Math.abs(p.constant-plane.constant)<1e-5))planes.push(plane);
  }
  assert.ok(planes.length>=10,'convex faces come from real cylinder geometry');
  const specialists=[...f.actors.actors.values()].filter(a=>a.runtime==='claude'&&a.role!=='orchestrator');
  assert.equal(specialists.length,11);
  for(const a of f.actors.actors.values())a.stationary=true;
  f.den.routineSpots=[];
  for(let offset=0;offset<11;offset+=6){
   const group=specialists.slice(offset,offset+6),meeting={id:'native-'+offset,ref:'meeting/native',state:'running',seats:group.map(a=>({role:a.role}))};
   f.actors.applyMeeting(meeting);f.tick(60);
   const participants=[f.actors.actors.get('orchestrator'),...group];
   assert.ok(f.actors.seatModels().get('orchestrator')===participants[0].panda.model,'the actual seated Bao chair publishes its label anchor');
   assert.equal(f.actors.seatModels().size,group.length+1,'all selected bodies and chair actually arrive: '+JSON.stringify(group.map(a=>({role:a.role,stage:a.meetingTrip?.stage,position:a.panda.model.position.toArray(),trip:a.meetingTrip}))));
   const owned=new Set();
   for(const actor of participants){
    assert.equal(actor.meetingTrip?.stage,'seated',actor.role+' arrived');
    assert.ok(!owned.has(actor.meetingPlace));owned.add(actor.meetingPlace);
    assert.equal(f.actors.places.get(actor.meetingPlace).owner,actor.identity);
    assert.equal(f.actors.places.get(actor.homePlace).owner,actor.identity,'home stays owned');
    assert.ok(f.den.walkWorld.supported(actor,actor.panda.model.position,actor.yaw),'physical floor support');
    for(const time of [0,.4,1.2]){
     actor.panda.rig.poseSit(time);const body=triangles(actor.panda.model);
     assert.equal(body.filter(t=>intersects(t,planes)).length,0,actor.role+' actual seated triangles clear actual table');
     assert.ok(Math.min(...body.flatMap(t=>[t.a.y,t.b.y,t.c.y]))>=f.den.walkWorld.supportAt(actor.panda.model.position.x,actor.panda.model.position.z)-.02,'body stays above its supporting floor');
    }
   }
   f.actors.applyMeeting({...meeting,state:'closed'});f.tick(60);
   for(const actor of participants){assert.equal(actor.meetingTrip,null);assert.deepEqual(actor.panda.model.position,actor.home);}
  }
  // Jiao's meeting authority is independent; prove her actual body and physical
  // route without inventing a Claude meeting participant for her runtime.
  const jiao=f.actors.actors.get('codex:orchestrator'),position={x:0,y:f.den.walkWorld.supportAt(0,-11)+.045,z:-11};
  assert.ok(f.den.routineRoute(jiao,jiao.home,position).length,'Jiao can reach the meeting chair');
  assert.ok(f.den.routineRoute(jiao,position,jiao.home).length,'Jiao can return to her desk');
  const lease=f.actors.places.define({id:'physical-jiao-clearance',kind:'meeting',position});
  assert.ok(f.actors.places.reserve(lease.id,jiao.identity,{...jiao.envelope,yaw:0}));
  jiao.panda.model.position.copy(position);jiao.panda.model.rotation.y=0;
  assert.ok(f.den.walkWorld.supported(jiao,position,0));
  for(const time of [0,.4,1.2]){
   jiao.panda.rig.poseSit(time);
   assert.equal(triangles(jiao.panda.model).filter(t=>intersects(t,planes)).length,0,'Jiao actual seated triangles clear the native table');
  }
  jiao.panda.model.position.copy(jiao.home);f.actors.places.release(lease.id,jiao.identity);
 }finally{f.dispose();}
});
