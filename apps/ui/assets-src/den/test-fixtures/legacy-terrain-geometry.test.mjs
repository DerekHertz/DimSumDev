import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createDenScene} from '../../../src/scene/meshy/plush/assembly.mjs';
import {createGardenNavigation} from '../../../src/scene/meshy/garden-navigation.mjs';
import {gardenWaterOracle} from './terrain-water.mjs';
globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};
test('actual curved stream, pond and flooded field geometry is excluded from standing surfaces',()=>{
 const garden=createDenScene();try{
  const physical=gardenWaterOracle(garden),world=createGardenNavigation(garden),point=garden.landscape.root.localToWorld(new T.Vector3(.3,.26,5.7));
  assert.equal(physical.waterDistance(point),0,'actual rendered triangles independently contain the point');
  assert.equal(world.navigation.groundAt(point.x,point.z,.26,.26,2.04),null);
  const pond=garden.assets.tea.root.localToWorld(new T.Vector3(2.9,.26,.75));
  const field=garden.landscape.root.localToWorld(new T.Vector3(6.08,.26,-2.25));
  for(const [label,p]of [['pond',pond],['flooded field',field]]){
   assert.equal(physical.waterDistance(p),0,`rendered ${label} triangles independently contain the point`);
   assert.equal(world.navigation.groundAt(p.x,p.z,p.y,.26,2.04),null,`${label} cannot supply a standing surface`);
  }
 }finally{garden.dispose();}
});
