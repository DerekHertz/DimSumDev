import * as T from 'three';
import {actorEnvelope} from './actor-envelope.mjs';
import {actorIdentity,createPlaceRegistry} from './places.mjs';
import {createActorTravel} from './actor-travel.mjs';
import {gardenRoute,routeSegment} from './garden-route.mjs';

// The scene adapter owns allocation; the existing common traveller owns motion.
export function createActorPlaces(den,actors,speed){
 const places=createPlaceRegistry(den.walkWorld),traveller=createActorTravel(den.walkWorld,places,{speed,getActors:()=>[...actors.values()]});
 function bind(a,row){
  const next=actorIdentity({...a,...row,agentId:row?.agentId??a.id,ref:row?.ref??null});
  if(a.identity)places.rebind(a.identity,next);a.identity=next;
 }
 function prepare(a,kind='work',near=a.home,{arrival=false}={}){
  a.envelope=actorEnvelope(a.panda,a.gesture);bind(a,a.live);
  const staging={x:den.walkStart?.x??0,y:den.walkStart?.groundY??.26,z:den.walkStart?.z??30};
  let home=places.find({id:'home:'+a.id,kind,near,owner:a.identity,envelope:a.envelope});
  if(home&&kind==='visitor'){
   const obstacles=[...(den.walkWorld.obstacles??[]),...[...actors.values()].filter(b=>b.panda.model.visible).map(b=>({...b.panda.model.position,type:'circle',radius:b.envelope.radius+.03}))];
   if(!gardenRoute({...den.walkWorld,obstacles},home.position,staging,a.envelope).length){places.release(home.id,a.identity);home=null;}
  }
  if(!home)home=places.find({id:'staging:'+a.id,kind:'staging',near:staging,owner:a.identity,envelope:a.envelope});
  if(!home){a.presentation='Scene place unavailable';a.panda.model.visible=false;return false;}
  a.homePlace=home.id;a.home=new T.Vector3(home.position.x,home.position.y,home.position.z);a.panda.model.position.copy(a.home);places.occupy(home.id,a.identity);
  a.presentation=home.kind==='staging'?'Workspace unavailable · waiting at a safe place':null;
  if(arrival){
   const start=a.home.clone().add(new T.Vector3(.9,0,.6));
   if(places.fits(start,a.envelope,a.identity)&&routeSegment(den.walkWorld,start,a.home,a.envelope)!==null){
    const stage=places.define({id:'arrival:'+a.id,kind:'staging',position:start});
    if(places.reserve(stage.id,a.identity,a.envelope)){places.occupy(stage.id,a.identity);a.panda.model.position.copy(start);places.release(stage.id,a.identity);a.arriving=true;go(a,home);}
   }
  }
  return true;
 }
 function go(a,place){
  if(!place){a.presentation='Scene destination unavailable';return false;}
  traveller.request(a,place.id);sync(a);return a.travel.status!=='unavailable';
 }
 function home(a){return go(a,places.get(a.homePlace));}
 function destination(a,{id,kind,position,overflow=true}){
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
 function remove(a){traveller.cancel(a);places.disposeActor(a.identity);}
 return{places,prepare,bind,go,home,destination,sync,remove,
  update(dt,reduced,held){traveller.update([...actors.values()].filter(a=>a.panda.model.visible),dt,reduced,held);for(const a of actors.values())sync(a);},
  dispose(){places.dispose();}};
}
