import test from 'node:test';
import assert from 'node:assert/strict';
import {createDenScene} from './plush/assembly.mjs';
import {residentHomes} from './resident-homes.mjs';
import {createGardenNavigation} from './garden-navigation.mjs';
import {gardenRoute} from './garden-route.mjs';
globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};

test('paired homes are separate, clear of actual furniture and reachable from the garden paths',()=>{
 const garden=createDenScene();try{
  const homes=residentHomes(garden),world=createGardenNavigation(garden);
  assert.equal(homes.length,32);
  for(const [role,team]of [['release-manager','pass'],['code-reviewer','pantry'],['sre','pantry'],['technical-writer','front']]){
   const pair=homes.filter(home=>home.role===role);
   assert.equal(pair.length,2,role+' has both runtime homes');
   assert.ok(pair.every(home=>home.teamId===team&&home.dispatchable),role+' sits by its charter team');
  }
  for(const home of homes){
   const [x,y,z]=home.position;
   const floor=world.navigation.groundAt(x,z,y,.45);
   assert.ok(floor!==null&&Math.abs(floor-y)<.05,home.id+' has an unburied home');
   for(const other of homes.filter(other=>other.id!==home.id))assert.ok(Math.hypot(x-other.position[0],z-other.position[2])>(home.role==='orchestrator'?2.8:1.2),home.id+' clear of '+other.id);
   const route=gardenRoute(world,{x:0,y:.26,z:6},{x,z});
   assert.ok(route.length,home.id+' is reachable from the central garden');
  }
  const [bao,jiao]=homes.filter(h=>h.role==='orchestrator');assert.equal(bao.position[1],jiao.position[1]);assert.equal(bao.position[2],jiao.position[2]);assert.equal(bao.yaw,jiao.yaw);
  const furniture=garden.welcomeFurniture;
  assert.ok(furniture,'welcome furniture and collision proxies share measured positions');
  for(const home of [bao,jiao])for(const object of furniture)assert.ok(Math.hypot(home.position[0]-object.position[0],home.position[2]-object.position[2])>1.7,home.id+' clears '+object.id);
 }finally{garden.dispose();}
});
