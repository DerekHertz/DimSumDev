import * as T from 'three';
import {createBalancedPandaRig,createRig} from './panda-rig.mjs';
import {CHARACTER_PROFILES} from './character-profiles.mjs';
import {castCharacterId} from './cast.mjs';
import {CAST_PROFILES} from './cast-profiles.mjs';
import {BAO_PRODUCTION} from './bao-profile.mjs';
import {createRoleOutfit} from './role-outfits.mjs';
import {createRoleTool} from './role-tools.mjs';
import {disposeWorld} from './assets.mjs';

// team-and-den-ux/23: `characters` maps a role to its own loaded species source; a role without one keeps Bao's body.
/** Appearance only: callers own identity, placement, availability and actions. */
export function createPandaAppearanceFactory({body,characters={},castProfiles=CAST_PROFILES,approvedOnly=false,...templates}){
 const outfits=new T.Group(),cache=new Map(),instances=new Map();let disposed=false;
 function createPanda(role,{runtime='claude'}={}){
  if(disposed)throw Error('Panda appearance factory disposed');
  if(!['claude','codex'].includes(runtime))throw Error('Unknown panda runtime: '+runtime);
  const bao=role==='orchestrator'&&runtime==='claude'&&characters.bao;
  // A cast species needs both its loaded source and its rig profile; either missing keeps the role's old panda (the rollback).
  const species=castCharacterId(role,runtime),cast=species&&characters[species]&&castProfiles[species];
  if(bao||cast||characters[role]){
   // Same species and silhouette for both runtimes (labels and badges tell them apart); props are fused in the mesh.
   const profile=bao?BAO_PRODUCTION:cast||CHARACTER_PROFILES[role],source=bao||(cast?characters[species]:characters[role]),rig=createRig(source,profile);
   rig.model.userData={roleId:role,actorKey:role,runtime,species:profile.id};rig.model.scale.setScalar(role==='orchestrator'?1.35:.68);
   instances.set(rig.model,{rig,tool:null});return {model:rig.model,rig};
  }
  if(approvedOnly){
   const model=new T.Group(),geometry=new T.CylinderGeometry(.45,.45,.08,12),material=new T.MeshStandardMaterial({color:'#89928a',roughness:1}),marker=new T.Mesh(geometry,material);model.add(marker);
   model.userData={roleId:role,runtime,modelUnavailable:true};
   const rig={model,profile:{id:'unavailable',envelope:{head:{top:.2}}},poseIdle(){},poseWaddle(){},poseSit(){},dispose(){geometry.dispose();material.dispose();model.removeFromParent();}};
   instances.set(model,{rig,tool:null});return {model,rig};
  }
  const key=runtime+':'+role;
  if(!cache.has(key)){const outfit=createRoleOutfit(role,templates,{runtime});cache.set(key,outfit);outfits.add(outfit);}
  const rig=createBalancedPandaRig(body);rig.addOutfit(cache.get(key));
  const tool=createRoleTool(role,{runtime});rig.bones.paw_R.add(tool);
  rig.model.userData={roleId:role,actorKey:role,runtime};
  rig.model.scale.setScalar(role==='orchestrator'?1.35:role==='stem-cub'?.52:.68);
  instances.set(rig.model,{rig,tool});return {model:rig.model,rig};
 }
 function destroyPanda(model){const entry=instances.get(model);if(!entry)return;entry.rig.dispose();if(entry.tool)disposeWorld(entry.tool);instances.delete(model);}
 function dispose(){if(disposed)return;disposed=true;for(const model of [...instances.keys()])destroyPanda(model);}
 // Outfit templates share fitted source geometry/textures: their asset owner
 // disposes `outfits` alongside those sources in one deduplicated resource pass.
 return {createPanda,destroyPanda,dispose,outfits,instances};
}
