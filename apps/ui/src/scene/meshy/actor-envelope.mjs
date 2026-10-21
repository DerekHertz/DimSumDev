import * as T from 'three';
import {WADDLE} from './panda-rig.mjs';

// Replacement characters publish their swept envelope. Legacy outfits/tools are
// measured on the actual rig at the same idle/walk/gesture poses shown in the den.
export function actorEnvelope(panda,gesture=null){
 const {model,rig}=panda,origin=new T.Vector3(),point=new T.Vector3(),bounds=new T.Box3();let radius=0,height=0;
 const base=new T.Vector3(),weighted=new T.Vector3(),bonePoint=new T.Vector3();
 // Three's precise skinned bounds recompute a bone product for every vertex
 // influence. Within one measured pose those double-precision products are
 // constant. Rebuild them per mesh/pose; never cache an envelope across poses,
 // preparations, model edits or the final physical-state revalidation.
 function expand(object){
  const geometry=object.geometry,position=geometry?.attributes.position;
  if(geometry&&(!object.isSkinnedMesh||object.isInstancedMesh||!position||object.getVertexPosition!==T.SkinnedMesh.prototype.getVertexPosition||object.applyBoneTransform!==T.SkinnedMesh.prototype.applyBoneTransform)){
   bounds.expandByObject(object,true);return;
  }
  object.updateWorldMatrix(false,false);
  if(geometry){
   const skeleton=object.skeleton,matrices=skeleton.bones.map((bone,i)=>new T.Matrix4().multiplyMatrices(bone.matrixWorld,skeleton.boneInverses[i]));
   const indices=geometry.attributes.skinIndex,weights=geometry.attributes.skinWeight;
   for(let i=0;i<position.count;i++){
    // Keep Mesh's morph processing and the original skin-weight order. Matrix4
    // products retain JS double precision, rather than skeleton.boneMatrices'
    // Float32 storage, so rounding cannot shrink a conservative envelope.
    T.Mesh.prototype.getVertexPosition.call(object,i,point);
    base.copy(point).applyMatrix4(object.bindMatrix);weighted.set(0,0,0);
    for(let k=0;k<4;k++){
     const weight=weights.getComponent(i,k);if(weight!==0)weighted.addScaledVector(bonePoint.copy(base).applyMatrix4(matrices[indices.getComponent(i,k)]),weight);
    }
    point.copy(weighted).applyMatrix4(object.bindMatrixInverse).applyMatrix4(object.matrixWorld);bounds.expandByPoint(point);
   }
  }
  for(const child of object.children)expand(child);
 }
 const measure=()=>{
  model.updateWorldMatrix(true,true);model.getWorldPosition(origin);bounds.makeEmpty();expand(model);
  for(const x of [bounds.min.x,bounds.max.x])for(const z of [bounds.min.z,bounds.max.z])radius=Math.max(radius,Math.hypot(x-origin.x,z-origin.z));
  height=Math.max(height,bounds.max.y-origin.y);
 };
 for(let i=0;i<8;i++){rig.poseWaddle(i*WADDLE.duration/8);measure();}
 rig.poseIdle(0);measure();
 for(const kind of ['tea','pond','greeting']){gesture?.pose(kind,2);measure();}gesture?.pose(null,0);
 if(rig.profile?.sit){rig.poseSit(1);measure();}
 const scale=model.getWorldScale(point);
 for(const pose of ['standing','moving','seated']){const e=rig.profile?.envelope?.[pose];if(e){radius=Math.max(radius,e.radius*Math.max(scale.x,scale.z));height=Math.max(height,e.height*scale.y);}}
 rig.poseIdle(0);model.updateWorldMatrix(true,true);
 return Object.freeze({radius:Math.ceil(radius*1.05*100)/100,height:Math.ceil(height*1.05*100)/100});
}

export const REPRESENTATIVE_ENVELOPES=Object.freeze({
 tail:Object.freeze({radius:2.47,height:2.29}),
 shell:Object.freeze({radius:1.35,height:2.25}),
 antlers:Object.freeze({radius:1.79,height:2.5}),
});
