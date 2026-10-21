import * as T from 'three';
import {actorEnvelope} from './actor-envelope.mjs';
import {actorIdentity,createPlaceRegistry} from './places.mjs';
import {createActorTravel} from './actor-travel.mjs';
import {gardenRoute,routeSegment} from './garden-route.mjs';
import {createAllocationWork} from './allocation-work.mjs';

// The scene adapter owns allocation; the existing common traveller owns motion.
export function createActorPlaces(den,actors,speed){
 const places=createPlaceRegistry(den.walkWorld,{getBodies:()=>[...actors.values()].filter(a=>a.panda.model.visible).map(a=>({owner:a.identity,position:a.panda.model.position,envelope:a.envelope}))}),traveller=createActorTravel(den.walkWorld,places,{speed,getActors:()=>[...actors.values()]});
 const exits=new Map();
 const point=p=>({x:p.x,y:p.y,z:p.z});
 const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
 function crosses(position,path,from,radius,work){
  for(const to of path){if(!work.take('exitChecks'))return true;const dx=to.x-from.x,dz=to.z-from.z,length=dx*dx+dz*dz,t=length?Math.max(0,Math.min(1,((position.x-from.x)*dx+(position.z-from.z)*dz)/length)):0;if(Math.hypot(position.x-from.x-dx*t,position.z-from.z-dz*t)<radius)return true;from=to;}return false;
 }
 function bind(a,row){
  const next=actorIdentity({...a,...row,agentId:row?.agentId??a.id,ref:row?.ref??null});
  if(a.identity)places.rebind(a.identity,next);a.identity=next;
 }
 function prepare(a,kind='work',near=a.home,{arrival=false}={}){
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
   const prior=[...exits].filter(([b])=>b!==a&&b.panda.model.visible).map(([b,e])=>({owner:b.identity,from:point(e.from),path:e.path.map(point),radius:e.radius}));
   const obstacles=(den.walkWorld.obstacles??[]).map(o=>({...o})),navigation={...den.walkWorld.navigation};
   return {bodies,leases,prior,obstacles,navigation,fingerprint:JSON.stringify([bodies,leases,prior,obstacles,navigation.revision??null,a.envelope])};
  }
  let physical=snapshot();
  const same=s=>s.fingerprint===physical.fingerprint&&s.navigation.groundAt===physical.navigation.groundAt;
  const world=()=>({...den.walkWorld,obstacles:[...physical.obstacles,...physical.bodies.filter(b=>b.visible).map(b=>({...b.position,type:'circle',radius:b.envelope.radius+.03})),...physical.leases.map(p=>({...p.position,type:'circle',radius:p.envelope.radius+.05}))],navigation:{...physical.navigation,groundAt:(...args)=>work.groundAt(physical.navigation,...args)}});
  const preservesExits=position=>physical.prior.every(old=>!crosses(position,old.path,old.from,a.envelope.radius+old.radius+.03,work));
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
  let landing=a.approach?null:findLanding(),exit;
  const accessible=position=>{
   if(!preservesExits(position))return false;
   const goal=a.approach??landing?.place.position;if(!goal)return false;
   const w=world(),navigation=w.navigation,pad=Math.max(4,a.envelope.radius*2);
   w.navigation={...navigation,groundAt(x,z,...args){if(x<Math.min(position.x,goal.x)-pad||x>Math.max(position.x,goal.x)+pad||z<Math.min(position.z,goal.z)-pad||z>Math.max(position.z,goal.z)+pad)return null;return navigation.groundAt(x,z,...args);}};
   const path=gardenRoute(w,position,goal,a.envelope,work);if(!path.length)return false;
   if(!sweep(path.at(-1),reverse(position,path)))return false;
   // Preserve the authored approach as a mandatory waypoint; extend a short
   // proof instead of accepting candidate-to-itself as an exit.
   if(distance(position,path.at(-1))<2*a.envelope.radius+.15){
    const tail=landing&&distance(position,landing.path.at(-1))>=2*a.envelope.radius+.15?landing.path:outgoing(path.at(-1),position,position);
    if(!tail)return false;path.push(...tail);
   }else if(landing){
    const tail=distance(position,landing.path.at(-1))>=2*a.envelope.radius+.15?landing.path:outgoing(path.at(-1),position,position);
    if(!tail)return false;path.push(...tail);
   }
   exit=path;return true;
  };
  let home=(a.approach||landing)?places.find({id:'home:'+a.id,kind,near,owner:a.identity,envelope:a.envelope,validate:accessible,work}):null;
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
  exits.set(a,{from:point(a.home),path:exit.map(point),radius:a.envelope.radius});
  a.presentation=home.kind==='staging'?'Workspace unavailable · waiting at a safe place':null;
  if(arrival){
   work=allocation.phase(1);
   const start=exit.at(-1);
   if(places.fits(start,a.envelope,a.identity,null,work)&&preservesExits(start)&&sweep(start,reverse(home.position,exit))&&sweep(home.position,exit)&&same(snapshot())){
    const stage=places.define({id:'arrival:'+a.id,kind:'staging',position:start});
    if(places.reserve(stage.id,a.identity,a.envelope,work)){
     places.occupy(stage.id,a.identity);a.panda.model.position.copy(start);places.release(stage.id,a.identity);go(a,home,work);a.arriving=a.travel?.status==='moving';
     if(!a.arriving){traveller.cancel(a);a.panda.model.position.copy(a.home);places.clearDeparted(a.identity,a.home,a.envelope);sync(a);}
    }
   }
  }
  return true;
 }
 function go(a,place,work=null){
  if(!a.homePlace){a.presentation='Scene place unavailable';return false;}
  if(!place){a.presentation='Scene destination unavailable';return false;}
  traveller.request(a,place.id,work);sync(a);return a.travel.status!=='unavailable';
 }
 function home(a){return go(a,places.get(a.homePlace));}
 function destination(a,{id,kind,position,overflow=true}){
  if(!a.homePlace)return null;
  if(kind==='leisure')return places.find({id,kind,near:position,owner:a.identity,envelope:a.envelope});
  position={...position,y:position.y??a.panda.model.position.y};
  const exact=places.define({id,kind,position});
  if(places.reserve(id,a.identity,a.envelope))return exact;
  return (overflow?places.find({id:id+':'+a.id,kind,near:position,owner:a.identity,envelope:a.envelope}):null)??(kind==='meeting'?exact:null);
 }
 function sync(a){
  if(!a.homePlace){a.presentation='Scene place unavailable';return;}
  const t=a.travel;a.path=t?.path?.length?t.path:null;
  a.routeGoal=t&&places.get(t.placeId)?.position;a.routeTries=t?.attempts??0;
  a.presentation=t?.status==='unavailable'?'Scene destination unavailable':t?.status==='waiting'?'Waiting for a safe route':t?.status==='yielding'?'Yielding on the path':a.leaving&&a.live?'Working · returning to desk':(!t||t.placeId===a.homePlace)&&places.get(a.homePlace)?.kind==='staging'?'Workspace unavailable · waiting at a safe place':null;
 }
 function remove(a){traveller.cancel(a);places.disposeActor(a.identity);exits.delete(a);}
 return{places,prepare,bind,go,home,destination,sync,remove,
  update(dt,reduced,held){traveller.update([...actors.values()].filter(a=>a.panda.model.visible),dt,reduced,held);for(const a of actors.values())sync(a);},
  dispose(){exits.clear();places.dispose();}};
}
