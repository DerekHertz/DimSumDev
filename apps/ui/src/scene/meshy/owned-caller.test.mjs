import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {residentCaller} from './test-fixtures/resident-caller.mjs';
import {occupiedVertices} from './test-fixtures/occupied-vertices.mjs';

const point=p=>({x:p.x,y:p.y,z:p.z});
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const segmentDistance=(p,a,b)=>{const dx=b.x-a.x,dz=b.z-a.z,l=dx*dx+dz*dz,t=l?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/l)):0;return Math.hypot(p.x-a.x-t*dx,p.z-a.z-t*dz);};
const state=a=>({id:a.id,identity:a.identity,visible:a.panda.model.visible,homePlace:a.homePlace,home:point(a.home),position:point(a.panda.model.position),presentation:a.presentation,routine:a.routine?.stage,travel:a.travel&&{placeId:a.travel.placeId,status:a.travel.status,path:a.travel.path.map(point),returnRequested:a.travel.returnRequested}});

test('36 full caller preserves all 32 owners through late arrivals, outings, failed cancellation and disconnected destinations',t=>{
 let phase='resident-construction',externalQueries=0;
 const counted=fn=>(...args)=>{externalQueries++;return fn(...args);};
 const f=residentCaller({groundAt:counted(()=>.26)}),stats={frames:0,footprints:0,segments:0,pairs:0,vertices:0},originalIds=[...f.actors.actors.keys()];
 const nav=f.den.walkWorld.navigation;
 const diagnostics=()=>({phase,stats,externalQueries,actors:[...f.actors.actors.values()].map(state),leases:[...f.actors.places.values()].filter(p=>p.owner).map(p=>({id:p.id,owner:p.owner,position:p.position,occupied:p.occupied,departing:p.departing}))});
 const allOwned=()=>{assert.equal(f.actors.actors.size,32);for(const id of originalIds){const a=f.actors.actors.get(id);assert.equal(a.panda.model.visible,true,id+' stays visible');assert.equal(f.actors.places.get(a.homePlace)?.owner,a.identity,id+' current full identity owns home');}};
 function inspect(before){
  const all=[...f.actors.actors.values()],leases=[...f.actors.places.values()].filter(p=>p.owner);
  for(const a of all){
   assert.equal(a.panda.model.visible,true,a.id+' stays visible');
   const at=a.panda.model.position,r=a.envelope.radius;assert.equal(f.actors.places.get(a.homePlace)?.owner,a.identity);
   assert.equal(nav.groundAt(at.x,at.z,at.y,r,a.envelope.height),at.y,a.id+' full footprint');stats.footprints++;
   assert.equal(nav.groundAt(a.home.x,a.home.z,a.home.y,r,a.envelope.height),a.home.y,a.id+' retained home footprint');
   for(const lease of leases)if(lease.owner!==a.identity){assert.ok(distance(at,lease.position)>=r+lease.envelope.radius+.049,a.id+' clears foreign lease '+lease.id);assert.ok(distance(a.home,lease.position)>=r+lease.envelope.radius+.049,a.id+' fitting retained home');}
   const from=before?.get(a.id);
   if(from&&distance(from,at)>1e-9){
    const samples=Math.max(1,Math.ceil(distance(from,at)/.0125));
    for(let i=0;i<=samples;i++){
     const fraction=i/samples,p={x:from.x+(at.x-from.x)*fraction,y:from.y+(at.y-from.y)*fraction,z:from.z+(at.z-from.z)*fraction};
     assert.equal(nav.groundAt(p.x,p.z,p.y,r,a.envelope.height),p.y,a.id+' independently swept footprint');
     for(const lease of leases)if(lease.owner!==a.identity)assert.ok(distance(p,lease.position)>=r+lease.envelope.radius+.049,a.id+' swept foreign lease');
    }
    const occupied=occupiedVertices(a);assert.deepEqual(occupied.unsupported,[]);assert.ok(occupied.vertices>0);assert.ok(occupied.radius<=r+1e-6,a.id+' deformed vertices within radius');assert.ok(occupied.height<=a.envelope.height+1e-6,a.id+' deformed vertices within height');stats.vertices+=occupied.vertices;stats.segments++;
   }
  }
  for(let i=0;i<all.length;i++)for(let j=0;j<i;j++){
   const a=all[i],b=all[j],at=a.panda.model.position,bt=b.panda.model.position,clearance=a.envelope.radius+b.envelope.radius+.029;
   assert.ok(distance(at,bt)>=clearance,a.id+' separates from '+b.id);
   if(before?.has(a.id)&&before.has(b.id)){const aa=before.get(a.id),bb=before.get(b.id);assert.ok(segmentDistance({x:0,z:0},{x:aa.x-bb.x,z:aa.z-bb.z},{x:at.x-bt.x,z:at.z-bt.z})>=clearance,'simultaneous swept pair '+a.id+'/'+b.id);}stats.pairs++;
  }
  stats.frames++;
 }
 const tick=()=>{const before=new Map([...f.actors.actors].map(([id,a])=>[id,point(a.panda.model.position)]));f.actors.update(.1,false);inspect(before);};
 const until=(predicate,limit,label)=>{for(let i=0;i<limit;i++){if(predicate())return;tick();}assert.ok(predicate(),label+' within '+limit+' frames');};
 const milestone=label=>t.diagnostic(JSON.stringify({milestone:label,phase,stats,externalQueries}));
 try{
  allOwned();inspect();milestone('all32-visible-owned-safe');
  phase='original-late-visitor';const rows=[{role:'developer',ref:'work/1'},{role:'developer',ref:'work/2'}];f.actors.applyLive(rows);
  const resident=f.actors.actors.get('developer'),visitor=f.actors.actors.get('developer#work/2');
  assert.notEqual(visitor.panda.rig.skeleton,resident.panda.rig.skeleton);assert.equal(visitor.live.ref,'work/2');assert.equal(f.actors.places.get(visitor.homePlace)?.owner,visitor.identity);
  const start=visitor.panda.model.position.clone();assert.ok(start.distanceTo(visitor.home)>=2*visitor.envelope.radius+.15-1e-6,'independent nonzero arrival start');
  tick();assert.ok(visitor.panda.model.position.distanceTo(start)>0);assert.notEqual(visitor.panda.rig.bones.Hip_L.quaternion.w,1,'walking deforms legs');
  until(()=>visitor.travel?.status==='arrived'&&visitor.panda.model.position.distanceTo(visitor.home)<.02,300,'visitor owned arrival');milestone('visitor-owned-arrival');
  f.actors.applyLive([]);assert.equal(f.den.pandaRigs.size,32);assert.equal(visitor.panda.model.parent,null);assert.equal([...f.actors.places.values()].some(p=>p.owner===visitor.identity),false);milestone('visitor-removal');
  phase='actual-outing';let outing;until(()=>{outing=[...f.actors.actors.values()].find(a=>a.routine?.stage==='outbound'&&distance(a.panda.model.position,a.home)>Math.max(2*a.envelope.radius+.15,3));return !!outing;},300,'actual outing away');
  const ownedHome=f.actors.places.get(outing.homePlace);assert.equal(ownedHome.owner,outing.identity);milestone('outing-retains-home');
  phase='newcomer-during-outing';const protectedRoute={from:point(outing.panda.model.position),path:outing.travel.path.map(point)};
  f.actors.applyLive(rows);const newcomer=f.actors.actors.get('developer#work/2'),newHome=f.actors.places.get(newcomer.homePlace);assert.equal(newHome?.owner,newcomer.identity);
  for(let i=0,from=protectedRoute.from;i<protectedRoute.path.length;from=protectedRoute.path[i++])assert.ok(segmentDistance(newHome.position,from,protectedRoute.path[i])>=newcomer.envelope.radius+outing.envelope.radius+.049,'newcomer leaves active outgoing corridor open');
  assert.equal(ownedHome.owner,outing.identity);tick();milestone('newcomer-preserves-trip');
  phase='cancellation-away-failed-reproof';const beforeCancel=point(outing.panda.model.position),navBefore=nav.groundAt,priorPath=outing.travel.path.map(point);
  const cuts=['x','z'].map(axis=>({axis,coordinate:(beforeCancel[axis]+outing.home[axis])/2})).filter(c=>[...f.actors.actors.values()].every(a=>Math.abs(a.panda.model.position[c.axis]-c.coordinate)>a.envelope.radius+.06&&Math.abs(a.home[c.axis]-c.coordinate)>a.envelope.radius+.06));assert.ok(cuts.length,'cut leaves every body/home fitting');const cut=cuts[0];
  nav.groundAt=counted((x,z,y,r)=>Math.abs((cut.axis==='x'?x:z)-cut.coordinate)<=r+.04?null:.26);nav.revision=(nav.revision??0)+1;
  f.actors.applyLive([...rows,{role:outing.role,runtime:outing.runtime,ref:'caller/interrupt'}]);
  assert.deepEqual(point(outing.panda.model.position),beforeCancel);assert.equal(ownedHome.owner,outing.identity);assert.deepEqual(outing.travel.path,priorPath,'failed replacement retains existing route');assert.equal(outing.travel.status,'waiting');assert.equal(outing.travel.returnRequested,true);inspect();tick();assert.deepEqual(point(outing.panda.model.position),beforeCancel);milestone('failed-cancel-holds-body-home-return');
  phase='cancel-return-after-restoration';nav.groundAt=navBefore;nav.revision++;
  until(()=>outing.travel?.status==='arrived'&&outing.travel.placeId===outing.homePlace&&distance(outing.panda.model.position,outing.home)<.02,500,'cancelled owned-home return');assert.equal(ownedHome.owner,outing.identity);milestone('cancelled-owned-home-return');
  const busyRows=[...f.actors.actors.values()].filter(a=>!a.visitor&&!a.guest).map(a=>({role:a.role,runtime:a.runtime,ref:'caller/settle/'+a.id}));f.actors.applyLive(busyRows);allOwned();inspect();milestone('current-identity-ownership');
  phase='local-egress-disconnected-destination';const maxX=Math.max(...[...f.actors.actors.values()].map(a=>a.panda.model.position.x))+8;
  nav.groundAt=counted((x,z,y,r)=>x+r<maxX||x-r>maxX+4?.26:null);nav.revision++;
  f.den.routineSpots.splice(0,f.den.routineSpots.length,{id:'disconnected',kind:'tea',position:new T.Vector3(maxX+12,.26,0),face:new T.Vector3(maxX+12,.26,-1)});f.actors.applyLive([]);
  const beforeDisconnected=[...f.actors.actors.values()].map(a=>({...state(a),idle:a.state==='idle'&&!a.routine&&(!a.travel||a.travel.status==='arrived')&&distance(a.panda.model.position,a.home)<.02})),cohort=beforeDisconnected.filter(a=>a.idle);
  for(const [id,home]of [['architect',{x:3,y:.26,z:-8}],['codex:architect',{x:6,y:.26,z:-8}]]){const a=cohort.find(a=>a.id===id);assert.ok(a,id+' idle rejection cohort');assert.deepEqual(a.position,home);}
  for(let i=0;i<45;i++)tick();
  assert.equal([...f.actors.actors.values()].some(a=>a.routine?.spot.id==='disconnected'),false);
  for(const before of cohort)assert.deepEqual(point(f.actors.actors.get(before.id).panda.model.position),before.position,'disconnected outing holds pre-tick idle '+before.id);
  for(const id of ['architect','codex:architect']){const a=f.actors.actors.get(id);assert.match(a.presentation,/destination unavailable/i,id+' truthfully rejected outing');assert.deepEqual(point(a.panda.model.position),beforeDisconnected.find(a=>a.id===id).home);}
  allOwned();milestone('disconnected-rejection-all32-owned-safe');
 }catch(error){console.error('36 caller failure '+JSON.stringify(diagnostics()));throw error;}
 finally{f.dispose();assert.equal([...f.actors.places.values()].length,0,'final disposal clears registry');}
});
