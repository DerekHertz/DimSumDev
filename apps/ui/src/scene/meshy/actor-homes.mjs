import * as T from 'three';
import {actorEnvelope} from './actor-envelope.mjs';
import {actorIdentity,createPlaceRegistry} from './places.mjs';
import {createAllocationWork} from './allocation-work.mjs';
import {WALK} from '../procedural/walk.mjs';

// Homes-first: one measured, owned footprint. No departure or trip is promised.
export function createActorHomes(den,actors){
 const places=createPlaceRegistry(den.walkWorld,{getBodies:()=>[...actors.values(),...(den.guestActors?.values()||[])].filter(a=>a.panda.model.visible).map(a=>({owner:a.identity,position:a.panda.model.position,envelope:{...a.envelope,yaw:a.yaw??a.baseYaw}}))});
 function bind(a,row){
  const next=actorIdentity({...a,...row,agentId:row?.agentId??a.id,ref:row?.ref??null});
  if(a.identity)places.rebind(a.identity,next);a.identity=next;
 }
 function prepare(a){
  a.envelope={...actorEnvelope(a.panda,null,{oriented:!!den.garden?.approved}),yaw:a.baseYaw};bind(a,a.live);
  if(den.garden?.approved){
   const id=a.dock?.slotId||'work:'+a.id;places.define({id,kind:'work',position:a.home});
   const home=places.reserve(id,a.identity,a.envelope);if(!home){a.homePlace=null;a.presentation='Workspace unavailable — available in Team';a.panda.model.visible=false;return false;}
   a.homePlace=id;places.occupy(id,a.identity);a.presentation=a.dock?.staged?'Executive office pending — at a reserved home':null;return true;
  }
  const allocation=createAllocationWork(),entry=den.walkStart;let work=allocation.phase(.75);
  const clear=position=>!entry||Math.hypot(position.x-entry.x,position.z-entry.z)>=Math.max(.65,a.envelope.radius+WALK.radius+.05);
  const find=(kind,near)=>places.find({id:'home:'+a.id,kind,near,owner:a.identity,envelope:a.envelope,work,validate:clear,preserveHeight:!!a.stationary});
  let home=find('work',a.home);
  if(!home){work=allocation.phase(1);const origin=den.actorStaging??entry;home=find('staging',{x:origin?.x??0,y:origin?.groundY??.26,z:origin?.z??30});}
  if(!home){a.homePlace=null;a.presentation='Scene place unavailable';a.panda.model.visible=false;return false;}
  a.homePlace=home.id;a.home=new T.Vector3(home.position.x,home.position.y,home.position.z);
  a.panda.model.position.copy(a.home);a.panda.model.visible=true;places.occupy(home.id,a.identity);
  a.presentation=home.kind==='staging'?'Workspace unavailable — at a safe home':null;
  return true;
 }
 return {places,prepare,bind,dispose(){places.dispose();}};
}
