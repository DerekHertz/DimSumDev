import * as T from 'three';
import {seated,seatSpots} from './meeting-table.mjs';
import {WADDLE} from './panda-rig.mjs';

// Physical presentation only. The bridge's meeting snapshot remains the owner
// of discussion, execution, pauses and decisions.
export function createMeetingResidents(den,actors,places,routines){
 const participants=new Map(),returning=new Set(),guests=den.guestActors=new Map();let current=null;
 const release=a=>{if(a.meetingPlace)places.release(a.meetingPlace,a.identity);a.meetingPlace=null;};
 function goHome(a){
  release(a);a.meetingOwned=false;a.meetingTrip={stage:'return',path:den.routineRoute(a,a.panda.model.position,a.home),wait:0,replans:0};returning.add(a);
 }
 function destroy(a){places.disposeActor(a.identity);a.panda.model.removeFromParent();den.destroyPanda?.(a.panda.model);guests.delete(a.id);returning.delete(a);}
 function guestFor(resident,meeting){
  if(!den.createPanda)return null;
  const id='meeting:'+meeting.id+':'+resident.role,identity=id;
  const candidates=den.walkWorld.nodes.filter(p=>Math.hypot(p.x-resident.home.x,p.z-resident.home.z)<16).sort((a,b)=>Math.hypot(a.x-resident.home.x,a.z-resident.home.z)-Math.hypot(b.x-resident.home.x,b.z-resident.home.z));
  let home=null;for(const position of candidates){places.define({id:'staging:'+id,kind:'staging',position});home=places.reserve('staging:'+id,identity,resident.envelope);if(home)break;const old=places.get('staging:'+id);if(old&&!old.owner)old.position={...position};}
  if(!home)return null;
  const panda=den.createPanda(resident.role,{runtime:'claude'});if(panda.model.userData.modelUnavailable){den.destroyPanda(panda.model);places.disposeActor(identity);return null;}
  const a={...resident,id,identity,panda,home:new T.Vector3(home.position.x,home.position.y,home.position.z),homePlace:home.id,dock:null,live:null,outgoing:false,guest:true,outing:null,meetingTrip:null,moved:0};
  panda.model.position.copy(a.home);panda.model.userData.actorKey=id;den.residents.add(panda.model);places.occupy(home.id,identity);guests.set(id,a);return a;
 }
 function start(resident,meeting,spot){
  const busy=resident.live&&resident.live.ref!==meeting.ref;
  const a=busy?guestFor(resident,meeting):resident;if(!a)return null;
  routines.transfer(a);const id='meeting:'+meeting.id+':'+resident.role;
  const position={x:spot.x,y:.46,z:spot.z};places.define({id,kind:'meeting',position});
  const lease=places.reserve(id,a.identity,{...a.envelope,yaw:spot.yaw});
  const path=lease?den.routineRoute(a,a.panda.model.position,position):[];
  if(!lease||!path.length){if(lease)places.release(id,a.identity);if(a.guest)destroy(a);return null;}
  a.meetingOwned=true;a.meetingPlace=id;a.meetingTrip={stage:'outbound',path,spot,wait:0,replans:0};a.path=path;return a;
 }
 function apply(meeting){
  const valid=seated(meeting),signature=valid?meeting.id+':'+meeting.seats.map(s=>s.role).join(','):null;
  if(signature!==current){for(const a of participants.values())goHome(a);participants.clear();current=signature;}
  if(!valid)return;
  const spots=seatSpots(meeting.seats.length);
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
   const p=a.panda.model.position;let left=reduced?Infinity:dt*(a.live?4:3);a.path=trip.path;
   while(trip.path.length&&left>0){
    const next=trip.path[0],distance=Math.hypot(next.x-p.x,next.z-p.z),travel=Math.min(left,distance),k=distance?travel/distance:1;
    const target={x:p.x+(next.x-p.x)*k,y:p.y+(next.y-p.y)*k,z:p.z+(next.z-p.z)*k};
    if(!den.routineClear(a,p,target)){
     trip.wait+=dt;if(trip.wait>=2&&trip.replans<1){trip.replans++;trip.path=den.routineRoute(a,p,trip.stage==='return'?a.home:{x:trip.spot.x,y:.46,z:trip.spot.z});}break;
    }
    trip.wait=0;if(distance>1e-6)a.yaw=next.yaw??Math.atan2(next.x-p.x,next.z-p.z);p.set(target.x,target.y,target.z);left-=travel;if(!reduced)a.moved+=travel;places.clearDeparted(a.identity,p,a.envelope);if(travel>=distance-1e-6)trip.path.shift();
   }
   if(!trip.path.length){
    const end=trip.stage==='return'?a.home:{x:trip.spot.x,y:.46,z:trip.spot.z};if(Math.hypot(p.x-end.x,p.z-end.z)>.02)continue;
    if(trip.stage==='return'){if(a.guest){destroy(a);continue;}a.meetingTrip=null;a.path=null;a.yaw=null;returning.delete(a);places.occupy(a.homePlace,a.identity);}
    else{trip.stage='seated';a.yaw=trip.spot.yaw;places.occupy(a.meetingPlace,a.identity);}
   }
   if(a.guest){a.panda.model.rotation.y=a.yaw??a.baseYaw;if(a.moved){a.gait=(a.gait||0)+a.moved/a.panda.model.scale.x/WADDLE.stride*WADDLE.duration;a.panda.rig.poseWaddle(a.gait);}else a.panda.rig.poseIdle(0,{reducedMotion:true});if(trip.stage==='seated')a.panda.rig.poseSit?.(1);}
  }
 }
 return {apply,update,seatModels:()=>new Map([...participants].filter(([,a])=>a.meetingTrip?.stage==='seated').map(([role,a])=>[role,a.panda.model])),seatOf:id=>{for(const [role,a]of participants)if(a.id===id||role===id||'meeting:'+role===id)return {role};return null;},dispose(){for(const a of participants.values()){release(a);a.meetingOwned=false;a.meetingTrip=null;}for(const a of [...guests.values()])destroy(a);for(const a of returning){a.meetingOwned=false;a.meetingTrip=null;}participants.clear();returning.clear();guests.clear();}};
}
