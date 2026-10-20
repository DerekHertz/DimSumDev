import * as THREE from 'three';
import {CHARACTERS} from '../procedural/restaurant.mjs';
import {actorBindings} from './layout.mjs';
import {WADDLE} from './panda-rig.mjs';
import {gardenRoute} from './garden-route.mjs';
import {isWalkBlocked} from '../procedural/walk.mjs';
import {seatSpots,seated} from './meeting-table.mjs';
import {createDailyRoutines} from './daily-routines.mjs';
import {createLeisureGesture} from './leisure-gesture.mjs';
import {TRAVEL_SPEED_SCALE} from './travel-speed.mjs';
import {RESIDENTS,residentKey,runtimeOf,sameResident,boundAgentKey} from '../../shell/resident-inventory.mjs';
const travelSpeed=.65*TRAVEL_SPEED_SCALE;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
export function createMeshyActors(den){
 const actors=new Map(),definitions=new Map(CHARACTERS.map(c=>[c[0],c]));let bindings=new Map(),selected=null,time=0,held=null;
 // den-mvp/64: the meeting at Bao's table. holders maps a seated role to the actor key sitting for it.
 let meeting=null;const holders=new Map();
 for(const source of den.propManifest){
  const model=den.roleWorkspaces.workspaces.get(source.id)?.person;if(!model)continue;
  const identity=RESIDENTS.find(r=>r.id===source.id),legacy=definitions.get(source.id),role=identity?.role||legacy[0],name=identity?.name||legacy[1],team=identity?.team||legacy[2],concept=identity?!identity.dispatchable:legacy[5],runtime=identity?.runtime||'claude',home=model.position.clone();
  const rig=den.pandaRigs.get(model).rig;
  actors.set(source.id,{id:source.id,role,runtime,name,team,concept:!!concept,stationary:role==='orchestrator',panda:{model,rig},gesture:createLeisureGesture(rig),home,baseYaw:model.rotation.y,index:actors.size,state:'idle',activity:role==='orchestrator'?'Hosting the Den':'At the workspace',live:null});
 }
 const routines=createDailyRoutines(den,actors);
 function clearPoint(base,index){
  const others=[...actors.values()].map(a=>a.home);
  for(let ring=1;ring<=7;ring++)for(let step=0;step<18;step++){
   const angle=index*.91+step*Math.PI/9,r=1.25+ring*.55,p={x:base.x+Math.sin(angle)*r,z:base.z+Math.cos(angle)*r};
   const ground=den.walkWorld.navigation ? den.walkWorld.navigation.groundAt(p.x,p.z,base.y,.45) : 0;
   if(ground===null||isWalkBlocked(p.x,p.z,{...den.walkWorld,groundY:ground})||others.some(a=>distance(a,p)<1.4))continue;
   return new THREE.Vector3(p.x,ground,p.z);
  }
  return base.clone();
 }
 function addVisitor(key,row){
  const base=actors.get(residentKey(row.role,runtimeOf(row)));if(!base)return null;
  const panda=den.createPanda(row.role,{runtime:base.runtime}),{model}=panda,home=clearPoint(base.home,actors.size);
  model.name=base.name+' · visitor';model.userData={...model.userData,roleId:row.role,actorKey:key};
  model.position.copy(home);den.residents.add(model);
  const actor={...base,id:key,name:base.name+' (visitor)',panda,gesture:null,routine:null,leaving:false,home,index:actors.size,live:row,visitor:true,baseYaw:base.baseYaw,path:null,seat:null,guest:false};
  // A short arrival uses the same independent skeleton as a meeting walk.
  for(const side of [1,-1]){
   const start=home.clone().add(new THREE.Vector3(side*.9,0,.6));
   if([0,.25,.5,.75,1].every(t=>{const p=start.clone().lerp(home,t);return !isWalkBlocked(p.x,p.z,{...den.walkWorld,groundY:home.y});})) {model.position.copy(start);actor.arriving=true;break;}
  }
  actors.set(key,actor);return actor;
 }
 function applyLive(rows=[],sharedBindings=null){
  bindings=sharedBindings ? new Map(sharedBindings) : actorBindings(rows,bindings,{meeting});
  for(const [key,a]of actors)if(a.visitor&&!bindings.has(key)){den.destroyPanda(a.panda.model);actors.delete(key);}
  // Meeting bodies are created/seated by applyMeeting, never as generic visitors.
  for(const [key,row]of bindings){if(!actors.has(key)&&key.startsWith('meeting:'))continue;const a=actors.get(key)||addVisitor(key,row);if(a)a.live=row;}
  for(const [key,a]of actors){
   a.live=bindings.get(key)||null;a.state=a.live?.state||'idle';a.activity=a.live?.activity||(a.role==='orchestrator'?'Hosting the Den':'At the workspace');
   if(a.live)routines.interrupt(a);
   a.panda.model.userData.ticketRef=a.live?.ref;delete a.panda.model.userData.selected;
  }
  setSelected(selected);
 }
 // Seat the table's meeting: a free resident sits for its role; a busy one keeps working and a guest copy sits in.
 function travel(a,to){a.path=gardenRoute(den.walkWorld,a.panda.model.position,to);a.routeGoal=to;a.routeTries=1;a.retryAt=time+8;}
 function sendHome(key,a){routines.cancel(a);a.seat=null;a.seatRole=null;travel(a,a.home);a.leaving=true;}
 function seatActor(role,ref){
  const resident=actors.get(role);if(!resident||resident.stationary)return null;
  if(!resident.live||resident.live.ref===ref)return role;
  const key='meeting:'+role;if(actors.has(key))return key;
  const panda=den.createPanda(role,{runtime:resident.panda.model.userData.runtime||'claude'}),{model}=panda;
  model.name=resident.name+' · at the table';model.userData={...model.userData,roleId:role,actorKey:key};model.position.copy(resident.home);den.residents.add(model);
  actors.set(key,{...resident,name:resident.name+' (at the table)',panda,gesture:null,routine:null,home:resident.home.clone(),index:actors.size,live:null,visitor:false,guest:true,arriving:false,path:null});
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
   if(a.seat?.x!==spot.x||a.seat?.z!==spot.z){routines.cancel(a);a.seat=spot;a.seatRole=role;a.leaving=false;travel(a,spot);}
  }
  // Join the newly created guest immediately, and move returning meeting runs
  // back to their ordinary visitor/resident identity when the table clears.
  applyLive([...bindings.values()]);
 }
 // The models the label layer hangs a seat's label over, by role; Bao is 'orchestrator'.
 function seatModels(){const out=new Map();for(const [role,key]of holders){const a=actors.get(key);if(a)out.set(role,a.panda.model);}const bao=actors.get('orchestrator');if(bao)out.set('orchestrator',bao.panda.model);return out;}
 function seatOf(key){const a=actors.get(key);return a?.seatRole?{meeting:meeting?.id,role:a.seatRole}:null;}
 function setSelected(identity=null){selected=identity;for(const a of actors.values()){const target=typeof identity==='string'?{role:a.role,ref:identity,runtime:'claude'}:identity;a.panda.model.userData.selected=!!a.live&&!!target&&a.live.ref===target.ref&&sameResident(a.live,target);}}
 function liveFigures(){const out=new Map();for(const a of actors.values())if(a.live)out.set(boundAgentKey(a.live),{...a.live,model:a.panda.model,panda:a.panda});return out;}
 function hold(key=null){held=key;}
 function update(dt,reduced=false){
  dt=Math.min(dt,.1);
  if(!reduced)time+=dt;
  routines.update(dt,reduced,held);
  for(const [key,a]of actors){const p=a.panda.model;let moved=0;
   if(reduced&&!a.path?.length&&(a.seat||a.leaving))a.path=[a.seat?{...a.seat,y:.26}:a.home];
   if(a.arriving){
    if(reduced){p.position.copy(a.home);a.arriving=false;}
    else if(key!==held){const dx=a.home.x-p.position.x,dz=a.home.z-p.position.z,length=Math.hypot(dx,dz),step=Math.min(dt*travelSpeed,length);if(length>.015){p.position.x+=dx/length*step;p.position.z+=dz/length*step;p.position.y=den.walkWorld.navigation.groundAt(p.position.x,p.position.z,p.position.y,.23)??p.position.y;p.rotation.y=Math.atan2(dx,dz);moved=step;}else{a.arriving=false;p.rotation.y=a.baseYaw;}}
   }
   if(a.path?.length){
    if(reduced){const end=a.path.at(-1);p.position.set(end.x,end.y,end.z);a.path=[];}
    else if(key!==held){const next=a.path[0],dx=next.x-p.position.x,dz=next.z-p.position.z,length=Math.hypot(dx,dz),step=Math.min(dt*travelSpeed,length);
     if(length>.02){p.position.x+=dx/length*step;p.position.z+=dz/length*step;p.position.y=den.walkWorld.navigation.groundAt(p.position.x,p.position.z,p.position.y,.23)??p.position.y;p.rotation.y=Math.atan2(dx,dz);moved=step;}else{p.position.set(next.x,next.y,next.z);a.path.shift();}}
    if(!a.path.length){a.path=null;a.routeGoal=null;if(a.leaving){a.leaving=false;if(a.guest){den.destroyPanda(p);actors.delete(key);continue;}}}
   }
   const yaw=a.seat?a.seat.yaw:a.baseYaw;
   if(!a.arriving&&!a.path&&a.routine?.stage!=='visit')p.rotation.y=yaw;
   if(key===held&&!reduced)continue;
   // team-and-den-ux/23: species with a seated pose sit once they reach their meeting seat.
   const sits=a.seat&&!a.path&&!a.arriving&&a.panda.rig.profile?.sit;
   if(moved){a.gait=(a.gait||0)+moved/p.scale.x/WADDLE.stride*WADDLE.duration;a.panda.rig.poseWaddle(a.gait);}else if(sits)a.panda.rig.poseSit(time+a.index*.63,{reducedMotion:reduced});else a.panda.rig.poseIdle(time+a.index*.63,{reducedMotion:reduced});
   a.gesture?.pose(!reduced&&a.routine?.stage==='visit'?a.routine.spot.kind:null,a.routine?.elapsed||0);
  }
 }
 // The walker keeps a body's width from every resident, species included: a species envelope covers its tail and props
 // for layout checks, and a walker caught inside one that wide could not step out.
 den.walkAvoid=()=>[...actors.values()].map(a=>({x:a.panda.model.position.x,z:a.panda.model.position.z,r:.65}));
 return {actors,applyLive,applyMeeting,seatModels,seatOf,setSelected,hold,liveFigures,update,dispose(){routines.dispose();for(const a of actors.values()){a.gesture?.dispose();if(a.visitor||a.guest)den.destroyPanda(a.panda.model);}actors.clear();}};
}
