// THROWAWAY: exact original fixture body; imports point to unchanged product modules.
import * as T from 'three';
import {createBalancedPandaRig} from '/home/dhertzell/dimsumden/.worktrees/owned-places-36-egress-proof/apps/ui/src/scene/meshy/panda-rig.mjs';
import {RESIDENTS as definitions} from '/home/dhertzell/dimsumden/.worktrees/owned-places-36-egress-proof/apps/ui/src/shell/resident-inventory.mjs';
import {createMeshyActors} from '/home/dhertzell/dimsumden/.worktrees/owned-places-36-egress-proof/apps/ui/src/scene/meshy/actors.mjs';
export function fixture(){
 const body=new T.Mesh(new T.BoxGeometry(2,3,1),new T.MeshStandardMaterial());body.position.y=1.5;
 const den={residents:new T.Group(),pandaRigs:new Map(),propManifest:definitions,roleWorkspaces:{workspaces:new Map()},walkWorld:{floorRadius:70,obstacles:[],navigation:{groundAt:()=>.26}}};
 den.createPanda=(role,{runtime='claude'}={})=>{const rig=createBalancedPandaRig(body);rig.model.scale.setScalar(.68);rig.model.userData={roleId:role,actorKey:role,runtime};den.pandaRigs.set(rig.model,{rig});return{model:rig.model,rig};};
 den.destroyPanda=model=>{den.pandaRigs.get(model)?.rig.dispose();den.pandaRigs.delete(model);};
 for(const[i,d]of definitions.entries()){const panda=den.createPanda(d.role,{runtime:d.runtime});panda.model.userData.actorKey=d.id;panda.model.position.set((i%7-3)*3,.26,-8-Math.floor(i/7)*4);den.residents.add(panda.model);den.roleWorkspaces.workspaces.set(d.id,{person:panda.model});}
 den.routineSpots=[{id:'tea',kind:'tea',position:new T.Vector3(0,.26,-2),face:new T.Vector3(0,.26,-3)},{id:'pond',kind:'pond',position:new T.Vector3(3,.26,-2),face:new T.Vector3(3,.26,-3)},{id:'greeting',kind:'greeting',position:new T.Vector3(-3,.26,-2),face:new T.Vector3(-3,.26,-3)}];
 let feeds=0;den.feedKoi=()=>feeds++;
 const actors=createMeshyActors(den);return{den,actors,get feeds(){return feeds;},dispose(){actors.dispose();for(const model of [...den.pandaRigs.keys()])den.destroyPanda(model);body.geometry.dispose();body.material.dispose();}};
}
