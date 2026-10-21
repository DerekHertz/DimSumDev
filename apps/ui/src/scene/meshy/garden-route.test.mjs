import test from 'node:test';
import assert from 'node:assert/strict';
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
