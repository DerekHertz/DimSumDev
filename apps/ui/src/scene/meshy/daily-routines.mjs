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

export const ROUTINE_POLICY=Object.freeze({maxOutings:3,maxLocalLength:60,walkSpeed:3,returnSpeed:4,activityMin:45,activityMax:90,cooldownMin:120,cooldownMax:240,yieldSeconds:2});
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
export const routeLength=(from,path)=>path.reduce((sum,p,i)=>sum+distance(i?path[i-1]:from,p),0);

// Presentation owns no execution timers. Every journey has a leased destination,
// and every failed plan stays at the last physically valid position.
export function createDailyRoutines(den,actors,{random=Math.random}={}){
 const reservations=new Map(),registry=den.placeRegistry;let time=0,nextDeparture=2,cursor=0,hidden=false,disposed=false;
 for(const a of actors.values()){a.outing=null;a.path=null;a.moved=0;a.yaw=null;}
 const jitter=(low,high)=>low+Math.max(0,Math.min(1,random()))*(high-low);
 const idle=a=>!a.live&&!a.meetingOwned&&!a.meetingTrip&&!a.hosting&&!a.outing&&!a.stationary&&a.panda.model.visible&&(!a.nextOuting||a.nextOuting<=time)&&!['failed','waiting_on_user','blocked','needs-you'].includes(a.state);
 const plan=(a,to)=>den.routineRoute?den.routineRoute(a,a.panda.model.position,to):gardenRoute(den.walkWorld,a.panda.model.position,to);
 const clear=(a,from,to)=>den.routineClear?den.routineClear(a,from,to):den.walkWorld.navigation.groundAt(to.x,to.z,to.y,a.envelope.radius,a.envelope.height)!==null;
 const lease=(a,spot)=>{
  if(reservations.has(spot.id))return false;
  if(registry){registry.define({id:spot.id,kind:spot.kind==='friend'?'visitor':'leisure',position:spot.position});if(!registry.reserve(spot.id,a.identity,a.envelope))return false;}
  reservations.set(spot.id,a.id);return true;
 };
 const release=a=>{const spot=a.outing?.spot;if(spot&&reservations.get(spot.id)===a.id){reservations.delete(spot.id);registry?.release(spot.id,a.identity);}if(a.outing?.host){a.outing.host.hosting=null;a.outing.host.yaw=null;}};
 const cooldown=a=>{a.nextOuting=time+jitter(120,240);};
 function arrive(a){release(a);a.panda.model.position.copy(a.home);a.outing=null;a.path=null;a.yaw=null;cooldown(a);registry?.occupy(a.homePlace,a.identity);}
 function returnHome(a){
  if(!a.outing)return;const group=a.outing.group;release(a);a.outing={stage:'return',spot:null,elapsed:0,wait:0,replans:0,group:null};a.path=plan(a,a.home);
  if(group)for(const b of actors.values())if(b!==a&&b.outing?.group===group&&b.outing.stage!=='return')returnHome(b);
 }
 function begin(a,spot,path,group=null){
  a.outing={spot,stage:'outbound',elapsed:0,duration:jitter(45,90),wait:0,replans:0,group,host:spot.host||null};a.path=path;
  if(spot.host)spot.host.hosting=a.id;
 }
 const choices=a=>{
  const local=['pass','steamers'].includes(a.teamId)?['tea','rest']:['pond','games'];
  const spots=(den.routineSpots||[]).filter(s=>local.includes(s.kind));
  // A friend place comes only from the assembled geometry validator.
  for(const host of actors.values())if(host!==a&&host.teamId!==a.teamId&&idle(host)){
   const spot=den.friendPlace?.(a,host);if(spot)spots.push({...spot,kind:'friend',host});
  }
  return spots.filter(s=>!reservations.has(s.id)).sort((x,y)=>distance(a.home,x.position)-distance(a.home,y.position));
 };
 function depart(){
  const all=[...actors.values()],count=all.filter(a=>a.outing).length;if(count>=3)return;
  for(let i=0;i<all.length;i++){
   const a=all[cursor++%all.length];if(!idle(a))continue;
   for(const spot of choices(a).slice(0,8)){
    if(spot.host&&!idle(spot.host))continue;
    const path=plan(a,spot.position);if(!path.length||routeLength(a.panda.model.position,path)>(spot.kind==='friend'?100:60))continue;
    if(spot.kind==='games'){
     const partner=all.find(b=>b!==a&&idle(b));if(!partner||count>1)continue;
     const second=(den.routineSpots||[]).find(s=>s.group===spot.group&&s.id!==spot.id&&!reservations.has(s.id));if(!second)continue;
     const other=plan(partner,second.position);if(!other.length||routeLength(partner.panda.model.position,other)>60)continue;
     if(!lease(a,spot))continue;if(!lease(partner,second)){reservations.delete(spot.id);registry?.release(spot.id,a.identity);continue;}
     const group='outing:'+a.id+':'+time;begin(a,spot,path,group);begin(partner,second,other,group);return;
    }
    if(lease(a,spot)){begin(a,spot,path);return;}
   }
   cooldown(a);return; // bounded selection: one actor per departure beat
  }
 }
 function step(a,dt,reduced){
  const r=a.outing,p=a.panda.model.position;let remaining=(a.live?4:3)*dt;
  if(reduced)remaining=Infinity;
  while(a.path?.length&&remaining>0){
   const n=a.path[0],d=distance(p,n),travel=Math.min(d,remaining),fraction=d?travel/d:1;
   const next={x:p.x+(n.x-p.x)*fraction,y:p.y+(n.y-p.y)*fraction,z:p.z+(n.z-p.z)*fraction};
   if(!clear(a,p,next)){
    r.wait+=dt;if(r.wait>=2&&r.replans<1){r.replans++;a.path=plan(a,r.stage==='return'?a.home:r.spot.position);}
    else if(r.wait>=2&&r.replans>=1&&r.stage!=='return')returnHome(a);
    return;
   }
   r.wait=0;if(d>1e-6)a.yaw=n.yaw??Math.atan2(n.x-p.x,n.z-p.z);p.set(next.x,next.y,next.z);if(!reduced)a.moved+=travel;
   registry?.clearDeparted(a.identity,p,a.envelope);remaining-=travel;if(travel>=d-1e-6)a.path.shift();
  }
  if(!a.path?.length){
   if(r.stage==='return'){if(distance(p,a.home)<.02&&clear(a,p,a.home))arrive(a);}
   else if(distance(p,r.spot.position)<.02&&clear(a,p,r.spot.position)){r.stage='visit';r.elapsed=0;registry?.occupy(r.spot.id,a.identity);if(r.spot.kind==='pond')den.feedKoi?.();}
   else returnHome(a);
  }
 }
 function update(dt,reduced=false){
  for(const a of actors.values())a.moved=0;
  if(disposed||hidden)return;dt=Math.max(0,Math.min(dt,.1));time+=dt;
  for(const a of [...actors.values()].sort((a,b)=>(b.live?1:0)-(a.live?1:0)||a.id.localeCompare(b.id))){
   const r=a.outing;if(!r)continue;
   if((a.live||a.meetingOwned||r.host&&(r.host.live||r.host.meetingOwned||!r.host.panda.model.visible))&&r.stage!=='return')returnHome(a);
   if(a.outing.stage==='visit'){
    const spot=a.outing.spot,p=a.panda.model.position;a.yaw=Math.atan2(spot.face.x-p.x,spot.face.z-p.z);
    if(a.outing.host){const h=a.outing.host,q=h.panda.model.position;h.yaw=Math.atan2(p.x-q.x,p.z-q.z);}
    a.outing.elapsed+=dt;if(a.outing.elapsed>=a.outing.duration)returnHome(a);
   }else step(a,dt,reduced);
  }
  if(time>=nextDeparture){nextDeparture=time+4;depart();}
 }
 return {update,reservations,get time(){return time;},cancel(a){if(a.outing)returnHome(a);},transfer(a){const group=a.outing?.group;release(a);a.outing=null;a.path=null;if(group)for(const b of actors.values())if(b.outing?.group===group)returnHome(b);},setHidden(value){if(hidden&&!value)for(const a of actors.values())if(a.outing)returnHome(a);hidden=!!value;},dispose(){if(disposed)return;disposed=true;for(const a of actors.values()){release(a);a.outing=null;a.path=null;a.hosting=null;}reservations.clear();}};
}
