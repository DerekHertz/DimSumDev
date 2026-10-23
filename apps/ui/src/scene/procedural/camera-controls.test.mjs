import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDenCameraStore} from './camera.mjs';
import {createCameraStore} from '../camera-store.mjs';

function target(){
  const listeners=new Map();return {
    addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},
    removeEventListener(type,fn){listeners.get(type)?.delete(fn);},
    emit(type,value={}){for(const fn of listeners.get(type)??[])fn(value);},
    count:()=>[...listeners.values()].reduce((sum,list)=>sum+list.size,0),
  };
}
test('real overview bindings orbit on drag/arrows, pan explicitly, pinch/zoom and cancel stale gestures',async()=>{
  const {bindCameraControls}=await import('./camera-controls.mjs');
  const canvas=target(),host=target(),doc=target(),win=target(),store=createDenCameraStore(createCameraStore());
  const captures=new Set();canvas.setPointerCapture=id=>captures.add(id);canvas.releasePointerCapture=id=>{captures.delete(id);canvas.emit('lostpointercapture',{pointerId:id});};
  let enabled=true;
  const dispose=bindCameraControls({canvas,host,doc,win,store,enabled:()=>enabled,view:()=>({width:1440,height:900,zoom:store.getZoom(),orbit:store.getOrbit()})});
  const pointer=(id,x,y,extra={})=>({pointerId:id,clientX:x,clientY:y,button:0,...extra});
  const down=(id,x,y,extra)=>canvas.emit('pointerdown',pointer(id,x,y,extra));
  const move=(id,x,y)=>canvas.emit('pointermove',pointer(id,x,y));
  const up=id=>canvas.emit('pointerup',pointer(id,0,0));
  const key=(key,extra={})=>host.emit('keydown',{key,target:{closest:()=>null},preventDefault(){},...extra});
  const initial=store.getOrbit(),focus=store.getTarget();
  down(1,0,0);move(1,30,-20);up(1);
  assert.notDeepEqual(store.getOrbit(),initial);assert.deepEqual(store.getTarget(),focus);
  const rotated=store.getOrbit();down(1,0,0,{shiftKey:true});move(1,20,10);up(1);
  assert.notDeepEqual(store.getTarget(),focus);assert.deepEqual(store.getOrbit(),rotated);
  const panned=store.getTarget();down(1,0,0,{button:2});move(1,20,10);up(1);assert.notDeepEqual(store.getTarget(),panned);
  key('ArrowUp');assert.ok(store.getOrbit().pitch>rotated.pitch);
  const beforeShift=store.getOrbit();key('ArrowDown',{shiftKey:true});assert.deepEqual(store.getOrbit(),beforeShift);
  key('ArrowLeft',{target:{closest:()=>({})}});assert.deepEqual(store.getOrbit(),beforeShift,'sheet fields keep their keys');
  down(1,0,0);down(2,100,0);const beforePinch=store.getOrbit();move(2,150,0);
  assert.ok(store.getZoom()<1);assert.deepEqual(store.getOrbit(),beforePinch);up(2);move(1,10,0);up(1);
  assert.notDeepEqual(store.getOrbit(),beforePinch,'remaining finger resumes orbit');
  key('-');const zoom=store.getZoom();canvas.emit('wheel',{deltaY:100,preventDefault(){}});assert.ok(store.getZoom()>zoom);
  for(const cancel of [()=>win.emit('blur'),()=>{doc.hidden=true;doc.emit('visibilitychange');doc.hidden=false;},()=>doc.emit('focusin'),()=>canvas.emit('lostpointercapture',pointer(1,0,0))]){
    down(1,0,0);cancel();const stopped=store.getOrbit();move(1,100,100);assert.deepEqual(store.getOrbit(),stopped);assert.equal(captures.size,0);
  }
  down(1,0,0);enabled=false;move(1,10,10);enabled=true;const stopped=store.getOrbit();move(1,100,100);assert.deepEqual(store.getOrbit(),stopped);
  dispose();assert.equal(canvas.count()+host.count()+doc.count()+win.count(),0);assert.equal(captures.size,0);
});
