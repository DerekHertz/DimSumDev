import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createApprovedGarden} from './approved-garden.mjs';
import * as meetingTable from './meeting-table.mjs';
const turnTeaTray=(...args)=>meetingTable.turnTeaTray(...args);

globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};
test('the native meeting tray retains real tea geometry and turns toward the current speaker, respecting reduced motion',()=>{
 const garden=createApprovedGarden();try{
  const tray=garden.root.getObjectByName('Lazy susan');assert.ok(tray);
  let triangles=0;tray.traverse(n=>{if(n.isMesh)triangles+=(n.geometry.index?.count??n.geometry.attributes.position.count)/3;});
  assert.ok(triangles>100,'the rotating group contains actual tray, pot and cups');
  const bounds=new T.Box3().setFromObject(tray);assert.ok(bounds.min.y>=1.4&&bounds.max.y<2,'tea sits above the unchanged table');
  const meeting={state:'running',seats:[{role:'product'},{role:'architect'},{role:'developer'}],live:{role:'product'}};
  const before=tray.rotation.y;turnTeaTray(tray,meeting,.1,false);assert.notEqual(tray.rotation.y,before);
  const turned=tray.rotation.y;turnTeaTray(tray,{...meeting,live:{role:'developer'}},.1,true);assert.equal(tray.rotation.y,turned);
  turnTeaTray(tray,null,.1,false);assert.equal(tray.rotation.y,turned);
  const point=tray.children.find(n=>n.isMesh&&n.material.color.getHexString()==='39725e');
  const vertex=new T.Vector3().fromBufferAttribute(point.geometry.attributes.position,0),position=point.localToWorld(vertex.clone());
  for(let i=0;i<40;i++)turnTeaTray(tray,meeting,.1,false);
  assert.ok(position.distanceTo(point.localToWorld(vertex.clone()))>.01,'real tea mesh vertices follow the rotating parent');
  const solid=garden.obstacles.find(o=>o.name==='Rotating meeting tea tray');assert.ok(solid);
  const swept=new T.Box3(new T.Vector3(...solid.min),new T.Vector3(...solid.max));
  for(let i=0;i<16;i++){tray.rotation.y=i*Math.PI/8;assert.ok(swept.containsBox(new T.Box3().setFromObject(tray)),'navigation covers the rotating tea geometry');}
 }finally{garden.dispose();}
});
