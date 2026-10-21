import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createActorPlaces} from './actor-places.mjs';
import {createSurfaceNavigation} from './navigation.mjs';
import {WALK,startWalk,walk} from '../procedural/walk.mjs';

function fixture(groundAt,walkX=10){
 const actors=new Map(),meshes=[],navigation={revision:0,groundAt},den={walkWorld:{navigation},actorStaging:{x:walkX,z:0,groundY:0}},transport=createActorPlaces(den,actors,2);
 const actor=(id,x=-10)=>{const model=new T.Group(),mesh=new T.Mesh(new T.BoxGeometry(.6,1,.6));mesh.position.y=.5;model.add(mesh);meshes.push(mesh);return{id,projectId:'landing',runtime:id==='two'?'codex':'claude',role:'developer',home:new T.Vector3(x,0,0),panda:{model,rig:{profile:{},poseIdle(){},poseWaddle(){}}}};};
 return{actors,transport,actor,navigation,den,dispose(){transport.dispose();for(const mesh of meshes){mesh.geometry.dispose();mesh.material.dispose();}}};
}

for(const kind of ['home','staging','arrival'])test(`36 ${kind} allocation keeps the declared walker entry clear`,()=>{
 const f=fixture(kind==='staging'?x=>x>=5?0:null:()=>0);
 try{
  const entry={x:kind==='staging'?10:0,z:0,yaw:0,groundY:0};f.den.walkStart=entry;
  const a=f.actor('entry-'+kind,kind==='staging'?-10:0);
  assert.equal(f.transport.prepare(a,'visitor',a.home,{arrival:kind==='arrival'}),true);f.actors.set(a.id,a);
  const home=f.transport.places.get(a.homePlace),clear=p=>Math.hypot(p.x-entry.x,p.z-entry.z)>=a.envelope.radius+WALK.radius+.05;
  assert.equal(home.owner,a.identity);assert.equal(a.panda.model.visible,true);
  assert.ok(clear(home.position),'owned home does not occupy the player entry');
  assert.ok(clear(a.panda.model.position),'published arrival body also clears the entry');
  f.transport.update(.1,true);assert.ok(clear(a.panda.model.position));
  const avoid=[{x:a.panda.model.position.x,z:a.panda.model.position.z,r:.65}],start=startWalk(entry);
  const moved=walk(start,{forward:1},.1,{...f.den.walkWorld,avoid});
  assert.ok(Math.hypot(moved.x-start.x,moved.z-start.z)>.1,'real walking can leave its authored entry');
 }finally{f.dispose();}
});

test('36 a destination cannot reserve the declared player entry',()=>{
 const f=fixture(()=>0);try{
  f.den.walkStart={x:10,z:0,groundY:0};const a=f.actor('entry-destination');
  assert.equal(f.transport.prepare(a),true);f.actors.set(a.id,a);
  const destination=f.transport.destination(a,{id:'entry-seat',kind:'meeting',position:{x:10,y:0,z:0},overflow:false});
  assert.notEqual(destination?.owner,a.identity,'entry is not leased to a meeting body');
  assert.equal(f.transport.go(a,destination),false);assert.equal(f.transport.places.get(a.homePlace).owner,a.identity);
 }finally{f.dispose();}
});

for(const reduced of [false,true])test(`36 stationary authored lift retains exact owned home after a physical return (reduced=${reduced})`,()=>{
 const f=fixture(()=>0);
 try{
  const a=f.actor('host',.0003);a.stationary=true;a.home.y=.03;a.panda.model.position.copy(a.home);
  assert.equal(f.transport.prepare(a),true);f.actors.set(a.id,a);
  const home=f.transport.places.get(a.homePlace),expected={x:.0003,y:.03,z:0};
  assert.deepEqual(home.position,expected);assert.deepEqual(a.home.toArray(),[.0003,.03,0]);assert.deepEqual(a.panda.model.position.toArray(),[.0003,.03,0]);
  const target=f.transport.destination(a,{id:'host-out',kind:'leisure',position:{x:-4,y:0,z:0}});
  assert.equal(f.transport.go(a,target),true);for(let i=0;i<30;i++)f.transport.update(.1,reduced);
  assert.equal(a.travel.status,'arrived');assert.ok(a.panda.model.position.distanceTo(a.home)>3);assert.equal(home.owner,a.identity);
  assert.equal(f.transport.home(a),true);for(let i=0;i<30;i++)f.transport.update(.1,reduced);
  assert.equal(a.travel.status,'arrived');assert.equal(a.travel.placeId,home.id);assert.equal(home.owner,a.identity);assert.equal(home.occupied,true);
  assert.deepEqual(a.panda.model.position.toArray(),[.0003,.03,0]);assert.deepEqual(home.position,expected);
 }finally{f.dispose();}
});

