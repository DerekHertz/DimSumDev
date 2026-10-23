import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { withDen } from './den-test-helpers.mjs';
import { planPlacements, poseFor, TEAM_LABELS } from './bindings.mjs';
import { cameraConfig, wheelZoom, clampZoom } from './camera.mjs';
import { createDenExplorer, isDenPositionBlocked } from './explorer.mjs';
import { denEvents } from './events.mjs';

const placement=(ref,role='developer',pose='working')=>({ref,role,pose});

test('the assembled village has Bao alone and finite, normalized skinning after compaction',()=>{
  withDen(den=>{
    assert.equal(den.pandas.length,1,'Bao is the only panda the village brings');
    let meshes=0;
    den.world.traverse(o=>{
      if(!o.isMesh)return;meshes++;
      for(const n of o.geometry.attributes.position.array)assert.ok(Number.isFinite(n));
      if(o.isSkinnedMesh){
        const w=o.geometry.attributes.skinWeight;
        for(let i=0;i<w.count;i++)assert.ok(Math.abs(w.getX(i)+w.getY(i)+w.getZ(i)+w.getW(i)-1)<1e-5);
      }
    });
    assert.ok(meshes<400,'static geometry and plush materials should share draws, got '+meshes);
  });
});

test('board refreshes retain identity, transition poses, and remove resolved figures and queue baskets',()=>{
  withDen((den,controller)=>{
    const first=placement('test/01');
    controller.sync([first],['test/02'],[{counted:7,color:'qi'}]);
    const panda=controller.figures.get(first.ref).panda;
    controller.update(1/60);
    controller.sync([{...first,pose:'waiting_on_user'}],['test/02'],[]);
    assert.equal(controller.figures.get(first.ref).panda,panda);
    controller.update(1/60);
    assert.ok(panda.bones.Shoulder_L.rotation.z>0.8);
    controller.sync([],[],[]);
    assert.equal(controller.figures.size,0);assert.equal(den.frontier.size,0);
    assert.equal(panda.model.parent,null);
  });
});

test('twelve tickets sharing a team have distinct places; synthetic Pass residents carry no ticket',()=>{
  withDen((den,controller)=>{
    const placements=Array.from({length:12},(_,i)=>placement('test/'+String(i+1).padStart(2,'0')));
    const planned=planPlacements([...placements,{ref:'__pass',role:'orchestrator',synthetic:true}]);
    assert.equal(planned.length,12);
    assert.equal(new Set(planned.map(c=>c.placement.position.join(','))).size,12);
    controller.sync(placements,[],[]);assert.equal(controller.figures.size,12);
    for(const f of controller.figures.values())assert.equal(f.panda.model.userData.ticketRef,f.placement.ref);
    controller.sync([placement('test/01','qa')],[],[]);
    assert.equal(controller.figures.size,1);
    assert.equal(controller.figures.get('test/01').panda.model.userData.role,'qa');
  });
});

test('reduced motion holds a pose without accumulating head tilt',()=>{
  withDen((den,controller)=>{
    controller.sync([placement('test/01','qa','blocked')],[],[]);
    controller.update(1/60,{reducedMotion:true});
    const head=controller.figures.get('test/01').panda.bones.Head.rotation.x;
    for(let i=0;i<120;i++)controller.update(1/60,{reducedMotion:true});
    assert.ok(Math.abs(controller.figures.get('test/01').panda.bones.Head.rotation.x-head)<1e-10);
    assert.notDeepEqual(poseFor('working',0),poseFor('blocked',0));
  });
});

test('the default desktop and phone cameras contain every team label and the Tally',()=>{
  for(const [width,height] of [[1440,900],[375,667]]){
    const config=cameraConfig({width,height}),camera=new THREE.OrthographicCamera(config.left,config.right,config.top,config.bottom,config.near,config.far);
    camera.position.set(...config.position);camera.lookAt(...config.target);camera.updateMatrixWorld(true);
    for(const l of TEAM_LABELS){
      const p=new THREE.Vector3(l.x,l.y,l.z).project(camera);
      assert.ok(Math.abs(p.x)<=1&&Math.abs(p.y)<=1,l.id+' should fit');
    }
    const tally=new THREE.Vector3(18,2.7,10).project(camera);
    assert.ok(Math.abs(tally.x)<=1&&Math.abs(tally.y)<=1);
  }
});

