import {gardenRoute,routeSegment} from './garden-route.mjs';
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const active=t=>['moving','yielding'].includes(t?.status);
function pointSegmentDistance(p,a,b){
 const dx=b.x-a.x,dz=b.z-a.z,length=dx*dx+dz*dz;
 const t=length?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/length)):0;
 return Math.hypot(p.x-a.x-t*dx,p.z-a.z-t*dz);
}
function segmentsConflict(a,b,c,d,clearance){
 const ab={x:b.x-a.x,z:b.z-a.z},cd={x:d.x-c.x,z:d.z-c.z};
 const cross=(u,v)=>u.x*v.z-u.z*v.x,den=cross(ab,cd),ac={x:c.x-a.x,z:c.z-a.z};
 if(den){const t=cross(ac,cd)/den,u=cross(ac,ab)/den;if(t>=0&&t<=1&&u>=0&&u<=1)return true;}
 return Math.min(pointSegmentDistance(a,c,d),pointSegmentDistance(b,c,d),pointSegmentDistance(c,a,b),pointSegmentDistance(d,a,b))<clearance;
}
// Retain right of way across frames until the remaining swept routes separate.
// A momentarily clear next step must not restart the original crossing conflict.
function routesConflict(a,b,position){
 const ap=[position(a),...a.travel.path],bp=[position(b),...b.travel.path];
 const clearance=a.envelope.radius+b.envelope.radius+.03;
 for(let i=1;i<ap.length;i++)for(let j=1;j<bp.length;j++)if(segmentsConflict(ap[i-1],ap[i],bp[j-1],bp[j],clearance))return true;
 return false;
}
export function createActorTravel(world,places,{speed=.65,getActors=()=>[]}={}){
 let time=0;
 const position=a=>a.position??a.panda.model.position;
 const owner=a=>a.identity??a.id;
 const relevantChange=t=>t.navigationRevision!==world.navigation.revision||t.placeRevision!==places.get(t.placeId)?.revision;
 const unavailable=a=>{const t=a.travel;t.status='unavailable';t.path=[];if(t.placeId!==a.homePlace)places.release(t.placeId,owner(a));t.navigationRevision=world.navigation.revision;t.placeRevision=places.get(t.placeId)?.revision;};
 function attempt(a,work=null){
  const t=a.travel,p=places.get(t.placeId);t.attempts++;t.retryAt=time+8;
  if(!p||!places.reserve(p.id,owner(a),a.envelope,work)){t.path=[];t.status='waiting';}
  else{const obstacles=[...(world.obstacles??[]),...getActors().filter(b=>b!==a&&b.panda?.model.visible!==false).map(b=>({...position(b),type:'circle',radius:b.envelope.radius+.03}))],navigation=work?{...world.navigation,groundAt:(...args)=>work.groundAt(world.navigation,...args)}:world.navigation;t.path=gardenRoute({...world,navigation,obstacles},position(a),p.position,a.envelope,work);t.status=t.path.length?'moving':'waiting';}
  if(t.status==='waiting'&&t.attempts>=3)unavailable(a);
 }
 function request(a,placeId,work=null){
  if(a.travel?.placeId===placeId&&a.travel.status==='unavailable'&&!relevantChange(a.travel))return a.travel;
  if(a.travel?.placeId===placeId&&!['arrived','unavailable'].includes(a.travel.status))return a.travel;
  if(a.travel&&a.travel.placeId!==a.homePlace)places.release(a.travel.placeId,owner(a));
  a.travel={placeId,path:[],attempts:0,status:'waiting',retryAt:time};attempt(a,work);return a.travel;
 }
 function cancel(a){if(a.travel&&a.travel.placeId!==a.homePlace)places.release(a.travel.placeId,owner(a));a.travel=null;places.cancel(owner(a),a.homePlace);}
 function update(actors,dt,reduced=false,held=null){
  time+=Math.min(dt,.1);const sorted=[...actors].sort((a,b)=>owner(a).localeCompare(owner(b)));
  for(const a of sorted){const t=a.travel,p=position(a);a.travelMoved=0;places.clearDeparted(owner(a),p,a.envelope);if(!t||a.id===held)continue;
   if(t.status==='unavailable'&&relevantChange(t)){t.attempts=0;attempt(a);}
   if(t.status==='waiting'){if(time+.000001>=t.retryAt)attempt(a);continue;}
   if(!['moving','yielding'].includes(t.status))continue;
   const destination=places.get(t.placeId);if(destination?.owner!==owner(a)){unavailable(a);continue;}
   if(t.yieldTo){
    const winner=sorted.find(b=>owner(b)===t.yieldTo);
    if(winner&&active(winner.travel)&&routesConflict(a,winner,position)){t.status='yielding';continue;}
    delete t.yieldTo;
   }
   const next=reduced?destination.position:t.path[0];if(!next)continue;
   const length=distance(p,next),amount=reduced?length:Math.min(length,dt*speed),to={x:p.x+(next.x-p.x)*(length?amount/length:0),y:p.y,z:p.z+(next.z-p.z)*(length?amount/length:0)};
   let y=routeSegment(world,p,to,a.envelope);
   if(reduced){let from=p;y=p.y;for(const next of t.path){y=routeSegment(world,from,next,a.envelope);if(y===null)break;from=next;}}
   const blockers=sorted.filter(b=>b!==a).filter(b=>{
    const at=position(b),points=reduced?[p,...t.path]:[p,to];
    return points.some((point,i)=>i&&pointSegmentDistance(at,points[i-1],point)<a.envelope.radius+b.envelope.radius+.03);
   });
   if(y===null){t.path=[];t.status='waiting';t.retryAt=time+8;continue;}
   if(blockers.length){
    t.status='yielding';t.yieldSince??=time;
    for(const b of blockers.filter(b=>active(b.travel))){
     const waiter=owner(a).localeCompare(owner(b))<0?b:a,winner=waiter===a?b:a;
     if(!waiter.travel.yieldTo||owner(winner).localeCompare(waiter.travel.yieldTo)<0)waiter.travel.yieldTo=owner(winner);
    }
    const yieldsPriority=!!t.yieldTo;
    if(!reduced&&!yieldsPriority&&time-t.yieldSince>1&&time>=(t.replanAt??0)){
     if(t.attempts>=3){unavailable(a);continue;}
     t.attempts++;
     const obstacles=[...(world.obstacles??[]),...sorted.filter(b=>b!==a).map(b=>({...position(b),type:'circle',radius:b.envelope.radius+.03}))];
     const detour=gardenRoute({...world,obstacles},p,destination.position,a.envelope);if(detour.length)t.path=detour;t.replanAt=time+4;
    }
    continue;
   }
   t.status='moving';t.yieldSince=null;p.x=to.x;p.z=to.z;p.y=y;a.travelMoved=amount;
   if(reduced)t.path=[];else if(distance(p,next)<.001)t.path.shift();
   if(!t.path.length&&distance(p,destination.position)<.02){t.status='arrived';places.occupy(t.placeId,owner(a));}
  }
 }
 return{request,update,cancel};
}