test('36 stationary authored lift must fit its raised body under actual overhead geometry',()=>{
 const beam=new T.Mesh(new T.BoxGeometry(.4,.05,.4));beam.position.y=1.095;
 const navigation=createSurfaceNavigation([beam],{baseY:0,placement:.1,floorRadius:20}),f=fixture(navigation.groundAt);
 try{
  const a=f.actor('low-host',0);a.stationary=true;a.home.y=.03;
  assert.equal(navigation.groundAt(0,0,0,.45,1.05),0,'floor-based body fits below the beam');
  assert.equal(navigation.groundAt(0,0,0,.45,1.08),null,'the lifted body top intersects the beam');
  assert.equal(f.transport.prepare(a),true);
  const home=f.transport.places.get(a.homePlace);assert.notDeepEqual(home.position,{x:0,y:.03,z:0});
  assert.equal(home.position.y,0,'overflow remains support-normalized');assert.equal(home.owner,a.identity);
  assert.deepEqual(a.panda.model.position.toArray(),[home.position.x,0,home.position.z]);
 }finally{f.dispose();beam.geometry.dispose();beam.material.dispose();}
});

test('36 a new low beam blocks a lifted owned-home return without a false arrival',()=>{
 const f=fixture(()=>0),beam=new T.Mesh(new T.BoxGeometry(.4,.05,.4));beam.position.y=1.095;
 const blocked=createSurfaceNavigation([beam],{baseY:0,placement:.1,floorRadius:20});
 try{
  const a=f.actor('returning-host',0);a.stationary=true;a.home.y=.03;
  assert.equal(f.transport.prepare(a),true);f.actors.set(a.id,a);
  const home=f.transport.places.get(a.homePlace);assert.equal(home.position.y,.03);
  const target=f.transport.destination(a,{id:'host-away',kind:'leisure',position:{x:-4,y:0,z:0}});
  assert.equal(f.transport.go(a,target),true);f.transport.update(.1,true);assert.equal(a.travel.status,'arrived');
  const away=a.panda.model.position.clone();f.navigation.groundAt=blocked.groundAt;f.navigation.revision++;
  assert.equal(f.transport.home(a),false);f.transport.update(.1,true);
  assert.deepEqual(a.panda.model.position,away);assert.equal(home.owner,a.identity);assert.notEqual(a.travel.placeId,home.id);
  f.navigation.groundAt=()=>0;f.navigation.revision++;
  assert.equal(f.transport.home(a),true);f.transport.update(.1,true);
  assert.equal(a.travel.status,'arrived');assert.equal(a.travel.placeId,home.id);assert.deepEqual(a.panda.model.position.toArray(),[0,.03,0]);
 }finally{f.dispose();beam.geometry.dispose();beam.material.dispose();}
});

test('36 departure from a lifted owned home sweeps the raised body top',()=>{
 const beam=new T.Mesh(new T.BoxGeometry(.1,.05,.4));beam.position.set(.65,1.095,0);
 const navigation=createSurfaceNavigation([beam],{baseY:0,placement:.1,floorRadius:20}),f=fixture(navigation.groundAt);
 try{
  const a=f.actor('departing-host',0);a.stationary=true;a.home.y=.03;
  assert.equal(f.transport.prepare(a),true);f.actors.set(a.id,a);assert.equal(a.home.y,.03);
  const target=f.transport.destination(a,{id:'host-beyond-beam',kind:'leisure',position:{x:4,y:0,z:0}});
  assert.equal(f.transport.go(a,target),true);const before=a.panda.model.position.clone();
  f.transport.update(.1,false);
  assert.deepEqual(a.panda.model.position,before,'first step cannot sweep the raised body under a low beam');assert.notEqual(a.travel.status,'arrived');
 }finally{f.dispose();beam.geometry.dispose();beam.material.dispose();}
});

test('36 occupied centre gives each actor an owned landing and a real second arrival',()=>{
 let queries=0;const f=fixture(x=>{assert.ok(++queries<=250000);return x>=5?0:null;});
 try{
  const first=f.actor('one');assert.equal(f.transport.prepare(first,'visitor'),true);f.actors.set(first.id,first);
  const firstHome=f.transport.places.get(first.homePlace);assert.equal(firstHome.position.x,10);assert.equal(firstHome.position.z,0);
  queries=0;const second=f.actor('two');assert.equal(f.transport.prepare(second,'visitor',second.home,{arrival:true}),true);f.actors.set(second.id,second);
  const secondHome=f.transport.places.get(second.homePlace);assert.notEqual(firstHome.id,secondHome.id);assert.equal(secondHome.owner,second.identity);assert.equal(firstHome.owner,first.identity);
  assert.equal(second.panda.model.visible,true);assert.equal(second.arriving,true);assert.equal(second.travel.status,'moving');
  const before=second.panda.model.position.clone();f.transport.update(.1,false);assert.ok(second.panda.model.position.distanceTo(before)>0);
  for(let i=0;i<50;i++){f.transport.update(.1,false);assert.ok(first.panda.model.position.distanceTo(second.panda.model.position)>=first.envelope.radius+second.envelope.radius+.03-.001);}
  assert.equal(second.travel.status,'arrived');assert.ok(second.panda.model.position.distanceTo(new T.Vector3(secondHome.position.x,secondHome.position.y,secondHome.position.z))<.02);assert.equal(firstHome.owner,first.identity);
 }finally{f.dispose();}
});

