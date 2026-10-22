import {CHARACTERS} from '../procedural/restaurant.mjs';
import {actorBindings} from './layout.mjs';
import {createActorHomes} from './actor-homes.mjs';
import {createDailyRoutines} from './daily-routines.mjs';
import {createLeisureGesture} from './leisure-gesture.mjs';
import {TRAVEL_SPEED_SCALE} from './travel-speed.mjs';
import {WADDLE} from './panda-rig.mjs';
import {RESIDENTS,sameResident,boundAgentKey} from '../../shell/resident-inventory.mjs';

// Homes first, then leisure outings (den-revival/07): idle residents walk from their owned homes to tea, the pond
// and greetings, and a live run sends them straight back. Meeting travel and extra bodies stay deferred;
// their live work remains in Team without borrowing another run's scene anchor.
const RETURNING='Working · returning to desk';
export function createMeshyActors(den){
 const actors=new Map(),definitions=new Map(CHARACTERS.map(c=>[c[0],c]));let bindings=new Map(),selected=null,time=0,held=null;
 const homes=createActorHomes(den,actors),places=homes.places;
 for(const source of den.propManifest){
  const model=den.roleWorkspaces.workspaces.get(source.id)?.person;if(!model)continue;
  const identity=RESIDENTS.find(r=>r.id===source.id),legacy=definitions.get(source.id),role=identity?.role||legacy[0],name=identity?.name||legacy[1],team=identity?.team||legacy[2],concept=identity?!identity.dispatchable:legacy[5],runtime=identity?.runtime||'claude';
  const a={id:source.id,role,runtime,name,team,concept:!!concept,stationary:role==='orchestrator',panda:{model,rig:den.pandaRigs.get(model).rig},home:model.position.clone(),baseYaw:model.rotation.y,index:actors.size,state:'idle',activity:role==='orchestrator'?'Hosting the Den':'At the workspace',live:null};
  homes.prepare(a);a.homeNote=a.presentation;actors.set(source.id,a);
 }
 const routines=createDailyRoutines(den,actors,{speed:.65*TRAVEL_SPEED_SCALE});
 const note=a=>{a.presentation=a.live&&a.outing?RETURNING:a.homeNote;};
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
  if(!reduced)time+=Math.min(dt,.1);
  routines.update(Math.min(dt,.1),reduced,held);
  for(const [key,a]of actors){
   const p=a.panda.model,visit=!reduced&&a.outing?.stage==='visit'?a.outing:null;note(a);
   if(a.moved)a.gait=(a.gait||0)+a.moved/p.scale.x/WADDLE.stride*WADDLE.duration;
   p.rotation.y=a.yaw??a.baseYaw;
   if(key===held&&!reduced)continue;
   if(a.moved)a.panda.rig.poseWaddle(a.gait);else a.panda.rig.poseIdle(time+a.index*.63,{reducedMotion:reduced});
   if(visit)(a.gesture??=createLeisureGesture(a.panda.rig)).pose(visit.spot.kind,visit.elapsed);else a.gesture?.pose(null,0);
  }
 }
 // The walker keeps a body's width from every resident, wherever it stands now.
 den.walkAvoid=()=>[...actors.values()].filter(a=>a.panda.model.visible).map(a=>({x:a.panda.model.position.x,z:a.panda.model.position.z,r:.65}));
 return {actors,places,applyLive,applyMeeting(){},seatModels:()=>new Map(),seatOf:()=>null,setSelected,hold(key=null){held=key;},liveFigures,presentationRows,update,dispose(){routines.dispose();for(const a of actors.values())a.gesture?.dispose();homes.dispose();actors.clear();}};
}
