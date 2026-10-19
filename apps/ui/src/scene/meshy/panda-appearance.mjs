import * as T from 'three';
import {createBalancedPandaRig} from './panda-rig.mjs';
import {createRoleOutfit} from './role-outfits.mjs';
import {createRoleTool} from './role-tools.mjs';
import {disposeWorld} from './assets.mjs';

/** Appearance only: callers own identity, placement, availability and actions. */
export function createPandaAppearanceFactory({body,...templates}){
 const outfits=new T.Group(),cache=new Map(),instances=new Map();let disposed=false;
 function createPanda(role,{runtime='claude'}={}){
  if(disposed)throw Error('Panda appearance factory disposed');
  if(!['claude','codex'].includes(runtime))throw Error('Unknown panda runtime: '+runtime);
  const key=runtime+':'+role;
  if(!cache.has(key)){const outfit=createRoleOutfit(role,templates,{runtime});cache.set(key,outfit);outfits.add(outfit);}
  const rig=createBalancedPandaRig(body);rig.addOutfit(cache.get(key));
  const tool=createRoleTool(role,{runtime});rig.bones.paw_R.add(tool);
  rig.model.userData={roleId:role,actorKey:role,runtime};
  rig.model.scale.setScalar(role==='orchestrator'?1.35:role==='stem-cub'?.52:.68);
  instances.set(rig.model,{rig,tool});return {model:rig.model,rig};
 }
 function destroyPanda(model){const entry=instances.get(model);if(!entry)return;entry.rig.dispose();disposeWorld(entry.tool);instances.delete(model);}
 function dispose(){if(disposed)return;disposed=true;for(const model of [...instances.keys()])destroyPanda(model);}
 // Outfit templates share fitted source geometry/textures: their asset owner
 // disposes `outfits` alongside those sources in one deduplicated resource pass.
 return {createPanda,destroyPanda,dispose,outfits,instances};
}