test('36 phased landing search resumes a partial outgoing anchor and arrives at its owned place',()=>{
 // Ten fitting but isolated disks consume ninety candidate/anchor attempts.
 // The next disk's eighth anchor has a swept corridor: primary cuts off part
 // way through that disk, and staging must continue instead of starting over.
 const radius=.45,step=.8,d=2*radius+.15,disks=[{x:0,z:0}];
 for(let i=0;i<10;i++)disks.push({x:Math.sin(i*Math.PI/8)*step,z:Math.cos(i*Math.PI/8)*step});
 const from=disks.at(-1),angle=Math.atan2(from.z,from.x)+7*Math.PI/4,to={x:from.x+Math.cos(angle)*d,z:from.z+Math.sin(angle)*d};
 const segmentDistance=(x,z)=>{const dx=to.x-from.x,dz=to.z-from.z,t=Math.max(0,Math.min(1,((x-from.x)*dx+(z-from.z)*dz)/(d*d)));return Math.hypot(x-from.x-t*dx,z-from.z-t*dz);};
 let queries=0;
 const ground=(x,z,y,r)=>{assert.ok(++queries<=250000,'all phases and actual travel stay externally bounded');return disks.some(p=>Math.hypot(x-p.x,z-p.z)+r<=radius+1e-6)||segmentDistance(x,z)+r<=radius+1e-6?0:null;};
 const f=fixture(ground,0);
 try{
  const a=f.actor('continuation',-10);
  assert.equal(f.transport.prepare(a,'visitor',a.home,{arrival:true}),true);
  f.actors.set(a.id,a);const home=f.transport.places.get(a.homePlace);
  assert.equal(home.owner,a.identity);assert.equal(home.occupied,true);assert.equal(home.kind,'staging');
  assert.ok(Math.hypot(home.position.x-from.x,home.position.z-from.z)<1e-6);
  assert.equal(a.panda.model.visible,true);assert.equal(a.arriving,true);assert.equal(a.travel.status,'moving');
  const before=a.panda.model.position.clone();f.transport.update(.1,false);assert.ok(a.panda.model.position.distanceTo(before)>0);
  for(let i=0;i<30;i++)f.transport.update(.1,false);
  assert.equal(a.travel.status,'arrived');assert.equal(home.owner,a.identity);assert.ok(a.panda.model.position.distanceTo(new T.Vector3(home.position.x,home.position.y,home.position.z))<.02);
 }finally{f.dispose();}
});

for(const change of ['body','envelope','lease','navigation'])test(`36 snapshot revalidates ${change} changes without stale placement or a budget reset`,()=>{
 let queries=0,changed=false,f;
 const ground=(x,z)=>{assert.ok(++queries<=250000,'snapshot replay shares original external query ceiling');if(!changed){changed=true;if(change==='body')other.panda.model.position.set(10,0,0);if(change==='envelope')other.envelope={radius:12,height:2};if(change==='lease'){f.transport.places.define({id:'foreign',kind:'work',position:{x:10,y:0,z:0}});f.transport.places.reserve('foreign','foreign',{radius:.45,height:2});}if(change==='navigation')f.navigation.revision++;}return change==='navigation'&&changed?null:0;};
 f=fixture(ground);const other=f.actor('other',-20);other.identity='other';other.envelope={radius:.45,height:1.1};other.panda.model.position.set(10,0,10);f.actors.set(other.id,other);
 try{
  const a=f.actor('changed',10),prepared=f.transport.prepare(a,'visitor',a.home,{arrival:true});
  if(prepared){const home=f.transport.places.get(a.homePlace);assert.equal(home.owner,a.identity);assert.ok(Math.hypot(home.position.x-other.panda.model.position.x,home.position.z-other.panda.model.position.z)>=a.envelope.radius+other.envelope.radius+.03);if(change==='lease'){assert.equal(f.transport.places.get('foreign').owner,'foreign');assert.ok(Math.hypot(home.position.x-10,home.position.z)>=a.envelope.radius+.45+.05);}assert.notEqual(change,'navigation');}
  else{assert.equal(a.panda.model.visible,false);assert.match(a.presentation,/unavailable/i);assert.equal([...f.transport.places.values()].some(p=>p.owner===a.identity),false);}
 }finally{f.dispose();}
});

