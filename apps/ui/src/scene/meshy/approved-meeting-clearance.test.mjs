import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {approvedFixture} from './approved.test-fixture.mjs';
import {CHAIR_SPOT} from './meeting-table.mjs';

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

function meshIndex(model){
 const cells=new Map(),key=(x,y,z)=>x+':'+y+':'+z;
 function visit(bounds,fn){for(let x=Math.floor(bounds.min.x/.5);x<=Math.floor(bounds.max.x/.5);x++)for(let y=Math.floor(bounds.min.y/.5);y<=Math.floor(bounds.max.y/.5);y++)for(let z=Math.floor(bounds.min.z/.5);z<=Math.floor(bounds.max.z/.5);z++)fn(key(x,y,z));}
 for(const triangle of triangles(model)){
  const bounds=new T.Box3().setFromPoints([triangle.a,triangle.b,triangle.c]),record={triangle,bounds};
  visit(bounds,k=>{if(!cells.has(k))cells.set(k,[]);cells.get(k).push(record);});
 }
 return {collides(body){
  for(const triangle of body){
   const bounds=new T.Box3().setFromPoints([triangle.a,triangle.b,triangle.c]),candidates=new Set();visit(bounds,k=>{for(const item of cells.get(k)||[])candidates.add(item);});
   for(const item of candidates)if(bounds.intersectsBox(item.bounds)&&triangleCollision(triangle,item.triangle))return true;
  }return false;
 }};
}
function triangleCollision(a,b){
 const av=[a.a,a.b,a.c],bv=[b.a,b.b,b.c],edges=v=>v.map((p,i)=>v[(i+1)%3].clone().sub(p)),ae=edges(av),be=edges(bv),an=a.getNormal(new T.Vector3()),bn=b.getNormal(new T.Vector3());
 const axes=[an,bn,...ae.flatMap(x=>be.map(y=>new T.Vector3().crossVectors(x,y))),...ae.map(x=>new T.Vector3().crossVectors(an,x)),...be.map(x=>new T.Vector3().crossVectors(bn,x))];
 return axes.every(axis=>{if(axis.lengthSq()<1e-12)return true;axis.normalize();const ap=av.map(v=>v.dot(axis)),bp=bv.map(v=>v.dot(axis));return Math.min(...ap)<Math.max(...bp)-1e-6&&Math.min(...bp)<Math.max(...ap)-1e-6;});
}

test('actual seated bodies rest on their padded support instead of floating above it',()=>{
 const f=approvedFixture();try{
  const chairs=f.den.garden.teahouse.chairs,indices=chairs.map(c=>meshIndex(c.root));
  for(const actor of f.actors.actors.values()){
   const index=actor.role==='orchestrator'?0:1,spot=chairs[index].spot;
   actor.panda.model.position.set(spot.x,1.225,spot.z);actor.panda.model.rotation.y=spot.yaw;
   actor.panda.rig.poseSit(1,{grounded:true,reducedMotion:true});
   const bounds=new T.Box3().setFromObject(actor.panda.model,true);
   assert.ok(bounds.min.y>=1.18&&bounds.min.y<1.24,actor.role+' makes supported contact');
   const body=triangles(actor.panda.model);
   assert.equal(indices[index].collides(body),false,actor.role+' clears the complete actual chair mesh');
   const underside=body.flatMap(t=>[t.a,t.b,t.c]).filter(p=>p.y<bounds.min.y+.025),ray=new T.Raycaster(undefined,new T.Vector3(0,-1,0),0,.13);
   assert.ok(underside.some(p=>{ray.ray.origin.copy(p).y+=.01;return ray.intersectObject(chairs[index].root,true).some(hit=>hit.distance<.12);}),actor.role+' rests within upholstery tolerance of the actual chair surface');
  }
 }finally{f.dispose();}
});

test('native meeting seating clears the actual assembled table with every specialist body and preserves ownership through return',()=>{
 const f=approvedFixture();try{
  const table=triangles(f.den.garden.teahouse.table),tableIndex=meshIndex(f.den.garden.teahouse.table);
  assert.ok(table.length>=32,'actual table triangles retained by batching');
  // The top is convex; test the actual batched surface independently of its pedestal.
  const top=table.filter(t=>[t.a,t.b,t.c].every(p=>p.y>=1.43));
  const center=new T.Vector3(0,1.59,-4),planes=[];
  for(const tri of top){
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
     actor.panda.rig.poseSit(time,{grounded:true});const body=triangles(actor.panda.model);
     assert.equal(body.filter(t=>intersects(t,planes)).length,0,actor.role+' actual seated triangles clear actual table');
     if(time===0)assert.equal(tableIndex.collides(body),false,actor.role+' clears every actual table surface, including the pedestal');
     assert.ok(Math.min(...body.flatMap(t=>[t.a.y,t.b.y,t.c.y]))>=f.den.walkWorld.supportAt(actor.panda.model.position.x,actor.panda.model.position.z)-.02,'body stays above its supporting floor');
    }
   }
   f.actors.applyMeeting({...meeting,state:'closed'});f.tick(60);
   for(const actor of participants){assert.equal(actor.meetingTrip?.stage??null,null,actor.role+' returned home');assert.deepEqual(actor.panda.model.position,actor.home);}
  }
  // Jiao's meeting authority is independent; prove her actual body and physical
  // route without inventing a Claude meeting participant for her runtime.
  const jiao=f.actors.actors.get('codex:orchestrator'),position={...CHAIR_SPOT,y:f.den.walkWorld.supportAt(CHAIR_SPOT.x,CHAIR_SPOT.z)+.045},mount=f.den.walkWorld.meetingApproach(jiao,position);
  assert.ok(mount?.length,'Jiao has a clear supported mount onto the permanent chair');
  assert.ok(f.den.routineRoute(jiao,jiao.home,mount[0]).length,'Jiao can reach the chair landing');
  assert.ok(f.den.routineRoute(jiao,mount[0],{...jiao.home,yaw:jiao.baseYaw}).length,'Jiao can return to her desk after dismounting');
  const lease=f.actors.places.define({id:'physical-jiao-clearance',kind:'meeting',position});
  assert.ok(f.actors.places.reserve(lease.id,jiao.identity,{...jiao.envelope,yaw:0}));
  jiao.panda.model.position.copy(position);jiao.panda.model.rotation.y=0;
  assert.ok(f.den.walkWorld.supported(jiao,position,0));
  for(const time of [0,.4,1.2]){
   jiao.panda.rig.poseSit(time,{grounded:true});
   assert.equal(triangles(jiao.panda.model).filter(t=>intersects(t,planes)).length,0,'Jiao actual seated triangles clear the native table');
  }
  jiao.panda.model.position.copy(jiao.home);f.actors.places.release(lease.id,jiao.identity);
  const partial={id:'reduced-partial',state:'running',seats:[specialists[0],specialists[2]].map(a=>({role:a.role}))};
  f.actors.applyMeeting(partial);f.tick(10,true);
  assert.equal(f.actors.seatModels().size,3,'a partial meeting uses supported seats with reduced motion');
  f.actors.applyMeeting({...partial,state:'closed'});f.tick(10,true);
  for(const a of [f.actors.actors.get('orchestrator'),specialists[0],specialists[2]]){assert.equal(a.meetingTrip,null);assert.deepEqual(a.panda.model.position,a.home);}
 }finally{f.dispose();}
});
