import * as T from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';

export const GROVE_ROLES=Object.freeze({orchestrator:'#674698',product:'#674698',architect:'#674698',developer:'#2759a2',scout:'#2759a2',runner:'#2759a2',qa:'#006e54',security:'#326a2d',designer:'#00658b',herald:'#00658b'});
export function rolePalette(role,runtime='claude'){
 if(!['claude','codex'].includes(runtime))throw Error('Unknown panda runtime: '+runtime);
 const hue=GROVE_ROLES[role];if(!hue)throw Error('Unknown Grove role: '+role);
 return {main:runtime==='codex'?hue:'#faf1db',accent:runtime==='codex'?'#faf1db':hue,closure:runtime==='codex'?'jade-diamond':'round-bamboo'};
}

/** Authored pieces are merged by material, preserving one named cue per batch. */
export function clothBuilder(palette){
 const root=new T.Group();
 const colors={main:palette.main,accent:palette.accent,jade:'#527f73',bamboo:'#b88b50',wood:'#bc9366',cream:'#faf1db',ink:'#303236',lens:'#9bb8c5',straw:'#c5a577',tea:'#755235',leaf:'#527b42',garnish:'#df9458'};
 const mats=new Map();
 const material=key=>{if(!mats.has(key))mats.set(key,new T.MeshStandardMaterial({color:colors[key]||key,roughness:key==='lens'?.28:.85,side:T.DoubleSide}));return mats.get(key);};
 const mesh=(geometry,key,at=[0,0,0],scale=[1,1,1])=>{const node=new T.Mesh(geometry,material(key));node.position.fromArray(at);node.scale.fromArray(scale);root.add(node);return node;};
 const box=(size,key,at)=>mesh(new T.BoxGeometry(...size),key,at);
 const orb=(r,key,at,scale)=>mesh(new T.SphereGeometry(r,16,10),key,at,scale);
 const cyl=(r,h,key,at,scale)=>mesh(new T.CylinderGeometry(r,r,h,32),key,at,scale);
 const ring=(r,t,key,at,scale)=>mesh(new T.TorusGeometry(r,t,6,36),key,at,scale);
 const tube=(points,r,key)=>mesh(new T.TubeGeometry(new T.CatmullRomCurve3(points.map(p=>new T.Vector3(...p))),Math.max(12,points.length*4),r,6,false),key);
 const closure=at=>{
  if(palette.closure==='jade-diamond'){
   const edge=box([.145,.145,.025],'cream',at);edge.rotation.z=Math.PI/4;
   const knot=box([.105,.105,.035],'jade',[at[0],at[1],at[2]+.018]);knot.rotation.z=Math.PI/4;
   box([.014,.09,.012],'cream',[at[0],at[1],at[2]+.04]);box([.09,.014,.012],'cream',[at[0],at[1],at[2]+.04]);
  }else{
   ring(.072,.018,'bamboo',at);box([.095,.018,.023],'bamboo',[at[0],at[1],at[2]+.006]);
  }
 };
 return {root,mesh,box,orb,cyl,ring,tube,closure,finish(name,userData={}){
  root.updateMatrixWorld(true);const batches=new Map();
  root.traverse(node=>{if(!node.isMesh)return;const geometry=node.geometry.index?node.geometry.toNonIndexed():node.geometry.clone();geometry.applyMatrix4(node.matrixWorld);const parts=batches.get(node.material)||[];parts.push(geometry);batches.set(node.material,parts);});
  const result=new T.Group();result.name=name;result.userData=userData;
  for(const[mat,parts]of batches){const node=new T.Mesh(mergeGeometries(parts,false),mat);node.name=name;node.userData={...userData};node.castShadow=true;result.add(node);parts.forEach(p=>p.dispose());}
  root.traverse(node=>node.geometry?.dispose());return result;
 }};
}
