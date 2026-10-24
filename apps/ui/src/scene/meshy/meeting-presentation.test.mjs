import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createApprovedGarden} from './approved-garden.mjs';
import {createMeetingPresentation} from './meeting-presentation.mjs';

globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};

test('a live role is highlighted at its actual seated place while the assembled tea service stays still',()=>{
 const garden=createApprovedGarden(),presentation=createMeetingPresentation();
 garden.root.add(presentation.root);
 try{
  const tray=garden.root.getObjectByName('Lazy susan');
  const before=new T.Box3().setFromObject(tray),rotation=tray.rotation.toArray();
  const parent=new T.Group();parent.position.set(1,0,-2);garden.root.add(parent);
  const product=new T.Group();product.position.set(-4,.89,-2);parent.add(product);
  const bao=new T.Group();bao.position.set(0,.89,-8);garden.root.add(bao);
  const seats=new Map([['product',product],['orchestrator',bao]]);
  const meeting={state:'running',seats:[{role:'product'}],live:{role:'product'}};
  presentation.update(meeting,seats);
  assert.equal(presentation.activePlace.visible,true);
  assert.equal(presentation.activePlace.position.x,-3);
  assert.equal(presentation.activePlace.position.z,-4);
  assert.ok(presentation.activePlace.position.y>=product.position.y&&presentation.activePlace.position.y<product.position.y+.1,'steady cue rests on the occupied seat instead of hiding under the chair');
  presentation.update({...meeting,live:{role:'orchestrator'}},seats);
  assert.equal(presentation.activePlace.position.x,0);
  assert.equal(presentation.activePlace.position.z,-8,'Bao can be the active role while drafting');
  assert.deepEqual(tray.rotation.toArray(),rotation);
  assert.deepEqual(new T.Box3().setFromObject(tray),before,'speaker changes do not move the real tea geometry');
 }finally{presentation.dispose();garden.dispose();}
});

test('the active-place cue clears for waiting, ended, retired, absent and unseated roles',()=>{
 const presentation=createMeetingPresentation(),model=new T.Group();
 const seats=new Map([['product',model],['stranger',model]]);
 const running={state:'running',seats:[{role:'product'}],live:{role:'product'}};
 try{
  for(const meeting of [{...running,state:'paused'},{...running,state:'briefed'},{...running,state:'closed'},{...running,state:'decided'},{...running,retired:true},null,{...running,live:{role:'stranger'}}]){
   presentation.update(running,seats);assert.equal(presentation.activePlace.visible,true);
   presentation.update(meeting,seats);assert.equal(presentation.activePlace.visible,false,'inactive meeting must not retain a stale live-role cue');
  }
  presentation.update(running,new Map());assert.equal(presentation.activePlace.visible,false,'a role still travelling is not highlighted at an empty place');
 }finally{presentation.dispose();}
});

test('one hanging lantern warms to amber while waiting and resets after the meeting',()=>{
 const garden=createApprovedGarden(),presentation=createMeetingPresentation({lantern:garden.meetingLantern});
 try{
  assert.ok(garden.meetingLantern,'the assembled nook owns its hanging lantern');
  const paper=garden.meetingLantern.material,normal=paper.color.getHex();
  for(const state of ['paused','briefed']){
   presentation.update({state,seats:[]},new Map());
   assert.notEqual(paper.color.getHex(),normal);
   assert.equal(presentation.activePlace.visible,false);
  }
  for(const meeting of [null,{state:'closed'},{state:'running'},{state:'briefed',retired:true}]){
   presentation.update(meeting,new Map());assert.equal(paper.color.getHex(),normal);
  }
 }finally{presentation.dispose();garden.dispose();}
});
