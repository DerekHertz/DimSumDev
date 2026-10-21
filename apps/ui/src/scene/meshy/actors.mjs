import {CHARACTERS} from '../procedural/restaurant.mjs';
import {actorBindings} from './layout.mjs';
import {createActorHomes} from './actor-homes.mjs';
import {RESIDENTS,sameResident,boundAgentKey} from '../../shell/resident-inventory.mjs';

// Homes-first slice. Tea trips, meeting travel and extra bodies are deferred;
// their live work remains in Team without borrowing another run's scene anchor.
export function createMeshyActors(den){
 const actors=new Map(),definitions=new Map(CHARACTERS.map(c=>[c[0],c]));let bindings=new Map(),selected=null,time=0,held=null;
 const homes=createActorHomes(den,actors),places=homes.places;
 for(const source of den.propManifest){
  const model=den.roleWorkspaces.workspaces.get(source.id)?.person;if(!model)continue;
  const identity=RESIDENTS.find(r=>r.id===source.id),legacy=definitions.get(source.id),role=identity?.role||legacy[0],name=identity?.name||legacy[1],team=identity?.team||legacy[2],concept=identity?!identity.dispatchable:legacy[5],runtime=identity?.runtime||'claude';
  const a={id:source.id,role,runtime,name,team,concept:!!concept,stationary:role==='orchestrator',panda:{model,rig:den.pandaRigs.get(model).rig},home:model.position.clone(),baseYaw:model.rotation.y,index:actors.size,state:'idle',activity:role==='orchestrator'?'Hosting the Den':'At the workspace',live:null};
  homes.prepare(a);actors.set(source.id,a);
 }
 function applyLive(rows=[],sharedBindings=null){
  // Shared bindings retain every run even though only residents have bodies.
  bindings=sharedBindings?new Map(sharedBindings):actorBindings(rows,bindings);
  for(const [key,a]of actors){
   a.live=bindings.get(key)||null;a.state=a.live?.state||'idle';a.activity=a.live?.activity||(a.role==='orchestrator'?'Hosting the Den':'At the workspace');
   homes.bind(a,a.live);a.panda.model.userData.ticketRef=a.live?.ref;delete a.panda.model.userData.selected;
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
  for(const [key,a]of actors){if(key===held&&!reduced)continue;a.panda.rig.poseIdle(time+a.index*.63,{reducedMotion:reduced});}
 }
 den.walkAvoid=()=>[...actors.values()].filter(a=>a.panda.model.visible).map(a=>({x:a.home.x,z:a.home.z,r:.65}));
 return {actors,places,applyLive,applyMeeting(){},seatModels:()=>new Map(),seatOf:()=>null,setSelected,hold(key=null){held=key;},liveFigures,presentationRows,update,dispose(){homes.dispose();actors.clear();}};
}
