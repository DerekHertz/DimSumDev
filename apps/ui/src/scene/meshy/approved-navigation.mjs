import * as T from 'three';
import {TEAMS,WALKS,transform,leisurePlaces} from './approved-plan.mjs';
import {routeLength} from './daily-routines.mjs';

const EPS=.025,distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const point=(x,z,y=.36)=>({x,y,z});
function rectangle(position,envelope,yaw){
 const box=envelope.bounds||{min:[-envelope.radius,0,-envelope.radius],max:[envelope.radius,envelope.height,envelope.radius]};
 const vertices=[];for(const x of [box.min[0],box.max[0]])for(const z of [box.min[2],box.max[2]])vertices.push({x:position.x+x*Math.cos(yaw)+z*Math.sin(yaw),z:position.z-x*Math.sin(yaw)+z*Math.cos(yaw)});
 return vertices;
}
const overlap=(a,b)=>{
 for(const polygon of [a,b])for(const [i,j]of [[0,1],[0,2]]){
  const axis={x:polygon[j].z-polygon[i].z,z:polygon[i].x-polygon[j].x},pa=a.map(p=>p.x*axis.x+p.z*axis.z),pb=b.map(p=>p.x*axis.x+p.z*axis.z);
  if(Math.max(...pa)<=Math.min(...pb)+EPS||Math.max(...pb)<=Math.min(...pa)+EPS)return false;
 }return true;
};
export function createApprovedNavigation(garden){
 const obstacles=garden.obstacles.map(o=>({...o,vertices:o.vertices?.map(v=>Array.isArray(v)?{x:v[0],z:v[1]}:v)||[{x:o.min[0],z:o.min[2]},{x:o.min[0],z:o.max[2]},{x:o.max[0],z:o.min[2]},{x:o.max[0],z:o.max[2]}]}));
 obstacles.push({min:[-2,0,-5.18],max:[2,1.5,-2.82],vertices:[{x:-2,z:-5.18},{x:-2,z:-2.82},{x:2,z:-5.18},{x:2,z:-2.82}],name:'Meeting table'});
 const cells=new Map();for(const o of obstacles)for(let x=Math.floor(o.min[0]/4);x<=Math.floor(o.max[0]/4);x++)for(let z=Math.floor(o.min[2]/4);z<=Math.floor(o.max[2]/4);z++){const key=x+':'+z;if(!cells.has(key))cells.set(key,[]);cells.get(key).push(o);}
 function fits(position,envelope,yaw=0,trace=null){
  const vertices=rectangle(position,envelope,yaw);if(vertices.some(p=>!garden.inside(p.x,p.z)))return false;
  const nearby=new Set();for(let x=Math.floor(Math.min(...vertices.map(p=>p.x))/4);x<=Math.floor(Math.max(...vertices.map(p=>p.x))/4);x++)for(let z=Math.floor(Math.min(...vertices.map(p=>p.z))/4);z<=Math.floor(Math.max(...vertices.map(p=>p.z))/4);z++)for(const o of cells.get(x+':'+z)||[])nearby.add(o);
  const blocked=[...nearby].find(o=>o.max[1]>position.y+.1&&o.min[1]<position.y+envelope.height&&(envelope.slices?
   envelope.slices.some(slice=>o.max[1]>position.y+Math.max(.1,slice.min[1])&&o.min[1]<position.y+slice.max[1]&&overlap(rectangle(position,{bounds:slice},yaw),o.vertices)):
   overlap(vertices,o.vertices)));
  if(blocked&&trace)trace.push(blocked);return !blocked;
 }
 function segment(a,b,envelope,yaw=null){
  const d=distance(a,b),facing=yaw??Math.atan2(b.x-a.x,b.z-a.z),steps=Math.max(1,Math.ceil(d/.25));
  for(let i=0;i<=steps;i++){const k=i/steps;if(!fits({x:a.x+(b.x-a.x)*k,y:a.y+(b.y-a.y)*k,z:a.z+(b.z-a.z)*k},envelope,facing))return false;}return true;
 }
 const nodes=[],edges=[],key=p=>p.x.toFixed(3)+':'+p.z.toFixed(3),byKey=new Map();
 const node=p=>{const k=key(p);if(byKey.has(k))return byKey.get(k);const i=nodes.length;nodes.push(p);edges.push(new Set());byKey.set(k,i);return i;};
 const lines=WALKS.flatMap(([path])=>path.slice(1).map((p,i)=>[point(...path[i]),point(...p)]));
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
  const envelope=actor.envelope,signature=JSON.stringify([envelope.radius,envelope.height,envelope.bounds]);
  const visible=(a,b,yaw=null)=>segment(a,b,envelope,yaw);
  const home=actor.home,dock=actor.dock,departing=distance(from,home)<.05,arriving=distance(to,home)<.05;
  const leisure=leisurePlaces(),goal=leisure.find(s=>distance(s.position,to)<.01),origin=leisure.find(s=>distance(s.position,from)<.01);
  const throat=dock?.approach?.at(-1),throatPoint=throat?point(throat[0],throat[2],throat[1]):null;
  let start=from,end=to,prefix=[],suffix=[];
  if(departing&&throatPoint){let p=from;for(const xyz of [...dock.approach].reverse()){const q=point(xyz[0],xyz[2],xyz[1]);if(!visible(p,q,actor.baseYaw))return [];prefix.push({...q,yaw:actor.baseYaw});p=q;}start=p;}
  if(arriving&&throatPoint){let p=point(dock.approach[0][0],dock.approach[0][2],dock.approach[0][1]);end=p;for(const xyz of [...dock.approach.slice(1),[to.x,to.y,to.z]]){const q=point(xyz[0],xyz[2],xyz[1]);if(!visible(p,q,actor.baseYaw))return [];suffix.push({...q,yaw:actor.baseYaw});p=q;}}
  if(origin){const yaw=Math.atan2(origin.face.x-from.x,origin.face.z-from.z);if(!visible(from,origin.approach,yaw))return [];start=origin.approach;prefix=[{...start,yaw}];}
  if(goal){const yaw=Math.atan2(goal.face.x-to.x,goal.face.z-to.z);if(!visible(goal.approach,to,yaw))return [];end=goal.approach;suffix=[{...to,yaw}];}
  if(visible(start,end))return [...prefix,{...end},...suffix];
  const costs=new Map(),parents=new Map(),queue=[];
  nodes.forEach((p,i)=>{if(distance(start,p)<16&&visible(start,p)){costs.set(i,distance(start,p));queue.push(i);}});
  let winner=null,total=Infinity;
  while(queue.length){queue.sort((a,b)=>costs.get(a)-costs.get(b));const id=queue.shift(),p=nodes[id],cost=costs.get(id);if(cost>total)break;
   if(distance(p,end)<16&&visible(p,end)&&cost+distance(p,end)<total){winner=id;total=cost+distance(p,end);}
   for(const next of edges[id]){
    const ekey=signature+':'+id+':'+next;let valid=edgeCache.get(ekey);if(valid===undefined){valid=visible(p,nodes[next]);edgeCache.set(ekey,valid);}if(!valid)continue;
    const ncost=cost+distance(p,nodes[next]);if(ncost>=(costs.get(next)??Infinity))continue;costs.set(next,ncost);parents.set(next,id);queue.push(next);
   }
  }
  if(winner===null)return [];const path=[];for(let id=winner;id!==undefined;id=parents.get(id))path.push({...nodes[id]});path.reverse();return [...prefix,...path,{...end},...suffix];
 }
 function fitsPlace(position,envelope,owner,ignore,places,bodies){
  const spot=leisurePlaces().find(s=>distance(s.position,position)<.01),dock=garden.docks.find(d=>distance(point(d.position[0],d.position[2]),position)<.01);
  const yaw=dock?.yaw??(spot?Math.atan2(spot.face.x-position.x,spot.face.z-position.z):envelope.yaw||0);
  if(!fits(position,envelope,yaw))return false;const own=rectangle(position,envelope,yaw);
  if(bodies.some(b=>b.owner!==owner&&overlap(own,rectangle(b.position,b.envelope,b.envelope.yaw||0))))return false;
  return ![...places.values()].some(p=>p.id!==ignore&&p.owner&&p.owner!==owner&&overlap(own,rectangle(p.position,p.envelope,p.envelope.yaw||0)));
 }
 return {floorRadius:85,floorCenter:{x:0,z:-4},eyeHeight:1.82,obstacles:[],fitsPlace,fits,segment,route,nodes,edges,physicalObstacles:obstacles,navigation:{groundAt(x,z,previous=.36,radius=.26,height=2.04){const position={x,y:previous,z};return fits(position,{radius,height})?previous:null;}}};
}

export function bindResidentNavigation(den,actors){
 den.routineRoute=(actor,from,to)=>den.walkWorld.route(actor,from,to);
 den.routineClear=(actor,from,to)=>{
  const yaw=actor.path?.[0]?.yaw??Math.atan2(to.x-from.x,to.z-from.z),world=den.walkWorld;
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
  const p=host.home,forward=new T.Vector3(0,0,-4.8).applyAxisAngle(new T.Vector3(0,1,0),host.baseYaw),position=p.clone().add(forward),face=p.clone();
  const yaw=Math.atan2(p.x-position.x,p.z-position.z),hostYaw=Math.atan2(position.x-p.x,position.z-p.z);
  if(!den.walkWorld.fits(position,guest.envelope,yaw)||!den.walkWorld.fits(p,host.envelope,hostYaw)||overlap(rectangle(position,guest.envelope,yaw),rectangle(p,host.envelope,hostYaw)))return null;
  // Visitors cannot occupy the team's central through-lane.
  const team=TEAMS.find(t=>t.id===host.teamId);if(!team||Math.abs(position.x-team.x)<3.2+guest.envelope.radius)return null;
  return {id:'visitor:'+host.id+':0',group:'friend:'+host.id,position,face};
 };
}
