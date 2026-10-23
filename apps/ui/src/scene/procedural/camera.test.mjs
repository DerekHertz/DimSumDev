import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as navigation from './camera.mjs';
import {createCameraStore} from '../camera-store.mjs';
import {DEN_TARGET} from './bindings.mjs';

const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);
const view={width:1440,height:900,zoom:1};
function camera(options){
  const c=navigation.cameraConfig(options),cam=new THREE.OrthographicCamera(c.left,c.right,c.top,c.bottom,c.near,c.far);
  cam.position.set(...c.position);cam.up.set(...c.up);cam.lookAt(...c.target);cam.updateMatrixWorld();return cam;
}
test('orbit turns around the current target without roll, clamps tilt and preserves the approved initial framing',()=>{
  const initial=navigation.cameraConfig(view);
  close(initial.position[1]-initial.target[1],63.50852961085883);
  const target=[4,2,-3],orbit={yaw:Math.PI/2,pitch:Math.PI/4};
  const c=navigation.cameraConfig({...view,target,orbit});
  close(c.position[0],4+110/Math.SQRT2);close(c.position[1],2+110/Math.SQRT2);close(c.position[2],-3);
  const cam=camera({...view,target,orbit}),p=new THREE.Vector3(...target).project(cam);
  close(p.x,0);close(p.y,0);assert.deepEqual(c.up,[0,1,0]);
  const up=navigation.dragOrbit(orbit,{dx:0,dy:-100000}),down=navigation.dragOrbit(orbit,{dx:0,dy:100000});
  close(up.pitch,75*Math.PI/180);close(down.pitch,20*Math.PI/180);
  assert.ok(navigation.dragOrbit(orbit,{dx:100,dy:0}).yaw!==orbit.yaw);
});
test('ground pan follows screen drag at rotated yaw and tilt with the same projection used for picking and cards',()=>{
  for(const orbit of [{yaw:0,pitch:Math.PI/4},{yaw:Math.PI/2,pitch:Math.PI/3},{yaw:-1,pitch:Math.PI/6}]){
    const target=[0,1,0],point=new THREE.Vector3(3,0,2),options={...view,target,orbit};
    const before=point.clone().project(camera(options));
    const next=navigation.dragPan(target,{dx:60,dy:-30},options);
    const after=point.clone().project(camera({...options,target:next}));
    close((after.x-before.x)*720,60);close(-(after.y-before.y)*450,-30);
  }
});
test('Den navigation resets orbit, target and zoom while team navigation retains the chosen tilt',()=>{
  const store=navigation.createDenCameraStore(createCameraStore());let changes=0;store.subscribe(()=>changes++);
  store.setOrbit({yaw:1,pitch:Math.PI/3});store.setZoom(.55);store.setTarget([10,2,4]);
  assert.ok(changes>=3);store.goToTeam('steamers');close(store.getOrbit().yaw,1);
  store.goToLevel(1);assert.deepEqual(store.getTarget(),DEN_TARGET);close(store.getZoom(),1);
  close(store.getOrbit().yaw,0);close(store.getOrbit().pitch,Math.atan(1/Math.SQRT2));
  const value=store.getOrbit();value.yaw=8;close(store.getOrbit().yaw,0);
});
