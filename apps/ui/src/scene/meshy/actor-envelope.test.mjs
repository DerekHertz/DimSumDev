import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {actorEnvelope} from './actor-envelope.mjs';
import {WADDLE} from './panda-rig.mjs';

// Independent reference: retain the original public Three precise-bounds path.
function referenceEnvelope({model,rig},gesture){
 const origin=new T.Vector3(),bounds=new T.Box3();let radius=0,height=0;
 const measure=()=>{model.updateWorldMatrix(true,true);model.getWorldPosition(origin);bounds.setFromObject(model,true);for(const x of[bounds.min.x,bounds.max.x])for(const z of[bounds.min.z,bounds.max.z])radius=Math.max(radius,Math.hypot(x-origin.x,z-origin.z));height=Math.max(height,bounds.max.y-origin.y);};
 for(let i=0;i<8;i++){rig.poseWaddle(i*WADDLE.duration/8);measure();}rig.poseIdle(0);measure();
 for(const kind of['tea','pond','greeting']){gesture?.pose(kind,2);measure();}gesture?.pose(null,0);
 if(rig.profile?.sit){rig.poseSit(1);measure();}
 const scale=model.getWorldScale(new T.Vector3());for(const pose of['standing','moving','seated']){const e=rig.profile?.envelope?.[pose];if(e){radius=Math.max(radius,e.radius*Math.max(scale.x,scale.z));height=Math.max(height,e.height*scale.y);}}
 rig.poseIdle(0);model.updateWorldMatrix(true,true);return{radius:Math.ceil(radius*1.05*100)/100,height:Math.ceil(height*1.05*100)/100};
}

for(const relative of[false,true])test(`precise posed envelopes retain mixed skin weights, morphs, props and live edits (relative=${relative})`,()=>{
 const model=new T.Group(),parent=new T.Group();parent.position.set(4,.3,-8);parent.rotation.y=.43;parent.add(model);model.scale.set(.68,.73,.61);
 const geometry=new T.BoxGeometry(1,2,1,3,3,3),position=geometry.attributes.position,count=position.count;
 geometry.setAttribute('skinIndex',new T.Uint16BufferAttribute(Array.from({length:count},()=>[0,1,0,0]).flat(),4));
 geometry.setAttribute('skinWeight',new T.Float32BufferAttribute(Array.from({length:count},(_,i)=>i%2?[.3,.7,0,0]:[1,0,0,0]).flat(),4));
 geometry.morphTargetsRelative=relative;
 geometry.morphAttributes.position=[new T.Float32BufferAttribute(Array.from({length:count},(_,i)=>relative?[.12,.04,0]:[position.getX(i)+.12,position.getY(i)+.04,position.getZ(i)]).flat(),3)];
 const root=new T.Bone(),tip=new T.Bone();tip.position.y=1;root.add(tip);model.add(root);
 const mesh=new T.SkinnedMesh(geometry,new T.MeshBasicMaterial());model.add(mesh);model.updateMatrixWorld(true);mesh.bind(new T.Skeleton([root,tip]));mesh.morphTargetInfluences[0]=.4;
 const prop=new T.Mesh(new T.BoxGeometry(.2,3,.2));prop.position.set(1.8,1.5,0);tip.add(prop);
 const rig={profile:{sit:true,envelope:{moving:{radius:1.3,height:2.2}}},poseIdle(){root.rotation.z=.04;tip.rotation.x=0;},poseWaddle(t){root.rotation.z=Math.sin(t)*.2;tip.rotation.x=Math.cos(t)*.3;},poseSit(){root.rotation.z=-.3;tip.rotation.x=.4;}};
 const gesture={pose(kind){tip.rotation.z=kind==='tea'?.5:kind==='pond'?-.3:kind==='greeting'?.8:0;}};
 try{
  assert.deepEqual(actorEnvelope({model,rig},gesture),referenceEnvelope({model,rig},gesture));
  const before=actorEnvelope({model,rig},gesture);prop.scale.y=2;mesh.morphTargetInfluences[0]=.9;model.scale.x=1.2;
  const after=actorEnvelope({model,rig},gesture);assert.deepEqual(after,referenceEnvelope({model,rig},gesture));assert.ok(after.height>before.height);assert.ok(after.radius>before.radius);
 }finally{geometry.dispose();mesh.material.dispose();prop.geometry.dispose();prop.material.dispose();mesh.skeleton.dispose();}
});

test('custom skinned vertex behavior retains Three precise-bounds fallback',()=>{
 const geometry=new T.BoxGeometry(1,2,1),model=new T.Group(),mesh=new T.SkinnedMesh(geometry,new T.MeshBasicMaterial());
 mesh.getVertexPosition=function(index,target){return target.fromBufferAttribute(geometry.attributes.position,index).multiplyScalar(2);};model.add(mesh);
 const rig={profile:{},poseIdle(){},poseWaddle(){}};
 try{assert.deepEqual(actorEnvelope({model,rig}),referenceEnvelope({model,rig}));}finally{geometry.dispose();mesh.material.dispose();}
});

test('instanced props retain Three conservative instance bounds',()=>{
 const geometry=new T.BoxGeometry(1,2,1),material=new T.MeshBasicMaterial(),model=new T.Group(),mesh=new T.InstancedMesh(geometry,material,2);
 mesh.setMatrixAt(0,new T.Matrix4().makeTranslation(2,1,0));mesh.setMatrixAt(1,new T.Matrix4().makeTranslation(-3,2,1));model.add(mesh);model.rotation.y=.4;
 const rig={profile:{},poseIdle(){},poseWaddle(){}};
 try{assert.deepEqual(actorEnvelope({model,rig}),referenceEnvelope({model,rig}));}finally{geometry.dispose();material.dispose();mesh.dispose();}
});
