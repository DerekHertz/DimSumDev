// THROWAWAY caller feasibility proof. No product import occurs before the sole run.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as T from 'three';
import {occupiedVertices} from './occupied-vertices.h14.mjs';
const output=process.argv[2];if(!output)throw Error('Explicit unique diagnostics path required');
const diag={started:new Date().toISOString(),milestones:[],operations:[],events:[],residents:[],unavailable:[],oracles:{frames:0,footprints:0,segments:0,pairs:0},failures:[]};
let queries=0,phase='imports',currentActor=null;const reads=new WeakMap(),locals=new Map(),active=new Map(),prepareStarts=new Map(),tripStarts=new Map(),rejects=new Map();
const p=a=>({x:a.x,y:a.y,z:a.z}),dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const state=a=>({id:a.id,identity:a.identity,visible:a.panda.model.visible,homePlace:a.homePlace,home:p(a.home),position:p(a.panda.model.position),envelope:a.envelope,travel:a.travel?{placeId:a.travel.placeId,status:a.travel.status,attempts:a.travel.attempts,path:a.travel.path?.map(p),returnRequested:a.travel.returnRequested}:null,presentation:a.presentation,role:a.role,runtime:a.runtime,concept:a.concept,state:a.state,activity:a.activity,live:a.live,routine:a.routine?{stage:a.routine.stage,elapsed:a.routine.elapsed,spot:{id:a.routine.spot.id,kind:a.routine.spot.kind,position:p(a.routine.spot.position)},place:{id:a.routine.place.id,owner:a.routine.place.owner,position:p(a.routine.place.position)}}:null});
function report(event,detail={}){const row={event,phase,time:new Date().toISOString(),...detail};diag.milestones.push(row);console.log(JSON.stringify(row));}
function track(fn){return (...args)=>{queries++;return fn(...args);};}
function finishOperation(kind,a,work,started){const measured=reads.get(work)?.();const operation={kind,id:a.id,identity:a.identity,phase,externalQueries:queries-(started??queries),work:measured};diag.operations.push(operation);if(measured){for(const [kind,limit]of Object.entries({candidates:129,routes:32,nodes:16384,exitChecks:32768,queries:250000}))assert.ok(measured.counts[kind]<=limit,kind+' unchanged ceiling');assert.ok(measured.cacheSize<=32768);}assert.ok(operation.externalQueries<=250000,'external allocation/trip ceiling');}
globalThis.__h13Observe=(event,data)=>{
 if(event==='work-view'){reads.set(data.work,data.read);return;}
 if(event==='work-cutoff'){const row={event,phase,id:currentActor?.id,...data};diag.events.push(row);console.log(JSON.stringify(row));return;}
 if(event==='registry-fit-rejected'){const actor=[...prepareStarts.keys()].find(a=>a.identity===data.owner);if(actor){if(!rejects.has(actor))rejects.set(actor,{first:{reason:data.reason,position:p(data.position)},count:0});const r=rejects.get(actor);r.last={reason:data.reason,position:p(data.position)};r.count++;}return;}
 if(event==='world-ready'){data.den.walkWorld.navigation.groundAt=track(data.den.walkWorld.navigation.groundAt);return;}
 const a=data.a;if(!a)return;
 if(event==='prepare-start'){currentActor=a;prepareStarts.set(a,queries);return;}
 if(event==='trip-start'){currentActor=a;tripStarts.set(a,queries);console.log(JSON.stringify({event,phase,id:a.id,identity:a.identity}));return;}
 if(event==='prepare-rejection'){if(!rejects.has(a))rejects.set(a,{first:{reason:data.reason,position:data.position},count:0});const r=rejects.get(a);r.last={reason:data.reason,position:data.position};r.count++;return;}
 if(event==='local-certificate')locals.set(a,{from:p(data.from),path:data.path.map(p)});
 if(event==='trip-certificate'){
  active.set(a,[...(active.get(a)??[]),{from:p(data.from),path:[...data.outbound,...data.returning].map(p)}]);
  finishOperation('trip-proof',a,data.work,tripStarts.get(a));
  diag.events.push({event,id:a.id,phase,from:data.from,outbound:data.outbound,returning:data.returning});
 }
 if(event==='trip-proof-failed'||event==='trip-rejected'){finishOperation(event,a,data.work,tripStarts.get(a));diag.events.push({event,id:a.id,phase,reason:data.reason??'transaction rejected',state:state(a)});}
 if(event==='retained-return'){const paths=data.active??[];assert.ok(paths.length>0,'failed cancellation retains real active corridor geometry');assert.deepEqual(paths,active.get(a),'observed retained geometry equals actually proved paths');diag.events.push({event,id:a.id,phase,paths:paths.map(q=>({from:p(q.from),path:q.path.map(p)}))});}
 if(event==='home-arrival')active.delete(a);
 if(event==='prepare-complete'||event==='prepare-failed'){
  finishOperation('prepare',a,data.work,prepareStarts.get(a));
  const outcome={...state(a),rejections:rejects.get(a)??null,work:reads.get(data.work)?.()};diag.events.push({event,phase,...outcome});if(event==='prepare-failed')diag.unavailable.push(outcome);
  console.log(JSON.stringify({event,phase,id:a.id,visible:outcome.visible,homePlace:outcome.homePlace,rejections:outcome.rejections,work:outcome.work}));
 }
};
function pointSegment(q,a,b){const dx=b.x-a.x,dz=b.z-a.z,l=dx*dx+dz*dz,t=l?Math.max(0,Math.min(1,((q.x-a.x)*dx+(q.z-a.z)*dz)/l)):0;return Math.hypot(q.x-a.x-t*dx,q.z-a.z-t*dz);}
function inspect(f,before=null){
 const all=[...f.actors.actors.values()].filter(a=>a.panda.model.visible),leases=[...f.actors.places.values()].filter(q=>q.owner);
 for(const a of all){
  const at=a.panda.model.position,home=f.actors.places.get(a.homePlace),r=a.envelope.radius;
  assert.equal(home?.owner,a.identity,a.id+' keeps owned home');
  assert.equal(f.den.walkWorld.navigation.groundAt(at.x,at.z,at.y,r,a.envelope.height),at.y,a.id+' full-footprint ground');diag.oracles.footprints++;
  for(const q of leases)if(q.owner!==a.identity){assert.ok(dist(at,q.position)>=r+q.envelope.radius+.049,a.id+' avoids foreign '+q.id);assert.ok(dist(home.position,q.position)>=r+q.envelope.radius+.049,a.id+' fitting owned home');}
  const from=before?.get(a.id);if(from&&dist(from,at)>1e-9){
   // Independent swept oracle: sample the measured inflated footprint, not route/certificate booleans.
   const count=Math.max(1,Math.ceil(dist(from,at)/.0125));for(let i=0;i<=count;i++){const t=i/count,q={x:from.x+(at.x-from.x)*t,y:from.y+(at.y-from.y)*t,z:from.z+(at.z-from.z)*t};assert.equal(f.den.walkWorld.navigation.groundAt(q.x,q.z,q.y,r,a.envelope.height),q.y,a.id+' swept footprint');for(const lease of leases)if(lease.owner!==a.identity)assert.ok(dist(q,lease.position)>=r+lease.envelope.radius+.049,a.id+' swept foreign lease');}diag.oracles.segments++;
   const occupied=occupiedVertices(a);diag.lastGeometry={phase,frame:diag.oracles.frames,actor:state(a),...occupied};diag.oracles.vertexMeasurements=(diag.oracles.vertexMeasurements??0)+1;diag.oracles.measuredVertices=(diag.oracles.measuredVertices??0)+occupied.vertexCount;assert.ok(occupied.supported,a.id+' supported nonempty actual deformed mesh measurement: '+JSON.stringify(occupied.unsupported));assert.ok(occupied.radius<=r+1e-6,a.id+' actual deformed rig remains in measured inflated radius; radius='+occupied.radius+' limit='+(r+1e-6)+' excess='+occupied.radiusExcess+' mesh='+occupied.extrema.radius.mesh+' vertex='+occupied.extrema.radius.index);assert.ok(occupied.height<=a.envelope.height+1e-6,a.id+' actual rig height; height='+occupied.height+' limit='+(a.envelope.height+1e-6)+' excess='+occupied.heightExcess+' mesh='+occupied.extrema.height.mesh+' vertex='+occupied.extrema.height.index);
  }
 }
 for(let i=0;i<all.length;i++)for(let j=0;j<i;j++){
  const a=all[i],b=all[j],at=a.panda.model.position,bt=b.panda.model.position;
  assert.ok(dist(at,bt)>=a.envelope.radius+b.envelope.radius+.029,a.id+' separated from '+b.id);
  if(before?.has(a.id)&&before.has(b.id)){const aa=before.get(a.id),bb=before.get(b.id),relativeStart={x:aa.x-bb.x,z:aa.z-bb.z},relativeEnd={x:at.x-bt.x,z:at.z-bt.z};assert.ok(pointSegment({x:0,z:0},relativeStart,relativeEnd)>=a.envelope.radius+b.envelope.radius+.029,'simultaneous swept pair separation '+a.id+'/'+b.id);}diag.oracles.pairs++;
 }
 diag.oracles.frames++;
}
function tick(f){const before=new Map([...f.actors.actors].map(([id,a])=>[id,p(a.panda.model.position)]));f.actors.update(.1,false);inspect(f,before);}
function until(f,predicate,limit,label){for(let i=0;i<limit;i++){if(predicate())return;tick(f);}assert.ok(predicate(),label+' reached within '+limit+' frames');}
function checkNewPlace(f,a,protectedBefore){const home=f.actors.places.get(a.homePlace);assert.ok(a.panda.model.visible&&home?.owner===a.identity,'newcomer has visible owned home');for(const entry of protectedBefore)for(let i=0,from=entry.from;i<entry.path.length;from=entry.path[i++])assert.ok(pointSegment(home.position,from,entry.path[i])>=a.envelope.radius+entry.radius+.049,'newcomer leaves prior local and return corridors open');}
function protectedGeometry(f){return [...f.actors.actors.values()].flatMap(a=>[...(locals.has(a)?[locals.get(a)]:[]),...(active.get(a)??[])].map(q=>({...q,radius:a.envelope.radius})));}
let f;
try{
 const {fixture}=await import('./fixture.prototype.mjs');phase='resident-construction';f=fixture();
 diag.residents=[...f.actors.actors.values()].map(a=>{const home=f.actors.places.get(a.homePlace);return {...state(a),owner:home?.owner??null,homeKind:home?.kind??null};});
 const unavailable=diag.residents.filter(a=>!a.visible||!a.homePlace||a.owner!==a.identity);report('all32-outcomes',{count:diag.residents.length,visible:diag.residents.filter(a=>a.visible).length,owned:diag.residents.filter(a=>a.owner===a.identity).length,unavailable:unavailable.map(a=>a.id)});
 assert.equal(diag.residents.length,32);assert.deepEqual(unavailable,[],'every original fixture resident must have a visible owned fitting home');inspect(f);
 for(const a of f.actors.actors.values()){const local=locals.get(a);assert.ok(local&&dist(local.from,local.path.at(-1))>=2*a.envelope.radius+.15-1e-6,'independent local anchor distance '+a.id);let from=local.from;for(const to of local.path){const count=Math.max(1,Math.ceil(dist(from,to)/.0125));for(let i=0;i<=count;i++){const t=i/count,q={x:from.x+(to.x-from.x)*t,y:from.y+(to.y-from.y)*t,z:from.z+(to.z-from.z)*t};assert.equal(f.den.walkWorld.navigation.groundAt(q.x,q.z,q.y,a.envelope.radius,a.envelope.height),q.y,'independent full local footprint '+a.id);for(const b of f.actors.actors.values())if(b!==a)assert.ok(dist(q,b.home)>=a.envelope.radius+b.envelope.radius+.049,'complete local witness avoids every later foreign home '+a.id+'/'+b.id);}from=to;}}
 phase='original-late-visitor';const rows=[{role:'developer',ref:'work/1'},{role:'developer',ref:'work/2'}];const oldProtected=protectedGeometry(f);f.actors.applyLive(rows);
 const resident=f.actors.actors.get('developer'),visitor=f.actors.actors.get('developer#work/2');
 assert.notEqual(visitor.panda.rig.skeleton,resident.panda.rig.skeleton);assert.equal(visitor.live.ref,'work/2');checkNewPlace(f,visitor,oldProtected);
 const start=visitor.panda.model.position.clone();assert.ok(start.distanceTo(visitor.home)>=2*visitor.envelope.radius+.15-1e-6,'distinct fitting arrival start');
 tick(f);assert.ok(visitor.panda.model.position.distanceTo(start)>0);assert.notEqual(visitor.panda.rig.bones.Hip_L.quaternion.w,1,'walking deforms the legs');
 until(f,()=>visitor.travel?.status==='arrived'&&visitor.panda.model.position.distanceTo(visitor.home)<.02,300,'late visitor owned arrival');assert.equal(f.actors.places.get(visitor.homePlace).owner,visitor.identity);report('visitor-owned-arrival',{id:visitor.id,identity:visitor.identity,position:p(visitor.panda.model.position)});
 f.actors.applyLive([]);assert.equal(f.den.pandaRigs.size,32);assert.equal(visitor.panda.model.parent,null);assert.equal([...f.actors.places.values()].some(q=>q.owner===visitor.identity),false);report('visitor-removed-back32',{rigs:f.den.pandaRigs.size});
 phase='actual-outing';let outing;until(f,()=>{outing=[...f.actors.actors.values()].find(a=>a.routine?.stage==='outbound'&&dist(a.panda.model.position,a.home)>Math.max(2*a.envelope.radius+.15,3));return !!outing;},300,'real outing away from retained home');
 const ownedHome=f.actors.places.get(outing.homePlace),away=p(outing.panda.model.position);assert.equal(ownedHome.owner,outing.identity);assert.ok(active.get(outing)?.length,'actual outing has observed proved outgoing and return paths');report('outing-away',{id:outing.id,home:p(outing.home),away});
 phase='newcomer-during-outing';const corridors=protectedGeometry(f);f.actors.applyLive(rows);const newcomer=f.actors.actors.get('developer#work/2');checkNewPlace(f,newcomer,corridors);assert.equal(ownedHome.owner,outing.identity);tick(f);report('newcomer-preserved-corridors',{id:newcomer.id,outing:outing.id});
 phase='cancellation-away-failed-reproof';
 const priorActive=JSON.parse(JSON.stringify(active.get(outing))),beforeCancel=p(outing.panda.model.position),nav=f.den.walkWorld.navigation,originalGround=nav.groundAt;
 // A thin infinite strip separates this away actor from its home while leaving
 // every current body and owned home fitting. Derive only a fixture-safe strip.
 const candidates=['x','z'].map(axis=>({axis,coordinate:(beforeCancel[axis]+outing.home[axis])/2})).filter(c=>[...f.actors.actors.values()].every(a=>Math.abs(a.panda.model.position[c.axis]-c.coordinate)>a.envelope.radius+.06&&Math.abs(a.home[c.axis]-c.coordinate)>a.envelope.radius+.06));
 assert.ok(candidates.length,'fixture permits a disconnected return strip without invalidating any body/home');const cut=candidates[0];
 nav.groundAt=track((x,z,y,r,h)=>Math.abs((cut.axis==='x'?x:z)-cut.coordinate)<=r+.04?null:.26);nav.revision=(nav.revision??0)+1;
 const cancellation=[...rows,{role:outing.role,runtime:outing.runtime,ref:'h13/interrupt'}];f.actors.applyLive(cancellation);
 assert.deepEqual(p(outing.panda.model.position),beforeCancel,'failed return proof holds current body');assert.equal(ownedHome.owner,outing.identity);assert.deepEqual(active.get(outing),priorActive,'failed return replacement retains all previously proved corridors');assert.equal(outing.travel.status,'waiting');assert.equal(outing.travel.returnRequested,true);inspect(f);tick(f);assert.deepEqual(p(outing.panda.model.position),beforeCancel);report('failed-reproof-retained-safe-return',{id:outing.id,cut});
 phase='cancel-return-after-restoration';nav.groundAt=originalGround;nav.revision++;until(f,()=>outing.travel?.status==='arrived'&&outing.travel.placeId===outing.homePlace&&dist(outing.panda.model.position,outing.home)<.02,500,'cancelled outing returns home');assert.equal(ownedHome.owner,outing.identity);assert.equal(active.has(outing),false);report('cancelled-outing-owned-home',{id:outing.id,position:p(outing.panda.model.position)});
 const busyRows=[...f.actors.actors.values()].filter(a=>!a.visitor&&!a.guest).map(a=>({role:a.role,runtime:a.runtime,ref:'h13/settle/'+a.id}));f.actors.applyLive(busyRows);assert.equal(f.den.pandaRigs.size,32);diag.settlement={selected:outing.id,actors:[...f.actors.actors.values()].map(a=>({...state(a),homeOwner:f.actors.places.get(a.homePlace)?.owner??null,homeKind:f.actors.places.get(a.homePlace)?.kind??null})),leases:[...f.actors.places.values()].map(q=>({id:q.id,kind:q.kind,owner:q.owner,position:p(q.position),envelope:q.envelope}))};report('settlement-activity-ownership',{selected:outing.id,actors:diag.settlement.actors});until(f,()=>outing.travel?.status==='arrived'&&outing.travel.placeId===outing.homePlace&&dist(outing.panda.model.position,outing.home)<.02,500,'selected cancelled actor remains at owned home');assert.equal(f.actors.actors.size,32,'all original residents remain present');for(const original of diag.residents){const a=f.actors.actors.get(original.id);assert.ok(a?.panda.model.visible,'original resident remains visible '+original.id);assert.deepEqual(a.identity,original.identity,'original resident keeps identity '+original.id);assert.equal(a.homePlace,original.homePlace,'original resident keeps home '+original.id);assert.equal(f.actors.places.get(a.homePlace)?.owner,a.identity,'original resident retains correct owned home '+original.id);}inspect(f);report('selected-return-all32-owned-safe',{selected:outing.id,count:f.actors.actors.size});
 phase='local-egress-disconnected-destination';
 // Reuse the full real caller. A finite safe island encloses all bodies/homes;
 // the leisure destination remains a fitting separate island beyond a moat.
 const xs=[...f.actors.actors.values()].map(a=>a.panda.model.position.x),maxX=Math.max(...xs)+8;
 nav.groundAt=track((x,z,y,r,h)=>x+r<maxX||x-r>maxX+4?.26:null);nav.revision++;
 f.den.routineSpots.splice(0,f.den.routineSpots.length,{id:'disconnected-h13',kind:'tea',position:new T.Vector3(maxX+12,.26,0),face:new T.Vector3(maxX+12,.26,-1)});
 f.actors.applyLive([]);
 const beforeDisconnected=new Map([...f.actors.actors].map(([id,a])=>[id,p(a.panda.model.position)]));const proofsBefore=diag.events.filter(e=>e.event==='trip-proof-failed'||e.event==='trip-rejected').length;
 for(let i=0;i<45;i++)tick(f);
 assert.ok(diag.events.filter(e=>e.event==='trip-proof-failed'||e.event==='trip-rejected').length>proofsBefore,'disconnected network truthfully rejects outing');assert.equal([...f.actors.actors.values()].some(a=>a.routine?.spot.id==='disconnected-h13'),false);for(const a of f.actors.actors.values())assert.deepEqual(p(a.panda.model.position),beforeDisconnected.get(a.id),'disconnected outing holds body');report('disconnected-outing-rejected');
 diag.verdict='pass';diag.finished=new Date().toISOString();report('full-caller-proof-pass',{oracles:diag.oracles,operations:diag.operations.length,externalQueries:queries});
}catch(error){diag.verdict='fail';diag.failurePhase=phase;diag.failures.push({name:error.name,message:error.message,stack:error.stack});report('STOP-first-failure',{failurePhase:phase,message:error.message});process.exitCode=1;}
finally{diag.finished=new Date().toISOString();diag.externalQueries=queries;if(f)diag.finalActors=[...f.actors.actors.values()].map(state);fs.writeFileSync(output,JSON.stringify(diag,null,2)+'\n',{flag:'wx'});f?.dispose();delete globalThis.__h13Observe;}
