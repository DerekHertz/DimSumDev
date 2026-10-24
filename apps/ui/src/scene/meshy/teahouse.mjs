import * as T from 'three';
import {TABLE,seatSpots,CHAIR_SPOT} from './meeting-table.mjs';

export function fitTeahouseProp(source,size){
 const object=source.clone(true),bounds=new T.Box3().setFromObject(object),extent=bounds.getSize(new T.Vector3()),center=bounds.getCenter(new T.Vector3());
 const root=new T.Group();object.position.sub(center);object.position.y+=extent.y/2;root.add(object);
 root.scale.set(size[0]/extent.x,size[1]/extent.y,size[2]/extent.z);
 root.traverse(n=>{if(n.isMesh)n.castShadow=n.receiveShadow=true;});return root;
}

export function buildTeahouse(kit,{props={}}={}){
 const {group,cyl,box,beam,orb}=kit,root=group('Round table teahouse'),chairs=[];
 root.userData.denInteraction={id:'center'};
 const floor=group('Circular stone inset',root);
 cyl(floor,9,.075,[TABLE.x,.35,TABLE.z],'cream');cyl(floor,8.5,.045,[TABLE.x,.39,TABLE.z],'jadeLight');
 const table=group('Solid pedestal meeting table',root);
 cyl(table,1.45,.22,[0,.5225,-4],'timber');cyl(table,.85,.85,[0,1.04,-4],'timber',1.05);
 cyl(table,3.2,.3,[0,1.59,-4],'honey');cyl(table,3.1,.045,[0,1.7625,-4],'paleWood');
 const teaTray=kit.teaSet(root,[0,1.79,-4],1.4);teaTray.name='Lazy susan';
 const allSpots=[CHAIR_SPOT,...seatSpots(6)];
 const upholstery=new T.MeshStandardMaterial({color:'#aab3a0',roughness:1});
 for(const [index,spot]of allSpots.entries()){
  const width=index===0?4.4:4,depth=4;
  const chair=group('Permanent curved-back chair '+index,root,[spot.x-Math.sin(spot.yaw)*1.2,.4125,spot.z-Math.cos(spot.yaw)*1.2]);chair.rotation.y=spot.yaw;
  if(props.chair)chair.add(fitTeahouseProp(props.chair,[width,1.25,depth]));
  else{
   box(chair,[width,.2,depth],[0,.63,0],'timber',.1);box(chair,[width-.2,.14,depth-.2],[0,.73,0],'jadeLight',.1);
   for(const x of [-width*.4,width*.4])for(const z of [-depth*.4,depth*.4])beam(chair,[x,0,z],[x,.58,z],.08,'timber');
   const back=kit.mesh(chair,new T.TorusGeometry(width*.43,.1,6,24,Math.PI),'timber',[0,1.05,-depth*.1]);back.rotation.x=Math.PI/2;
  }
  const supportWidth=index===0?3.6:3;
  const pad=box(chair,[supportWidth,.14,2.2],[0,.6975,1.2],upholstery,.13);pad.name='Fitted sage seat pad';
  chair.traverse(node=>{if(node.isMesh)node.castShadow=false;});
  chairs.push({root:chair,spot,supportTop:1.18,width,depth,supportWidth});
 }
 const lanternFrame=group('Meeting lantern and cantilever',root);
 beam(lanternFrame,[0,.4,-7.7],[0,6.8,-7.7],.09,'timber');beam(lanternFrame,[0,6.8,-7.7],[0,6.8,-4],.09,'timber');beam(lanternFrame,[0,6.8,-4],[0,6.2,-4],.025,'honey');
 const paper=new T.MeshStandardMaterial({color:'#fff1cf',emissive:'#eab56f',emissiveIntensity:.12,roughness:.9});
 const lantern=orb(lanternFrame,.6,[0,5.6,-4],paper,[1,1.25,1]);
 for(const height of [4.88,6.32])cyl(lanternFrame,.27,.09,[0,height,-4],'timber');
 return {root,table,chairs,floor,teaTray,lantern,lanternFrame};
}

// Project each real triangle into small conservative columns. Unlike a single
// mesh box, these retain the chair's open front and curved back for mounting.
export function propObstacles(object,cell=.25){
 object.updateWorldMatrix(true,true);const columns=new Map(),p=new T.Vector3(),inverse=object.matrixWorld.clone().invert();
 object.traverse(mesh=>{
  if(!mesh.isMesh)return;const vertices=mesh.geometry.attributes.position,index=mesh.geometry.index;
  for(let i=0;i<(index?.count??vertices.count);i+=3){
   const bounds=new T.Box3();for(let k=0;k<3;k++)bounds.expandByPoint(p.fromBufferAttribute(vertices,index?index.getX(i+k):i+k).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse));
   for(let x=Math.floor(bounds.min.x/cell);x<=Math.floor(bounds.max.x/cell);x++)for(let z=Math.floor(bounds.min.z/cell);z<=Math.floor(bounds.max.z/cell);z++){
    const key=x+':'+z,existing=columns.get(key),min=[x*cell,bounds.min.y,z*cell],max=[(x+1)*cell,bounds.max.y,(z+1)*cell];
    if(existing){existing.min[1]=Math.min(existing.min[1],min[1]);existing.max[1]=Math.max(existing.max[1],max[1]);}else columns.set(key,{name:object.name,min,max});
   }
  }
 });return [...columns.values()].map(column=>{
  const bounds=new T.Box3(new T.Vector3(...column.min),new T.Vector3(...column.max)).applyMatrix4(object.matrixWorld);
  const vertices=[[column.min[0],column.min[2]],[column.min[0],column.max[2]],[column.max[0],column.min[2]],[column.max[0],column.max[2]]].map(([x,z])=>new T.Vector3(x,0,z).applyMatrix4(object.matrixWorld)).map(p=>[p.x,p.z]);
  return {name:column.name,min:bounds.min.toArray(),max:bounds.max.toArray(),vertices};
 });
}
