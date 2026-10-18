import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createDenScene} from './plush/assembly.mjs';
import {populateAmbientGarden} from './ambient-garden.mjs';

globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};
test('ambient walking advances 20% faster with matching gait while idle keeps its breathing clock',()=>{
 const world=createDenScene(),body=new T.Mesh(new T.BoxGeometry(2,3,1),new T.MeshStandardMaterial());body.position.y=1.5;
 const vest=new T.Group(),headphones=new T.Group();let ambient;
 try{
  world.landscape.residents[0].pose='walking';
  ambient=populateAmbientGarden(world,{body,vest,headphones});
  const walker=ambient.rigs.find(e=>e.spec.pose==='walking'),idle=ambient.rigs.find(e=>e.place==='grove'&&e!==walker);
  ambient.pose(0);const start=Math.atan2(walker.rig.model.position.x,walker.rig.model.position.z);
  ambient.pose(1);const end=Math.atan2(walker.rig.model.position.x,walker.rig.model.position.z);
  assert.ok(Math.abs((end-start)*6.5-.3808)<1e-7,'circle travel rises from .317333 to .3808 units/second');
  const expected=walker.rig.poseWaddle(1.2);assert.equal(expected.cycles,1);
  const shoulder=walker.rig.bones.Shoulder_L.quaternion.clone();ambient.pose(1);
  assert.ok(walker.rig.bones.Shoulder_L.quaternion.angleTo(shoulder)<1e-7,'distance and gait use the same faster clock');
  idle.rig.poseIdle(1+idle.index*.67);const breath=idle.rig.bones.Chest.scale.clone();ambient.pose(1);
  assert.deepEqual(idle.rig.bones.Chest.scale,breath,'idle retains its original clock');
  ambient.pose(1,null,true);const position=walker.rig.model.position.clone();ambient.pose(20,null,true);
  assert.deepEqual(walker.rig.model.position,position,'reduced motion stops travel');
 }finally{ambient?.dispose();world.dispose();body.geometry.dispose();body.material.dispose();}
});
