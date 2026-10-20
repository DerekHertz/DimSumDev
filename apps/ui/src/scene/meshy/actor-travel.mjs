import {gardenRoute,routeSegment} from './garden-route.mjs';
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
export function createActorTravel(world,places,{speed=.65}={}){
 let time=0;
 const position=a=>a.position??a.panda.model.position;
 const owner=a=>a.identity??a.id;
 function attempt(a){
  const t=a.travel,p=places.get(t.placeId);t.attempts++;t.retryAt=time+8;
  if(!p||!places.reserve(p.id,owner(a),a.envelope)){t.path=[];t.status='waiting';}
  else{t.path=gardenRoute(world,position(a),p.position,a.envelope);t.status=t.path.length?'moving':distance(position(a),p.position)<.02?'arrived':'waiting';if(t.status==='arrived')places.occupy(p.id,owner(a));}
  if(t.status==='waiting'&&t.attempts>=3){t.status='unavailable';places.release(t.placeId,owner(a));}
 }
 function request(a,placeId){
  if(a.travel?.placeId===placeId&&!['arrived','unavailable'].includes(a.travel.status))return a.travel;
  if(a.travel)places.release(a.travel.placeId,owner(a));
  a.travel={placeId,path:[],attempts:0,status:'waiting',retryAt:time};attempt(a);return a.travel;
 }
 function cancel(a){if(a.travel)places.release(a.travel.placeId,owner(a));a.travel=null;places.cancel(owner(a));}
 function update(actors,dt,reduced=false,held=null){
  time+=Math.min(dt,.1);const sorted=[...actors].sort((a,b)=>owner(a).localeCompare(owner(b)));
  for(const a of sorted){const t=a.travel,p=position(a);a.travelMoved=0;places.clearDeparted(owner(a),p,a.envelope);if(!t||a.id===held)continue;
   if(t.status==='waiting'){if(time+.000001>=t.retryAt)attempt(a);continue;}
   if(!['moving','yielding'].includes(t.status))continue;
   const destination=places.get(t.placeId);if(destination?.owner!==owner(a)){t.status='unavailable';t.path=[];continue;}
   const next=reduced?destination.position:t.path[0];if(!next)continue;
   const length=distance(p,next),amount=reduced?length:Math.min(length,dt*speed),to={x:p.x+(next.x-p.x)*(length?amount/length:0),y:p.y,z:p.z+(next.z-p.z)*(length?amount/length:0)};
   const y=routeSegment(world,p,to,a.envelope);
   const blockers=sorted.filter(b=>b!==a).filter(b=>{
    const at=position(b),dx=to.x-p.x,dz=to.z-p.z,den=dx*dx+dz*dz,along=den?Math.max(0,Math.min(1,((at.x-p.x)*dx+(at.z-p.z)*dz)/den)):0;
    return Math.hypot(p.x+dx*along-at.x,p.z+dz*along-at.z)<a.envelope.radius+b.envelope.radius+.03;
   });
   if(y===null){t.path=[];t.status='waiting';t.retryAt=time+8;continue;}
   if(blockers.length){
    t.status='yielding';t.yieldSince??=time;
    const yieldsPriority=blockers.some(b=>owner(b).localeCompare(owner(a))<0&&['moving','yielding'].includes(b.travel?.status));
    if(!reduced&&!yieldsPriority&&time-t.yieldSince>1&&time>=(t.replanAt??0)){
     const obstacles=[...(world.obstacles??[]),...sorted.filter(b=>b!==a).map(b=>({...position(b),type:'circle',radius:b.envelope.radius+.02}))];
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
