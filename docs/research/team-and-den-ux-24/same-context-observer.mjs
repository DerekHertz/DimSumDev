// Temporary diagnostic observer. This module is injected only into a research
// build; normal deployment never imports it. It owns no source/rig disposal.
const requireCondition=(condition,message)=>{if(!condition)throw Error(message);};
export function calibrationPlan(){return {
 schema:1,kind:'Preregistered diagnostic only; not Bao acceptance',scenario:'meeting-light',
 freshQuietHostRequired:true,warmupMs:10000,sampleMs:30000,repetitions:3,
 blocks:['A','B','B','A','A','B'].map((label,i)=>({label,body:'original',pair:Math.floor(i/2)+1})),
 selection:'Every label invokes switchTo outside warmup/sample; same entry point even when unchanged',
 acceptancePercent:5,pairedGuardPercent:5,pairedGuardIsDiagnosticOnly:true,
 minimumFrames:801,minimumGpuQueries:251,zeroDisjointAndPending:true,
 metrics:'Unchanged nearest-rank GPU elapsed and combined render+animation CPU p95; median of three per label',
 stop:'Retain all six rows, queries and outliers. A/A failure stops A/B/full60; no favorable-mode retry or substitution.',
 resources:'Both loaded source families and rig families resident; only one active body/gesture/skeleton',
 resourceAcceptance:'Separate cold single-family loads only',
 coverage:'Stationary Claude Bao host only; refuse additional Claude Bao actors. Ten-state replay not implemented.',
 };}

export function createSameContextBaoObserver({den,agents,original,createGesture,reducedMotion=()=>false}){
 const actor=agents.actors.get('orchestrator');
 requireCondition(actor?.role==='orchestrator'&&actor.runtime==='claude','Expected actual Claude Bao host');
 requireCondition(original?.model&&original.rig&&original!==actor.panda,'Distinct original Bao rig required');
 requireCondition(!original.model.userData.species&&original.model.userData.runtime==='claude','Original must use legacy Claude Bao outfit/tool');
 requireCondition(actor.panda.model.userData.species==='giant-panda','Selected A Bao required');
 const entries={original:{panda:original,gesture:createGesture(original.rig)},selected:{panda:actor.panda,gesture:actor.gesture}};
 let active='selected',disposed=false,collecting=false;
 const updates={original:{pose:0,skeleton:0,gesture:0},selected:{pose:0,skeleton:0,gesture:0}},restore=[];
 for(const [kind,entry]of Object.entries(entries)){
  const rig=entry.panda.rig;
  for(const name of ['poseIdle','poseWaddle','poseSit'])if(typeof rig[name]==='function')observe(rig,name,kind,'pose');
  observe(rig.skeleton,'update',kind,'skeleton');if(entry.gesture)observe(entry.gesture,'pose',kind,'gesture');
 }
 function observe(owner,key,kind,count){const previous=owner[key];owner[key]=function(...args){updates[kind][count]++;return previous.apply(this,args);};restore.push(()=>{owner[key]=previous;});}
 original.model.removeFromParent();original.model.visible=false;
 den.pandaRigs.set(original.model,{rig:original.rig,tool:null});
 function state(){return agents.__bao24State();}
 function assertSupported(){
  const current=state();requireCondition(!disposed&&!collecting,'Refuse disposed or collection-time switch');
  requireCondition(actor.role==='orchestrator'&&actor.runtime==='claude'&&actor.stationary,'Stationary Claude Bao host required');
  requireCondition(!actor.path&&!actor.seat&&!actor.arriving&&!actor.routine&&current.held!==actor.id,'Locomotion/seat/routine/held pose outside meeting-light feasibility scope');
  requireCondition(Number.isFinite(current.time),'Logical clock unavailable');
  requireCondition(actor.panda===entries[active].panda&&actor.gesture===entries[active].gesture,'Active model/gesture ownership drift');
 }
 function snapshot(){
  const attached=new Set();den.world.traverse(n=>attached.add(n));
  const current=entries[active].panda.model,parked=entries[active==='original'?'selected':'original'].panda.model;
  let activeShadowMeshes=0,activeSkeletons=new Set();current.traverse(n=>{if(n.isMesh&&n.castShadow)activeShadowMeshes++;if(n.isSkinnedMesh)activeSkeletons.add(n.skeleton);});
  return {active,logicalClock:state().time,actorCount:agents.actors.size,activeBodyRoots:Object.values(entries).filter(e=>attached.has(e.panda.model)&&e.panda.model.visible).length,
   activeShadowMeshes,activeSkeletons:activeSkeletons.size,parkedAttached:attached.has(parked),parkedVisible:parked.visible,
   updates:structuredClone(updates),baoRepresentations:[...agents.actors.values()].filter(a=>a.role==='orchestrator'&&a.runtime==='claude').map(a=>({id:a.id,visitor:!!a.visitor,guest:!!a.guest,species:a.panda.model.userData.species??null,switched:a===actor})),
   identity:{id:actor.id,role:actor.role,runtime:actor.runtime,actorKey:current.userData.actorKey,ticketRef:current.userData.ticketRef??null},
   transform:{position:current.position.toArray(),quaternion:current.quaternion.toArray(),scale:current.scale.toArray()},
  };
 }
 function switchTo(kind){
  assertSupported();requireCondition(Object.hasOwn(entries,kind),'Unknown body selection');
  const previous=entries[active],next=entries[kind],nullSwitch=kind===active;
  if(!nullSwitch){
   const from=previous.panda.model,to=next.panda.model;
   to.position.copy(from.position);to.quaternion.copy(from.quaternion);to.scale.copy(from.scale);to.name=from.name;
   for(const key of Object.keys(from.userData))if(key!=='species')to.userData[key]=from.userData[key];
   from.removeFromParent();from.visible=false;actor.panda=next.panda;actor.gesture=next.gesture;active=kind;
   den.roleWorkspaces.workspaces.get(actor.id).person=to;
  }
  // Same phase as actors.update without advancing its closure clock or routines.
  // Bao is stationary and cannot occupy a meeting seat in the current product.
  next.panda.rig.poseIdle(state().time+actor.index*.63,{reducedMotion:reducedMotion()});
  next.gesture?.pose(null,0);
  next.panda.model.visible=true;den.residents.add(next.panda.model);
  const receipt=snapshot();requireCondition(receipt.activeBodyRoots===1&&!receipt.parkedAttached&&!receipt.parkedVisible,'Body/shadow traversal ownership failed');
  return {...receipt,nullSwitch};
 }
 function assertNoParkedUpdates(before){const parked=active==='original'?'selected':'original';requireCondition(JSON.stringify(before.updates[parked])===JSON.stringify(updates[parked]),'parked rig received animation/gesture/skeleton updates');}
 function assertHostOnlyCoverage(){requireCondition(snapshot().baoRepresentations.length===1,'additional Claude Bao actors require whole-identity switching before A/B');}
 return {switchTo,snapshot,assertNoParkedUpdates,assertHostOnlyCoverage,setCollecting(value){collecting=!!value;},dispose(){if(disposed)return;disposed=true;entries[active==='original'?'selected':'original'].gesture?.dispose();for(const undo of restore)undo();}};
}
