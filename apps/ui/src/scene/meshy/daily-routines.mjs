import {gardenRoute} from './garden-route.mjs';

// A spot is {id,kind,group,team?,position,face}. Stations and the library have several slots (one resident each) in one group;
// "team" is the asset id of the home pavilion, so a resident never snoops at its own.
export function gardenRoutineSpots(garden){
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

// Roams start and end at the resident's owned home: one scene clock, one departure beat, one walker. A roam chains a few
// nearby spots, nearest first. Paths are searched at a departure, a hop or an interruption only; residents standing elsewhere are obstacles then.
const NEARBY=18,LOOK=[0,.8,-.8,.4,-.4,0],LOOKING=new Set(['station','library']);
const turn=(from,to,max)=>from+Math.max(-max,Math.min(max,Math.atan2(Math.sin(to-from),Math.cos(to-from))));
export function createDailyRoutines(den,actors,{speed=.78}={}){
 const spots=den.routineSpots||[],reserved=new Map();let time=0,nextDeparture=2,cursor=0,visit=0;
 for(const a of actors.values()){a.outing=null;a.path=null;a.moved=0;a.yaw=null;}
 // The search stops within a cell of the goal, so its last node can lie past it; a node that makes the walker turn back is dropped.
 const search=(world,at,goal)=>{
  const path=gardenRoute(world,at,goal),k=path.length;
  if(k>1){const prev=k>2?path[k-3]:at,n=path[k-2],end=path[k-1];if((n.x-prev.x)*(end.x-n.x)+(n.z-prev.z)*(end.z-n.z)<0)path.splice(k-2,1);}
  return path;
 };
 const route=(a,goal)=>{
  const at=a.panda.model.position,clearOf=(b,r)=>Math.hypot(b.x-at.x,b.z-at.z)>=r+.23&&Math.hypot(b.x-goal.x,b.z-goal.z)>=r+.23;
  const bodies=[...actors.values()].filter(b=>b!==a&&b.panda.model.visible).map(b=>({type:'circle',x:b.panda.model.position.x,z:b.panda.model.position.z,radius:b.envelope.radius+.03})).filter(o=>clearOf(o,o.radius));
  return search({...den.walkWorld,obstacles:[...(den.walkWorld.obstacles||[]),...bodies]},at,goal);
 };
 // The nearest free slot of each group (not the resident's own team, not a group already seen), then one of the three nearest groups.
 const pick=(a,from,seen,limit,turnOf)=>{
  const best=new Map();
  for(const s of spots){
   if(reserved.has(s.id)||seen.has(s.group)||(s.team&&s.team===a.teamId))continue;
   const d=Math.hypot(s.position.x-from.x,s.position.z-from.z);if(d<=limit&&!(best.get(s.group)?.d<=d))best.set(s.group,{s,d});
  }
  const near=[...best.values()].sort((x,y)=>x.d-y.d);
  return near.length?near[turnOf%Math.min(3,near.length)].s:null;
 };
 const release=a=>{if(a.outing?.spot&&reserved.get(a.outing.spot.id)===a)reserved.delete(a.outing.spot.id);};
 function arrive(a){release(a);a.outing=null;a.path=null;a.yaw=null;a.panda.model.position.copy(a.home);a.nextOuting=time+14+a.index%5*3;}
 function returnHome(a){
  release(a);a.outing.stage='return';a.outing.spot=null;
  // shortcut: with no clear path home (a body in the way) fall back to the static map, then to a snap; upgrade if it ever shows.
  a.path=route(a,a.home);if(!a.path.length)a.path=search(den.walkWorld,a.panda.model.position,a.home);
  if(!a.path.length)arrive(a);else a.path[a.path.length-1]=a.home.clone();
 }
 function hop(a){
  const r=a.outing,spot=r.left>0?pick(a,a.panda.model.position,r.seen,NEARBY,0):null,path=spot?route(a,spot.position):[];
  if(!path.length)return false;
  release(a);reserved.set(spot.id,a);Object.assign(r,{spot,stage:'outbound',elapsed:0,left:r.left-1});r.seen.add(spot.group);a.path=path;return true;
 }
 function step(a,dt){
  const p=a.panda.model.position;let left=dt*speed;
  while(left>0&&a.path.length){
   const n=a.path[0],d=Math.hypot(n.x-p.x,n.z-p.z);a.yaw=d>1e-6?Math.atan2(n.x-p.x,n.z-p.z):a.yaw;
   if(d<=left){p.set(n.x,n.y,n.z);a.path.shift();a.moved+=d;left-=d;}
   else{const k=left/d;p.set(p.x+(n.x-p.x)*k,p.y+(n.y-p.y)*k,p.z+(n.z-p.z)*k);a.moved+=left;left=0;}
  }
 }
 function update(dt,reduced,held){
  if(!reduced)time+=dt;
  for(const [key,a]of actors){
   a.moved=0;const r=a.outing;if(!r)continue;
   if(reduced){arrive(a);continue;}
   if(a.live&&r.stage!=='return')returnHome(a);
   if(!a.outing||key===held)continue;
   if(r.stage==='visit'){
    r.elapsed+=dt;const p=a.panda.model.position,looks=LOOKING.has(r.spot.kind),look=looks?LOOK[Math.floor(r.elapsed/1.8)%LOOK.length]:0;
    a.yaw=turn(a.yaw??a.baseYaw,Math.atan2(r.spot.face.x-p.x,r.spot.face.z-p.z)+look,dt*3);
    if(r.elapsed>=(looks?11+a.index%3:10+a.index%3*2)&&!hop(a))returnHome(a);
   }else{
    step(a,dt);
    if(!a.path?.length){
     if(r.stage==='return')arrive(a);
     else{r.stage='visit';r.elapsed=0;if(r.spot.kind==='pond')den.feedKoi?.();}
    }
   }
  }
  if(reduced||!spots.length||time<nextDeparture)return;
  nextDeparture=time+4;
  const candidates=[...actors.values()].filter(a=>!a.stationary&&a.panda.model.visible);
  // At most one route search per departure beat, even when a destination is unreachable.
  for(let i=0;i<candidates.length;i++){
   const a=candidates[cursor++%candidates.length];
   if(a.live||a.outing||a.id===held||(a.nextOuting||0)>time)continue;
   const spot=pick(a,a.panda.model.position,new Set(),Infinity,visit);
   if(!spot)continue;
   a.nextOuting=time+18;
   const path=route(a,spot.position);
   if(path.length){reserved.set(spot.id,a);a.outing={spot,stage:'outbound',elapsed:0,left:1+visit%2,seen:new Set([spot.group])};a.path=path;}
   visit++;return;
  }
 }
 return {update,dispose(){for(const a of actors.values()){release(a);a.outing=null;a.path=null;}reserved.clear();}};
}
