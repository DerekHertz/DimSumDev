import * as T from 'three';
import {actorEnvelope} from './actor-envelope.mjs';
import {actorIdentity,createPlaceRegistry} from './places.mjs';
import {createActorTravel} from './actor-travel.mjs';
import {gardenRoute,routeSegment} from './garden-route.mjs';
import {createAllocationWork} from './allocation-work.mjs';

// The scene adapter owns allocation; the existing common traveller owns motion.
export function createActorPlaces(den,actors,speed){
 const places=createPlaceRegistry(den.walkWorld,{getBodies:()=>[...actors.values()].filter(a=>a.panda.model.visible).map(a=>({owner:a.identity,position:a.panda.model.position,envelope:a.envelope}))});
 const traveller=createActorTravel(den.walkWorld,places,{speed,getActors:()=>[...actors.values()],proveRoute:proveTrip});
 // Home witnesses are permanent; complete trip corridors survive until an
 // owned, physically validated home arrival. Neither is a second registry.
 const exits=new Map(),pending=new Map(),rejections=new Map();
 let time=0;
 const point=p=>({x:p.x,y:p.y,z:p.z});
 const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
 const reverse=(from,path)=>[...path.slice(0,-1).reverse(),from];
 function protectedPaths(a){
  return [...exits].filter(([b])=>b!==a&&b.panda.model.visible).flatMap(([b,e])=>[e,...e.active].map(p=>({owner:b.identity,from:point(p.from),path:p.path.map(point),radius:e.radius})));
 }
 function preservesProtected(a,position,work){return protectedPaths(a).every(e=>!crosses(position,e.path,e.from,a.envelope.radius+e.radius+.05,work));}
 function snapshot(a,destination){
  const bodies=[...actors.values()].filter(b=>b!==a&&b.panda.model.visible).map(b=>({owner:b.identity,position:point(b.panda.model.position),envelope:{...b.envelope}}));
  const leases=[...places.values()].filter(p=>p.owner&&p.owner!==a.identity).map(p=>({owner:p.owner,id:p.id,position:point(p.position),envelope:{...p.envelope},occupied:p.occupied,departing:p.departing,revision:p.revision}));
  const prior=protectedPaths(a),navigation={...den.walkWorld.navigation},obstacles=(den.walkWorld.obstacles??[]).map(o=>({...o}));
  const lease=p=>p&&({id:p.id,owner:p.owner,position:point(p.position),envelope:{...p.envelope},occupied:p.occupied,departing:p.departing,revision:p.revision});
  const home=lease(places.get(a.homePlace)),target=lease(places.get(destination.id)),e=exits.get(a),local=e&&{from:point(e.from),path:e.path.map(point),radius:e.radius,active:e.active.map(p=>({from:point(p.from),path:p.path.map(point)}))};
  const position=point(a.panda.model.position),envelope={...a.envelope},approach=a.approach&&point(a.approach);
  return {bodies,leases,prior,navigation,obstacles,envelope,position,home,target,local,approach,fingerprint:JSON.stringify([bodies,leases,prior,obstacles,navigation.revision??null,a.identity,envelope,position,home,target,local,approach])};
 }
 const same=(a,b)=>a.fingerprint===b.fingerprint&&a.navigation.groundAt===b.navigation.groundAt;
 function proofWorld(physical,work){
  return {...den.walkWorld,obstacles:[...physical.obstacles,...physical.bodies.map(b=>({...b.position,type:'circle',radius:b.envelope.radius+.03})),...physical.leases.map(p=>({...p.position,type:'circle',radius:p.envelope.radius+.05}))],navigation:{...physical.navigation,groundAt:(...args)=>work.groundAt(physical.navigation,...args)}};
 }
 function sweep(world,from,path,envelope,work){
  if(!path?.length||!work.take('routes'))return false;
  for(const to of path){const y=routeSegment(world,from,to,envelope);if(y===null||Math.abs(y-to.y)>.1)return false;from=to;}
  return true;
 }
 // Moving bodies are checked every step; stationary changes invalidate a trip.
 // Do not turn transient body motion into an unbounded per-frame route search.
 function dependency(a){
  return JSON.stringify([a.identity,a.envelope,den.walkWorld.navigation.revision??null,den.walkWorld.obstacles??[],[...actors.values()].filter(b=>b!==a).map(b=>[b.identity,b.panda.model.visible,b.envelope]),[...places.values()].filter(p=>p.owner&&p.owner!==a.identity).map(p=>[p.id,p.owner,p.position,p.envelope,p.revision])]);
 }
 function releaseNew(a,ids){for(const id of ids){const p=places.get(id);if(p?.owner===a.identity&&!p.occupied)places.release(id,a.identity);}}
 function proveTrip(a,destination,sharedWork=null,arrivalStart=null){
  const work=sharedWork??createAllocationWork(),local=exits.get(a),home=places.get(a.homePlace);
  if(!local||home?.owner!==a.identity||!destination)return null;
  const acquired=destination.owner!==a.identity;
  if(!places.reserve(destination.id,a.identity,a.envelope,work))return null;
  let physical=snapshot(a,destination);
  // One revalidation may spend remaining work, never another allowance.
  for(let retry=0;retry<2&&!work.exhausted;retry++){
   const world=proofWorld(physical,work),envelope=physical.envelope,start=point(arrivalStart??physical.position),target=physical.target,retainedHome=physical.home,witness=physical.local;
   if(!witness||target?.owner!==a.identity||retainedHome?.owner!==a.identity||distance(witness.from,retainedHome.position)>.02)break;
   const pathVia=(from,to,via)=>{
    const path=[];let at=from;
    for(const target of [...(via?[via]:[]),to]){
     if(distance(at,target)<1e-7&&Math.abs(at.y-target.y)<.001)continue;
     const leg=gardenRoute(world,at,target,envelope,work);if(!leg.length)return null;path.push(...leg);at=path.at(-1);
    }
    return path;
   };
   const atHome=distance(start,retainedHome.position)<.02;
   // A home request already at home is a validated no-op, not a zero-length
   // travel certificate. All real trips require nonempty outgoing and return.
   const alreadyHome=target.id===retainedHome.id&&atHome&&Math.abs(start.y-retainedHome.position.y)<.1;
   const alreadyThere=distance(start,target.position)<.02&&Math.abs(start.y-target.position.y)<.1;
   const outbound=alreadyThere?[]:pathVia(start,target.position,target.id===retainedHome.id||atHome?physical.approach:null);
   const returning=alreadyHome?[]:outbound&&pathVia(target.position,retainedHome.position,target.id!==retainedHome.id?physical.approach:null);
   const localSafe=distance(witness.from,witness.path.at(-1))>=2*envelope.radius+.15-1e-6&&sweep(world,witness.from,witness.path,envelope,work)&&sweep(world,witness.path.at(-1),reverse(witness.from,witness.path),envelope,work);
   const preserves=physical.prior.every(e=>!crosses(target.position,e.path,e.from,envelope.radius+e.radius+.05,work));
   const noOpSafe=alreadyThere&&routeSegment(world,start,target.position,envelope)!==null;
   // For a return, the return-to-home leg is a terminal no-op, validated by
   // the reverse outgoing sweep rather than published as an empty route.
   const returningSafe=target.id===retainedHome.id||returning?.length&&sweep(world,target.position,returning,envelope,work)&&sweep(world,retainedHome.position,reverse(target.position,returning),envelope,work);
   const valid=localSafe&&preserves&&returningSafe&&(noOpSafe||outbound?.length&&sweep(world,start,outbound,envelope,work)&&sweep(world,target.position,reverse(start,outbound),envelope,work));
   const current=snapshot(a,destination);
   if(!same(physical,current)){physical=current;continue;}
   if(!valid)break;
   if(!alreadyHome){
    const certificate={from:start,path:[...outbound,...returning].map(point)};
    if(!local.active.some(p=>JSON.stringify(p)===JSON.stringify(certificate)))local.active=[...local.active,certificate];
   }
   local.dependency=dependency(a);local.groundAt=den.walkWorld.navigation.groundAt;
   local.radius=envelope.radius;
   if(home.envelope.radius!==envelope.radius||home.envelope.height!==envelope.height){home.envelope={...envelope};home.revision++;}
   return {path:outbound.map(point),arrived:alreadyThere};
  }
  if(acquired)releaseNew(a,[destination.id]);
  return null;
 }
 function revalidateTrips(){
  for(const [a,e]of exits){
   const failure=rejections.get(a),t=a.travel;if(!failure&&!t)continue;
   const dep=dependency(a),groundAt=den.walkWorld.navigation.groundAt;
   if(failure){
    const changed=failure.dependency!==dep||failure.groundAt!==groundAt;
    if(changed||failure.attempts<3&&time+.000001>=failure.retryAt){
     const place=failure.request?destination(a,failure.request,true):places.get(failure.placeId);
     go(a,place,null,failure,failure.kind);
    }
    continue;
   }
   if(!t.reproofRequested&&!['moving','yielding'].includes(t.status))continue;
   if(!t.reproofRequested&&e.dependency===dep&&e.groundAt===groundAt)continue;
   go(a,places.get(t.placeId),null,null,'reproof');
  }
 }
 function crosses(position,path,from,radius,work){
  for(const to of path){if(!work.take('exitChecks'))return true;const dx=to.x-from.x,dz=to.z-from.z,length=dx*dx+dz*dz,t=length?Math.max(0,Math.min(1,((position.x-from.x)*dx+(position.z-from.z)*dz)/length)):0;if(Math.hypot(position.x-from.x-dx*t,position.z-from.z-dz*t)<radius)return true;from=to;}return false;
 }
 function bind(a,row){
  const next=actorIdentity({...a,...row,agentId:row?.agentId??a.id,ref:row?.ref??null});
  if(a.identity)places.rebind(a.identity,next);a.identity=next;
 }
 function prepare(a,kind='work',near=a.home,{arrival=false}={}){
  releaseNew(a,pending.get(a)?.acquired??[]);pending.delete(a);rejections.delete(a);
  a.homePlace=null;a.travel=null;a.path=null;a.arriving=false;a.presentation=null;
  a.envelope=actorEnvelope(a.panda,a.gesture);bind(a,a.live);
  const staging={x:den.walkStart?.x??0,y:den.walkStart?.groundY??.26,z:den.walkStart?.z??30};
  const allocation=createAllocationWork();
  // Primary search gets 3/4 of the shared work. Staging retains 3/16 and
  // arrival the last 1/16; unused earlier work stays available to later phases.
  let work=allocation.phase(.75);
  // Copy physical state: mutable model vectors and lease records must never
  // silently change the world against which a certificate was proved.
  function snapshot(){
   const bodies=[...actors.values()].filter(b=>b!==a).map(b=>({owner:b.identity,visible:b.panda.model.visible,position:point(b.panda.model.position),envelope:{...b.envelope}}));
   const leases=[...places.values()].filter(p=>p.owner&&p.owner!==a.identity).map(p=>({owner:p.owner,id:p.id,position:point(p.position),envelope:{...p.envelope},occupied:p.occupied,departing:p.departing,revision:p.revision}));
   const prior=protectedPaths(a);
   const obstacles=(den.walkWorld.obstacles??[]).map(o=>({...o})),navigation={...den.walkWorld.navigation};
   return {bodies,leases,prior,obstacles,navigation,fingerprint:JSON.stringify([bodies,leases,prior,obstacles,navigation.revision??null,a.envelope])};
  }
  let physical=snapshot();
  const same=s=>s.fingerprint===physical.fingerprint&&s.navigation.groundAt===physical.navigation.groundAt;
  const world=()=>({...den.walkWorld,obstacles:[...physical.obstacles,...physical.bodies.filter(b=>b.visible).map(b=>({...b.position,type:'circle',radius:b.envelope.radius+.03})),...physical.leases.map(p=>({...p.position,type:'circle',radius:p.envelope.radius+.05}))],navigation:{...physical.navigation,groundAt:(...args)=>work.groundAt(physical.navigation,...args)}});
  const preservesExits=position=>physical.prior.every(old=>!crosses(position,old.path,old.from,a.envelope.radius+old.radius+.05,work));
  function sweep(from,path){
   if(!work.take('routes'))return false;
   const w=world();let at=from;
   for(const to of path){const y=routeSegment(w,at,to,a.envelope);if(y===null||Math.abs(y-to.y)>.1)return false;at={...to,y};}
   return true;
  }
  const reverse=(from,path)=>[...path.slice(0,-1).reverse(),from];
  // A fitting point is insufficient: prove a nonzero swept departure and its
  // reverse beyond the occupied-place release threshold, without a grid search.
  function outgoing(from,centre=staging,origin=from,progress={index:0,stage:0}){
   const d=2*a.envelope.radius+.15,angle=distance(from,centre)>1e-6?Math.atan2(from.z-centre.z,from.x-centre.x):0;
   const next=()=>{progress.index++;progress.stage=0;progress.to=null;};
   while(progress.index<8&&!work.exhausted){
    const theta=angle+progress.index*Math.PI/4,to=progress.to??={x:from.x+Math.cos(theta)*d,y:from.y,z:from.z+Math.sin(theta)*d};
    if(progress.stage===0){if(distance(origin,to)<d-1e-6){next();continue;}if(!work.take('candidates'))return null;progress.stage=1;}
    if(progress.stage===1){const y=work.groundAt(physical.navigation,to.x,to.z,to.y,a.envelope.radius,a.envelope.height);if(y===null){if(work.exhausted)return null;next();continue;}to.y=y;progress.stage=2;}
    if(progress.stage===2){if(!places.fits(to,a.envelope,a.identity,null,work)){if(work.exhausted)return null;next();continue;}progress.stage=3;}
    if(progress.stage===3){if(!preservesExits(to)){if(work.exhausted)return null;next();continue;}progress.stage=4;}
    if(progress.stage===4){if(!sweep(from,[to])){if(work.exhausted)return null;next();continue;}progress.stage=5;}
    if(!sweep(to,[from])){if(work.exhausted)return null;next();continue;}return [to];
   }
   return null;
  }
  let landingSearch={},landingAttempts=new WeakMap(),landingPath;
  const validateLanding=position=>{
   let attempt=landingAttempts.get(position);
   if(!attempt){attempt={preserved:false,outgoing:{index:0,stage:0}};landingAttempts.set(position,attempt);}
   if(!attempt.preserved){if(!preservesExits(position))return false;attempt.preserved=true;}
   landingPath=outgoing(position,staging,position,attempt.outgoing);return !!landingPath;
  };
  function findLanding(){
   // Never reuse a rejection after a body, lease, envelope or navigation change.
   // A resulting certificate still goes through the bounded revalidation below.
   if(!same(snapshot())){landingSearch={};landingAttempts=new WeakMap();}
   const place=places.find({id:'staging:'+a.id,kind:'staging',near:staging,owner:a.identity,envelope:a.envelope,work,validate:validateLanding,continuation:landingSearch});
   return place?{place,path:landingPath}:null;
  }
  let landing=null,exit;
  const accessible=position=>{
   if(!preservesExits(position))return false;
   if(!a.approach){exit=outgoing(position,staging,position);return !!exit;}
   const goal=a.approach;
   const w=world(),navigation=w.navigation,pad=Math.max(4,a.envelope.radius*2);
   w.navigation={...navigation,groundAt(x,z,...args){if(x<Math.min(position.x,goal.x)-pad||x>Math.max(position.x,goal.x)+pad||z<Math.min(position.z,goal.z)-pad||z>Math.max(position.z,goal.z)+pad)return null;return navigation.groundAt(x,z,...args);}};
   const path=gardenRoute(w,position,goal,a.envelope,work);if(!path.length)return false;
   if(!sweep(path.at(-1),reverse(position,path)))return false;
   // Preserve the authored approach as a mandatory waypoint; extend a short
   // proof instead of accepting candidate-to-itself as an exit.
   if(distance(position,path.at(-1))<2*a.envelope.radius+.15){
    const tail=landing&&distance(position,landing.path.at(-1))>=2*a.envelope.radius+.15?landing.path:outgoing(path.at(-1),position,position);
    if(!tail)return false;path.push(...tail);
   }
   exit=path;return true;
  };
  let home=places.find({id:'home:'+a.id,kind,near,owner:a.identity,envelope:a.envelope,validate:accessible,work,preserveHeight:!!a.stationary});
  if(!home){work=allocation.phase(.9375);landing??=findLanding();if(landing){home=landing.place;exit=landing.path;}}
  const fail=()=>{places.disposeActor(a.identity);exits.delete(a);a.presentation='Scene place unavailable';a.panda.model.visible=false;return false;};
  if(!home)return fail();
  // Revalidate at most once on a physical change, spending only remaining work.
  // Own tentative leases are excluded so reserving a proof landing is harmless.
  const measured=actorEnvelope(a.panda,a.gesture);a.envelope=measured;
  const current=snapshot();
  if(!same(current)){
   physical=current;work=allocation.phase(1);
   if(!places.fits(home.position,a.envelope,a.identity,home.id,work)||!preservesExits(home.position)||distance(home.position,exit.at(-1))<2*a.envelope.radius+.15||!sweep(home.position,exit)||!sweep(exit.at(-1),reverse(home.position,exit))||!same(snapshot()))return fail();
   home.envelope={...a.envelope};
  }
  if(landing&&landing.place!==home)places.release(landing.place.id,a.identity);
  a.panda.model.visible=true;
  a.homePlace=home.id;a.home=new T.Vector3(home.position.x,home.position.y,home.position.z);a.panda.model.position.copy(a.home);places.occupy(home.id,a.identity);
  exits.set(a,{from:point(a.home),path:exit.map(point),radius:a.envelope.radius,active:[]});
  a.presentation=home.kind==='staging'?'Workspace unavailable · waiting at a safe place':null;
  if(arrival){
   work=allocation.phase(1);
   const start=exit.at(-1);
   if(places.fits(start,a.envelope,a.identity,null,work)&&preservesExits(start)&&sweep(start,reverse(home.position,exit))&&sweep(home.position,exit)&&same(snapshot())){
    const stage=places.define({id:'arrival:'+a.id,kind:'staging',position:start});
    if(places.reserve(stage.id,a.identity,a.envelope,work)){
     // Prove the initial arrival before publishing its starting body. A failed
     // proof leaves the initial owned home in place, without a visible rollback.
     const response=traveller.request(a,home.id,work,start);
     if(response?.status==='moving'){
      a.panda.model.position.copy(start);places.occupy(stage.id,a.identity);places.release(stage.id,a.identity);a.arriving=true;sync(a);
     }else releaseNew(a,[stage.id]);
    }
   }
  }
  return true;
 }
 function go(a,place,work=null,retry=null,kind='request'){
  const tentative=pending.get(a);pending.delete(a);
  releaseNew(a,(tentative?.acquired??[]).filter(id=>id!==place?.id));
  if(!a.homePlace){a.presentation='Scene place unavailable';return false;}
  const old=retry??rejections.get(a);
  const request=tentative?.request??retry?.request??(old?.placeId===place?.id?old.request:null),placeId=place?.id??request?.id;
  if(!placeId){rejections.delete(a);a.presentation='Scene destination unavailable';return false;}
  const dep=dependency(a),key=JSON.stringify(request??placeId),unchanged=old?.key===key&&old.dependency===dep&&old.groundAt===den.walkWorld.navigation.groundAt;
  // Repeated caller events retain the original attempt count and beat. An
  // uncommitted intent owns no place and cannot replace existing travel.
  if(!retry&&unchanged){releaseNew(a,tentative?.acquired??[]);a.presentation='Scene destination unavailable';return false;}
  work??=tentative?.work??createAllocationWork();
  const attempts=(unchanged?old.attempts:0)+1;
  const current=a.travel,certificate=exits.get(a);
  if(current?.placeId===placeId&&['moving','yielding'].includes(current.status)&&!current.returnRequested&&!current.reproofRequested&&certificate?.dependency===dep&&certificate.groundAt===den.walkWorld.navigation.groundAt){rejections.delete(a);sync(a);return true;}
  const response=place&&traveller.request(a,placeId,work);
  if(!['moving','arrived'].includes(response?.status)){
   releaseNew(a,tentative?.acquired??[]);
   rejections.set(a,{placeId,key,request,kind,dependency:dependency(a),groundAt:den.walkWorld.navigation.groundAt,attempts,retryAt:time+8});
   const interrupted=kind==='return'||kind==='reproof';
   if(current&&interrupted){current.status=attempts>=3?'unavailable':'waiting';current.retryAt=Infinity;current.attempts=attempts;if(kind==='return')current.returnRequested=true;else current.reproofRequested=true;}
   // Publish terminal failure only after bounded retries. This is presentation
   // state, never a route certificate, occupied lease or successful arrival.
   if(attempts>=3&&(!current||current.placeId===placeId||interrupted)){
    a.travel??={placeId,path:[]};a.travel.status='unavailable';a.travel.attempts=attempts;a.travel.retryAt=Infinity;
    if(placeId!==a.homePlace)releaseNew(a,[placeId]);
   }
   a.presentation='Scene destination unavailable';return false;
  }
  response.attempts=attempts;rejections.delete(a);sync(a);return true;
 }
 function home(a){
  return go(a,places.get(a.homePlace),null,null,'return');
 }
 function destination(a,{id,kind,position,overflow=true},retry=false){
  if(!a.homePlace)return null;
  releaseNew(a,pending.get(a)?.acquired??[]);
  const request={id,kind,position:{...position},overflow};
  const failure=rejections.get(a);
  if(!retry&&failure?.key===JSON.stringify(request)&&failure.dependency===dependency(a)&&failure.groundAt===den.walkWorld.navigation.groundAt){pending.set(a,{request,acquired:[]});return places.get(failure.placeId)??null;}
  const work=createAllocationWork(),ownedBefore=new Set([...places.values()].filter(p=>p.owner===a.identity).map(p=>p.id));
  const finish=p=>{pending.set(a,{work,request,acquired:p&&!ownedBefore.has(p.id)?[p.id]:[]});return p;};
  const validate=p=>preservesProtected(a,p,work);
  if(kind==='leisure')return finish(places.find({id,kind,near:position,owner:a.identity,envelope:a.envelope,work,validate}));
  position={...position,y:position.y??a.panda.model.position.y};
  const exact=places.define({id,kind,position});
  if(validate(position)&&places.reserve(id,a.identity,a.envelope,work))return finish(exact);
  return finish((overflow?places.find({id:id+':'+a.id,kind,near:position,owner:a.identity,envelope:a.envelope,work,validate}):null)??(kind==='meeting'?exact:null));
 }
 function sync(a){
  if(!a.homePlace){a.presentation='Scene place unavailable';return;}
  const t=a.travel,e=exits.get(a);
  if(t?.status==='arrived'&&t.placeId===a.homePlace&&e?.active.length&&distance(a.panda.model.position,a.home)<.02&&places.fits(a.home,a.envelope,a.identity,a.homePlace)){
   e.active=[];places.cancel(a.identity,a.homePlace);places.clearDeparted(a.identity,a.home,a.envelope);
  }
  a.path=t?.path?.length?t.path:null;
  a.routeGoal=t&&places.get(t.placeId)?.position;a.routeTries=rejections.get(a)?.attempts??t?.attempts??0;
  a.presentation=t?.status==='unavailable'?'Scene destination unavailable':t?.status==='waiting'?'Waiting for a safe route':t?.status==='yielding'?'Yielding on the path':rejections.has(a)?'Scene destination unavailable':a.leaving&&a.live?'Working · returning to desk':(!t||t.placeId===a.homePlace)&&places.get(a.homePlace)?.kind==='staging'?'Workspace unavailable · waiting at a safe place':null;
 }
 function remove(a){traveller.cancel(a);places.disposeActor(a.identity);exits.delete(a);pending.delete(a);rejections.delete(a);}
 return{places,prepare,bind,go,home,destination,sync,remove,
  update(dt,reduced,held){time+=Math.min(dt,.1);revalidateTrips();traveller.update([...actors.values()].filter(a=>a.panda.model.visible),dt,reduced,held);for(const a of actors.values())sync(a);},
  dispose(){for(const a of actors.values())traveller.cancel(a);exits.clear();pending.clear();rejections.clear();places.dispose();}};
}