for(const reduced of [false,true])test(`36 fitting boxed landing has no physical outgoing witness (reduced=${reduced})`,()=>{
 let queries=0;const ground=(x,z,y,r)=>{assert.ok(++queries<=250000);return Math.hypot(x,z)+r<=.55?0:null;},f=fixture(ground,0);
 try{
  const a=f.actor('boxed',0);assert.equal(ground(0,0,0,.45),0,'independent disk oracle fits the central body');assert.equal(ground(1.05,0,0,.45),null,'independent disk oracle rejects a departure beyond the body');
  assert.equal(f.transport.prepare(a,'visitor',a.home,{arrival:true}),false);f.actors.set(a.id,a);f.transport.update(.1,reduced);
  assert.equal(a.panda.model.visible,false);assert.match(a.presentation,/unavailable/i);assert.equal(a.homePlace,null);assert.notEqual(a.travel?.status,'arrived');assert.equal([...f.transport.places.values()].some(p=>p.owner===a.identity),false);
 }finally{f.dispose();}
});

test('36 dense no-approach allocation exhausts truthfully within a total query budget and valid movement still succeeds',()=>{
 let queries=0,blocked=true;
 const actors=new Map(),world={navigation:{groundAt:(x,z)=>{assert.ok(++queries<=250000,'one allocation never exceeds 250000 external navigation calls');return blocked&&Math.abs(x)<7?null:0;}}},den={walkWorld:world,actorStaging:{x:0,z:0,groundY:0}};
 const transport=createActorPlaces(den,actors,2),meshes=[];
 const make=(id,x,z=0)=>{const model=new T.Group(),mesh=new T.Mesh(new T.BoxGeometry(.6,1,.6));mesh.position.y=.5;model.add(mesh);model.position.set(x,0,z);meshes.push(mesh);return{id,role:'developer',home:new T.Vector3(x,0,z),panda:{model,rig:{profile:{},poseIdle(){},poseWaddle(){}}}};};
 try{
  // Dense bodies have no approach metadata. The blocked actor has an unreachable
  // landing so primary searches remain expensive; staging itself is on the barrier.
  for(let i=0;i<12;i++){const a=make('body'+i,-6+i,-3);a.identity=a.id;a.envelope={radius:.45,height:1.1};actors.set(a.id,a);}
  const unavailable=make('blocked',-20);unavailable.approach={x:20,y:0,z:0};assert.equal(transport.prepare(unavailable),false);
  assert.ok(queries>0);assert.equal(unavailable.panda.model.visible,false);assert.match(unavailable.presentation,/unavailable/i);
  assert.equal(unavailable.homePlace,null);assert.equal([...transport.places.values()].some(p=>p.owner===unavailable.identity),false);
  blocked=false;queries=0;
  const valid=make('valid',-10);assert.equal(transport.prepare(valid),true);assert.ok(queries<=250000);actors.set(valid.id,valid);
  const target=transport.destination(valid,{id:'valid-target',kind:'leisure',position:{x:-8,y:0,z:0}});assert.ok(target);assert.equal(transport.go(valid,target),true);
  const before=valid.panda.model.position.clone();transport.update(.1,false);assert.ok(valid.panda.model.position.distanceTo(before)>0);
  for(let i=0;i<30;i++)transport.update(.1,false);
  assert.equal(valid.travel.status,'arrived');assert.equal(transport.places.get(target.id).owner,valid.identity);assert.ok(valid.panda.model.position.distanceTo(new T.Vector3(-8,0,0))<.02);
 }finally{transport.dispose();for(const mesh of meshes){mesh.geometry.dispose();mesh.material.dispose();}}
});

