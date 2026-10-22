import test from 'node:test';
import assert from 'node:assert/strict';
import {createDenScene} from './plush/assembly.mjs';
import {createGardenNavigation} from './garden-navigation.mjs';
import {gardenRoute} from './garden-route.mjs';
import {gardenRoutineSpots} from './daily-routines.mjs';

globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};
test('real assembled garden offers dry reachable tea, pond, greeting, station and library approaches with valid team returns',()=>{
 const garden=createDenScene();try{
  const world=createGardenNavigation(garden),spots=gardenRoutineSpots(garden);
  const homes=[['steamers',garden.assets.steamers.residents.developer.position],['pass',garden.assets.pass.residents[0].position],['pantry',garden.assets.pantry.residents[0].position],['front',garden.assets.front.residents[0].position],['library',[-1.1,.43,2.6]],['festival',[5.2,.635,1.8]]].map(([id,p])=>garden.worldPoint(id,p));
  assert.deepEqual([...new Set(spots.map(s=>s.group))].sort(),['greeting','library:library','pond','station:front','station:pantry','station:pass','station:steamers','tea'],'four stations and the library beside the three leisure spots');
  assert.equal(new Set(spots.map(s=>s.id)).size,spots.length);
  for(const spot of spots){
   const ground=world.navigation.groundAt(spot.position.x,spot.position.z,spot.position.y,.23);assert.notEqual(ground,null,spot.id+' is walkable');
   for(const home of homes){
    const path=gardenRoute(world,home,spot.position);assert.ok(path.length,spot.id+' approach from '+home.toArray());
    let last=home;for(const p of path){assert.notEqual(world.navigation.groundAt((p.x+last.x)/2,(p.z+last.z)/2,last.y,.23),null,'every path segment is supported');last=p;}
    const back=gardenRoute(world,path.at(-1),home);assert.ok(back.length,spot.id+' return to team');
    assert.ok(Math.hypot(back.at(-1).x-home.x,back.at(-1).z-home.z)<.001);
   }
  }
  assert.equal(garden.assets.tea.koi.fish.length,3);
 }finally{garden.dispose();}
});
