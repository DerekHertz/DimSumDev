import {CHARACTERS} from '../procedural/restaurant.mjs';
import {actorBindings} from './layout.mjs';
import {createActorHomes} from './actor-homes.mjs';
import {createDailyRoutines} from './daily-routines.mjs';
import {createLeisureGesture} from './leisure-gesture.mjs';
import {TRAVEL_SPEED_SCALE} from './travel-speed.mjs';
import {WADDLE} from './panda-rig.mjs';
import {bindResidentNavigation} from './approved-navigation.mjs';
import {createMeetingResidents} from './meeting-residents.mjs';
import {RESIDENTS,sameResident,boundAgentKey} from '../../shell/resident-inventory.mjs';

const RETURNING='Working · returning to desk';
export function createMeshyActors(den){
 const actors=new Map(),definitions=new Map(CHARACTERS.map(c=>[c[0],c]));let bindings=new Map(),selected=null,time=0,held=null,hidden=false;
 const homes=createActorHomes(den,actors),places=homes.places;
 for(const source of den.propManifest){
  const model=den.roleWorkspaces.workspaces.get(source.id)?.person;if(!model)continue;
  const identity=RESIDENTS.find(r=>r.id===source.id),legacy=definitions.get(source.id),role=identity?.role||legacy[0],name=identity?.name||legacy[1],team=identity?.team||legacy[2],concept=identity?!identity.dispatchable:legacy[5],runtime=identity?.runtime||'claude';
  const a={id:source.id,role,runtime,name,team,teamId:source.teamId??team,concept:!!concept,stationary:role==='orchestrator'||!!model.userData.modelUnavailable,dock:source,panda:{model,rig:den.pandaRigs.get(model).rig},home:model.position.clone(),baseYaw:model.rotation.y,index:actors.size,state:'idle',activity:role==='orchestrator'?'Hosting the Den':'At the workspace',live:null};
  homes.prepare(a);a.homeNote=model.userData.modelUnavailable?'Model unavailable — reload to retry; available in Team':a.presentation;model.userData.home=a.home;actors.set(source.id,a);
 }
 den.placeRegistry=places;if(den.garden?.approved)bindResidentNavigation(den,actors);
 const routines=createDailyRoutines(den,actors);
 const meetings=den.garden?.approved?createMeetingResidents(den,actors,places,routines):null;
 const note=a=>{a.presentation=a.meetingTrip?.blocked?'Waiting for a clear route '+(a.meetingTrip.stage==='return'?'home':'to the meeting'):a.live&&(a.outing||a.meetingTrip?.stage==='return')?RETURNING:a.outing?(a.outing.stage==='return'?'Returning home':a.outing.stage==='outbound'?'Going to '+a.outing.spot.kind:({tea:'Taking tea',pond:'Watching the pond',rest:'Resting',games:'Playing mahjong',friend:'Visiting '+a.outing.host?.name}[a.outing.spot.kind])):a.homeNote;};
 function applyLive(rows=[],sharedBindings=null){
  // Shared bindings retain every run even though only residents have bodies.
  bindings=sharedBindings?new Map(sharedBindings):actorBindings(rows,bindings);
  for(const [key,a]of actors){
   a.live=bindings.get(key)||null;a.state=a.live?.state||'idle';a.activity=a.live?.activity||(a.role==='orchestrator'?'Hosting the Den':'At the workspace');
   homes.bind(a,a.live);note(a);a.panda.model.userData.ticketRef=a.live?.ref;delete a.panda.model.userData.selected;
  }
  setSelected(selected);
 }
 function setSelected(identity=null){selected=identity;for(const a of actors.values()){const target=typeof identity==='string'?{role:a.role,ref:identity,runtime:'claude'}:identity;a.panda.model.userData.selected=!!a.live&&!!target&&a.live.ref===target.ref&&sameResident(a.live,target);}}
 function liveFigures(){const out=new Map();for(const a of actors.values())if(a.live&&a.panda.model.visible)out.set(boundAgentKey(a.live),{...a.live,model:a.panda.model,panda:a.panda});return out;}
 function presentationRows(){
  return [...[...actors.values()].filter(a=>a.presentation).map(a=>({id:a.id,role:a.role,runtime:a.runtime,ref:a.live?.ref??null,agentId:a.live?.agentId??null,presentation:a.presentation})),
   ...[...bindings].filter(([id])=>!actors.has(id)).map(([id,row])=>({id,...row,guest:id.startsWith('meeting:'),presentation:'Scene visitor deferred — available in Team'}))];
 }
 function update(dt,reduced=false){
  if(hidden)return;
  if(!reduced)time+=Math.min(dt,.1);
  if(!reduced||den.garden?.approved)routines.update(Math.min(dt,.1),reduced,held);
  meetings?.update(Math.min(dt,.1),reduced);
  for(const [key,a]of actors){
   const p=a.panda.model,visit=!reduced&&a.outing?.stage==='visit'?a.outing:null;note(a);
   if(a.moved)a.gait=(a.gait||0)+a.moved/p.scale.x/(a.panda.rig.profile?.gait?.stride??WADDLE.stride)*(a.panda.rig.profile?.gait?.duration??WADDLE.duration);
   if(key===held&&!reduced)continue;
   p.rotation.y=a.yaw??a.baseYaw;
   if(a.mount!=null&&!reduced)a.panda.rig.poseMount(a.mount);else if(a.moved)a.panda.rig.poseWaddle(a.gait,{groundAt:den.walkWorld.supportAt});else a.panda.rig.poseIdle(time+a.index*.63,{reducedMotion:reduced||!!a.live});
   if(a.meetingTrip?.stage==='seated')a.panda.rig.poseSit?.(1,{grounded:true,reducedMotion:reduced});
   if(visit&&!a.panda.model.userData.modelUnavailable){if(a.panda.rig.profile?.sit&&['rest','tea','pond','games'].includes(visit.spot.kind))a.panda.rig.poseSit(1);(a.gesture??=createLeisureGesture(a.panda.rig)).pose(visit.spot.kind==='games'?'mahjong':visit.spot.kind==='friend'?'greeting':visit.spot.kind,visit.elapsed);}else a.gesture?.pose(null,0);
  }
 }
 // The walker keeps a body's width from every resident, wherever it stands now.
 den.walkAvoid=()=>[...actors.values()].filter(a=>a.panda.model.visible).map(a=>({x:a.panda.model.position.x,z:a.panda.model.position.z,r:.65}));
 return {actors,places,routines,setHidden(value){hidden=!!value;routines.setHidden(value);},applyLive,applyMeeting:meeting=>meetings?.apply(meeting),seatModels:()=>meetings?.seatModels()||new Map(),seatOf:id=>meetings?.seatOf(id)||null,setSelected,hold(key=null){held=key;},liveFigures,presentationRows,update,dispose(){meetings?.dispose();routines.dispose();for(const a of actors.values())a.gesture?.dispose();homes.dispose();actors.clear();}};
}
