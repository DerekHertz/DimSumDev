import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {ROLE_TOOLS,createRoleTool} from './role-tools.mjs';
import {ROLE_OUTFITS} from './role-outfits.mjs';
import {disposeWorld} from './assets.mjs';
test('every permanent role has its own finite paw-sized tool and independent resources',()=>{
 assert.deepEqual(Object.keys(ROLE_TOOLS).sort(),ROLE_OUTFITS.map(o=>o.id).sort());
 assert.equal(new Set(Object.values(ROLE_TOOLS)).size,15);
 const geometries=new Set(),materials=new Set();
 for(const role of Object.keys(ROLE_TOOLS)){
  const tool=createRoleTool(role),size=new T.Box3().setFromObject(tool).getSize(new T.Vector3());
  assert.equal(tool.userData.roleId,role);assert.ok(size.toArray().every(v=>v>0&&v<1),role);
  tool.traverse(n=>{if(!n.isMesh)return;assert.equal(geometries.has(n.geometry),false);geometries.add(n.geometry);materials.add(n.material);});disposeWorld(tool);
 }
 assert.ok(materials.size>=14);
 assert.throws(()=>createRoleTool('unknown'),/Unknown role/);
});
