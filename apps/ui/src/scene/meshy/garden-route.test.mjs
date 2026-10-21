import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createSurfaceNavigation} from './navigation.mjs';
import {gardenRoute} from './garden-route.mjs';
test('meeting routes go around furniture instead of cutting diagonally through it',()=>{
 const blocked=(x,z)=>x>1&&x<3&&Math.abs(z)<1;
 const world={navigation:{groundAt:(x,z)=>Math.abs(x)>6||Math.abs(z)>6||blocked(x,z)?null:.26}};
 const path=gardenRoute(world,{x:0,y:.26,z:0},{x:4,z:0});
 assert.ok(path.length>10);assert.deepEqual(path.at(-1),{x:4,z:0,y:.26});
 let last={x:0,z:0};for(const p of path){assert.equal(blocked((last.x+p.x)/2,(last.z+p.z)/2),false);last=p;}
});
test('an unreachable meeting destination never produces a teleport through a wall',()=>{
 const world={navigation:{groundAt:(x,z)=>Math.abs(x)<1&&Math.abs(z)<1?.26:null}};
 assert.deepEqual(gardenRoute(world,{x:0,y:.26,z:0},{x:4,z:0}),[]);
});

test('heightless raised destinations use the reachable stair approach and explicit heights stay binding',()=>{
 const root=new THREE.Group();
 for(const [size,position] of [[[2,.2,.8],[0,.1,-.4]],[[2,.4,.8],[0,.2,-1.2]],[[2,.6,2],[0,.3,-2.6]]]){
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(...size));mesh.position.set(...position);mesh.userData.navigationSurface='walkable';root.add(mesh);
 }
 const world={navigation:createSurfaceNavigation([root],{placement:.1}),obstacles:[]},from={x:0,y:0,z:1},to={x:0,z:-2.6};
 const path=gardenRoute(world,from,to);assert.ok(path.length,'omitted height is established by the swept approach');assert.equal(path.at(-1).y,.6);
 assert.ok(gardenRoute(world,from,{...to,y:.6}).length,'correct explicit height remains reachable');
 assert.deepEqual(gardenRoute(world,from,{...to,y:0}),[],'explicit floor cannot be replaced with the higher landing');
 assert.deepEqual(gardenRoute(world,from,{...to,y:0},undefined,{take:()=>true}),[],'budgeted direct-route shortcut obeys the explicit landing height too');
 world.obstacles=[{type:'circle',x:0,z:-2.6,radius:.4}];
 assert.deepEqual(gardenRoute(world,from,to),[],'heightless targets still require a clear final segment');
 root.traverse(n=>{n.geometry?.dispose();n.material?.dispose();});
});