test('36 primary home search preserves staging and arrival work',()=>{
 let queries=0;
 // Eleven fitting isolated primary disks exert candidate pressure without a
 // reversible local exit. Staging must retain work for a real arrival.
 const disks=[{x:-10,z:0}];for(let i=0;i<10;i++)disks.push({x:-10+Math.sin(i*Math.PI/8)*.8,z:Math.cos(i*Math.PI/8)*.8});
 const actors=new Map(),world={navigation:{groundAt:(x,z,y,r)=>{assert.ok(++queries<=250000,'primary, staging and arrival share one external query ceiling');return x>=5||disks.some(p=>Math.hypot(x-p.x,z-p.z)+r<=.45+1e-6)?0:null;}}};
 const transport=createActorPlaces({walkWorld:world,actorStaging:{x:10,z:0,groundY:0}},actors,2);
 const model=new T.Group(),mesh=new T.Mesh(new T.BoxGeometry(.6,1,.6));mesh.position.y=.5;model.add(mesh);
 const actor={id:'fallback',role:'developer',home:new T.Vector3(-10,0,0),panda:{model,rig:{profile:{},poseIdle(){},poseWaddle(){}}}};
 try{
  // Inactive homes promise local egress, not connectivity to the garden.
  assert.equal(transport.prepare(actor,'visitor',actor.home,{arrival:true}),true);
  const home=transport.places.get(actor.homePlace);assert.equal(home.kind,'staging');assert.equal(home.owner,actor.identity);assert.equal(home.occupied,true);
  assert.equal(model.visible,true);assert.match(actor.presentation,/safe place/);assert.equal(actor.arriving,true);assert.equal(actor.travel.status,'moving');
  actors.set(actor.id,actor);const before=model.position.clone();transport.update(.1,false);assert.ok(model.position.distanceTo(before)>0);
  for(let i=0;i<20;i++)transport.update(.1,false);
  assert.equal(actor.travel.status,'arrived');assert.equal(home.owner,actor.identity);assert.ok(model.position.distanceTo(new T.Vector3(home.position.x,home.position.y,home.position.z))<.02);
 }finally{transport.dispose();mesh.geometry.dispose();mesh.material.dispose();}
});

test('36 later allocation cannot seal an existing resident only body-width exit',()=>{
 const actors=new Map(),world={navigation:{groundAt:(x,z,y,r)=>Math.abs(z)+r>1.25||Math.abs(x)+r>12?null:0}},den={walkWorld:world,actorStaging:{x:10,z:0,groundY:0}};
 const transport=createActorPlaces(den,actors,2),meshes=[];
 function actor(id,x){const model=new T.Group(),mesh=new T.Mesh(new T.BoxGeometry(1.5,2,1.5));mesh.position.y=1;model.add(mesh);model.position.x=x;meshes.push(mesh);return{id,role:'developer',runtime:'claude',home:new T.Vector3(x,0,0),panda:{model,rig:{profile:{},poseIdle(){},poseWaddle(){}}}};}
 try{
  const first=actor('first',-5);assert.equal(transport.prepare(first),true);actors.set(first.id,first);
  const target=transport.destination(first,{id:'exit',kind:'staging',position:{x:10,y:0,z:0},overflow:false});assert.ok(target);transport.go(first,target);
  const later=actor('later',0);transport.prepare(later);actors.set(later.id,later);
  assert.equal(later.panda.model.visible,false,'a second body has no independent exit in the single-body corridor');assert.match(later.presentation,/unavailable/i);
  for(let i=0;i<150;i++)transport.update(.1,false);
  assert.equal(first.travel.status,'arrived');assert.ok(Math.abs(first.panda.model.position.x-10)<.02);assert.equal(transport.places.get(target.id).owner,first.identity);
 }finally{transport.dispose();for(const mesh of meshes){mesh.geometry.dispose();mesh.material.dispose();}}
});

test('36 failed cancellation retains the complete return corridor until validated home arrival',()=>{
 let cut=false,queries=0;
 const ground=(x,z,y,r)=>{assert.ok(++queries<=250000,'each transaction remains externally bounded');return Math.abs(z)+r>.7||x-r< -10.6||x+r> -3.4||cut&&Math.abs(x+8.5)<=r+.04?null:0;};
 const f=fixture(ground);
 try{
  const a=f.actor('retained',-10);assert.equal(f.transport.prepare(a),true);f.actors.set(a.id,a);
  queries=0;const target=f.transport.destination(a,{id:'out',kind:'leisure',position:{x:-4,y:0,z:0}});assert.ok(target);assert.equal(f.transport.go(a,target),true);
  for(let i=0;i<15;i++){queries=0;f.transport.update(.1,false);}
  assert.ok(a.panda.model.position.x> -7.1&&a.panda.model.position.x< -6.9);
  const before=a.panda.model.position.clone(),oldPath=a.travel.path.map(p=>({...p}));cut=true;f.navigation.revision++;queries=0;
  assert.equal(f.transport.home(a),false);assert.deepEqual(a.panda.model.position,before);assert.deepEqual(a.travel.path,oldPath);assert.equal(a.travel.returnRequested,true);assert.equal(f.transport.places.get(a.homePlace).owner,a.identity);assert.equal(target.owner,a.identity,'failed replacement retains the prior target');
  queries=0;const later=f.actor('later',-8.5);assert.equal(f.transport.prepare(later),false,'no later body may seal the retained corridor');f.actors.set(later.id,later);
  for(let i=0;i<20;i++){queries=0;f.transport.update(.1,false);}assert.deepEqual(a.panda.model.position,before);
  cut=false;f.navigation.revision++;queries=0;
  for(let i=0;i<30;i++){queries=0;f.transport.update(.1,false);}
  assert.equal(a.travel.status,'arrived');assert.equal(a.travel.placeId,a.homePlace);assert.ok(a.panda.model.position.distanceTo(a.home)<.02);assert.equal(target.owner,null);
  queries=0;const after=f.actor('after',-5);assert.equal(f.transport.prepare(after),true,'home arrival releases trip-only corridor protection');
 }finally{f.dispose();}
});

