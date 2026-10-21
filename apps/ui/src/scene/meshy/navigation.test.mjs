import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSurfaceNavigation } from './navigation.mjs';
import {bakeCrafted} from './crafted-architecture.mjs';
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
 const overhead=new THREE.Group();block(overhead,[.31,.15,.31],[.55,1.1,.55]);
 const headroom=createSurfaceNavigation([overhead],{placement:.2,baseY:0});
 assert.equal(headroom.groundAt(0,0,0,1.23,.9),0,'short body clears the interior overhead solid');
 assert.equal(headroom.groundAt(0,0,0,1.23,1.8),null,'same footprint and cell require fresh full-disc body-height clearance');
 assert.equal(headroom.groundAt(0,0,0,1.23,.9),0,'cached candidate columns do not cache a tall-body verdict');
 overhead.traverse(n=>{n.geometry?.dispose();n.material?.dispose();});
 root.traverse(n=>{n.geometry?.dispose();n.material?.dispose();});
});

test('36 leading-edge stair support never lets the centre stand inside a raised floor',()=>{
 const root=new THREE.Group(),floor=block(root,[4,.7,4],[0,.35,0]);floor.userData.navigationSurface='walkable';
 const nav=createSurfaceNavigation([root],{placement:.1,baseY:0});
 assert.equal(nav.groundAt(0,0,0,1.23,2.28),null);assert.equal(nav.groundAt(0,0,.7,1.23,2.28),.7);
 assert.equal(nav.groundAt(2.8,0,0,1.23,2.28),0,'a wide leading edge may overlap the authored step before its centre climbs');
 assert.equal(nav.groundAt(1.9,0,0,1.23,2.28),null,'leading-edge support cannot bury the centre inside that same step');
 floor.userData.navigationSurface='solid';const furniture=createSurfaceNavigation([root],{placement:.1,baseY:0});
 assert.equal(furniture.groundAt(2.8,0,0,1.23,2.28),null,'the identical unmarked furniture volume cannot support a leading edge');
 root.traverse(n=>{n.geometry?.dispose();n.material?.dispose();});
});

test('36 water needs complete local bridge support rather than a partly covered raster cell',()=>{
 const root=new THREE.Group(),bridge=block(root,[.5,.2,3],[0,.4,0]);bridge.userData.navigationSurface='walkable';
 const water=new THREE.Mesh(new THREE.BoxGeometry(4,.02,4));water.position.y=.1;
 const nav=createSurfaceNavigation([root],{placement:.1,baseY:0,excludedObjects:[water]});
 assert.equal(nav.groundAt(0,0,.5,.19,1.8),.5);assert.equal(nav.groundAt(0,0,.5,.26,1.8),null,'a body wider than the bridge cannot stand above its water margin');
 root.traverse(n=>{n.geometry?.dispose();n.material?.dispose();});water.geometry.dispose();water.material.dispose();
});

test('material-batched floors and overhead retain their empty gap while furniture stays solid',()=>{
 const source=new THREE.Group(),material=new THREE.MeshStandardMaterial();
 const floor=block(source,[4,.24,4],[0,.12,0]);floor.material=material;floor.userData.navigationSurface='walkable';
 block(source,[4,.2,4],[0,2.8,0]).material=material;
 block(source,[.5,1,.5],[1,.74,0]).material=material;
 const baked=bakeCrafted(source),nav=createSurfaceNavigation([baked],{placement:.1});
 assert.equal(baked.children.length,1,'render batching stays unchanged');
 assert.equal(nav.groundAt(0,0,0,.26,2.04),.24,'the floor-to-overhead gap remains traversable');
 assert.equal(nav.groundAt(1,0,.24,.26,2.04),null,'same-material furniture retains its occupied volume');
 assert.equal(nav.groundAt(0,0,.24,.26,2.6),null,'actual overhead still blocks a tall body');
 baked.traverse(n=>{n.geometry?.dispose();n.material?.dispose();});
});
