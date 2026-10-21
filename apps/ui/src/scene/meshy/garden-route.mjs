// A bounded surface search keeps meeting participants on the same stairs and
// clear floors as the player. Every edge samples clearance, including diagonals.
const DEFAULT_BODY={radius:.23,height:2.04};
export function routeGround(world,x,z,y,envelope=DEFAULT_BODY){
 if(world.obstacles?.some(o=>o.type==='circle'&&Math.hypot(x-o.x,z-o.z)<o.radius+envelope.radius))return null;
 return world.navigation.groundAt(x,z,y,envelope.radius,envelope.height);
}
// The final approach and every smoothed/diagonal segment use the same swept checks.
export function routeSegment(world,from,to,envelope=DEFAULT_BODY){
 const samples=Math.max(1,Math.ceil(Math.hypot(to.x-from.x,to.z-from.z)/.025));let y=from.y??.26;
 for(let i=0;i<=samples;i++){const t=i/samples;y=routeGround(world,from.x+(to.x-from.x)*t,from.z+(to.z-from.z)*t,y,envelope);if(y===null)return null;}
 return y;
}
export function gardenRoute(world,from,to,envelope=DEFAULT_BODY,work=null){
 if(work){
  if(!work.take('routes'))return [];
  // Allocation often has a clear landing in sight. Prove that entire swept
  // segment before paying for the grid; this uses the same physical checks.
  const y=routeSegment(world,from,to,envelope);if(y!==null)return [{x:to.x,y,z:to.z}];
 }
 const step=.4,key=(x,z)=>`${x},${z}`;
 const heap=[],seen=new Map(),end={x:to.x,z:to.z},ground=from.y??.26;
 const push=n=>{heap.push(n);let i=heap.length-1;while(i){const p=(i-1)>>1;if(heap[p].score<=n.score)break;heap[i]=heap[p];i=p;}heap[i]=n;};
 const pop=()=>{const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let c=i*2+1;if(c+1<heap.length&&heap[c+1].score<heap[c].score)c++;if(last.score<=heap[c].score)break;heap[i]=heap[c];i=c;}heap[i]=last;}return first;};
 const clear=(x,z,y)=>routeGround(world,x,z,y,envelope);
 if(clear(from.x,from.z,ground)===null||clear(to.x,to.z,to.y??ground)===null)return [];
 const start={ix:0,iz:0,x:from.x,z:from.z,y:ground,cost:0};start.score=Math.hypot(start.x-end.x,start.z-end.z);push(start);seen.set('0,0',start);
 for(let count=0;heap.length&&count<45000;count++){
  const n=pop();if(n.closed)continue;if(work&&!work.take('nodes'))return [];n.closed=true;
  if(Math.hypot(n.x-end.x,n.z-end.z)<step){
   const y=routeSegment(world,n,{...end,y:to.y},envelope);if(y!==null){const route=[{...end,y}];for(let p=n;p.parent;p=p.parent)route.push({x:p.x,y:p.y,z:p.z});return route.reverse();}
  }
  for(const[dx,dz]of[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){
   const ix=n.ix+dx,iz=n.iz+dz,id=key(ix,iz),x=from.x+ix*step,z=from.z+iz*step,cost=n.cost+Math.hypot(dx,dz)*step,old=seen.get(id);
   if(old&&old.cost<=cost)continue;
   const y=routeSegment(world,n,{x,z},envelope);if(y===null)continue;
   if(dx&&dz&&(clear(x,n.z,n.y)===null||clear(n.x,z,n.y)===null))continue;
   const next={ix,iz,x,z,y,cost,parent:n,score:cost+Math.hypot(x-end.x,z-end.z)};seen.set(id,next);push(next);
  }
 }
 return [];
}
