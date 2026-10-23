import * as T from 'three';
import {seated,seatSpots} from './meeting-table.mjs';
import {ROUTINE_POLICY} from './daily-routines.mjs';
import {WADDLE} from './panda-rig.mjs';

// Physical presentation only. The bridge's meeting snapshot remains the owner
// of discussion, execution, pauses and decisions.
export function createMeetingResidents(den,actors,places,routines){
 const participants=new Map(),returning=new Set(),guests=den.guestActors=new Map();let current=null;
 const snapshot=()=>JSON.stringify([...actors.values(),...guests.values()].map(a=>[a.panda.model.position.x.toFixed(2),a.panda.model.position.z.toFixed(2),a.yaw]));
 function travelPath(a,trip){
  const from=a.panda.model.position,spot=trip.spot;
  if(trip.stage==='return'){
   const home={...a.home,yaw:a.baseYaw},direct=den.routineRoute(a,from,home);
   if(direct.length||!den.walkWorld.segment)return direct;
   for(const distance of [3,2,1]){
    const exit={x:spot.x-Math.sin(spot.yaw)*distance,y:from.y,z:spot.z-Math.cos(spot.yaw)*distance,yaw:spot.yaw};
    if(!den.walkWorld.segment(from,exit,a.envelope,spot.yaw))continue;
    const onward=den.routineRoute(a,exit,home);
    if(onward.length)return [exit,...onward];
   }
   return [];
  }
  for(const distance of [3,2,1,0]){
   const approach={x:spot.x-Math.sin(spot.yaw)*distance,y:.46,z:spot.z-Math.cos(spot.yaw)*distance,yaw:spot.yaw};
   const arrival=den.routineRoute(a,approach,spot),outbound=den.routineRoute(a,from,approach);
   if(arrival.length&&outbound.length)return [...outbound,...arrival.map(p=>({...p,yaw:spot.yaw}))];
  }
  return [];
 }
 const release=a=>{if(a.meetingPlace)places.release(a.meetingPlace,a.identity);a.meetingPlace=null;};
 function goHome(a){
  const spot=a.meetingTrip.spot;
  release(a);a.meetingOwned=false;a.meetingTrip={stage:'return',spot,path:[],wait:0,replans:0};a.meetingTrip.path=travelPath(a,a.meetingTrip);returning.add(a);
 }
 function destroy(a){places.disposeActor(a.identity);a.panda.model.removeFromParent();den.destroyPanda?.(a.panda.model);guests.delete(a.id);returning.delete(a);}
 function guestFor(resident,meeting,spot){
  if(!den.createPanda)return null;
  const id='meeting:'+meeting.id+':'+resident.role,identity=id;
  const candidates=den.walkWorld.nodes.filter(p=>Math.hypot(p.x-spot.x,p.z-spot.z)<18).sort((a,b)=>Math.hypot(a.x-spot.x,a.z-spot.z)-Math.hypot(b.x-spot.x,b.z-spot.z));
  let home=null;for(const position of candidates){const place=places.define({id:'staging:'+id,kind:'staging',position});if(!place.owner)place.position={...position};home=places.reserve(place.id,identity,resident.envelope);if(home)break;}
  if(!home)return null;
  const panda=den.createPanda(resident.role,{runtime:'claude'});if(panda.model.userData.modelUnavailable){den.destroyPanda(panda.model);places.disposeActor(identity);return null;}
  const a={...resident,id,identity,panda,home:new T.Vector3(home.position.x,home.position.y,home.position.z),homePlace:home.id,dock:null,live:null,outgoing:false,guest:true,outing:null,meetingTrip:null,moved:0};
  panda.model.position.copy(a.home);panda.model.userData.actorKey=id;den.residents.add(panda.model);places.occupy(home.id,identity);guests.set(id,a);return a;
 }
 function start(resident,meeting,spot){
  const busy=resident.role!=='orchestrator'&&resident.live&&resident.live.ref!==meeting.ref;
  const a=busy?guestFor(resident,meeting,spot):resident;if(!a)return null;
  routines.transfer(a);const id='meeting:'+meeting.id+':'+resident.role;
  let lease=null,path=[],chosen=null;
  const radius=Math.hypot(spot.x,spot.z+4)||1;
  for(const extra of [0,.5,1,1.5,2,2.5]){
   const position={x:spot.x+spot.x/radius*extra,y:.46,z:spot.z+(spot.z+4)/radius*extra};
   const place=places.define({id,kind:'meeting',position});if(!place.owner)place.position={...position};
   lease=places.reserve(id,a.identity,{...a.envelope,yaw:spot.yaw});if(!lease)continue;
   chosen={...spot,...position};path=travelPath(a,{stage:'outbound',spot:chosen});
   if(path.length)break;places.release(id,a.identity);lease=null;
  }
  if(!lease||!path.length){if(lease)places.release(id,a.identity);if(a.guest)destroy(a);return null;}
  a.meetingOwned=true;a.meetingPlace=id;a.meetingTrip={stage:'outbound',path,spot:chosen,wait:0,replans:0};a.path=path;return a;
 }
 function apply(meeting){
  const valid=seated(meeting),signature=valid?meeting.id+':'+meeting.seats.map(s=>s.role).join(','):null;
  if(signature!==current){for(const a of participants.values())if(a.guest)destroy(a);else goHome(a);participants.clear();current=signature;}
  if(!valid)return;
  const spots=seatSpots(meeting.seats.length);
  const bao=actors.get('orchestrator');
  if(bao&&!participants.has('orchestrator')&&!bao.meetingTrip){const chair=start(bao,meeting,{x:0,z:-11,yaw:0});if(chair)participants.set('orchestrator',chair);}
  meeting.seats.forEach((seat,i)=>{
   const resident=[...actors.values()].find(a=>a.role===seat.role&&a.runtime==='claude');if(!resident)return;
   const old=participants.get(seat.role),busy=resident.live&&resident.live.ref!==meeting.ref;
   if(old&&!old.guest&&busy){goHome(old);participants.delete(seat.role);}
   if(!participants.has(seat.role)&&!resident.meetingTrip){const a=start(resident,meeting,spots[i]);if(a)participants.set(seat.role,a);}
  });
 }
 function update(dt,reduced=false){
  for(const a of [...participants.values(),...returning]){
   const trip=a.meetingTrip;if(!trip)continue;if(a.guest)a.moved=0;
   const p=a.panda.model.position;let left=reduced?Infinity:dt*(a.live?ROUTINE_POLICY.returnSpeed:ROUTINE_POLICY.walkSpeed);a.path=trip.path;
   while(trip.path.length&&left>0){
    const next=trip.path[0],distance=Math.hypot(next.x-p.x,next.z-p.z),travel=Math.min(left,distance),k=distance?travel/distance:1;
    const target={x:p.x+(next.x-p.x)*k,y:p.y+(next.y-p.y)*k,z:p.z+(next.z-p.z)*k};
    if(den.walkWorld.supportAt){const y=den.walkWorld.supportAt(target.x,target.z);if(y===null)break;target.y=y+.045;}
    if(!den.routineClear(a,p,target)){
     trip.blocked=true;break;
    }
    trip.wait=0;trip.blocked=false;if(distance>1e-6)a.yaw=next.yaw??Math.atan2(next.x-p.x,next.z-p.z);p.set(target.x,target.y,target.z);left-=travel;if(!reduced)a.moved+=travel;places.clearDeparted(a.identity,p,a.envelope);if(travel>=distance-1e-6)trip.path.shift();
   }
   if(!trip.path.length){
    const end=trip.stage==='return'?a.home:{x:trip.spot.x,y:.46,z:trip.spot.z};if(Math.hypot(p.x-end.x,p.z-end.z)>.02){trip.blocked=true;}else{
    if(trip.stage==='return'){if(a.guest){destroy(a);continue;}if(!den.routineClear(a,p,a.home))continue;p.copy(a.home);a.meetingTrip=null;a.path=null;a.yaw=null;returning.delete(a);places.occupy(a.homePlace,a.identity);}
    else{trip.stage='seated';a.yaw=trip.spot.yaw;places.occupy(a.meetingPlace,a.identity);}trip.blocked=false;
    }
   }
   if(trip.blocked){
    trip.wait+=dt;
    if(trip.wait>=2){
     const state=snapshot();
     if(trip.replans===0||trip.blockedSnapshot!==state){trip.replans++;trip.blockedSnapshot=state;trip.path=travelPath(a,trip);trip.blocked=!trip.path.length;}
     trip.wait=0;
    }
   }
   if(a.guest){a.panda.model.rotation.y=a.yaw??a.baseYaw;if(a.moved){a.gait=(a.gait||0)+a.moved/a.panda.model.scale.x/(a.panda.rig.profile?.gait?.stride??WADDLE.stride)*(a.panda.rig.profile?.gait?.duration??WADDLE.duration);a.panda.rig.poseWaddle(a.gait,{groundAt:den.walkWorld.supportAt});}else a.panda.rig.poseIdle(0,{reducedMotion:true});if(trip.stage==='seated')a.panda.rig.poseSit?.(1);}
  }
 }
 return {apply,update,seatModels:()=>new Map([...participants].filter(([role,a])=>role!=='orchestrator'&&a.meetingTrip?.stage==='seated').map(([role,a])=>[role,a.panda.model])),seatOf:id=>{for(const [role,a]of participants)if(a.id===id||role===id||'meeting:'+role===id)return {role};return null;},dispose(){for(const a of participants.values()){release(a);a.meetingOwned=false;a.meetingTrip=null;}for(const a of [...guests.values()])destroy(a);for(const a of returning){a.meetingOwned=false;a.meetingTrip=null;}participants.clear();returning.clear();guests.clear();}};
}