function eventTarget(){
  const listeners=new Map();
  return {listeners,
    addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},
    removeEventListener(type,fn){listeners.get(type)?.delete(fn);},
    emit(type,event={}){for(const fn of listeners.get(type)||[])fn(event);},
    count(){return [...listeners.values()].reduce((n,s)=>n+s.size,0);},
  };
}
test('Tab frees the cursor without leaving first person, clears movement, and mouse look can resume',()=>{
  const doc=eventTarget(),win=eventTarget(),canvas=eventTarget(),previousDoc=globalThis.document,previousWin=globalThis.window;
  doc.pointerLockElement=null;win.matchMedia=()=>({matches:false});
  canvas.requestPointerLock=()=>{doc.pointerLockElement=canvas;doc.emit('pointerlockchange');};
  doc.exitPointerLock=()=>{doc.pointerLockElement=null;doc.emit('pointerlockchange');};
  globalThis.document=doc;globalThis.window=win;
  let explorer;
  try {
    const modes=[],navigation={enabled:true};
    explorer=createDenExplorer(THREE,{canvas,orbitControls:navigation,den:{obstacles:[]},onModeChange:v=>modes.push(v)});
    explorer.enter();
    assert.equal(doc.pointerLockElement,canvas);
    const key=code=>doc.emit('keydown',{code,target:{closest:()=>null},preventDefault(){}});
    key('KeyW');key('Tab');
    assert.equal(doc.pointerLockElement,null);
    assert.equal(explorer.active,true);
    assert.equal(navigation.enabled,false);
    const position=explorer.camera.position.clone();
    explorer.update(0.1);assert.deepEqual(explorer.camera.position.toArray(),position.toArray());
    doc.emit('mousemove',{movementX:100,movementY:0});explorer.update(0.1);
    assert.equal(explorer.camera.rotation.y,0,'moving a free cursor does not turn the camera');
    explorer.capture();
    assert.equal(doc.pointerLockElement,canvas);
    doc.emit('mousemove',{movementX:100,movementY:0});explorer.update(0.1);
    assert.ok(explorer.camera.rotation.y<0);
    key('Escape');assert.equal(explorer.active,true);
    assert.equal(doc.pointerLockElement,null,'first Escape releases capture');
    key('Escape');assert.equal(explorer.active,false);
    assert.deepEqual(modes,[true,false]);
  }finally{explorer?.dispose();globalThis.document=previousDoc;globalThis.window=previousWin;}
});
test('first-person fallback accepts scene keys, ignores fields and buttons, and cleans up its listeners',()=>{
  const doc=eventTarget(),win=eventTarget(),canvas=eventTarget(),previousDoc=globalThis.document,previousWin=globalThis.window;
  doc.pointerLockElement=null;win.matchMedia=()=>({matches:false});
  canvas.requestPointerLock=()=>{throw Error('unavailable in test');};
  canvas.setPointerCapture=()=>{};
  globalThis.document=doc;globalThis.window=win;
  let explorer;
  try {
    const navigation={enabled:true},modes=[];
    explorer=createDenExplorer(THREE,{canvas,orbitControls:navigation,den:{obstacles:[]},onModeChange:v=>modes.push(v)});
    explorer.enter();assert.equal(navigation.enabled,false);
    const start=explorer.camera.position.z;
    doc.emit('keydown',{code:'KeyW',target:{closest:()=>({})},preventDefault(){}});
    explorer.update(0.1);assert.equal(explorer.camera.position.z,start);
    doc.emit('keydown',{code:'KeyW',target:{closest:()=>null},preventDefault(){}});
    explorer.update(0.1);assert.ok(explorer.camera.position.z<start);
    doc.emit('focusin');const paused=explorer.camera.position.z;
    explorer.update(0.1);assert.equal(explorer.camera.position.z,paused);
    doc.emit('keydown',{code:'Escape',target:{closest:()=>null},preventDefault(){}});
    assert.deepEqual(modes,[true,false]);assert.equal(navigation.enabled,true);
    explorer.dispose();explorer=null;
    assert.equal(doc.count()+win.count()+canvas.count(),0);
  }finally{explorer?.dispose();globalThis.document=previousDoc;globalThis.window=previousWin;}
});
test('Enter starts every visit at the same frame, and the diorama navigation is off while walking and back on after Esc',()=>{
  const doc=eventTarget(),win=eventTarget(),canvas=eventTarget(),previousDoc=globalThis.document,previousWin=globalThis.window;
  doc.pointerLockElement=null;win.matchMedia=()=>({matches:false});
  canvas.requestPointerLock=()=>{throw Error('unavailable in test');};canvas.setPointerCapture=()=>{};
  globalThis.document=doc;globalThis.window=win;
  let explorer;
  try {
    const navigation={enabled:true},states=[];
    explorer=createDenExplorer(THREE,{canvas,orbitControls:navigation,den:{obstacles:[]},onModeChange:v=>states.push([v,navigation.enabled])});
    const key=(code,target={closest:()=>null})=>doc.emit('keydown',{code,target,preventDefault(){}});
    explorer.enter();const first=explorer.camera.position.clone();
    assert.deepEqual([first.x,first.y,first.z],[4.2,1.65,23.4]);
    key('KeyW');explorer.update(0.5);key('Escape');
    explorer.enter();
    assert.deepEqual(explorer.camera.position.toArray(),first.toArray());
    assert.equal(explorer.camera.rotation.y,0);
    key('Escape');
    assert.deepEqual(states,[[true,false],[false,true],[true,false],[false,true]]);
  }finally{explorer?.dispose();globalThis.document=previousDoc;globalThis.window=previousWin;}
});
test('mouse look through the adapter is clamped in pitch and applied on the next frame',()=>{
  const doc=eventTarget(),win=eventTarget(),canvas=eventTarget(),previousDoc=globalThis.document,previousWin=globalThis.window;
  doc.pointerLockElement=canvas;doc.exitPointerLock=()=>{};win.matchMedia=()=>({matches:false});
  canvas.requestPointerLock=()=>{};canvas.setPointerCapture=()=>{};
  globalThis.document=doc;globalThis.window=win;
  let explorer;
  try {
    explorer=createDenExplorer(THREE,{canvas,orbitControls:{enabled:true},den:{obstacles:[]}});
    explorer.enter();
    doc.emit('mousemove',{movementX:0,movementY:-100000});explorer.update(1/60);
    assert.equal(explorer.camera.rotation.x,1.30);
    doc.emit('mousemove',{movementX:0,movementY:100000});explorer.update(1/60);
    assert.equal(explorer.camera.rotation.x,-1.20);
  }finally{explorer?.dispose();globalThis.document=previousDoc;globalThis.window=previousWin;}
});

