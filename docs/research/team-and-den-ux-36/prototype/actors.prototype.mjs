import {CHARACTERS} from '../procedural/restaurant.mjs';
import {actorBindings} from './layout.mjs';
import {WADDLE} from './panda-rig.mjs';
import {seatSpots,seated} from './meeting-table.mjs';
import {createDailyRoutines} from './daily-routines.mjs';
import {createLeisureGesture} from './leisure-gesture.mjs';
import {TRAVEL_SPEED_SCALE} from './travel-speed.mjs';
import {createActorPlaces} from './actor-places.mjs';
import {RESIDENTS,residentKey,runtimeOf,sameResident,boundAgentKey} from '../../shell/resident-inventory.mjs';
const travelSpeed=.65*TRAVEL_SPEED_SCALE;
export function createMeshyActors(den){globalThis.__h13Observe?.('world-ready',{den});
 const actors=new Map(),definitions=new Map(CHARACTERS.map(c=>[c[0],c]));let bindings=new Map(),selected=null,time=0,held=null;
 const transport=createActorPlaces(den,actors,travelSpeed),places=transport.places;
 // den-mvp/64: the meeting at Bao's table. holders maps a seated role to the actor key sitting for it.
 let meeting=null;const holders=new Map();
 for(const source of den.propManifest){
  const model=den.roleWorkspaces.workspaces.get(source.id)?.person;if(!model)continue;
  const identity=RESIDENTS.find(r=>r.id===source.id),legacy=definitions.get(source.id),role=identity?.role||legacy[0],name=identity?.name||legacy[1],team=identity?.team||legacy[2],concept=identity?!identity.dispatchable:legacy[5],runtime=identity?.runtime||'claude',home=model.position.clone();
  const rig=den.pandaRigs.get(model).rig;
  const a={id:source.id,role,runtime,name,team,concept:!!concept,stationary:role==='orchestrator',panda:{model,rig},gesture:createLeisureGesture(rig),home,approach:source.approach?home.clone().fromArray(source.approach):null,baseYaw:model.rotation.y,index:actors.size,state:'idle',activity:role==='orchestrator'?'Hosting the Den':'At the workspace',live:null};
  transport.prepare(a);actors.set(source.id,a);
 }
 const routines=createDailyRoutines(den,actors,transport);
 // Copies share resident metadata, never its mutable ownership, travel or meeting state.
 function copyActor(base,id,panda,name,extra){return{id,role:base.role,runtime:base.runtime,name,team:base.team,concept:base.concept,stationary:false,panda,gesture:null,routine:null,leaving:false,arriving:false,identity:null,homePlace:null,travel:null,home:base.home.clone(),approach:base.approach?.clone(),index:actors.size,live:null,state:'idle',activity:'At the workspace',baseYaw:base.baseYaw,path:null,seat:null,seatRole:null,seatRequest:null,seatMeeting:null,visitor:false,guest:false,...extra};}
 function addVisitor(key,row){
  const base=actors.get(residentKey(row.role,runtimeOf(row)));if(!base)return null;
  const panda=den.createPanda(row.role,{runtime:base.runtime}),{model}=panda;
  model.name=base.name+' · visitor';model.userData={...model.userData,roleId:row.role,actorKey:key};
  den.residents.add(model);
  const actor=copyActor(base,key,panda,base.name+' (visitor)',{live:row,visitor:true});
  transport.prepare(actor,'visitor',base.home,{arrival:true});
  actors.set(key,actor);return actor;
 }
 function applyLive(rows=[],sharedBindings=null){
  bindings=sharedBindings ? new Map(sharedBindings) : actorBindings(rows,bindings,{meeting});
  for(const [key,a]of actors)if(a.visitor&&!bindings.has(key)){transport.remove(a);den.destroyPanda(a.panda.model);actors.delete(key);}
  // Meeting bodies are created/seated by applyMeeting, never as generic visitors.
  for(const [key,row]of bindings){if(!actors.has(key)&&key.startsWith('meeting:'))continue;const a=actors.get(key)||addVisitor(key,row);if(a)a.live=row;}
  for(const [key,a]of actors){
   a.live=bindings.get(key)||null;a.state=a.live?.state||'idle';a.activity=a.live?.activity||(a.role==='orchestrator'?'Hosting the Den':'At the workspace');
   transport.bind(a,a.live);
   if(a.live)routines.interrupt(a);
   a.panda.model.userData.ticketRef=a.live?.ref;delete a.panda.model.userData.selected;
  }
  setSelected(selected);
 }
 // Seat the table's meeting: a free resident sits for its role; a busy one keeps working and a guest copy sits in.
 function sendHome(key,a){routines.cancel(a);a.seat=null;a.seatRole=null;a.leaving=true;transport.home(a);}
 function seatActor(role,ref){
  const resident=actors.get(role);if(!resident||resident.stationary)return null;
  if(!resident.live||resident.live.ref===ref)return role;
  const key='meeting:'+role;if(actors.has(key))return key;
  const panda=den.createPanda(role,{runtime:resident.panda.model.userData.runtime||'claude'}),{model}=panda;
  model.name=resident.name+' · at the table';model.userData={...model.userData,roleId:role,actorKey:key};model.position.copy(resident.home);den.residents.add(model);
  const a=copyActor(resident,key,panda,resident.name+' (at the table)',{guest:true});
  transport.prepare(a,'visitor',resident.home);actors.set(key,a);
  return key;
 }
 function applyMeeting(m){
  const roles=seated(m)?m.seats.map(s=>s.role):[],spots=seatSpots(roles.length),want=new Map(roles.map((r,i)=>[r,spots[i]]));
  for(const [role,key]of [...holders]){
   const a=actors.get(key);
   if(!want.has(role)||meeting?.id!==m?.id||(!a?.guest&&a?.live&&a.live.ref!==m?.ref)){holders.delete(role);if(a)sendHome(key,a);}
  }
  meeting=seated(m)?m:null;
  for(const [role,spot]of want){
   let key=holders.get(role);if(!key||!actors.has(key)){key=seatActor(role,m.ref);if(!key)continue;holders.set(role,key);}
   const a=actors.get(key);
   if(a.seatRequest?.x!==spot.x||a.seatRequest?.z!==spot.z||a.seatMeeting!==m.id){
    routines.cancel(a);a.seatRequest=spot;a.seatMeeting=m.id;a.seatRole=role;a.leaving=false;
    const place=transport.destination(a,{id:`meeting:${m.id}:${role}`,kind:'meeting',position:spot});
    a.seat=place?{...place.position,yaw:spot.yaw}:null;transport.go(a,place);
   }
  }
  // Join the newly created guest immediately, and move returning meeting runs
  // back to their ordinary visitor/resident identity when the table clears.
  applyLive([...bindings.values()]);
 }
 // The models the label layer hangs a seat's label over, by role; Bao is 'orchestrator'.
 function seatModels(){const out=new Map();for(const [role,key]of holders){const a=actors.get(key);if(a?.panda.model.visible)out.set(role,a.panda.model);}const bao=actors.get('orchestrator');if(bao?.panda.model.visible)out.set('orchestrator',bao.panda.model);return out;}
 function seatOf(key){const a=actors.get(key);return a?.seatRole?{meeting:meeting?.id,role:a.seatRole}:null;}
 function setSelected(identity=null){selected=identity;for(const a of actors.values()){const target=typeof identity==='string'?{role:a.role,ref:identity,runtime:'claude'}:identity;a.panda.model.userData.selected=!!a.live&&!!target&&a.live.ref===target.ref&&sameResident(a.live,target);}}
 function liveFigures(){const out=new Map();for(const a of actors.values())if(a.live&&a.panda.model.visible)out.set(boundAgentKey(a.live),{...a.live,model:a.panda.model,panda:a.panda});return out;}
 function presentationRows(){return [...actors.values()].filter(a=>a.presentation).map(a=>({id:a.id,role:a.role,runtime:a.runtime,ref:a.live?.ref??null,agentId:a.live?.agentId??null,guest:a.guest===true,presentation:a.presentation}));}
 function hold(key=null){held=key;}
 function update(dt,reduced=false){
  dt=Math.min(dt,.1);
  if(!reduced)time+=dt;
  routines.update(dt,reduced,held);
  const before=new Map([...actors].map(([key,a])=>[key,a.panda.model.position.clone()]));
  transport.update(dt,reduced,held);
  for(const [key,a]of actors){const p=a.panda.model,moved=a.travelMoved||0,previous=before.get(key);
   if(moved&&!reduced)a.gait=(a.gait||0)+moved/p.scale.x/WADDLE.stride*WADDLE.duration;
   if(moved)p.rotation.y=Math.atan2(p.position.x-previous.x,p.position.z-previous.z);
   if(a.travel?.status==='arrived'){
    a.arriving=false;a.routeGoal=null;
    if(a.leaving){a.leaving=false;if(a.guest){transport.remove(a);den.destroyPanda(p);actors.delete(key);continue;}}
   }
   const yaw=a.seat?a.seat.yaw:a.baseYaw;
   if(!a.arriving&&!a.path&&a.routine?.stage!=='visit')p.rotation.y=yaw;
   if(key===held&&!reduced)continue;
   // team-and-den-ux/23: species with a seated pose sit once they reach their meeting seat.
   const sits=a.seat&&a.travel?.status==='arrived'&&!a.arriving&&a.panda.rig.profile?.sit;
   if(moved&&!reduced)a.panda.rig.poseWaddle(a.gait);else if(sits)a.panda.rig.poseSit(time+a.index*.63,{reducedMotion:reduced});else a.panda.rig.poseIdle(time+a.index*.63,{reducedMotion:reduced});
   a.gesture?.pose(!reduced&&a.routine?.stage==='visit'?a.routine.spot.kind:null,a.routine?.elapsed||0);
  }
 }
 // The walker keeps a body's width from every resident, species included: a species envelope covers its tail and props
 // for layout checks, and a walker caught inside one that wide could not step out.
 den.walkAvoid=()=>[...actors.values()].filter(a=>a.panda.model.visible).map(a=>({x:a.panda.model.position.x,z:a.panda.model.position.z,r:.65}));
 return {actors,places,applyLive,applyMeeting,seatModels,seatOf,setSelected,hold,liveFigures,presentationRows,update,dispose(){routines.dispose();for(const a of actors.values()){transport.remove(a);a.gesture?.dispose();if(a.visitor||a.guest)den.destroyPanda(a.panda.model);}transport.dispose();actors.clear();}};
}
