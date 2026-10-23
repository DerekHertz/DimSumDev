import * as T from 'three';

// Independent source-geometry oracle. It neither calls nor reads the navigation
// raster: compare a disc to the actual rendered water triangles only; it does not depend on the navigation water metadata.
const segmentDistance=(p,a,b)=>{
 const dx=b.x-a.x,dz=b.z-a.z,s=dx*dx+dz*dz,t=s?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/s)):0;
 return Math.hypot(p.x-a.x-t*dx,p.z-a.z-t*dz);
};
function triangleDistance(p,[a,b,c]){
 const cross=(a,b)=>(b.x-a.x)*(p.z-a.z)-(b.z-a.z)*(p.x-a.x),s=[cross(a,b),cross(b,c),cross(c,a)];
 if(s.every(n=>n>=0)||s.every(n=>n<=0))return 0;
 return Math.min(segmentDistance(p,a,b),segmentDistance(p,b,c),segmentDistance(p,c,a));
}
export function gardenWaterOracle(garden){
 const triangles=[];
 for(const root of [garden.landscape.waterGroup,garden.assets.tea.pond.children.find(mesh=>mesh.material?.transparent&&mesh.material?.depthWrite===false)]){
  root.updateWorldMatrix(true,true);root.traverse(mesh=>{
   if(!mesh.isMesh)return;const attr=mesh.geometry.attributes.position,index=mesh.geometry.index;
   for(let i=0;i<(index?.count??attr.count);i+=3){const points=[0,1,2].map(j=>new T.Vector3().fromBufferAttribute(attr,index?index.getX(i+j):i+j).applyMatrix4(mesh.matrixWorld));
    if(Math.abs((points[1].x-points[0].x)*(points[2].z-points[0].z)-(points[1].z-points[0].z)*(points[2].x-points[0].x))>1e-9)triangles.push({points,top:Math.max(...points.map(p=>p.y))});
   }
  });
 }
 return{
  waterDistance(position){return Math.min(...triangles.filter(t=>t.top>=position.y-.12).map(t=>triangleDistance(position,t.points)));},
 };
}
