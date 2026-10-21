import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createActorPlaces} from './actor-places.mjs';

function fixture(groundAt,walkX=10){
 const actors=new Map(),meshes=[],navigation={revision:0,groundAt},transport=createActorPlaces({walkWorld:{navigation},walkStart:{x:walkX,z:0,groundY:0}},actors,2);
 const actor=(id,x=-10)=>{const model=new T.Group(),mesh=new T.Mesh(new T.BoxGeometry(.6,1,.6));mesh.position.y=.5;model.add(mesh);meshes.push(mesh);return{id,projectId:'landing',runtime:id==='two'?'codex':'claude',role:'developer',home:new T.Vector3(x,0,0),panda:{model,rig:{profile:{},poseIdle(){},poseWaddle(){}}}};};
 return{actors,transport,actor,navigation,dispose(){transport.dispose();for(const mesh of meshes){mesh.geometry.dispose();mesh.material.dispose();}}};
}

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
 const actors=new Map(),world={navigation:{groundAt:(x,z)=>{assert.ok(++queries<=250000,'one allocation never exceeds 250000 external navigation calls');return blocked&&Math.abs(x)<7?null:0;}}},den={walkWorld:world,walkStart:{x:0,z:0,groundY:0}};
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
 const transport=createActorPlaces({walkWorld:world,walkStart:{x:10,z:0,groundY:0}},actors,2);
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
 const actors=new Map(),world={navigation:{groundAt:(x,z,y,r)=>Math.abs(z)+r>1.25||Math.abs(x)+r>12?null:0}},den={walkWorld:world,walkStart:{x:10,z:0,groundY:0}};
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
