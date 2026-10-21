const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const KINDS=new Set(['work','meeting','leisure','visitor','staging']);
export const actorIdentity=actor=>JSON.stringify([actor.projectId??actor.project??null,actor.runtime??'claude',actor.role??null,actor.agentId??actor.id??null,actor.ref??null]);

// One scene-owned registry. A lease owns an envelope, not merely a role or a coordinate.
export function createPlaceRegistry(world,{getBodies=()=>[]}={}){
 const places=new Map();let revision=0;
 function define({id,kind,position}){
  if(!KINDS.has(kind))throw Error('Unknown place kind: '+kind);
  const old=places.get(id);if(old)return old;
  const place={id,kind,position:{...position},owner:null,envelope:null,occupied:false,departing:false,revision:0};places.set(id,place);revision++;return place;
 }
 const ground=(position,envelope,work)=>work?work.groundAt(world.navigation,position.x,position.z,position.y,envelope.radius,envelope.height):world.navigation.groundAt(position.x,position.z,position.y,envelope.radius,envelope.height);
 function fits(position,envelope,owner,ignore=null,work=null){
  const y=ground(position,envelope,work);
  if(y===null||Math.abs(y-position.y)>.1)return false;
  if(world.obstacles?.some(o=>o.type==='circle'&&distance(position,o)<o.radius+envelope.radius))return false;
  if(getBodies().some(b=>b.owner!==owner&&distance(position,b.position)<envelope.radius+b.envelope.radius+.03))return false;
  return ![...places.values()].some(p=>p.id!==ignore&&p.owner&&p.owner!==owner&&distance(position,p.position)<envelope.radius+p.envelope.radius+.05);
 }
 function reserve(id,owner,envelope,work=null){
  const p=places.get(id);if(!p||p.owner&&p.owner!==owner||!fits(p.position,envelope,owner,id,work))return null;
  if(p.owner!==owner){p.owner=owner;p.envelope={...envelope};p.occupied=false;p.departing=false;p.revision++;revision++;}return p;
 }
 function clear(p){p.owner=null;p.envelope=null;p.occupied=false;p.departing=false;p.revision++;revision++;}
 function release(id,owner){const p=places.get(id);if(p?.owner!==owner)return;if(p.occupied){p.departing=true;}else clear(p);}
 function occupy(id,owner){const p=places.get(id);if(p?.owner!==owner)return false;p.occupied=true;p.departing=false;return true;}
 function clearDeparted(owner,position,envelope){for(const p of places.values())if(p.owner===owner&&p.departing&&distance(position,p.position)>envelope.radius+p.envelope.radius+.1)clear(p);}
 function cancel(owner,keepPlaceId=null){for(const p of places.values())if(p.owner===owner&&p.id!==keepPlaceId)release(p.id,owner);}
 function disposeActor(owner){for(const p of places.values())if(p.owner===owner)clear(p);}
 function rebind(from,to){if(from===to)return;for(const p of places.values())if(p.owner===from)p.owner=to;revision++;}
 function find({id,kind,near,owner,envelope,validate=()=>true,work=null}){
  const existing=places.get(id);if(existing?.owner)return (!work||work.take('candidates'))&&validate(existing.position)?reserve(id,owner,envelope,work):null;
  const candidates=[{...near}];
  for(let ring=1;ring<=8;ring++)for(let step=0;step<16;step++){const angle=step*Math.PI/8,r=ring*Math.max(.8,envelope.radius*1.5);candidates.push({x:near.x+Math.sin(angle)*r,y:near.y,z:near.z+Math.cos(angle)*r});}
  for(const position of candidates){if(work?.exhausted)break;const y=ground(position,envelope,work);if(y===null)continue;position.y=y;if(!fits(position,envelope,owner,null,work))continue;if(work&&!work.take('candidates'))break;if(!validate(position))continue;const place=define({id,kind,position});if(existing)place.position={...position};if(reserve(place.id,owner,envelope,work))return place;}
  return null;
 }
 return {define,get:id=>places.get(id),values:()=>places.values(),reserve,occupy,release,cancel,disposeActor,rebind,clearDeparted,find,fits,get revision(){return revision;},dispose(){places.clear();revision++;}};
}