test('36 changing trip snapshots reject atomically and release only the newly unoccupied destination',()=>{
 let queries=0,mutate=false,f;
 f=fixture(()=>{assert.ok(++queries<=250000);if(mutate)f.navigation.revision++;return 0;});
 try{
  const a=f.actor('changing',-10);assert.equal(f.transport.prepare(a),true);f.actors.set(a.id,a);
  queries=0;const target=f.transport.destination(a,{id:'new',kind:'leisure',position:{x:-4,y:0,z:0}});assert.ok(target);const before=a.panda.model.position.clone();mutate=true;
  assert.equal(f.transport.go(a,target),false);assert.deepEqual(a.panda.model.position,before);assert.equal(a.travel,null);assert.equal(target.owner,null);assert.equal(f.transport.places.get(a.homePlace).owner,a.identity);assert.match(a.presentation,/destination unavailable/i);
 }finally{f.dispose();}
});

test('36 a moved owned destination is reproved before the traveller receives its exact replacement route',()=>{
 let mutate=false,changed=false,f,target,queries=0;
 f=fixture(()=>{assert.ok(++queries<=250000);if(mutate&&!changed){changed=true;target.position.x=-6;target.revision++;}return 0;});
 try{
  const a=f.actor('replacement',-10);assert.equal(f.transport.prepare(a),true);f.actors.set(a.id,a);
  queries=0;target=f.transport.destination(a,{id:'moving-target',kind:'leisure',position:{x:-4,y:0,z:0}});assert.ok(target);mutate=true;
  assert.equal(f.transport.go(a,target),true);assert.equal(changed,true);assert.deepEqual(a.travel.path.at(-1),{x:-6,y:0,z:0});
  for(let i=0;i<30;i++){queries=0;f.transport.update(.1,false);}
  assert.equal(a.travel.status,'arrived');assert.equal(target.owner,a.identity);assert.ok(Math.abs(a.panda.model.position.x+6)<.02);assert.equal(f.transport.places.get(a.homePlace).owner,a.identity);
 }finally{f.dispose();}
});

const tick=(transport,seconds,reduced=false)=>{for(let i=0;i<Math.round(seconds*10);i++)transport.update(.1,reduced);};
for(const mode of ['reservation','proof'])for(const reduced of [false,true])test(`36 recovery ${mode} rejection is atomic, deduplicated, bounded and recovers after function replacement (reduced=${reduced})`,()=>{
 let blocked=false,queries=0;
 const open=(x,z,y,r)=>{queries++;return x-r< -12||x+r>0||Math.abs(z)+r>1?null:0;};
 const f=fixture((x,z,y,r)=>blocked&&(mode==='reservation'||Math.abs(x+7)<r+.05)?(queries++,null):open(x,z,y,r));
 try{
  const a=f.actor('retry',-10);assert.equal(f.transport.prepare(a),true);f.actors.set(a.id,a);const before=a.panda.model.position.clone();blocked=true;
  const target=f.transport.destination(a,{id:'retry-seat',kind:'meeting',position:{x:-4,y:0,z:0},overflow:false});assert.ok(target);
  assert.equal(f.transport.go(a,target),false);assert.equal(a.travel,null);assert.deepEqual(a.panda.model.position,before);assert.equal(target.owner,null);
  const first=queries;tick(f.transport,7,reduced);assert.equal(queries,first);
  assert.equal(f.transport.go(a,target),false);assert.equal(queries,first,'duplicate intent neither searches nor restarts the beat');
  tick(f.transport,2,reduced);assert.ok(queries>first,'the second attempt includes destination reservation and route proof');
  tick(f.transport,30,reduced);assert.equal(a.travel.status,'unavailable');assert.equal(a.travel.attempts,3);assert.deepEqual(a.travel.path,[]);assert.equal(target.owner,null);assert.equal(f.transport.places.get(a.homePlace).owner,a.identity);assert.deepEqual(a.panda.model.position,before);
  const exhausted=queries;tick(f.transport,30,reduced);assert.equal(queries,exhausted);assert.equal(f.transport.go(a,target),false);assert.equal(queries,exhausted);
  f.navigation.groundAt=open;f.transport.update(.1,reduced);assert.ok(queries>exhausted);assert.ok(['moving','arrived'].includes(a.travel.status));tick(f.transport,5,reduced);
  assert.equal(a.travel.status,'arrived');assert.equal(target.owner,a.identity);assert.equal(target.occupied,true);assert.ok(Math.abs(a.panda.model.position.x+4)<.02);assert.equal(f.transport.places.get(a.homePlace).owner,a.identity);
 }finally{f.dispose();}
});

