import * as T from 'three';

// Read current drawn vertices independently of the envelope's pose sampling.
// Apply morphs and the current skin explicitly, without changing a pose.
export function occupiedVertices(actor){
 const model=actor.panda.model;model.updateWorldMatrix(true,true);
 const origin=model.getWorldPosition(new T.Vector3()),point=new T.Vector3(),base=new T.Vector3(),weighted=new T.Vector3(),bonePoint=new T.Vector3(),matrix=new T.Matrix4();
 const result={vertices:0,radius:0,height:0,unsupported:[]};
 const visible=o=>{for(;o;o=o.parent)if(!o.visible)return false;return true;};
 const standardVertices=material=>{
  if(material.onBeforeCompile===T.Material.prototype.onBeforeCompile)return true;
  // Wardrobe tint edits the fragment shader only. Run its real compile hook
  // against the standard shader and reject any changed vertex program.
  const shader={uniforms:{},vertexShader:T.ShaderLib.standard.vertexShader,fragmentShader:T.ShaderLib.standard.fragmentShader};
  try{material.onBeforeCompile(shader);return shader.vertexShader===T.ShaderLib.standard.vertexShader;}catch{return false;}
 };
 model.traverse(mesh=>{
  if(!visible(mesh)||!mesh.geometry)return;
  const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];
  if(!materials.some(m=>m?.visible))return;
  const geometry=mesh.geometry,position=geometry.attributes.position;
  if(!mesh.isMesh||mesh.isInstancedMesh||mesh.isBatchedMesh||!position||position.itemSize!==3||materials.some(m=>m?.visible&&(m.isShaderMaterial||m.isRawShaderMaterial||m.displacementMap||!standardVertices(m)))){result.unsupported.push(mesh.name||mesh.type);return;}
  const morph=geometry.morphAttributes.position??[];
  if(morph.length&&(!mesh.morphTargetInfluences||morph.some((attribute,i)=>attribute.count!==position.count||!Number.isFinite(mesh.morphTargetInfluences[i])))){result.unsupported.push('incomplete morph');return;}
  let inverseBind;
  if(mesh.isSkinnedMesh){
   if(!mesh.skeleton||!geometry.attributes.skinIndex||!geometry.attributes.skinWeight||!['attached','detached'].includes(mesh.bindMode)){result.unsupported.push('incomplete skin');return;}
   for(const bone of mesh.skeleton.bones)bone.updateWorldMatrix(true,false);
   inverseBind=(mesh.bindMode==='attached'?mesh.matrixWorld:mesh.bindMatrix).clone().invert();
  }
  const total=geometry.index?.count??position.count,draw=geometry.drawRange,indices=new Set();
  for(const group of Array.isArray(mesh.material)?geometry.groups:[{start:0,count:total,materialIndex:0}]){
   if(!materials[group.materialIndex]?.visible)continue;
   const start=Math.max(0,draw.start,group.start),end=Math.min(total,draw.start+draw.count,group.start+group.count);
   if(!Number.isInteger(start)||!Number.isInteger(end)||start%3!==0||(end-start)%3!==0){result.unsupported.push('partial triangle range');return;}
   for(let i=start;i<end;i++)indices.add(geometry.index?geometry.index.getX(i):i);
  }
  if(!indices.size){result.unsupported.push('no drawn vertices');return;}
  for(const index of indices){
   T.Mesh.prototype.getVertexPosition.call(mesh,index,point);
   if(mesh.isSkinnedMesh){
    base.copy(point).applyMatrix4(mesh.bindMatrix);weighted.set(0,0,0);
    const si=geometry.attributes.skinIndex,sw=geometry.attributes.skinWeight;
    for(let k=0;k<4;k++){
     const weight=sw.getComponent(index,k),boneIndex=si.getComponent(index,k);
     if(!weight)continue;
     matrix.multiplyMatrices(mesh.skeleton.bones[boneIndex].matrixWorld,mesh.skeleton.boneInverses[boneIndex]);
     weighted.addScaledVector(bonePoint.copy(base).applyMatrix4(matrix),weight);
    }
    point.copy(weighted).applyMatrix4(inverseBind);
   }
   point.applyMatrix4(mesh.matrixWorld);
   if(![point.x,point.y,point.z].every(Number.isFinite)){result.unsupported.push('nonfinite deformed vertex');return;}
   result.radius=Math.max(result.radius,Math.hypot(point.x-origin.x,point.z-origin.z));
   result.height=Math.max(result.height,point.y-origin.y);result.vertices++;
  }
 });
 return result;
}
