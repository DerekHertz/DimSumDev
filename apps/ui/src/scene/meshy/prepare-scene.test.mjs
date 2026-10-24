import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {prepareDenScene} from './prepare-scene.mjs';
import {createBalancedPandaRig} from './panda-rig.mjs';
import {createRuntimeOrnaments} from './runtime-ornaments.mjs';
import {RESIDENTS} from '../../shell/resident-inventory.mjs';

function fixture(){
 const body=new T.Mesh(new T.BoxGeometry(2,3,1),new T.MeshStandardMaterial());body.position.y=1.5;
 const rig=createBalancedPandaRig(body);rig.model.scale.setScalar(.68);rig.model.position.set(0,.26,-8);rig.model.userData={runtime:'claude',actorKey:'developer'};
 const world=new T.Group();world.add(rig.model);
 const den={world,residents:world,pandaRigs:new Map([[rig.model,{rig}]]),propManifest:[RESIDENTS.find(r=>r.id==='developer')],roleWorkspaces:{workspaces:new Map([['developer',{person:rig.model}]])},walkWorld:{floorRadius:70,obstacles:[],physicalObstacles:[],navigation:{groundAt:()=>.26}}};
 den.garden={assets:{}};den.ornaments=createRuntimeOrnaments(den,{claude:{geometry:new T.BoxGeometry(.66,.66,.04),materials:[new T.MeshStandardMaterial()]}});
 const camera=new T.OrthographicCamera(-10,10,10,-10,.1,100);camera.position.set(0,4,10);camera.lookAt(0,3,0);camera.updateMatrixWorld(true);
 return {den,rig,camera,scene:new T.Scene(),dispose(){den.ornaments.dispose();rig.dispose();body.geometry.dispose();body.material.dispose();}};
}

test('scene readiness waits for hidden leisure props and badges to finish shader preparation',async()=>{
 const f=fixture();let release,settled=false;const ready=new Promise(resolve=>{release=resolve;});
 const renderer={compileAsync(world,camera,scene){assert.equal(world,f.den.world);assert.equal(camera,f.camera);assert.equal(scene,f.scene);assert.equal(world.getObjectByName('Little leisure tea cup').visible,false);assert.ok(world.getObjectByName('claude runtime ornament'));return ready;}};
 let agents;try{
  const pending=prepareDenScene(f.den,renderer,f.camera,f.scene,800).then(value=>{settled=true;return value;});
  await Promise.resolve();assert.equal(settled,false,'not ready while shaders are pending');release();agents=await pending;assert.ok(agents.actors.get('developer').gesture);
 }finally{agents?.dispose();f.dispose();}
});

test('cancellation during shader preparation releases resident props and owned places',async()=>{
 const f=fixture(),abort=new AbortController();let release;const ready=new Promise(resolve=>{release=resolve;});
 try{
  const pending=prepareDenScene(f.den,{compileAsync:()=>ready},f.camera,f.scene,800,abort.signal);assert.ok(f.rig.model.getObjectByName('Little leisure tea cup'));
  abort.abort();release();await assert.rejects(pending,{name:'AbortError'});
  assert.equal(f.rig.model.getObjectByName('Little leisure tea cup'),undefined);assert.equal([...f.den.placeRegistry.values()].length,0);
 }finally{f.dispose();}
});

test('shader preparation failure releases resident state before reporting the error',async()=>{
 const f=fixture();try{
  await assert.rejects(prepareDenScene(f.den,{compileAsync:async()=>{throw Error('shader failed');}},f.camera,f.scene,800),/shader failed/);
  assert.equal(f.rig.model.getObjectByName('Little leisure tea cup'),undefined);assert.equal([...f.den.placeRegistry.values()].length,0);
 }finally{f.dispose();}
});


test('readiness prepares the one-plane roof variant and restores renderer state before preparing full roofs',async()=>{
 const f=fixture();f.den.garden.setRoofMode=()=>{};const planes=[],renders=[],compiles=[];let finish,agents;
 const renderer={clippingPlanes:planes,autoClear:true,render(scene,camera){assert.equal(camera,f.camera);assert.equal(scene.children.length,0);assert.equal(this.autoClear,false);renders.push(this.clippingPlanes.length);},compileAsync(){compiles.push(this.clippingPlanes.length);return compiles.length===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve();}};
 try{
  const pending=prepareDenScene(f.den,renderer,f.camera,f.scene,800);assert.deepEqual(compiles,[1]);finish();agents=await pending;
  assert.deepEqual(compiles,[1,0]);assert.deepEqual(renders,[1,0]);assert.equal(renderer.clippingPlanes,planes);assert.equal(renderer.autoClear,true);
 }finally{agents?.dispose();f.dispose();}
});

test('failed roof preparation restores the renderer and releases resident state',async()=>{
 const f=fixture();f.den.garden.setRoofMode=()=>{};const planes=[];
 const renderer={clippingPlanes:planes,autoClear:true,render(){},compileAsync:async()=>{throw Error('roof shader failed');}};
 try{await assert.rejects(prepareDenScene(f.den,renderer,f.camera,f.scene,800),/roof shader failed/);assert.equal(renderer.clippingPlanes,planes);assert.equal(renderer.autoClear,true);assert.equal([...f.den.placeRegistry.values()].length,0);}finally{f.dispose();}
});