for(const cleanup of ['home','remove','dispose'])test(`36 recovery ${cleanup} clears rejected pending intent without later motion or leases`,()=>{
 let blocked=false,queries=0;const f=fixture((x,z,y,r)=>{queries++;return blocked&&Math.abs(x+7)<r+.05||Math.abs(z)+r>1||x-r< -12||x+r>0?null:0;});
 try{
  const a=f.actor('cancel',-10);assert.equal(f.transport.prepare(a),true);f.actors.set(a.id,a);blocked=true;
  const target=f.transport.destination(a,{id:'cancel-seat',kind:'meeting',position:{x:-4,y:0,z:0},overflow:false});assert.equal(f.transport.go(a,target),false);
  const before=a.panda.model.position.clone();
  if(cleanup==='home')assert.equal(f.transport.home(a),true);else f.transport[cleanup](...(cleanup==='remove'?[a]:[]));
  const stopped=queries;tick(f.transport,40,true);assert.equal(queries,stopped);assert.deepEqual(a.panda.model.position,before);assert.equal(target.owner,null);assert.notEqual(a.travel?.placeId,target.id);
 }finally{f.dispose();}
});

test('36 recovery failed home request without committed travel exhausts safely and resumes on navigation revision',()=>{
 let blocked=false,queries=0;const f=fixture(()=>{queries++;return blocked?null:0;});
 try{
  const a=f.actor('home-retry');assert.equal(f.transport.prepare(a),true);f.actors.set(a.id,a);blocked=true;const before=a.panda.model.position.clone();
  assert.equal(f.transport.home(a),false);assert.equal(a.travel,null);tick(f.transport,40,true);assert.equal(a.travel.status,'unavailable');assert.equal(a.travel.attempts,3);assert.equal(f.transport.places.get(a.homePlace).owner,a.identity);assert.deepEqual(a.panda.model.position,before);
  const exhausted=queries;tick(f.transport,30,true);assert.equal(queries,exhausted);blocked=false;f.navigation.revision++;f.transport.update(.1,true);assert.equal(a.travel.status,'arrived');assert.equal(a.travel.placeId,a.homePlace);assert.equal(a.travel.attempts,1);assert.deepEqual(a.panda.model.position,before);
 }finally{f.dispose();}
});

for(const returning of [false,true])test(`36 recovery static active failure is bounded and retains the body, home and occupied lease (return=${returning})`,()=>{
 let blocked=false,queries=0;const open=(x,z,y,r)=>{queries++;return Math.abs(z)+r>1||x-r< -12||x+r>0?null:0;};
 const f=fixture((x,z,y,r)=>blocked&&Math.abs(x+7)<r+.05?(queries++,null):open(x,z,y,r));
 try{
  const a=f.actor('active-retry',-10);assert.equal(f.transport.prepare(a),true);f.actors.set(a.id,a);
  const target=f.transport.destination(a,{id:'active-out',kind:'leisure',position:{x:-4,y:0,z:0}});assert.equal(f.transport.go(a,target),true);
  if(returning)f.transport.update(.1,true);else tick(f.transport,1);
  const before=a.panda.model.position.clone(),oldPath=a.travel.path.map(p=>({...p}));blocked=true;f.navigation.revision++;
  if(returning){assert.equal(f.transport.home(a),false);assert.deepEqual(a.travel.path,oldPath);assert.equal(target.occupied,true);}else f.transport.update(.1,false);
  const first=queries;tick(f.transport,7);assert.equal(queries,first);tick(f.transport,2);assert.ok(queries>first);tick(f.transport,30,true);
  assert.equal(a.travel.status,'unavailable');assert.equal(a.travel.attempts,3);assert.deepEqual(a.panda.model.position,before);assert.equal(f.transport.places.get(a.homePlace).owner,a.identity);assert.equal(target.owner,returning?a.identity:null);
  const exhausted=queries;tick(f.transport,30,true);assert.equal(queries,exhausted);
  f.navigation.groundAt=open;f.transport.update(.1,true);assert.equal(a.travel.status,'arrived');assert.equal(a.travel.placeId,returning?a.homePlace:target.id);assert.ok(a.panda.model.position.distanceTo(returning?a.home:new T.Vector3(-4,0,0))<.02);if(returning)assert.equal(target.owner,null);
 }finally{f.dispose();}
});

