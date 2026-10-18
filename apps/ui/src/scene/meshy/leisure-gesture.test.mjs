import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createDenScene} from './plush/assembly.mjs';
import {populateAmbientGarden} from './ambient-garden.mjs';
globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};
test('assembled tea and mahjong pandas gesture, resting and festival poses remain, added cups dispose',()=>{
 const garden=createDenScene(),body=new T.Mesh(new T.BoxGeometry(2,3,1),new T.MeshStandardMaterial());body.position.y=1.5;
 const ambient=populateAmbientGarden(garden,{body,vest:body,headphones:new T.Group()});
 try{
  const tea=ambient.rigs.find(e=>e.place==='tea'),mahjong=ambient.rigs.find(e=>e.place==='mahjong'),rest=ambient.rigs.find(e=>e.place==='sleepy');
  ambient.pose(1);const sip=tea.rig.bones.Shoulder_L.quaternion.clone(),reach=mahjong.rig.bones.Shoulder_R.quaternion.clone();
  ambient.pose(3);assert.ok(!tea.rig.bones.Shoulder_L.quaternion.equals(sip));assert.ok(!mahjong.rig.bones.Shoulder_R.quaternion.equals(reach));
  assert.equal(tea.gesture.cup.visible,true);assert.equal(rest.rig.model.rotation.x,-Math.PI/2);assert.equal(ambient.carrierRigs.length,3);
  ambient.pose(3,null,true);assert.equal(tea.gesture.cup.visible,false);const paused=tea.rig.bones.Shoulder_L.quaternion.clone();ambient.pose(3,null,true);assert.ok(tea.rig.bones.Shoulder_L.quaternion.equals(paused));
  const cups=ambient.rigs.filter(e=>e.gesture).map(e=>e.gesture.cup);let released=0;
  for(const cup of cups)cup.children[0].geometry.addEventListener('dispose',()=>released++);
  ambient.dispose();assert.equal(released,cups.length);assert.ok(cups.every(c=>c.parent===null));
 }finally{garden.dispose();body.geometry.dispose();body.material.dispose();}
});
