import {gardenRoute} from './garden-route.mjs';
import {leisurePlaces} from './approved-plan.mjs';

// A spot is {id,kind,group,team?,position,face}. Stations and the library have several slots (one resident each) in one group;
// "team" is the asset id of the home pavilion, so a resident never snoops at its own.
export function gardenRoutineSpots(garden){
 if(garden.approved)return leisurePlaces();
 const tea=garden.assets.tea,point=p=>garden.worldPoint('tea',p),at=(id,p)=>garden.worldPoint(id,p);
 const slots=(team,kind,xs,z,y)=>xs.map((x,i)=>({id:kind+':'+team+':'+i,kind,group:kind+':'+team,team,position:at(team,[x,y,z]),face:at(team,[x,y+.4,z-4])}));
 return [
  {id:'tea',kind:'tea',group:'tea',position:point([-1.7,.43,1.0]),face:point([-1.7,.43,.02])},
  {id:'pond',kind:'pond',group:'pond',position:point([2.18,0,-1.35]),face:point([2.18,0,.05])},
  {id:'greeting',kind:'greeting',group:'greeting',position:point([-.10,.43,-1.6]),face:point(tea.residents[0].position)},
  ...['pass','steamers','pantry','front'].flatMap(team=>slots(team,'station',[-3,-1,1,3],5.5,0)),
  ...slots('library','library',[-1.8,-.6,.6,1.8],1.8,.43),
 ];
}

export const ROUTINE_POLICY=Object.freeze({maxOutings:3,maxLocalLength:60,walkSpeed:3.6,returnSpeed:4.8,activityMin:45,activityMax:90,cooldownMin:120,cooldownMax:240,yieldSeconds:2});
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
export const routeLength=(from,path)=>path.reduce((sum,p,i)=>sum+distance(i?path[i-1]:from,p),0);
export function routeSeconds(actor,path){let p=actor.panda.model.position,yaw=actor.yaw??actor.baseYaw,total=0;for(const q of path){const d=distance(p,q),facing=q.yaw??(d<1e-6?yaw:Math.atan2(q.x-p.x,q.z-p.z));total+=d/ROUTINE_POLICY.walkSpeed;if(q.mount==null)total+=Math.abs(Math.atan2(Math.sin(facing-yaw),Math.cos(facing-yaw)))/3.5;p=q;yaw=facing;}return total;}

