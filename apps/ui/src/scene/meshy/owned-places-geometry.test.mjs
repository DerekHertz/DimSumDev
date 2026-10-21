import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createDenScene} from './plush/assembly.mjs';
import {createGardenNavigation} from './garden-navigation.mjs';
import {gardenRoutineSpots} from './daily-routines.mjs';
import {gardenRoute,routeSegment} from './garden-route.mjs';
import {createPlaceRegistry} from './places.mjs';
import {actorEnvelope,REPRESENTATIVE_ENVELOPES} from './actor-envelope.mjs';
import {gardenClearanceOracle} from './test-fixtures/place-clearance.mjs';
globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};
test('model, posed props and replacement envelopes determine collision radius and overhead height',()=>{
 const model=new T.Group(),mesh=new T.Mesh(new T.BoxGeometry(1,2,1));mesh.position.y=1;model.add(mesh);model.scale.setScalar(.68);
 const rig={model,profile:{},poseIdle(){mesh.position.x=0;},poseWaddle(t){mesh.position.x=Math.sin(t*10)*.5;}};
 const plain=actorEnvelope({model,rig});
 const prop=new T.Mesh(new T.BoxGeometry(.1,4,.1));prop.position.set(2,2,0);model.add(prop);
 const withProp=actorEnvelope({model,rig});assert.ok(withProp.radius>plain.radius);assert.ok(withProp.height>plain.height);
 rig.profile.envelope={moving:{radius:5,height:6}};const replacement=actorEnvelope({model,rig});assert.ok(replacement.radius>=3.4);assert.ok(replacement.height>=4.08);
 model.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});
});
test('assembled booth to tea and back validates full swept segments; large fixture bodies fit or wait safely',()=>{
 const garden=createDenScene();try{
  const world=createGardenNavigation(garden),places=createPlaceRegistry(world),spot=gardenRoutineSpots(garden).find(s=>s.id==='tea'),physical=gardenClearanceOracle(garden);
  const body={radius:.65,height:2.04},home=garden.worldPoint('steamers',[0,.4,2.8]);
  const tea=places.find({id:'tea',kind:'leisure',near:spot.position,owner:'test',envelope:body});assert.ok(tea);
  const there=gardenRoute(world,home,tea.position,body);assert.ok(there.length,'fitting resident must reach the real tea garden');
  const back=gardenRoute(world,there.at(-1),home,body);assert.ok(back.length,'return route must also exist');
  for(const [start,path]of [[home,there],[there.at(-1),back]]){let previous=start;for(const next of path){assert.notEqual(routeSegment(world,previous,next,body),null);previous=next;}}
  for(const [name,envelope]of Object.entries(REPRESENTATIVE_ENVELOPES)){
   const fitting=places.find({id:name,kind:'staging',near:spot.position,owner:name,envelope});
   if(fitting){assert.equal(places.fits(fitting.position,envelope,name,fitting.id),true);physical.assertClear(fitting.position,envelope);}
  }
 }finally{garden.dispose();}
});

test('36 the actual curved stream is excluded even where the retired rectangular proxy missed it',()=>{
 const garden=createDenScene();try{
  const physical=gardenClearanceOracle(garden),world=createGardenNavigation(garden),point=garden.landscape.root.localToWorld(new T.Vector3(.3,.26,5.7));
  assert.equal(physical.waterDistance(point),0,'actual rendered triangles independently contain the point');
  assert.equal(world.navigation.groundAt(point.x,point.z,.26,.26,2.04),null);
 }finally{garden.dispose();}
});

test('36 actual pavilion pillars and water boundaries reject complete replacement footprints',()=>{
 const garden=createDenScene();try{
  const world=createGardenNavigation(garden),pillar=garden.assets.pass.root.localToWorld(new T.Vector3(-5.4,2.25,-3.25));
  const p=garden.assets.pass.root.localToWorld(new T.Vector3(-5.9,.315,-3.65));
  const stream=garden.landscape.root.localToWorld(new T.Vector3(-3.2-.55-.1,0,-2));stream.y=.26;
  for(const envelope of [{radius:1.23,height:2.28},...Object.values(REPRESENTATIVE_ENVELOPES)]){
   assert.ok(Math.hypot(Math.max(0,Math.abs(p.x-pillar.x)-.155),Math.max(0,Math.abs(p.z-pillar.z)-.155))<envelope.radius,'actual pillar AABB intersects footprint');
   assert.equal(world.navigation.groundAt(p.x,p.z,p.y,envelope.radius,envelope.height),null);
   assert.equal(world.navigation.groundAt(stream.x,stream.z,.26,envelope.radius,envelope.height),null,'centre is on land but body overlaps actual stream');
  }
 }finally{garden.dispose();}
});
