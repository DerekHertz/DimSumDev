import * as THREE from 'three';
const STEP_UP=.30,STEP_DOWN=.42,BODY_HEIGHT=2.04;
// Clip a triangle to an X/Z placement while retaining interpolated elevation. This is
// built once from the actual local models; walking never raycasts millions of triangles.
function clip(points,axis,bound,greater){
 const out=[];
 for(let i=0;i<points.length;i++){
  const a=points[i],b=points[(i+1)%points.length],insideA=greater?a[axis]>=bound:a[axis]<=bound,insideB=greater?b[axis]>=bound:b[axis]<=bound;
  if(insideA)out.push(a);
  if(insideA!==insideB){const t=(bound-a[axis])/(b[axis]-a[axis]);out.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});}
 }
 return out;
}
export function createSurfaceNavigation(objects,{placement=.18,floorRadius=29,floorCenter={x:0,z:-1},baseY=0,excludedObjects=[]}={}){
 const columns=new Map(),point=new THREE.Vector3(),ab=new THREE.Vector3(),ac=new THREE.Vector3(),normal=new THREE.Vector3();let triangles=0;
 const key=(x,z)=>`${x},${z}`;
 for(const root of [...objects,...excludedObjects]){
  const excluded=excludedObjects.includes(root);
  root.updateWorldMatrix(true,true);
  root.traverse(mesh=>{
   if(!mesh.isMesh||!mesh.geometry?.attributes.position)return;
   for(let p=mesh;p;p=p.parent)if(!p.visible)return;
   const attr=mesh.geometry.attributes.position,indices=mesh.geometry.index;
   for(let i=0;i<(indices?.count||attr.count);i+=3){
    const triangle=[0,1,2].map(j=>point.fromBufferAttribute(attr,indices?indices.getX(i+j):i+j).applyMatrix4(mesh.matrixWorld).clone());
    const low=Math.min(...triangle.map(v=>v.y)),high=Math.max(...triangle.map(v=>v.y));
    if(high<baseY-STEP_DOWN||low>7)continue;
    const minX=Math.floor(Math.min(...triangle.map(v=>v.x))/placement),maxX=Math.floor(Math.max(...triangle.map(v=>v.x))/placement),minZ=Math.floor(Math.min(...triangle.map(v=>v.z))/placement),maxZ=Math.floor(Math.max(...triangle.map(v=>v.z))/placement);
    ab.subVectors(triangle[1],triangle[0]);ac.subVectors(triangle[2],triangle[0]);normal.crossVectors(ab,ac).normalize();const supports=normal.y>.70;
    for(let x=minX;x<=maxX;x++)for(let z=minZ;z<=maxZ;z++){
     if(Math.hypot((x+.5)*placement-floorCenter.x,(z+.5)*placement-floorCenter.z)>floorRadius)continue;
     let polygon=triangle;
     for(const [axis,bound,greater]of [['x',x*placement,true],['x',(x+1)*placement,false],['z',z*placement,true],['z',(z+1)*placement,false]]){polygon=clip(polygon,axis,bound,greater);if(!polygon.length)break;}
     if(!polygon.length)continue;
     const id=key(x,z);let column=columns.get(id);if(!column)columns.set(id,column={surfaces:[],volumes:new Map()});
     const bottom=Math.min(...polygon.map(v=>v.y)),top=Math.max(...polygon.map(v=>v.y));let volume=column.volumes.get(mesh);
     if(volume){volume[0]=Math.min(volume[0],bottom);volume[1]=Math.max(volume[1],top);}else{volume=[bottom,top,mesh.userData.navigationSurface==='walkable',excluded,0];column.volumes.set(mesh,volume);}
     if(supports)volume[4]+=Math.abs(polygon.reduce((area,p,i)=>{const next=polygon[(i+1)%polygon.length];return area+p.x*next.z-next.x*p.z;},0))/2;
     if(supports&&!excluded)column.surfaces.push((bottom+top)/2);
    }
    triangles++;
   }
  });
 }
 for(const column of columns.values()){
  column.surfaces=[...new Set(column.surfaces.map(y=>Math.round(y*100)/100))].sort((a,b)=>a-b);
  // Keep authored supporting floors separate from solids. A table's top or an
  // overhead beam must never become a stair simply because a wide body reaches it.
  const merged=[];for(const span of [...column.volumes.values()].sort((a,b)=>Number(a[3])-Number(b[3])||Number(a[2])-Number(b[2])||a[0]-b[0])){span[4]=span[4]>=placement*placement-1e-7;const last=merged.at(-1);if(last&&!span[2]&&span[2]===last[2]&&span[3]===last[3]&&span[0]<=last[1]+.025)last[1]=Math.max(last[1],span[1]);else merged.push(span);}
  column.spans=merged;delete column.volumes;
 }
 const columnAt=(x,z)=>columns.get(key(Math.floor(x/placement),Math.floor(z/placement)));
 // Cache only candidate columns, never a clearance verdict: sub-cell positions,
 // ground elevation and the requested envelope still receive exact checks.
 const footprints=new Map();
 function footprintAt(x,z,radius){
  const cx=Math.floor(x/placement),cz=Math.floor(z/placement),id=`${cx},${cz},${radius}`;
  let footprint=footprints.get(id);if(footprint)return footprint;
  footprint=[];
  for(let ix=Math.floor(cx-radius/placement);ix<=Math.floor(cx+1+radius/placement);ix++)for(let iz=Math.floor(cz-radius/placement);iz<=Math.floor(cz+1+radius/placement);iz++){
   const column=columns.get(key(ix,iz));if(column)footprint.push({x0:ix*placement,x1:(ix+1)*placement,z0:iz*placement,z1:(iz+1)*placement,column});
  }
  if(footprints.size>=512)footprints.delete(footprints.keys().next().value);
  footprints.set(id,footprint);return footprint;
 }
 function groundAt(x,z,previous=0,radius=.26,bodyHeight=BODY_HEIGHT){
  const center=columnAt(x,z),surfaces=[baseY,...(center?.surfaces||[])];
  const footprint=footprintAt(x,z,radius);
  const candidates=surfaces.filter(y=>y<=previous+STEP_UP+.015&&y>=previous-STEP_DOWN-.015).sort((a,b)=>b-a);
  for(const ground of candidates){
   let blocked=false;
   // Visit every raster cell intersected by the complete disc, including its
   // interior. Cell bounds conservatively cover the clipped source triangles.
   outer:for(const {x0,x1,z0,z1,column:c}of footprint){
    const dx=Math.max(x0-x,0,x-x1),dz=Math.max(z0-z,0,z-z1);
    if(dx*dx+dz*dz>radius*radius)continue;
    for(const [lo,hi,walkable,excluded]of c.spans){
     if(excluded){
      // Water and planted banks are never standing surfaces. Only an actual
      // authored bridge/deck in this footprint cell can provide support above it.
      if(!c.spans.some(([bottom,top,support,water,coversCell])=>support&&coversCell&&!water&&top>=hi+.12&&bottom<=ground+.12&&top<=ground+STEP_UP+radius+.015)){blocked=true;break outer;}
      continue;
     }
     // Only explicitly authored low floors/treads can support the leading edge.
     // Centre elevation still obeys STEP_UP; furniture retains its entire volume.
     const centerCell=x>=x0&&x<x1&&z>=z0&&z<z1;
     const support=!centerCell&&lo<=ground+.12&&hi<=ground+STEP_UP+(walkable?radius:0)+.015?hi:ground;
     if(hi>support+.12&&lo<ground+bodyHeight){blocked=true;break outer;}
    }
   }
   if(!blocked)return ground;
  }
  return null;
 }
 // Raster geometry is immutable. Repeated edges may reuse only an identical
 // floating-point query (including previous height and both body dimensions).
 const results=new Map();
 function cachedGroundAt(x,z,previous=0,radius=.26,height=BODY_HEIGHT){
  const id=[x,z,previous,radius,height].join(':');if(results.has(id))return results.get(id);
  const y=groundAt(x,z,previous,radius,height);if(results.size>=32768)results.delete(results.keys().next().value);results.set(id,y);return y;
 }
 return {groundAt:cachedGroundAt,placement,columns:columns.size,triangles,stepUp:STEP_UP,stepDown:STEP_DOWN,bodyHeight:BODY_HEIGHT};
}
