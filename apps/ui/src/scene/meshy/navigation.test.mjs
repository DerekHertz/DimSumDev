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

for(const [label,size,at] of [['interior post',[.31,4,.31],[.55,2.25,.55]],['overhead beam',[.31,.15,.31],[.55,1.1,.55]],['tall furniture',[.4,1.2,.4],[1.2,.6,0]]])test(`36 full footprint rejects ${label} between the old nine sample points`,()=>{
 const root=new THREE.Group(),mesh=block(root,size,at),nav=createSurfaceNavigation([root],{placement:.2,baseY:0,floorRadius:20});
 const box=new THREE.Box3().setFromObject(mesh),r=1.23;
 const clearance=Math.hypot(Math.max(box.min.x,0,-box.max.x),Math.max(box.min.z,0,-box.max.z));
 assert.ok(clearance<r&&box.max.y>0&&box.min.y<2.28,'independent box oracle proves an actual occupied-volume intersection');
 assert.equal(nav.groundAt(0,0,0,r,2.28),null);
 root.traverse(n=>{n.geometry?.dispose();n.material?.dispose();});
});

test('36 cached footprint candidates retain exact sub-cell positions and body heights',()=>{
 const root=new THREE.Group();block(root,[.1,2,.1],[.3,1,0]);const nav=createSurfaceNavigation([root],{placement:.2,baseY:0});
 assert.equal(nav.groundAt(.05,0,0,.09,1.8),0);
 assert.equal(nav.groundAt(.15,0,0,.09,1.8),null,'same centre cell but footprint now intersects the solid cell');
 assert.equal(nav.groundAt(.05,0,0,.09,1.8),0);
 root.traverse(n=>{n.geometry?.dispose();n.material?.dispose();});
});

test('36 leading-edge stair support never lets the centre stand inside a raised floor',()=>{
 const root=new THREE.Group(),floor=block(root,[4,.7,4],[0,.35,0]);floor.userData.navigationSurface='walkable';
 const nav=createSurfaceNavigation([root],{placement:.1,baseY:0});
 assert.equal(nav.groundAt(0,0,0,1.23,2.28),null);assert.equal(nav.groundAt(0,0,.7,1.23,2.28),.7);
 root.traverse(n=>{n.geometry?.dispose();n.material?.dispose();});
});

test('36 water needs complete local bridge support rather than a partly covered raster cell',()=>{
 const root=new THREE.Group(),bridge=block(root,[.5,.2,3],[0,.4,0]);bridge.userData.navigationSurface='walkable';
 const water=new THREE.Mesh(new THREE.BoxGeometry(4,.02,4));water.position.y=.1;
 const nav=createSurfaceNavigation([root],{placement:.1,baseY:0,excludedObjects:[water]});
 assert.equal(nav.groundAt(0,0,.5,.19,1.8),.5);assert.equal(nav.groundAt(0,0,.5,.26,1.8),null,'a body wider than the bridge cannot stand above its water margin');
 root.traverse(n=>{n.geometry?.dispose();n.material?.dispose();});water.geometry.dispose();water.material.dispose();
});
