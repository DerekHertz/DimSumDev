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
 const bodyWorld=ignore=>({...den.walkWorld,obstacles:[...(den.walkWorld.obstacles??[]),...[...actors.values()].filter(b=>b!==ignore&&b.panda.model.visible).map(b=>({...b.panda.model.position,type:'circle',radius:b.envelope.radius+.03}))]});
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
  const work=createAllocationWork(),bodySnapshot=bodyWorld(a),navigation=den.walkWorld.navigation;
  const budgetWorld={...den.walkWorld,navigation:{...navigation,groundAt:(...args)=>work.groundAt(navigation,...args)}};
  bodySnapshot.navigation=budgetWorld.navigation;
  let exit,goal=a.approach??staging;
  // A later allocation must not seal the only exit of an already placed body.
  // Search only on allocation, using the same bounded route search as travel.
  const accessible=position=>{
   for(const b of actors.values()){
    const old=exits.get(b);if(old&&b.panda.model.visible&&crosses(position,old.path,old.from,a.envelope.radius+b.envelope.radius+.03,work))return false;
   }
   const world={...bodySnapshot},navigation=world.navigation,pad=Math.max(4,a.envelope.radius*2);
   // Prove an exit to the authored landing, not a new cross-garden trip for
   // every candidate. A conservative local search bounds allocation cost.
   world.navigation={...navigation,groundAt(x,z,...args){if(x<Math.min(position.x,goal.x)-pad||x>Math.max(position.x,goal.x)+pad||z<Math.min(position.z,goal.z)-pad||z>Math.max(position.z,goal.z)+pad)return null;return navigation.groundAt(x,z,...args);}};
   exit=gardenRoute(world,position,goal,a.envelope,work);if(!exit.length)return false;
   return true;
  };
  let home=places.find({id:'home:'+a.id,kind,near,owner:a.identity,envelope:a.envelope,validate:accessible,work});
  if(!home){goal=staging;home=places.find({id:'staging:'+a.id,kind:'staging',near:staging,owner:a.identity,envelope:a.envelope,validate:accessible,work});}
  if(!home){places.disposeActor(a.identity);a.presentation='Scene place unavailable';a.panda.model.visible=false;return false;}
  a.panda.model.visible=true;
  a.homePlace=home.id;a.home=new T.Vector3(home.position.x,home.position.y,home.position.z);a.panda.model.position.copy(a.home);places.occupy(home.id,a.identity);
  exits.set(a,{from:a.home.clone(),path:exit});
  a.presentation=home.kind==='staging'?'Workspace unavailable · waiting at a safe place':null;
  if(arrival){
   const start=a.home.clone().add(new T.Vector3(.9,0,.6));
   if(places.fits(start,a.envelope,a.identity,null,work)&&routeSegment(budgetWorld,start,a.home,a.envelope)!==null){
    const stage=places.define({id:'arrival:'+a.id,kind:'staging',position:start});
    if(places.reserve(stage.id,a.identity,a.envelope,work)){places.occupy(stage.id,a.identity);a.panda.model.position.copy(start);places.release(stage.id,a.identity);a.arriving=true;go(a,home,work);}
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
