import test from 'node:test';
import assert from 'node:assert/strict';
import {createDenScene} from './plush/assembly.mjs';
import {createGardenNavigation} from './garden-navigation.mjs';
import {gardenRoute} from './garden-route.mjs';
import {gardenRoutineSpots,createDailyRoutines} from './daily-routines.mjs';
import {createFrameWork} from './frame-work.mjs';
import * as T from 'three';

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


function budgetedRoutine(){
 let clock=0;const work=createFrameWork({now:()=>++clock,budgetMs:2}),model=new T.Group();
 const a={id:'one',identity:'resident:one',teamId:'pass',baseYaw:0,home:model.position.clone(),envelope:{radius:.3,height:1},panda:{model},state:'idle'};
 const den={walkWorld:{},routineSpots:[{id:'tea',kind:'tea',position:{x:3,y:0,z:0},face:{x:0,y:0,z:0}}],routineClear:()=>true,routineRouteSteps:function*(_a,_from,to){for(let i=0;i<10;i++)yield;return [{...to}];}};
 const routines=createDailyRoutines(den,new Map([[a.id,a]]),{work,random:()=>0});
 return {a,work,routines,tick(n,reduced=false){for(let i=0;i<n;i++){routines.update(1/60,reduced);work.update();}},dispose(){routines.dispose();work.dispose();}};
}

test('budgeted departures prepare early but lease only on the departure beat',()=>{
 const f=budgetedRoutine();f.tick(100);assert.equal(f.routines.reservations.size,0);assert.equal(f.a.outing,null);
 f.tick(22);assert.equal(f.routines.reservations.get('tea'),'one');assert.equal(f.a.outing.stage,'outbound');f.dispose();
});

test('work rebinding and reduced motion cancel a prepared departure without a stale lease',()=>{
 for(const reduced of [false,true]){
  const f=budgetedRoutine();f.tick(100);if(!reduced)f.a.live={ref:'new-work'};
  f.tick(30,reduced);assert.equal(f.routines.reservations.size,0);assert.equal(f.a.outing,null);f.dispose();
 }
});

test('transferring an unstarted return job clears planning state and permits later departures',()=>{
 const f=budgetedRoutine();try{
  f.a.panda.model.position.x=1;f.a.outing={stage:'visit',spot:{id:'tea'}};
  f.routines.cancel(f.a);assert.equal(f.a.routePending,true);assert.equal(f.work.has(f.a),true);
  f.routines.transfer(f.a);assert.equal(f.work.has(f.a),false);assert.equal(f.a.routePending,false);assert.equal(f.a.outing,null);
  f.tick(122);assert.equal(f.a.outing.stage,'outbound');assert.ok(f.a.panda.model.position.x>1,'a later trip moves instead of remaining stuck in planning');
 }finally{f.dispose();}
});

test('disposing an unstarted return job clears its planning state',()=>{
 const f=budgetedRoutine();try{
  f.a.outing={stage:'visit',spot:{id:'tea'}};f.routines.cancel(f.a);assert.equal(f.a.routePending,true);
  f.routines.dispose();assert.equal(f.work.has(f.a),false);assert.equal(f.a.routePending,false);assert.equal(f.a.outing,null);
 }finally{f.dispose();}
});