test('wheel zoom is exponential: equal wheel travel gives equal zoom ratios, and it stays inside 0.55 to 1.2',()=>{
  // Literals: exp(-0.3) = 0.7408, exp(-0.1) = 0.9048.
  assert.ok(Math.abs(wheelZoom(1,-300)-0.7408)<1e-4);
  assert.ok(Math.abs(wheelZoom(1,-100)-0.9048)<1e-4);
  assert.ok(Math.abs(wheelZoom(wheelZoom(1,-100),100)-1)<1e-12,'a wheel step and its reverse cancel');
  assert.ok(Math.abs(wheelZoom(0.8,-100)/0.8-wheelZoom(1,-100))<1e-12,'the same travel scales by the same ratio at any zoom');
  assert.equal(wheelZoom(1,-5000),0.55);assert.equal(wheelZoom(1,20000),1.2);
  assert.equal(clampZoom(0.1),0.55);assert.equal(clampZoom(9),1.2);
});

test('pointer-lock picking uses the crosshair and normal picking delegates to the existing event manager',()=>{
  const canvas={},previous=globalThis.document;globalThis.document={pointerLockElement:canvas};
  try{
    let delegated=0,center=null,picked=false;
    const stage={explorer:{active:true}},manager=denEvents({compute(){delegated++;}},stage);
    const state={gl:{domElement:canvas},camera:{},pointer:{set(x,y){center=[x,y];}},raycaster:{setFromCamera(){picked=true;}}};
    manager.compute({},state);assert.deepEqual(center,[0,0]);assert.equal(picked,true);assert.equal(delegated,0);
    stage.explorer.active=false;manager.compute({},state);assert.equal(delegated,1);
  }finally{globalThis.document=previous;}
});

test('each of the five states poses the panda differently: no two share a pose',()=>{
  const states=['working','waiting_on_user','blocked','failed','done'];
  for(const [i,a] of states.entries())for(const b of states.slice(i+1))assert.notDeepEqual(poseFor(a,0),poseFor(b,0),a+' vs '+b);
});

test('no panda perches on Bao: Pass roles stand on the ground beside the Pass, and Bao is the orchestrator',()=>{
  withDen((den,controller)=>{
    const onBao=p=>{for(let o=p.model.parent;o;o=o.parent)if(o===den.hero.model)return true;return false;};
    assert.deepEqual(den.pandas.slice(1).filter(onBao).map(p=>p.model.name),[]);
    const planned=planPlacements([placement('t/01','product'),placement('t/02','architect'),placement('t/03','orchestrator')]);
    for(const c of planned)assert.ok(!['crown','left-shoulder','right-shoulder'].includes(c.placement.parent),c.role);
    const at=role=>planned.find(c=>c.role===role).placement;
    assert.ok(Math.abs(at('product').position[0]-(-4))<1.1&&Math.abs(at('product').position[2]-(-11))<1.1,'product beside the Pass');
    assert.ok(Math.abs(at('architect').position[0]-4)<1.1&&Math.abs(at('architect').position[2]-(-11))<1.1,'architect beside the Pass');
    controller.sync([placement('t/03','orchestrator')],[],[]);
    assert.equal(controller.figures.size,0,'live orchestrator work shows on Bao, not as another panda');
    controller.sync([placement('t/01','product')],[],[]);
    assert.equal(onBao(controller.figures.get('t/01').panda),false);
  });
});
