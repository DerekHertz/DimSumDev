// THROWAWAY independent occupied-vertex oracle; never changes poses or envelopes.
import * as T from 'three';
const xyz=v=>({x:v.x,y:v.y,z:v.z});
const transform=o=>({name:o.name,type:o.type,uuid:o.uuid,position:o.position.toArray(),quaternion:o.quaternion.toArray(),scale:o.scale.toArray(),matrix:o.matrix.toArray(),matrixWorld:o.matrixWorld.toArray()});
const chain=o=>{const result=[];for(;o;o=o.parent)result.push(transform(o));return result;};
export function occupiedVertices(actor){
 const model=actor.panda.model;
 // Refresh transforms only, as H13 did. Do not invoke pose/animation updates.
 model.updateWorldMatrix(true,true);
 const origin=model.getWorldPosition(new T.Vector3());
 const result={id:actor.id,identity:actor.identity,envelope:{...actor.envelope},tolerance:1e-6,origin:xyz(origin),model:chain(model),meshCount:0,vertexCount:0,meshes:[],extrema:{radius:null,height:null,minY:null},unsupported:[]};
 const point=new T.Vector3(),base=new T.Vector3(),weighted=new T.Vector3(),bonePoint=new T.Vector3(),boneMatrix=new T.Matrix4();
 const visible=o=>{for(;o;o=o.parent)if(!o.visible)return false;return true;};
 const unsupported=(o,reason)=>result.unsupported.push({mesh:transform(o),reason});
 model.traverse(mesh=>{
  if(!visible(mesh)||!mesh.geometry)return;
  const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];
  if(!materials.some(m=>m?.visible))return;
  if(!mesh.isMesh||mesh.isInstancedMesh||mesh.isBatchedMesh){unsupported(mesh,'unsupported visible renderable type');return;}
  const geometry=mesh.geometry,position=geometry.attributes.position;
  if(!position||position.itemSize!==3){unsupported(mesh,'missing or unsupported position attribute');return;}
  if(materials.some(m=>m?.visible&&(m.isShaderMaterial||m.isRawShaderMaterial||m.displacementMap||m.onBeforeCompile!==T.Material.prototype.onBeforeCompile))){unsupported(mesh,'unsupported shader vertex deformation');return;}
  const morph=geometry.morphAttributes.position??[];
  if(morph.length&&(!mesh.morphTargetInfluences||morph.some((a,i)=>a.count!==position.count||!Number.isFinite(mesh.morphTargetInfluences[i])))){unsupported(mesh,'incomplete morph state');return;}
  let inverseBind=null;
  if(mesh.isSkinnedMesh){
   if(!mesh.skeleton||!geometry.attributes.skinIndex||!geometry.attributes.skinWeight||!['attached','detached'].includes(mesh.bindMode)){unsupported(mesh,'incomplete or unsupported skin');return;}
   for(const bone of mesh.skeleton.bones)bone.updateWorldMatrix(true,false);
   // Renderer-equivalent bind inverse without mutating mesh.bindMatrixInverse.
   inverseBind=(mesh.bindMode==='attached'?mesh.matrixWorld:mesh.bindMatrix).clone().invert();
  }
  const total=geometry.index?.count??position.count,draw=geometry.drawRange;
  const groups=Array.isArray(mesh.material)?geometry.groups:[{start:0,count:total,materialIndex:0}];
  const indices=new Set();
  for(const group of groups){
   const material=materials[group.materialIndex];if(!material?.visible)continue;
   const begin=Math.max(0,draw.start,group.start),end=Math.min(total,draw.start+draw.count,group.start+group.count);
   if(!Number.isInteger(begin)||!Number.isInteger(end)||begin%3!==0||(end-begin)%3!==0){unsupported(mesh,'unsupported partial triangle range');return;}
   for(let i=begin;i<end;i++)indices.add(geometry.index?geometry.index.getX(i):i);
  }
  if(!indices.size){unsupported(mesh,'visible mesh has no drawn vertices');return;}
  const record={...transform(mesh),ancestors:chain(mesh.parent),vertexCount:indices.size,drawRange:{start:draw.start,count:Number.isFinite(draw.count)?draw.count:'Infinity'},groups:geometry.groups,morphTargetsRelative:geometry.morphTargetsRelative,morphTargetInfluences:mesh.morphTargetInfluences?.slice()??[],skin:mesh.isSkinnedMesh?{bindMode:mesh.bindMode,bindMatrix:mesh.bindMatrix.toArray(),storedBindMatrixInverse:mesh.bindMatrixInverse.toArray(),renderBindMatrixInverse:inverseBind.toArray(),bones:mesh.skeleton.bones.map((b,i)=>({...transform(b),inverse:mesh.skeleton.boneInverses[i].toArray()}))}:null};
  result.meshes.push(record);result.meshCount++;
  for(const index of indices){
   if(!Number.isInteger(index)||index<0||index>=position.count){unsupported(mesh,'invalid drawn vertex index');return;}
   // Mesh's morph implementation, then independently apply the current skin.
   T.Mesh.prototype.getVertexPosition.call(mesh,index,point);
   const morphed=xyz(point);let influences=null;
   if(mesh.isSkinnedMesh){
    base.copy(point).applyMatrix4(mesh.bindMatrix);weighted.set(0,0,0);influences=[];
    const si=geometry.attributes.skinIndex,sw=geometry.attributes.skinWeight;
    for(let k=0;k<4;k++){
     const weight=sw.getComponent(index,k),boneIndex=si.getComponent(index,k);
     if(!Number.isFinite(weight)||!Number.isInteger(boneIndex)||!mesh.skeleton.bones[boneIndex]){unsupported(mesh,'invalid skin influence');return;}
     influences.push({boneIndex,weight});if(!weight)continue;
     boneMatrix.multiplyMatrices(mesh.skeleton.bones[boneIndex].matrixWorld,mesh.skeleton.boneInverses[boneIndex]);
     weighted.addScaledVector(bonePoint.copy(base).applyMatrix4(boneMatrix),weight);
    }
    point.copy(weighted).applyMatrix4(inverseBind);
   }
   const deformedLocal=xyz(point);point.applyMatrix4(mesh.matrixWorld);
   if(![point.x,point.y,point.z].every(Number.isFinite)){unsupported(mesh,'nonfinite deformed world vertex');return;}
   const radial=Math.hypot(point.x-origin.x,point.z-origin.z),height=point.y-origin.y;
   const evidence={mesh:mesh.uuid,name:mesh.name,type:mesh.type,index,source:[position.getX(index),position.getY(index),position.getZ(index)],morphed,deformedLocal,world:xyz(point),relative:{x:point.x-origin.x,y:height,z:point.z-origin.z},radius:radial,height,skinInfluences:influences};
   if(!result.extrema.radius||radial>result.extrema.radius.radius)result.extrema.radius=evidence;
   if(!result.extrema.height||height>result.extrema.height.height)result.extrema.height=evidence;
   if(!result.extrema.minY||height<result.extrema.minY.height)result.extrema.minY=evidence;
   result.vertexCount++;
  }
 });
 result.radius=result.extrema.radius?.radius??null;result.height=result.extrema.height?.height??null;
 result.radiusExcess=result.radius===null?null:result.radius-actor.envelope.radius;
 result.heightExcess=result.height===null?null:result.height-actor.envelope.height;
 result.radiusMargin=result.radius===null?null:actor.envelope.radius+result.tolerance-result.radius;
 result.heightMargin=result.height===null?null:actor.envelope.height+result.tolerance-result.height;
 result.supported=result.unsupported.length===0&&result.meshCount>0&&result.vertexCount>0;
 return result;
}
