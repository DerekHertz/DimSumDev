import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createApprovedGarden} from './approved-garden.mjs';
import {createMeetingPresentation} from './meeting-presentation.mjs';

globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};
test('the native meeting tray retains real tea geometry and stays stationary across speaker changes',()=>{
 const garden=createApprovedGarden(),presentation=createMeetingPresentation();try{
  const tray=garden.root.getObjectByName('Lazy susan');assert.ok(tray);
  let triangles=0;tray.traverse(n=>{if(n.isMesh)triangles+=(n.geometry.index?.count??n.geometry.attributes.position.count)/3;});
  assert.ok(triangles>100,'the service contains actual tray, pot and cups');
  const bounds=new T.Box3().setFromObject(tray);assert.ok(bounds.min.y>=1.78&&bounds.max.y<2.5,'tea sits above the substantial tabletop');
  const meeting={state:'running',seats:[{role:'product'},{role:'architect'},{role:'developer'}],live:{role:'product'}};
  const seats=new Map(meeting.seats.map((seat,index)=>{const model=new T.Group();model.position.set(index-1,.89,-3);return [seat.role,model];}));
  const before=tray.rotation.toArray();presentation.update(meeting,seats);
  assert.equal(presentation.activePlace.visible,true);
  presentation.update({...meeting,live:{role:'developer'}},seats);assert.deepEqual(tray.rotation.toArray(),before);
  presentation.update(null,seats);assert.deepEqual(tray.rotation.toArray(),before);
  const point=tray.children.find(n=>n.isMesh&&n.material.color.getHexString()==='39725e');
  const vertex=new T.Vector3().fromBufferAttribute(point.geometry.attributes.position,0),position=point.localToWorld(vertex.clone());
  for(let i=0;i<40;i++)presentation.update({...meeting,live:{role:meeting.seats[i%3].role}},seats);
  assert.equal(position.distanceTo(point.localToWorld(vertex.clone())),0,'real tea mesh vertices stay fixed through speaker changes');
  const solid=garden.obstacles.find(o=>o.name==='Stationary meeting tea tray');assert.ok(solid);
  const swept=new T.Box3(new T.Vector3(...solid.min),new T.Vector3(...solid.max));
  assert.ok(swept.containsBox(new T.Box3().setFromObject(tray)),'navigation covers the stationary tea geometry');
 }finally{presentation.dispose();garden.dispose();}
});
