import * as T from 'three';
import {TEAMS,WALKS,transform,leisurePlaces,officeVisitors} from './approved-plan.mjs';
import {routeLength} from './daily-routines.mjs';

const EPS=.025,distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const point=(x,z,y=.36)=>({x,y,z});
function rectangle(position,envelope,yaw){
 const box=envelope.bounds||{min:[-envelope.radius,0,-envelope.radius],max:[envelope.radius,envelope.height,envelope.radius]};
 const vertices=[],cos=Math.cos(yaw),sin=Math.sin(yaw);for(const x of [box.min[0],box.max[0]])for(const z of [box.min[2],box.max[2]])vertices.push({x:position.x+x*cos+z*sin,z:position.z-x*sin+z*cos});
 return vertices;
}
const overlap=(a,b)=>{
 for(let side=0;side<2;side++)for(let edge=1;edge<=2;edge++){
  const polygon=side?a:b,x=polygon[edge].z-polygon[0].z,z=polygon[0].x-polygon[edge].x;
  let minA=Infinity,maxA=-Infinity,minB=Infinity,maxB=-Infinity;
  for(let i=0;i<4;i++){const pa=a[i].x*x+a[i].z*z,pb=b[i].x*x+b[i].z*z;minA=Math.min(minA,pa);maxA=Math.max(maxA,pa);minB=Math.min(minB,pb);maxB=Math.max(maxB,pb);}
  if(maxA<=minB+EPS||maxB<=minA+EPS)return false;
 }return true;
};
function bounds(vertices){
 let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
 for(const p of vertices){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minZ=Math.min(minZ,p.z);maxZ=Math.max(maxZ,p.z);}
 return {minX,maxX,minZ,maxZ};
}
const touches=(box,area)=>box.max[0]>=area.minX&&box.min[0]<=area.maxX&&box.max[2]>=area.minZ&&box.min[2]<=area.maxZ;
export function createApprovedNavigation(garden){
 let bodies=()=>[],reservations=()=>[];
 const obstacles=garden.obstacles.map(o=>({...o,vertices:o.vertices?.map(v=>Array.isArray(v)?{x:v[0],z:v[1]}:v)||[{x:o.min[0],z:o.min[2]},{x:o.min[0],z:o.max[2]},{x:o.max[0],z:o.min[2]},{x:o.max[0],z:o.max[2]}]}));
 const cells=new Map();for(const o of obstacles)for(let x=Math.floor(o.min[0]/4);x<=Math.floor(o.max[0]/4);x++)for(let z=Math.floor(o.min[2]/4);z<=Math.floor(o.max[2]/4);z++){const key=x+':'+z;if(!cells.has(key))cells.set(key,[]);cells.get(key).push(o);}
 let routeFits=null;
 function fits(position,envelope,yaw=0,trace=null){
  if(!routeFits||trace)return fitsAt(position,envelope,yaw,trace);
  let cache=routeFits.get(envelope);if(!cache){cache=new Map();routeFits.set(envelope,cache);}
  const key=position.x+':'+position.y+':'+position.z+':'+yaw,cached=cache.get(key);
  if(cached!==undefined)return cached;
  const result=fitsAt(position,envelope,yaw);cache.set(key,result);return result;
 }
 function fitsAt(position,envelope,yaw,trace=null){
  const vertices=rectangle(position,envelope,yaw);if(vertices.some(p=>!garden.inside(p.x,p.z)))return false;
  const area=bounds(vertices),nearby=new Set();let slices;
  for(let x=Math.floor(area.minX/4);x<=Math.floor(area.maxX/4);x++)for(let z=Math.floor(area.minZ/4);z<=Math.floor(area.maxZ/4);z++)for(const o of cells.get(x+':'+z)||[])nearby.add(o);
  for(const o of nearby){
   if(o.max[1]<=position.y+.1||o.min[1]>=position.y+envelope.height||!touches(o,area))continue;
   if(envelope.slices&&!slices)slices=envelope.slices.map(slice=>{const vertices=rectangle(position,{bounds:slice},yaw);return {vertices,area:bounds(vertices),minY:position.y+Math.max(.1,slice.min[1]),maxY:position.y+slice.max[1]};});
   const blocked=slices?slices.some(slice=>o.max[1]>slice.minY&&o.min[1]<slice.maxY&&touches(o,slice.area)&&overlap(slice.vertices,o.vertices)):overlap(vertices,o.vertices);
   if(blocked){trace?.push(o);return false;}
  }
  return true;
 }
 function segment(a,b,envelope,yaw=null){
  const d=distance(a,b),facing=yaw??Math.atan2(b.x-a.x,b.z-a.z),steps=Math.max(1,Math.ceil(d/.25));
  for(let i=0;i<=steps;i++){const k=i/steps;if(!fits({x:a.x+(b.x-a.x)*k,y:a.y+(b.y-a.y)*k,z:a.z+(b.z-a.z)*k},envelope,facing))return false;}return true;
 }
 const surfaceVertices=o=>o.vertices?.map(v=>Array.isArray(v)?{x:v[0],z:v[1]}:v)||[{x:o.min[0],z:o.min[2]},{x:o.min[0],z:o.max[2]},{x:o.max[0],z:o.min[2]},{x:o.max[0],z:o.max[2]}];
 const surfaces=[...(garden.surfaces||[]),...obstacles.filter(o=>o.support)].map(o=>({...o,vertices:surfaceVertices(o)}));
 const surfaceCells=new Map();for(const s of surfaces)for(let x=Math.floor(s.min[0]/4);x<=Math.floor(s.max[0]/4);x++)for(let z=Math.floor(s.min[2]/4);z<=Math.floor(s.max[2]/4);z++){const key=x+':'+z;if(!surfaceCells.has(key))surfaceCells.set(key,[]);surfaceCells.get(key).push(s);}
 function supportAt(x,z){
  if(!garden.inside(x,z))return null;
  let top=.165;
  for(const o of surfaceCells.get(Math.floor(x/4)+':'+Math.floor(z/4))||[]){
   let contains=true;
   for(let edge=1;edge<=2;edge++){const a=o.vertices[0],b=o.vertices[edge],dx=b.x-a.x,dz=b.z-a.z,length=Math.hypot(dx,dz),coordinate=((x-a.x)*dx+(z-a.z)*dz)/length;if(!length||coordinate<-.005||coordinate>length+.005){contains=false;break;}}
   if(contains)top=Math.max(top,o.supportTop);
  }
  return top;
 }
 function footHeights(actor,p,yaw){
  const foot=actor.panda.rig.profile.foot,scale=actor.panda.model.scale.x;
  return [-1,1].flatMap(side=>[-.1,.1].flatMap(dx=>[-.1,.1].map(dz=>{
   const x=(side*foot.x+dx)*scale,z=(foot.z+dz)*scale;
   return supportAt(p.x+x*Math.cos(yaw)+z*Math.sin(yaw),p.z-x*Math.sin(yaw)+z*Math.cos(yaw));
  })));
 }
 function supported(actor,p,yaw){return footHeights(actor,p,yaw).every(height=>height!==null&&p.y>=height-.025&&p.y-height<.075);}
 function groundedPosition(actor,p,yaw){
  if(supported(actor,p,yaw))return {...p};
  const heights=footHeights(actor,p,yaw);if(heights.includes(null))return null;
  const y=Math.max(Math.min(...heights)+.045,Math.max(...heights)-.024),at={x:p.x,y,z:p.z};
  return supported(actor,at,yaw)&&fits(at,actor.envelope,yaw)?at:null;
 }
 function turn(p,from,to,envelope){
  const delta=Math.atan2(Math.sin(to-from),Math.cos(to-from)),steps=Math.max(1,Math.ceil(Math.abs(delta)/.06));
  const box=envelope.bounds;let radius=box?Math.hypot(Math.max(Math.abs(box.min[0]),Math.abs(box.max[0])),Math.max(Math.abs(box.min[2]),Math.abs(box.max[2]))):Math.SQRT2*envelope.radius;
  for(const slice of envelope.slices||[])radius=Math.max(radius,Math.hypot(Math.max(Math.abs(slice.min[0]),Math.abs(slice.max[0])),Math.max(Math.abs(slice.min[2]),Math.abs(slice.max[2]))));
  const area={minX:p.x-radius,maxX:p.x+radius,minZ:p.z-radius,maxZ:p.z+radius},nearby=new Set();
  for(let x=Math.floor(area.minX/4);x<=Math.floor(area.maxX/4);x++)for(let z=Math.floor(area.minZ/4);z<=Math.floor(area.maxZ/4);z++)for(const o of cells.get(x+':'+z)||[])nearby.add(o);
  const empty=![...nearby].some(o=>o.max[1]>p.y+.1&&o.min[1]<p.y+envelope.height&&touches(o,area));
  if(empty){
   for(let i=0;i<=steps;i++)if(rectangle(p,envelope,from+delta*i/steps).some(v=>!garden.inside(v.x,v.z)))return false;
   return true;
  }
  for(let i=0;i<=steps;i++)if(!fits(p,envelope,from+delta*i/steps))return false;
  return true;
 }
 function approachAt(actor,spot){
  const to=spot.position,finalYaw=Math.atan2(spot.face.x-to.x,spot.face.z-to.z),candidates=[];
  if(spot.id.startsWith('visitor:')&&garden.assets.office)candidates.push({x:to.x-Math.sign(to.x)*3.5,y:.36,z:to.z});
  if(spot.kind==='rest')for(const [dx,dz]of [[0,3.8],[-3.8,0],[3.8,0],[0,-3.8]])candidates.push({x:to.x+dx,y:.36,z:to.z+dz});
  else{
   const dx=to.x-spot.face.x,dz=to.z-spot.face.z,length=Math.hypot(dx,dz);
   candidates.push({x:to.x+dx/length*3,y:.36,z:to.z+dz/length*3});if(spot.approach)candidates.push(spot.approach);
  }
  if(spot.kind==='meeting'){
   candidates.length=0;
   const outward=Math.atan2(to.x,to.z+4),offsets=[0,...Array.from({length:8},(_,i)=>[(i+1)*Math.PI/16,-(i+1)*Math.PI/16]).flat()];
   for(const radius of [7,6.5,6,5.5,5])for(const offset of offsets){const angle=outward+offset;candidates.push({x:to.x+Math.sin(angle)*radius,y:.36,z:to.z+Math.cos(angle)*radius});}
  }else if(spot.kind!=='rest')for(const radius of [2.5,2,3.5])for(let i=0;i<16;i++){const angle=i*Math.PI/8;candidates.push({x:to.x+Math.sin(angle)*radius,y:.36,z:to.z+Math.cos(angle)*radius});}
  for(const from of candidates){
   if(spot.kind==='meeting'){const floor=supportAt(from.x,from.z);if(floor===null||floor>.5)continue;from.y=floor+.045;}
   const yaw=Math.atan2(to.x-from.x,to.z-from.z),length=distance(from,to);
   if(length>(spot.kind==='meeting'?7.1:4.1)||!supported(actor,from,yaw)||!supported(actor,to,finalYaw))continue;
   const steps=Math.ceil(length/.05),points=[];
   // A short supported mount: both feet leave the floor, tuck during the
   // flight and plant on the measured cushion/mattress before the final turn.
   // Furniture stays solid throughout the actual full-body sweep.
   for(let i=0;i<=steps;i++){
    const k=i/steps,blend=T.MathUtils.smoothstep(k,.25,.8),delta=Math.atan2(Math.sin(finalYaw-yaw),Math.cos(finalYaw-yaw)),p={x:from.x+(to.x-from.x)*k,y:from.y+(to.y-from.y)*k+Math.sin(Math.PI*k)*(spot.kind==='meeting'?2.1:1.1),z:from.z+(to.z-from.z)*k,yaw:yaw+delta*blend,airborne:i>0&&i<steps,mount:k};
    points.push(p);
   }
   if(!points.every(p=>fits(p,actor.envelope,p.yaw)))continue;
   points.push({...to,yaw:finalYaw});
   if(spot.id.startsWith('visitor:')&&garden.assets.office){
    const entry=Math.abs(from.z-to.z)<.01?{x:0,y:.36,z:from.z,yaw}:{x:from.x,y:.36,z:-21,yaw};
    if(!segment(entry,from,actor.envelope,yaw)||!turn(entry,0,yaw,actor.envelope))continue;
    return [entry,...points];
   }
   return points;
  }
  return null;
 }
 const placements=new Map();
 function place(actor,spot){
  const key=actor.id+':'+spot.id;if(placements.has(key))return placements.get(key);
  const offsets=[[0,0]];
  if(spot.kind==='rest')for(const z of [.2,.4,.6,.8])for(const x of [0,-.2,.2])offsets.push([x,z]);
  else for(const r of [.15,.3,.45])for(let i=0;i<8;i++)offsets.push([Math.sin(i*Math.PI/4)*r,Math.cos(i*Math.PI/4)*r]);
  for(const [x,z]of offsets){const candidate={...spot,position:spot.position.clone().add(new T.Vector3(x,0,z))},path=approachAt(actor,candidate);if(path){candidate.approachPath=path;if(spot.id.startsWith('visitor:')&&garden.assets.office)candidate.approachReservation=path[1];placements.set(key,candidate);return candidate;}}
  placements.set(key,null);return null;
 }
 function approach(actor,spot,{reverse=false}={}){const candidate=place(actor,spot);if(!candidate)return null;return reverse?[...candidate.approachPath].reverse():candidate.approachPath;}
 const nodes=[],edges=[],key=p=>p.x.toFixed(3)+':'+p.z.toFixed(3),byKey=new Map();
 const node=p=>{const k=key(p);if(byKey.has(k))return byKey.get(k);const i=nodes.length;nodes.push(p);edges.push(new Set());byKey.set(k,i);return i;};
 const lines=WALKS.flatMap(([path])=>path.slice(1).map((p,i)=>[point(...path[i]),point(...p)]));
 if(garden.assets.office){
  lines.push([point(0,-17),point(0,-36.9)]);
  for(const x of [-6.4,6.4])lines.push([point(0,-21),point(x,-21)],[point(x,-21),point(x,-24.5)]);
 }
 if(!garden.assets.office)for(const [a,b]of [[[-10,-17],[-10,-20]],[[-10,-20],[10,-20]],[[10,-20],[10,-17]]])lines.push([point(...a),point(...b)]);
 for(const team of TEAMS){
  const at=p=>{const v=transform([p[0],.36,p[1]],team);return point(v.x,v.z,v.y);};
  lines.push([at([0,15]),at([0,-8])]);
  for(const z of team.id==='pantry'?[-1.8,1.8]:team.roles.length===3?[-7,0,7]:[-4.5,4.5])lines.push([at([-7,z]),at([7,z])]);
 }
 // Through aisles and both approaches of the shared rooms.
 for(const [a,b]of [[[-23,-17],[-23,9]],[[23,-17],[23,9]],[[-46,-9],[-35,-9]],[[-46,1],[-35,1]],[[35,-10.8],[46,-10.8]],[[35,2.8],[46,2.8]]])lines.push([point(...a),point(...b)]);
 for(const [a,b]of lines){
  const candidates=[a,b];
  for(const [c,d]of lines){
   const denominator=(b.x-a.x)*(d.z-c.z)-(b.z-a.z)*(d.x-c.x);if(Math.abs(denominator)<1e-6)continue;
   const t=((c.x-a.x)*(d.z-c.z)-(c.z-a.z)*(d.x-c.x))/denominator,u=((c.x-a.x)*(b.z-a.z)-(c.z-a.z)*(b.x-a.x))/denominator;
   if(t>=0&&t<=1&&u>=0&&u<=1)candidates.push(point(a.x+t*(b.x-a.x),a.z+t*(b.z-a.z)));
  }
  candidates.sort((c,d)=>distance(a,c)-distance(a,d));
  const indices=[...new Set(candidates.map(node))];for(let i=1;i<indices.length;i++){edges[indices[i-1]].add(indices[i]);edges[indices[i]].add(indices[i-1]);}
 }
 const edgeCache=new Map();
 function route(actor,from,to){
  const work=routeSteps(actor,from,to);let result;
  do{result=work.next();}while(!result.done);return result.value;
 }
 function routeSteps(actor,from,to){
  const cache=new WeakMap(),iterator=planRoute(actor,from,to);
  const invoke=(method,value)=>{const previous=routeFits;routeFits=cache;try{return iterator[method](value);}finally{routeFits=previous;}};
  return {[Symbol.iterator](){return this;},next:value=>invoke('next',value),return:value=>invoke('return',value)};
 }
 function* planRoute(actor,from,to){
  const envelope=actor.envelope,signature=JSON.stringify([envelope.radius,envelope.height,envelope.bounds,envelope.slices]);
  const bodySnapshot=[
   ...bodies().filter(other=>other!==actor&&other.panda.model.visible).map(other=>({position:other.panda.model.position.clone(),envelope:other.envelope,yaw:other.yaw??other.baseYaw})),
   ...reservations().filter(place=>place.owner&&place.owner!==actor.identity).map(place=>({position:place.position,envelope:place.envelope,yaw:place.envelope.yaw??0}))
  ].map(other=>({...other,radius:other.envelope.radius,vertices:rectangle(other.position,other.envelope,other.yaw)}));
  const canTurn=(p,fromYaw,toYaw)=>{
   if(!turn(p,fromYaw,toYaw,envelope))return false;
   if(!Number.isFinite(to.yaw))return true;
   const nearby=bodySnapshot.filter(other=>distance(p,other.position)<envelope.radius+other.radius+.1);
   if(!nearby.length)return true;
   const delta=Math.atan2(Math.sin(toYaw-fromYaw),Math.cos(toYaw-fromYaw)),steps=Math.max(1,Math.ceil(Math.abs(delta)/.06));
   for(let i=0;i<=steps;i++)if(nearby.some(other=>overlap(rectangle(p,envelope,fromYaw+delta*i/steps),other.vertices)))return false;
   return true;
  };
  const canSee=(a,b,yaw=null)=>{
   const facing=yaw??Math.atan2(b.x-a.x,b.z-a.z);if(!segment(a,b,envelope,facing))return false;
   const dx=b.x-a.x,dz=b.z-a.z,squared=dx*dx+dz*dz;
   const nearby=bodySnapshot.filter(other=>{const k=squared?Math.max(0,Math.min(1,((other.position.x-a.x)*dx+(other.position.z-a.z)*dz)/squared)):0;return Math.hypot(other.position.x-a.x-dx*k,other.position.z-a.z-dz*k)<envelope.radius+other.radius;});
   for(let i=0,n=Math.max(1,Math.ceil(distance(a,b)/.3));i<=n;i++){
    const k=i/n,p={x:a.x+(b.x-a.x)*k,z:a.z+(b.z-a.z)*k};
    if(a.mount==null&&b.mount==null&&a.y<.5&&b.y<.5&&!fits({...p,y:supportAt(p.x,p.z)+.045},envelope,facing))return false;
    const own=rectangle(p,envelope,facing);
    if(nearby.some(other=>overlap(own,other.vertices)))return false;
   }return true;
  };
  const turns=new Map(),segments=new Map();
  const routeTurn=(p,fromYaw,toYaw)=>{const key=p.x+':'+p.y+':'+p.z+':'+fromYaw+':'+toYaw;let result=turns.get(key);if(result===undefined){result=canTurn(p,fromYaw,toYaw);turns.set(key,result);}return result;};
  const visible=(a,b,yaw=null)=>{const facing=yaw??Math.atan2(b.x-a.x,b.z-a.z),key=[a.x,a.y,a.z,a.mount,b.x,b.y,b.z,b.mount,facing].join(':');let result=segments.get(key);if(result===undefined){result=canSee(a,b,facing);segments.set(key,result);}return result;};
  const home=actor.home,dock=actor.dock,departing=distance(from,home)<.05,arriving=distance(to,home)<.05;
 // Placement offsets are at most .83 units; unrelated destinations cannot match this trip.
 const leisure=[];
 for(const s of [...leisurePlaces(),...(garden.assets.office?officeVisitors():[])])if(distance(s.position,to)<1||distance(s.position,from)<1){const candidate=place(actor,s);if(candidate)leisure.push(candidate);yield;}
 const goal=leisure.find(s=>distance(s.position,to)<.01),origin=leisure.find(s=>distance(s.position,from)<.01);
  const throat=dock?.approach?.at(-1),throatPoint=throat?point(throat[0],throat[2],throat[1]):null;
  let start=from,end=to,prefix=[],suffix=[];
  if(departing&&throatPoint){let p=from;for(const xyz of [...dock.approach].reverse()){const q=point(xyz[0],xyz[2],xyz[1]);if(!visible(p,q,actor.baseYaw))return [];prefix.push({...q,yaw:actor.baseYaw});p=q;yield;}start=p;}
  if(arriving&&throatPoint){let p=point(dock.approach[0][0],dock.approach[0][2],dock.approach[0][1]);end=p;for(const xyz of [...dock.approach.slice(1),[to.x,to.y,to.z]]){const q=point(xyz[0],xyz[2],xyz[1]);if(!visible(p,q,actor.baseYaw))return [];suffix.push({...q,yaw:actor.baseYaw});p=q;yield;}}
  if(origin){const path=approach(actor,origin,{reverse:true});if(!path)return [];start=path.at(-1);prefix=path;}
  if(goal){const path=approach(actor,goal);if(!path)return [];end=path[0];suffix=path;}
  const endPoint={x:end.x,y:end.y,z:end.z};
  const finalTurn=Number.isFinite(to.yaw)?[{x:end.x,y:end.y,z:end.z,yaw:to.yaw}]:[];
  function* validTurns(path){let p=from,yaw=from.yaw??actor.yaw??actor.baseYaw;for(const q of path){const facing=q.yaw??(distance(p,q)<1e-6?yaw:Math.atan2(q.x-p.x,q.z-p.z));if(!routeTurn(p,yaw,facing)||!visible(p,q,facing))return false;p=q;yaw=facing;yield;}return true;}
  const direct=[...prefix,endPoint,...finalTurn,...suffix];if(visible(start,end)&&(yield* validTurns(direct)))return direct;
  const costs=new Map(),parents=new Map(),queue=[];
  for(let i=0;i<nodes.length;i++){yield;const p=nodes[i];if(distance(start,p)<16&&visible(start,p)&&(yield* validTurns([...prefix,p]))){costs.set(i,distance(start,p));queue.push(i);}}
  let winner=null,total=Infinity;
  while(queue.length){queue.sort((a,b)=>costs.get(a)+distance(nodes[a],end)-costs.get(b)-distance(nodes[b],end));const id=queue.shift(),p=nodes[id],cost=costs.get(id);if(cost+distance(p,end)>total)break;
   const prior=parents.has(id)?nodes[parents.get(id)]:start,incoming=Math.atan2(p.x-prior.x,p.z-prior.z);
   if(distance(p,end)<16&&visible(p,end)&&cost+distance(p,end)<total&&routeTurn(p,incoming,Math.atan2(end.x-p.x,end.z-p.z))&&routeTurn(end,Math.atan2(end.x-p.x,end.z-p.z),to.yaw??suffix[0]?.yaw??Math.atan2(end.x-p.x,end.z-p.z))){winner=id;total=cost+distance(p,end);}
   yield;
   for(const next of edges[id]){
    yield;
    const ekey=signature+':'+id+':'+next;let valid=edgeCache.get(ekey);if(valid===undefined){valid=segment(p,nodes[next],envelope);edgeCache.set(ekey,valid);}if(!valid||!visible(p,nodes[next]))continue;
    if(!routeTurn(p,incoming,Math.atan2(nodes[next].x-p.x,nodes[next].z-p.z)))continue;
    const ncost=cost+distance(p,nodes[next]);if(ncost>=(costs.get(next)??Infinity))continue;costs.set(next,ncost);parents.set(next,id);queue.push(next);
   }
  }
  if(winner===null)return [];const path=[];for(let id=winner;id!==undefined;id=parents.get(id))path.push({...nodes[id]});path.reverse();const result=[...prefix,...path,endPoint,...finalTurn,...suffix];return (yield* validTurns(result))?result:[];
 }
 function fitsPlace(position,envelope,owner,ignore,places,bodies){
  const spot=[...placements.values()].find(s=>s&&distance(s.position,position)<.01)||leisurePlaces().find(s=>distance(s.position,position)<.01),dock=garden.docks.find(d=>distance(point(d.position[0],d.position[2]),position)<.01);
  const yaw=dock?.yaw??(spot?Math.atan2(spot.face.x-position.x,spot.face.z-position.z):envelope.yaw||0);
  if(!fits(position,envelope,yaw))return false;const own=rectangle(position,envelope,yaw);
  if(bodies.some(b=>b.owner!==owner&&overlap(own,rectangle(b.position,b.envelope,b.envelope.yaw||0))))return false;
  return ![...places.values()].some(p=>p.id!==ignore&&p.owner&&p.owner!==owner&&overlap(own,rectangle(p.position,p.envelope,p.envelope.yaw||0)));
 }
 return {setBodies(provider){bodies=provider;},setReservations(provider){reservations=provider;},floorRadius:85,floorCenter:{x:0,z:-4},eyeHeight:1.82,obstacles:[],fitsPlace,fits,segment,route,routeSteps,place,approach,
  meetingApproach(actor,spot){return approachAt(actor,{id:'meeting-chair',kind:'meeting',position:new T.Vector3(spot.x,spot.y,spot.z),face:new T.Vector3(0,spot.y,-4)});},
  supported,groundedPosition,supportAt,nodes,edges,physicalObstacles:obstacles,navigation:{groundAt(x,z,previous=.36,radius=.26,height=2.04){const y=supportAt(x,z);if(y===null)return null;const position={x,y:y+.045,z};return fits(position,{radius,height})?position.y:null;}}};
}

