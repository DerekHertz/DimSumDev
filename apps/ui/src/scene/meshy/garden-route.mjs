// A bounded surface search keeps meeting participants on the same stairs and
// clear floors as the player. Every edge samples clearance, including diagonals.
export function gardenRoute(world,from,to){
 const nav=world.navigation,step=.4,radius=.23,key=(x,z)=>`${x},${z}`;
 const heap=[],seen=new Map(),end={x:to.x,z:to.z},ground=from.y??.26;
 const push=n=>{heap.push(n);let i=heap.length-1;while(i){const p=(i-1)>>1;if(heap[p].score<=n.score)break;heap[i]=heap[p];i=p;}heap[i]=n;};
 const pop=()=>{const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let c=i*2+1;if(c+1<heap.length&&heap[c+1].score<heap[c].score)c++;if(last.score<=heap[c].score)break;heap[i]=heap[c];i=c;}heap[i]=last;}return first;};
 const clear=(x,z,y)=>{if(world.obstacles?.some(o=>o.type==='circle'&&Math.hypot(x-o.x,z-o.z)<o.radius+radius))return null;return nav.groundAt(x,z,y,radius);};
 const start={ix:0,iz:0,x:from.x,z:from.z,y:ground,cost:0};start.score=Math.hypot(start.x-end.x,start.z-end.z);push(start);seen.set('0,0',start);
 for(let count=0;heap.length&&count<45000;count++){
  const n=pop();if(n.closed)continue;n.closed=true;
  if(Math.hypot(n.x-end.x,n.z-end.z)<step){
   const y=clear(end.x,end.z,n.y);if(y!==null){const route=[{...end,y}];for(let p=n;p.parent;p=p.parent)route.push({x:p.x,y:p.y,z:p.z});return route.reverse();}
  }
  for(const[dx,dz]of[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){
   const ix=n.ix+dx,iz=n.iz+dz,id=key(ix,iz),x=from.x+ix*step,z=from.z+iz*step,cost=n.cost+Math.hypot(dx,dz)*step,old=seen.get(id);
   if(old&&old.cost<=cost)continue;
   const mid=clear((n.x+x)/2,(n.z+z)/2,n.y);if(mid===null)continue;
   const y=clear(x,z,mid);if(y===null)continue;
   if(dx&&dz&&(clear(x,n.z,n.y)===null||clear(n.x,z,n.y)===null))continue;
   const next={ix,iz,x,z,y,cost,parent:n,score:cost+Math.hypot(x-end.x,z-end.z)};seen.set(id,next);push(next);
  }
 }
 return [];
}