test('36 recovery repeated destination allocation does not spend work or reset exhausted intent',()=>{
 let blocked=false,queries=0;const f=fixture(()=>{queries++;return blocked?null:0;});
 try{
  const a=f.actor('repeat');assert.equal(f.transport.prepare(a),true);f.actors.set(a.id,a);blocked=true;
  const request={id:'repeat-seat',kind:'meeting',position:{x:-4,y:0,z:0},overflow:false};
  assert.equal(f.transport.go(a,f.transport.destination(a,request)),false);const first=queries;
  for(let i=0;i<70;i++){assert.equal(f.transport.go(a,f.transport.destination(a,request)),false);f.transport.update(.1,false);}assert.equal(queries,first);
  tick(f.transport,32,true);assert.equal(a.travel.attempts,3);const exhausted=queries;
  for(let i=0;i<100;i++){f.transport.go(a,f.transport.destination(a,request));f.transport.update(.1,true);}assert.equal(queries,exhausted);assert.equal(a.travel.status,'unavailable');
 }finally{f.dispose();}
});

test('36 recovery failed replacement preserves committed travel and its occupied destination',()=>{
 let blocked=false;const f=fixture(x=>blocked&&x> -2?null:0);
 try{
  const a=f.actor('prior',-10);assert.equal(f.transport.prepare(a),true);f.actors.set(a.id,a);
  const first=f.transport.destination(a,{id:'first-out',kind:'leisure',position:{x:-4,y:0,z:0}});assert.equal(f.transport.go(a,first),true);const current=a.travel,path=current.path.map(p=>({...p}));blocked=true;
  const next=f.transport.destination(a,{id:'rejected-next',kind:'meeting',position:{x:-1,y:0,z:0},overflow:false});const before=a.panda.model.position.clone();
  assert.equal(f.transport.go(a,next),false);assert.equal(a.travel,current);assert.deepEqual(a.travel.path,path);assert.deepEqual(a.panda.model.position,before);assert.equal(first.owner,a.identity);assert.equal(next.owner,null);
  tick(f.transport,40,true);assert.equal(a.travel,current);assert.equal(a.travel.status,'arrived');assert.equal(a.travel.placeId,first.id);assert.equal(first.occupied,true);assert.equal(first.owner,a.identity);assert.equal(next.owner,null);assert.equal(f.transport.places.get(a.homePlace).owner,a.identity);
  assert.equal(f.transport.home(a),true);f.transport.update(.1,true);assert.equal(a.travel.placeId,a.homePlace);assert.equal(a.travel.status,'arrived');assert.equal(first.owner,null);const at=a.panda.model.position.clone();tick(f.transport,30,true);assert.deepEqual(a.panda.model.position,at);assert.equal(next.owner,null);
 }finally{f.dispose();}
});

test('36 recovery moving neighbours cannot reset a rejected request on every frame',()=>{
 let blocked=false,queries=0;const f=fixture(()=>{queries++;return blocked?null:0;});
 try{
  const a=f.actor('bounded-moving');assert.equal(f.transport.prepare(a),true);f.actors.set(a.id,a);
  const b=f.actor('moving-neighbour',-30);assert.equal(f.transport.prepare(b),true);f.actors.set(b.id,b);blocked=true;
  const target=f.transport.destination(a,{id:'moving-neighbour-seat',kind:'meeting',position:{x:-4,y:0,z:0},overflow:false});assert.equal(f.transport.go(a,target),false);const first=queries;
  for(let i=0;i<70;i++){b.panda.model.position.z+=.01;f.transport.update(.1,false);}assert.equal(queries,first);
  for(let i=0;i<330;i++){b.panda.model.position.z+=.01;f.transport.update(.1,false);}assert.equal(a.travel.attempts,3);const exhausted=queries;
  for(let i=0;i<300;i++){b.panda.model.position.z+=.01;f.transport.update(.1,false);}assert.equal(queries,exhausted);
 }finally{f.dispose();}
});

test('36 recovery idle owners do not repeatedly read navigation dependencies or search',()=>{
 let queries=0,reads=0;const f=fixture(()=>{queries++;return 0;});
 try{
  const a=f.actor('idle');assert.equal(f.transport.prepare(a),true);f.actors.set(a.id,a);assert.equal(a.travel,null);
  const revision=f.navigation.revision;Object.defineProperty(f.navigation,'revision',{get(){reads++;return revision;}});const before=queries;
  tick(f.transport,10);assert.equal(reads,0,'idle frames have no navigation snapshot work');assert.equal(queries,before);assert.equal(a.travel,null);assert.equal(f.transport.places.get(a.homePlace).owner,a.identity);
 }finally{f.dispose();}
});
