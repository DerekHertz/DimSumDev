import * as T from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {castsShadow} from './plush/garden-kit.mjs';

// Each assembly keeps its own transform, visibility and clipping controls.
export function batchStaticAssemblies(root){
 const originals=new Set();root.updateWorldMatrix(true,true);
 for(const assembly of [...root.children]){
  if(assembly.isMesh)continue;
  const batches=new Map(),old=[],inverse=assembly.matrixWorld.clone().invert();
  assembly.traverse(node=>{
   if(!node.isMesh||node.isSkinnedMesh||node.isInstancedMesh||Array.isArray(node.material))return;
   const geometry=node.geometry.index?node.geometry.toNonIndexed():node.geometry.clone();
   geometry.applyMatrix4(inverse.clone().multiply(node.matrixWorld));
   if(!geometry.attributes.uv)geometry.setAttribute('uv',new T.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count*2),2));
   const cast=castsShadow(node),receive=node.receiveShadow,key=node.material.uuid+':'+cast+':'+receive;
   const batch=batches.get(key)||{material:node.material,cast,receive,parts:[]};
   batch.parts.push(geometry);batches.set(key,batch);old.push(node);originals.add(node.geometry);
  });
  for(const {material,cast,receive,parts}of batches.values()){
   const geometry=mergeGeometries(parts,false);
   if(!geometry)throw Error('Static scenery has incompatible geometry attributes');
   const mesh=new T.Mesh(geometry,material);mesh.name=assembly.name+' · assembly batch';
   mesh.castShadow=cast;mesh.receiveShadow=receive;mesh.userData.noShadow=!cast;assembly.add(mesh);
   parts.forEach(part=>part.dispose());
  }
  old.forEach(node=>node.removeFromParent());
 }
 const retained=new Set();root.traverse(node=>{if(node.geometry)retained.add(node.geometry);});
 for(const geometry of originals)if(!retained.has(geometry))geometry.dispose();
}
