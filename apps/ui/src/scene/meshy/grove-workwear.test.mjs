import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createRoleOutfit} from './role-outfits.mjs';
import {createRoleTool} from './role-tools.mjs';
import {createRoleHeadwear} from './role-headwear.mjs';
import {createPandaAppearanceFactory} from './panda-appearance.mjs';

const roles=['orchestrator','product','architect','developer','scout','runner','qa','security','designer','herald'];
const hues=['674698','674698','674698','2759a2','2759a2','2759a2','006e54','326a2d','00658b','00658b'];
const cues={orchestrator:['Chef toque'],product:['Round spectacles'],architect:['Round spectacles','Ear pencil'],developer:['Padded headphones'],scout:['Forehead goggles'],runner:['Tied headband'],qa:['Woven douli'],security:['Short-brim cap'],designer:['Tilted beret'],herald:['Folded headband','Tucked paper slip']};
function templates(){
 const make=name=>{const g=new T.Group();g.name=name;const m=new T.Mesh(new T.BoxGeometry(.9,.7,.4),new T.MeshStandardMaterial({color:'#888888'}));m.name='Fabric';m.position.y=1.75;g.add(m);return g;};
 return {vest:make('Wardrobe · developer-vest'),scarf:make('Wardrobe · qa-scarf'),headphones:make('Wardrobe · developer-headphones')};
}
function meshes(root){const result=[];root.traverse(n=>{if(n.isMesh)result.push(n);});return result;}
test('ten approved pairs invert fabric and closures without modifying templates or natural tool materials',()=>{
 const fitted=templates();
 roles.forEach((role,i)=>{
  const a=createRoleOutfit(role,fitted),b=createRoleOutfit(role,fitted,{runtime:'codex'});
  assert.equal(a.userData.runtime,'claude');assert.equal(b.userData.runtime,'codex');
  assert.deepEqual(a.userData.palette,{main:'#faf1db',accent:'#'+hues[i],closure:'round-bamboo'});
  assert.deepEqual(b.userData.palette,{main:'#'+hues[i],accent:'#faf1db',closure:'jade-diamond'});
  const cream=a.getObjectByName('Fabric'),colored=b.getObjectByName('Fabric');
  assert.equal(cream.geometry,colored.geometry);assert.notEqual(cream.material,colored.material);
  assert.equal(cream.material.color.getHexString(),'faf1db');assert.equal(colored.material.color.getHexString(),hues[i]);
  assert.equal(fitted.vest.getObjectByName('Fabric').material.color.getHexString(),'888888');
  const natural=runtime=>meshes(createRoleTool(role,{runtime})).map(m=>m.material.color.getHexString());
  if(role!=='orchestrator')assert.deepEqual(natural('claude'),natural('codex'),role+' tools retain natural materials');
 });
 assert.throws(()=>createRoleOutfit('product',fitted,{runtime:'unknown'}),/runtime/i);
});
test('headwear and props carry approved silhouettes with practical crown and paw bounds',()=>{
 for(const role of roles)for(const runtime of ['claude','codex']){
  const head=createRoleHeadwear(role,{runtime});
  for(const cue of cues[role])assert.ok(head.userData.cues.includes(cue),role+' '+cue);
  const bounds=new T.Box3().setFromObject(head),size=bounds.getSize(new T.Vector3());
  assert.ok(bounds.min.y>2.25&&bounds.max.y<3.8,role+' contacts head space');
  assert.ok(size.x<2.5&&size.z<2.2,role+' compact headwear');
  assert.ok(meshes(head).length<=9,role+' headwear batched');
  const tool=createRoleTool(role,{runtime}),toolSize=new T.Box3().setFromObject(tool).getSize(new T.Vector3());
  assert.ok(toolSize.toArray().every(v=>v>0&&v<1),role+' paw tool');
 }
 assert.notEqual(createRoleTool('orchestrator').name,createRoleTool('orchestrator',{runtime:'codex'}).name);
 const toque=new T.Box3().setFromObject(createRoleHeadwear('orchestrator')).getSize(new T.Vector3());
 assert.ok(toque.x<1.32,'the toque fits the measured .93-unit crown rather than a full body-width hat');
});
test('appearance factory keeps runtime poses, equal coordinator scale, socket contact and disposal independent',()=>{
 const body=new T.Mesh(new T.SphereGeometry(1,12,8),new T.MeshStandardMaterial({color:'#ededdd'}));
 const factory=createPandaAppearanceFactory({body,...templates()});
 const bao=factory.createPanda('orchestrator'),jiao=factory.createPanda('orchestrator',{runtime:'codex'});
 const others=roles.slice(1).map(role=>factory.createPanda(role,{runtime:'codex'}));
 try{
  assert.deepEqual(bao.model.scale.toArray(),jiao.model.scale.toArray());
  assert.equal(bao.model.userData.runtime,'claude');assert.equal(jiao.model.userData.runtime,'codex');
  assert.equal(body.material.color.getHexString(),'ededdd');
  assert.equal(bao.rig.outfits.children[0].skeleton,bao.rig.skeleton);
  for(const panda of [bao,jiao,...others]){
   const tool=panda.rig.bones.paw_R.children.find(n=>n.userData.tool);
   assert.ok(tool,'tool attached to the paw socket');
   const attachment=tool.position.clone();
   for(let frame=0;frame<12;frame++){
    panda.rig.poseWaddle(frame/12*1.2);panda.rig.poseIdle(frame/12*4.8);
    assert.ok(tool.position.distanceTo(attachment)<1e-9);
    assert.ok(tool.getWorldPosition(new T.Vector3()).toArray().every(Number.isFinite));
   }
   panda.rig.poseIdle(2,{reducedMotion:true});
   assert.ok(panda.rig.bones.Head.quaternion.angleTo(new T.Quaternion())<1e-7);
   const hatMesh=panda.rig.outfits.children.find(n=>n.userData.headwearRole);
   assert.ok(hatMesh,'headwear metadata survives shared-rig binding');
   const weights=hatMesh.geometry.attributes.skinWeight,indices=hatMesh.geometry.attributes.skinIndex;
   for(let i=0;i<weights.count;i++)assert.equal(panda.rig.skeleton.bones[indices.getX(i)].name,'Head');
   const cuffs=panda.rig.outfits.children.filter(n=>n.userData.attachBone);
   assert.equal(cuffs.length,4,'each cuff keeps its main and accent batch');
   for(const cuff of cuffs){
    const index=cuff.geometry.attributes.skinIndex,weight=cuff.geometry.attributes.skinWeight;
    for(let i=0;i<weight.count;i++){
     assert.equal(weight.getX(i),1,'cuffs must not stretch across the arm/torso blend boundary');
     assert.equal(panda.rig.skeleton.bones[index.getX(i)].name,cuff.userData.attachBone);
    }
   }
  }
  const mesh=jiao.rig.meshes[0];let disposed=0;mesh.material.addEventListener('dispose',()=>disposed++);
  factory.destroyPanda(jiao.model);assert.equal(disposed,1);factory.destroyPanda(jiao.model);assert.equal(disposed,1);
  assert.equal(factory.instances.size,10);
 }finally{factory.dispose();}
 assert.equal(factory.instances.size,0);
 assert.throws(()=>factory.createPanda('developer'),/disposed/i);
});
