import {gardenRoute} from './garden-route.mjs';

export function gardenRoutineSpots(garden){
 const tea=garden.assets.tea,point=p=>garden.worldPoint('tea',p);
 return [
  {id:'tea',kind:'tea',position:point([-1.7,.43,1.0]),face:point([-1.7,.43,.02])},
  {id:'pond',kind:'pond',position:point([2.18,0,-1.35]),face:point([2.18,0,.05])},
  {id:'greeting',kind:'greeting',position:point([-.10,.43,-1.6]),face:point(tea.residents[0].position)},
 ];
}

// Outings start and end at the resident's owned home. One scene clock, one departure beat, one walker.
// Paths are searched at a departure or an interruption only; residents standing elsewhere are obstacles then.
export function createDailyRoutines(den,actors,{speed=.78,maxOut=3}={}){
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
 const release=a=>{if(a.outing?.spot&&reserved.get(a.outing.spot.id)===a)reserved.delete(a.outing.spot.id);};
 function arrive(a){release(a);a.outing=null;a.path=null;a.yaw=null;a.panda.model.position.copy(a.home);a.nextOuting=time+14+a.index%5*3;}
 function returnHome(a){
  release(a);a.outing.stage='return';a.outing.spot=null;
  // shortcut: with no clear path home (a body in the way) fall back to the static map, then to a snap; upgrade if it ever shows.
  a.path=route(a,a.home);if(!a.path.length)a.path=search(den.walkWorld,a.panda.model.position,a.home);
  if(!a.path.length)arrive(a);else a.path[a.path.length-1]=a.home.clone();
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
    r.elapsed+=dt;const p=a.panda.model.position;a.yaw=Math.atan2(r.spot.face.x-p.x,r.spot.face.z-p.z);
    if(r.elapsed>=10+(a.index%3)*2)returnHome(a);
   }else{
    step(a,dt);
    if(!a.path?.length){
     if(r.stage==='return')arrive(a);
     else{r.stage='visit';r.elapsed=0;a.yaw=null;if(r.spot.kind==='pond')den.feedKoi?.();}
    }
   }
  }
  if(reduced||!spots.length||time<nextDeparture)return;
  nextDeparture=time+4;
  if([...actors.values()].filter(a=>a.outing).length>=maxOut)return;
  const candidates=[...actors.values()].filter(a=>!a.stationary&&a.panda.model.visible);
  // At most one route search per departure beat, even when a destination is unreachable.
  for(let i=0;i<candidates.length;i++){
   const a=candidates[cursor++%candidates.length];
   if(a.live||a.outing||a.id===held||(a.nextOuting||0)>time)continue;
   const spot=spots.slice(visit%spots.length).concat(spots.slice(0,visit%spots.length)).find(s=>!reserved.has(s.id));
   if(!spot)return;
   visit++;a.nextOuting=time+18;
   const path=route(a,spot.position);
   if(path.length){reserved.set(spot.id,a);a.outing={spot,stage:'outbound',elapsed:0};a.path=path;}
   return;
  }
 }
 return {update,dispose(){for(const a of actors.values()){release(a);a.outing=null;a.path=null;}reserved.clear();}};
}
