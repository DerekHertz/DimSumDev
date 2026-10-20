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
export function createSurfaceNavigation(objects,{placement=.18,floorRadius=29,floorCenter={x:0,z:-1},baseY=0}={}){
 const columns=new Map(),point=new THREE.Vector3(),ab=new THREE.Vector3(),ac=new THREE.Vector3(),normal=new THREE.Vector3();let triangles=0;
 const key=(x,z)=>`${x},${z}`;
 for(const root of objects){
  root.updateWorldMatrix(true,true);
  root.traverse(mesh=>{
   if(!mesh.isMesh||!mesh.geometry?.attributes.position)return;
   for(let p=mesh;p;p=p.parent)if(!p.visible)return;
   const attr=mesh.geometry.attributes.position,indices=mesh.geometry.index;
   for(let i=0;i<(indices?.count||attr.count);i+=3){
    const triangle=[0,1,2].map(j=>point.fromBufferAttribute(attr,indices?indices.getX(i+j):i+j).applyMatrix4(mesh.matrixWorld).clone());
    const low=Math.min(...triangle.map(v=>v.y)),high=Math.max(...triangle.map(v=>v.y));
    if(high<.08||low>7)continue;
    const minX=Math.floor(Math.min(...triangle.map(v=>v.x))/placement),maxX=Math.floor(Math.max(...triangle.map(v=>v.x))/placement),minZ=Math.floor(Math.min(...triangle.map(v=>v.z))/placement),maxZ=Math.floor(Math.max(...triangle.map(v=>v.z))/placement);
    ab.subVectors(triangle[1],triangle[0]);ac.subVectors(triangle[2],triangle[0]);normal.crossVectors(ab,ac).normalize();const supports=Math.abs(normal.y)>.70;
    for(let x=minX;x<=maxX;x++)for(let z=minZ;z<=maxZ;z++){
     if(Math.hypot((x+.5)*placement-floorCenter.x,(z+.5)*placement-floorCenter.z)>floorRadius)continue;
     let polygon=triangle;
     for(const [axis,bound,greater]of [['x',x*placement,true],['x',(x+1)*placement,false],['z',z*placement,true],['z',(z+1)*placement,false]]){polygon=clip(polygon,axis,bound,greater);if(!polygon.length)break;}
     if(!polygon.length)continue;
     const id=key(x,z);let column=columns.get(id);if(!column)columns.set(id,column={surfaces:[],spans:[]});
     const bottom=Math.min(...polygon.map(v=>v.y)),top=Math.max(...polygon.map(v=>v.y));column.spans.push([bottom,top]);
     if(supports)column.surfaces.push((bottom+top)/2);
    }
    triangles++;
   }
  });
 }
 for(const column of columns.values()){
  column.surfaces=[...new Set(column.surfaces.map(y=>Math.round(y*100)/100))].sort((a,b)=>a-b);
  const merged=[];for(const span of column.spans.sort((a,b)=>a[0]-b[0])){const last=merged.at(-1);if(last&&span[0]<=last[1]+.025)last[1]=Math.max(last[1],span[1]);else merged.push(span);}
  column.spans=merged;
 }
 const columnAt=(x,z)=>columns.get(key(Math.floor(x/placement),Math.floor(z/placement)));
 function groundAt(x,z,previous=0,radius=.26,bodyHeight=BODY_HEIGHT){
  const center=columnAt(x,z),surfaces=[baseY,...(center?.surfaces||[])];
  const candidates=surfaces.filter(y=>y<=previous+STEP_UP+.015&&y>=previous-STEP_DOWN-.015).sort((a,b)=>b-a);
  for(const ground of candidates){
   let blocked=false;
   for(const [dx,dz]of [[0,0],[-radius,0],[radius,0],[0,-radius],[0,radius],[-radius*.7,-radius*.7],[radius*.7,-radius*.7],[-radius*.7,radius*.7],[radius*.7,radius*.7]]){
    const c=columnAt(x+dx,z+dz);
    // A body's leading edge can cover the next stair before its centre reaches
    // that tread. Include that short look-ahead; the centre still obeys STEP_UP.
    const neighborGround=dx||dz ? Math.max(ground,...(c?.surfaces||[]).filter(y=>y<=ground+STEP_UP+radius+.015)) : ground;
    if(c?.spans.some(([lo,hi])=>hi>neighborGround+.12&&lo<ground+bodyHeight)){blocked=true;break;}
   }
   if(!blocked)return ground;
  }
  return null;
 }
 return {groundAt,placement,columns:columns.size,triangles,stepUp:STEP_UP,stepDown:STEP_DOWN,bodyHeight:BODY_HEIGHT};
}
