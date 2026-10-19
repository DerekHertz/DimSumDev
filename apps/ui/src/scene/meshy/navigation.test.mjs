import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSurfaceNavigation } from './navigation.mjs';
import { walk } from '../procedural/walk.mjs';
function block(root,size,position){const m=new THREE.Mesh(new THREE.BoxGeometry(...size));m.position.set(...position);root.add(m);return m;}

test('authored stair treads let a walker climb and descend a raised floor',()=>{
 const root=new THREE.Group();
 for(let i=0;i<4;i++)block(root,[2,(i+1)*.16,.6],[0,(i+1)*.08,-i*.6]);
 block(root,[3,.64,2],[0,.32,-2.7]);
 const navigation=createSurfaceNavigation([root],{placement:.1});
 const world={floorRadius:29,obstacles:[],navigation};
 let p={x:0,z:.7,y:1.65,yaw:0,pitch:0,walkTime:0};
 for(let i=0;i<95;i++)p=walk(p,{forward:1,reducedMotion:true},1/60,world);
 assert.ok(p.z < -2.4,`walked up the steps to ${p.z}`);
 assert.ok(Math.abs(p.y-2.29)<.02,`eye follows the .64 raised floor: ${p.y}`);
 for(let i=0;i<95;i++)p=walk(p,{forward:-1,reducedMotion:true},1/60,world);
 assert.ok(p.z>.5);assert.ok(Math.abs(p.y-1.65)<.02);
});
test('walls and tables block while a clear doorway and overhead lintel permit passage',()=>{
 const root=new THREE.Group();
 block(root,[.4,3,2],[-1,1.5,0]);block(root,[.4,3,2],[1,1.5,0]);block(root,[2.4,.5,2],[0,2.75,0]);
 block(root,[1,1.2,1],[4,.6,0]);
 const nav=createSurfaceNavigation([root],{placement:.1});
 assert.equal(nav.groundAt(0,0,0),0);
 assert.equal(nav.groundAt(1,0,0),null);
 assert.equal(nav.groundAt(4,0,0),null,'cannot jump onto a table');
});