// Presentation owns no execution timers. Every journey has a leased destination,
// and every failed plan stays at the last physically valid position.
export function createDailyRoutines(den,actors,{random=Math.random,work=null}={}){
 const reservations=new Map(),registry=den.placeRegistry;let time=0,nextDeparture=2,cursor=0,hidden=false,disposed=false;
 const departure=Symbol('resident departure');
 for(const a of actors.values()){a.outing=null;a.path=null;a.moved=0;a.yaw=null;}
 const jitter=(low,high)=>low+Math.max(0,Math.min(1,random()))*(high-low);
 const hostAvailable=a=>!a.live&&!a.meetingOwned&&!a.meetingTrip&&!a.hosting&&!a.outing&&!a.panda.model.userData.modelUnavailable&&a.panda.model.visible&&!['failed','waiting_on_user','blocked','needs-you'].includes(a.state);
 const available=a=>hostAvailable(a)&&!a.stationary;
 const idle=a=>available(a)&&(!a.nextOuting||a.nextOuting<=time);
 const plan=(a,to)=>den.routineRoute?den.routineRoute(a,a.panda.model.position,to):gardenRoute(den.walkWorld,a.panda.model.position,to);
 function* planSteps(a,to){return den.routineRouteSteps?yield* den.routineRouteSteps(a,{...a.panda.model.position},{...to}):plan(a,to);}
 function setPath(a,to){
  if(!work){a.path=plan(a,to);return;}
  const outing=a.outing;a.path=null;a.routePending=true;
  work.submit(a,(function*(){try{const path=yield* planSteps(a,to);if(a.outing===outing)a.path=path;}finally{if(a.outing===outing)a.routePending=false;}})());
 }
 const validPath=(a,spot,path)=>path.length&&routeLength(a.panda.model.position,path)<=(spot.kind==='friend'?100:60)&&(!den.garden?.approved||spot.kind==='friend'||routeSeconds(a,path)<=20);
 const clear=(a,from,to)=>den.routineClear?den.routineClear(a,from,to):den.walkWorld.navigation.groundAt(to.x,to.z,to.y,a.envelope.radius,a.envelope.height)!==null;
 const lease=(a,spot)=>{
  if(reservations.has(spot.id))return false;
  if(registry){
   const destination=registry.define({id:spot.id,kind:spot.kind==='friend'?'visitor':'leisure',position:spot.position});if(!destination.owner)destination.position={...spot.position};
   const yaw=Math.atan2(spot.face.x-spot.position.x,spot.face.z-spot.position.z);if(!registry.reserve(spot.id,a.identity,{...a.envelope,yaw}))return false;
   const approach=spot.approachReservation||spot.approachPath?.[0];
   if(approach){
    const id='approach:'+spot.id,place=registry.define({id,kind:'leisure',position:approach});if(!place.owner)place.position={...approach};
    if(!registry.reserve(id,a.identity,{...a.envelope,yaw:approach.yaw})){registry.release(spot.id,a.identity);return false;}
    a.approachPlace=id;
   }
  }
  reservations.set(spot.id,a.id);return true;
 };
 const release=a=>{const spot=a.outing?.spot;if(spot&&reservations.get(spot.id)===a.id){reservations.delete(spot.id);registry?.release(spot.id,a.identity);}if(a.outing?.host){a.outing.host.hosting=null;a.outing.host.yaw=null;}};
 const cooldown=a=>{a.nextOuting=time+jitter(120,240);};
 function arrive(a){release(a);if(a.approachPlace)registry?.release(a.approachPlace,a.identity);a.approachPlace=null;a.panda.model.position.copy(a.home);a.outing=null;a.path=null;a.yaw=null;cooldown(a);registry?.occupy(a.homePlace,a.identity);}
 function returnHome(a){
  if(!a.outing)return;const group=a.outing.group;release(a);a.outing={stage:'return',spot:null,elapsed:0,wait:0,replans:0,group:null};setPath(a,a.home);
  if(group)for(const b of actors.values())if(b!==a&&b.outing?.group===group&&b.outing.stage!=='return')returnHome(b);
 }
 function begin(a,spot,path,group=null){
  a.outing={spot,stage:'outbound',elapsed:0,duration:jitter(45,90),wait:0,replans:0,group,host:spot.host||null};a.path=path;
  if(spot.host)spot.host.hosting=a.id;
 }
 function* choices(a){
  const local=['pass','steamers'].includes(a.teamId)?['tea','rest']:['pond','games'];
  const spots=[];
  for(const s of den.routineSpots||[])if(local.includes(s.kind)){const spot=den.routinePlace?den.routinePlace(a,s):s;if(spot)spots.push(spot);yield;}
  // A friend place comes only from the assembled geometry validator.
  for(const host of actors.values())if(host!==a&&host.teamId!==a.teamId&&hostAvailable(host)){
   const spot=den.friendPlace?.(a,host);if(spot)spots.push({...spot,kind:'friend',host});yield;
  }
  return spots.filter(s=>!reservations.has(s.id)).sort((x,y)=>distance(a.home,x.position)-distance(a.home,y.position));
 }
 function* departSteps(){
  const all=[...actors.values()];
  if(all.filter(a=>a.outing).length>=3||!all.some(idle))yield {ready:()=>time>=nextDeparture};
  const count=all.filter(a=>a.outing).length;if(count>=3)return;
  for(let i=0;i<all.length;i++){
   const a=all[cursor++%all.length];if(!idle(a))continue;
   const destinations=yield* choices(a);
   for(const spot of destinations.slice(0,8)){
    if(!idle(a))return;
    if(spot.host&&!hostAvailable(spot.host))continue;
    const path=yield* planSteps(a,spot.position);yield;if(!idle(a))return;if(!validPath(a,spot,path))continue;
    if(spot.kind==='games'){
     const partner=all.find(b=>b!==a&&idle(b));if(!partner||count>1)continue;
     const candidate=(den.routineSpots||[]).find(s=>s.group===spot.group&&s.id!==spot.id&&!reservations.has(s.id));if(!candidate)continue;
     const second=den.routinePlace?den.routinePlace(partner,candidate):candidate;if(!second)continue;
     const other=yield* planSteps(partner,second.position);yield;if(!idle(a))return;if(!idle(partner)||!validPath(partner,second,other))continue;
     while(work&&time<nextDeparture)yield {ready:()=>time>=nextDeparture};
     if(!idle(a)||!idle(partner))return;
     if([...actors.values()].filter(a=>a.outing).length>1)continue;
     if(!lease(a,spot))continue;if(!lease(partner,second)){reservations.delete(spot.id);registry?.release(spot.id,a.identity);if(a.approachPlace)registry?.release(a.approachPlace,a.identity);a.approachPlace=null;continue;}
     const group='outing:'+a.id+':'+time;begin(a,spot,path,group);begin(partner,second,other,group);return;
    }
    while(work&&time<nextDeparture)yield {ready:()=>time>=nextDeparture};
    if(!idle(a))return;
    if([...actors.values()].filter(a=>a.outing).length<3&&(!spot.host||hostAvailable(spot.host))&&lease(a,spot)){begin(a,spot,path);return;}
   }
   cooldown(a);return; // bounded selection: one actor per departure beat
  }
 }
 function depart(){
  if(work){if(!work.has(departure))work.submit(departure,(function*(){yield* departSteps();nextDeparture=Math.max(time,nextDeparture)+4;})());}
  else{const job=departSteps();while(!job.next().done){}}
 }
 function step(a,dt,reduced){
  if(a.routePending)return;
  const r=a.outing,p=a.panda.model.position;let remaining=(a.live?ROUTINE_POLICY.returnSpeed:ROUTINE_POLICY.walkSpeed)*dt;
  if(reduced)remaining=Infinity;
  while(a.path?.length&&remaining>0){
   const n=a.path[0],d=distance(p,n),travel=Math.min(d,remaining),fraction=d?travel/d:1;
   const facing=n.yaw??(d<1e-6?(a.yaw??a.baseYaw):Math.atan2(n.x-p.x,n.z-p.z)),angle=Math.atan2(Math.sin(facing-(a.yaw??a.baseYaw)),Math.cos(facing-(a.yaw??a.baseYaw)));
   if(den.garden?.approved&&!reduced&&n.mount==null&&Math.abs(angle)>.01){
    const yaw=(a.yaw??a.baseYaw)+Math.sign(angle)*Math.min(Math.abs(angle),3.5*dt);
    if(!den.walkWorld.fits(p,a.envelope,yaw))return;
    a.yaw=yaw;return;
   }
   const next={x:p.x+(n.x-p.x)*fraction,y:p.y+(n.y-p.y)*fraction,z:p.z+(n.z-p.z)*fraction};
   if(n.mount==null&&den.walkWorld.supportAt){const y=den.walkWorld.supportAt(next.x,next.z);if(y===null)return;next.y=y+.045;}
   if(!clear(a,p,next)){
    r.wait+=dt;if(r.wait>=2&&r.replans<1){r.replans++;setPath(a,r.stage==='return'?a.home:r.spot.position);}
    else if(r.wait>=2&&r.replans>=1&&r.stage!=='return')returnHome(a);
    return;
   }
   r.wait=0;a.yaw=facing;a.mount=n.mount??null;p.set(next.x,next.y,next.z);if(!reduced)a.moved+=travel;
   registry?.clearDeparted(a.identity,p,a.envelope);remaining-=travel;if(travel>=d-1e-6)a.path.shift();
  }
  if(!a.path?.length){
   if(r.stage==='return'){if(distance(p,a.home)<.02&&clear(a,p,a.home))arrive(a);}
   else if(distance(p,r.spot.position)<.02&&clear(a,p,r.spot.position)){r.stage='visit';r.elapsed=0;registry?.occupy(r.spot.id,a.identity);if(r.spot.kind==='pond')den.feedKoi?.();}
   else returnHome(a);
  }
 }
 function update(dt,reduced=false){
  for(const a of actors.values()){a.moved=0;a.mount=null;}
  if(disposed||hidden)return;dt=Math.max(0,Math.min(dt,.1));if(!reduced)time+=dt;
  if(reduced)work?.cancel(departure);
  for(const a of [...actors.values()].sort((a,b)=>(b.live?1:0)-(a.live?1:0)||a.id.localeCompare(b.id))){
   const r=a.outing;if(!r)continue;
   if((reduced||a.live||a.meetingOwned||r.host&&(r.host.live||r.host.meetingOwned||!r.host.panda.model.visible))&&r.stage!=='return')returnHome(a);
   if(a.outing.stage==='visit'){
    const spot=a.outing.spot,p=a.panda.model.position;a.yaw=Math.atan2(spot.face.x-p.x,spot.face.z-p.z);
    if(a.outing.host){const h=a.outing.host,q=h.panda.model.position;h.yaw=Math.atan2(p.x-q.x,p.z-q.z);}
    a.outing.elapsed+=dt;if(a.outing.elapsed>=a.outing.duration)returnHome(a);
   }else step(a,dt,reduced);
   if(reduced&&distance(a.panda.model.position,a.home)>.02){
    const p=a.panda.model.position,at=den.walkWorld.groundedPosition?.(a,p,a.yaw??a.baseYaw);
    if(at&&at.y!==p.y&&clear(a,p,at))p.set(at.x,at.y,at.z);
   }
  }
  if(!reduced){if(work)depart();else if(time>=nextDeparture){nextDeparture=time+4;depart();}}
 }
 return {update,reservations,get time(){return time;},cancel(a){if(a.outing)returnHome(a);},transfer(a){work?.cancel(a);a.routePending=false;const group=a.outing?.group;release(a);if(a.approachPlace)registry?.release(a.approachPlace,a.identity);a.approachPlace=null;a.outing=null;a.path=null;if(group)for(const b of actors.values())if(b.outing?.group===group)returnHome(b);},setHidden(value){if(hidden&&!value)for(const a of actors.values())if(a.outing)returnHome(a);hidden=!!value;},dispose(){if(disposed)return;disposed=true;work?.cancel(departure);for(const a of actors.values()){work?.cancel(a);a.routePending=false;release(a);if(a.approachPlace)registry?.release(a.approachPlace,a.identity);a.approachPlace=null;a.outing=null;a.path=null;a.hosting=null;}reservations.clear();}};
}