export function bindResidentNavigation(den,actors){
 den.walkWorld.setBodies(()=>[...actors.values(),...(den.guestActors?.values()||[])]);
 den.walkWorld.setReservations(()=>[...den.placeRegistry.values()].filter(place=>place.kind==='meeting'));
 den.routinePlace=(actor,spot)=>den.walkWorld.place(actor,spot);
 den.routineRoute=(actor,from,to)=>den.walkWorld.route(actor,from,to);
 den.routineRouteSteps=(actor,from,to)=>den.walkWorld.routeSteps(actor,from,to);
 den.routineClear=(actor,from,to)=>{
  const yaw=actor.path?.[0]?.yaw??(distance(from,to)<1e-6?(actor.yaw??actor.baseYaw):Math.atan2(to.x-from.x,to.z-from.z)),world=den.walkWorld;
  if(!world.segment(from,to,actor.envelope,yaw))return false;
  const startYaw=actor.yaw??actor.baseYaw,delta=Math.atan2(Math.sin(yaw-startYaw),Math.cos(yaw-startYaw));
  for(let k=0;k<=Math.ceil(Math.abs(delta)/.12);k++){const angle=startYaw+delta*k/Math.max(1,Math.ceil(Math.abs(delta)/.12));if(!world.fits(from,actor.envelope,angle))return false;}
  const steps=Math.max(1,Math.ceil(distance(from,to)/.25));
  for(let i=0;i<=steps;i++){
   const k=i/steps,own=rectangle({x:from.x+(to.x-from.x)*k,y:from.y+(to.y-from.y)*k,z:from.z+(to.z-from.z)*k},actor.envelope,yaw);
   for(const other of [...actors.values(),...(den.guestActors?.values()||[])])if(other!==actor&&other.panda.model.visible){const p=other.panda.model.position;if(overlap(own,rectangle(p,other.envelope,other.yaw??other.baseYaw)))return false;}
  }
  return true;
 };
 den.friendPlace=(guest,host)=>{
  if(host.teamId==='office'&&den.garden.assets.office){
   const spot=den.walkWorld.place(guest,officeVisitors()[host.runtime==='codex'?1:0]);
   if(!spot||!den.walkWorld.fits(host.home,host.envelope,host.baseYaw))return null;
   return spot;
  }
  const p=host.home,forward=new T.Vector3(0,0,-4.8).applyAxisAngle(new T.Vector3(0,1,0),host.baseYaw),position=p.clone().add(forward),face=p.clone();
  const yaw=Math.atan2(p.x-position.x,p.z-position.z),hostYaw=Math.atan2(position.x-p.x,position.z-p.z);
  if(!den.walkWorld.fits(position,guest.envelope,yaw)||!den.walkWorld.fits(p,host.envelope,hostYaw)||overlap(rectangle(position,guest.envelope,yaw),rectangle(p,host.envelope,hostYaw)))return null;
  // Visitors cannot occupy the team's central through-lane.
  const team=TEAMS.find(t=>t.id===host.teamId);if(!team||Math.abs(position.x-team.x)<3.2+guest.envelope.radius)return null;
  return {id:'visitor:'+host.id+':0',group:'friend:'+host.id,position,face};
 };
}
