import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createDenScene} from '../../../src/scene/meshy/plush/assembly.mjs';
globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};

// The den froze the user's browser (2026-10-19): the garden drew 3.4M triangles, every one of them twice for the shadow map.
const tris=o=>(o.geometry.index?o.geometry.index.count:o.geometry.attributes.position.count)/3;
function weigh(){
 const garden=createDenScene(),root=garden.root??garden;root.updateMatrixWorld(true);
 const meshes=[];root.traverse(o=>{if(o.isMesh&&o.visible)meshes.push(o);});
 const sum=list=>list.reduce((n,o)=>n+tris(o),0);
 return{root,meshes,total:sum(meshes),cast:sum(meshes.filter(o=>o.castShadow))};
}

test('the garden stays inside its triangle budget, and only part of it casts shadows', () => {
 const {total,cast}=weigh();
 assert.ok(total<1.8e6,`garden triangles ${Math.round(total)} over 1.8M`);
 assert.ok(cast<7e5,`shadow-casting triangles ${Math.round(cast)} over 700k`);
});

test('flat ground does not cast a shadow, buildings still do', () => {
 const {meshes}=weigh(),box=new T.Box3(),size=new T.Vector3();
 const flat=meshes.filter(o=>box.setFromObject(o).getSize(size).y<.1&&size.x*size.z>4);
 assert.ok(flat.length>0,'the garden has flat ground pieces');
 assert.deepEqual(flat.filter(o=>o.castShadow).map(o=>o.name),[]);
 const tall=meshes.filter(o=>box.setFromObject(o).getSize(size).y>2);
 assert.ok(tall.some(o=>o.castShadow),'tall pieces still cast');
});

