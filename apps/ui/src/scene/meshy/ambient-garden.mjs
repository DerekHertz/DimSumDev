import * as T from 'three';
import { createBalancedPandaRig, WADDLE } from './panda-rig.mjs';
import { createRoleHeadwear } from './role-headwear.mjs';
import { createRoleOutfit } from './role-outfits.mjs';
import { GROUND } from './plush/assembly.mjs';
import {createLeisureGesture} from './leisure-gesture.mjs';

export function populateAmbientGarden(world,{body,vest,headphones}){
 const rigs=[],outfits=[],props=new T.Group(),groups=[];
 const addGroup=(parent,name)=>{const g=new T.Group();g.name=name;parent.add(g);groups.push(g);return g;};
 function tinted(spec){
  const outfit=new T.Group(),garment=vest.clone(true);outfit.name='Approved study outfit · '+spec.id;
  garment.traverse(n=>{if(!n.isMesh)return;const tintMaterial=source=>{const m=source.clone(),color=new T.Color(spec.color);m.onBeforeCompile=shader=>{shader.uniforms.studyTint={value:color};shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nuniform vec3 studyTint;').replace('#include <map_fragment>','#include <map_fragment>\nfloat studyLuma=dot(diffuseColor.rgb,vec3(.2126,.7152,.0722));\ndiffuseColor.rgb=studyTint*mix(.65,1.25,studyLuma);');};m.customProgramCacheKey=()=> 'assembled-study-fabric';return m;};n.material=Array.isArray(n.material)?n.material.map(tintMaterial):tintMaterial(n.material);});
  outfit.add(garment);if(spec.headwear)outfit.add(createRoleHeadwear(spec.headwear));return outfit;
 }
 function resident(parent,spec,place){
  const rig=createBalancedPandaRig(body),outfit=spec.role?createRoleOutfit(spec.role,{vest,headphones}):tinted(spec);outfits.push(outfit);rig.addOutfit(outfit);rig.model.name='Balanced Bao · '+spec.id;
  rig.model.position.fromArray(spec.position);rig.model.rotation.y=spec.yaw||0;rig.model.scale.setScalar(spec.scale||.68);if(spec.pose==='reclining')rig.model.rotation.x=-Math.PI/2;
  parent.add(rig.model);const entry={rig,spec,place,index:rigs.length,gesture:['tea','mahjong'].includes(place)?createLeisureGesture(rig):null};rigs.push(entry);return entry;
 }
 for(const id of['mahjong','tea','sleepy']){const asset=world.assets[id],g=addGroup(asset.root,id+' leisure pandas');for(const spec of asset.residents)resident(g,{...spec,scale:.60},id);}
 const gardenPandas=addGroup(world.landscape.root,'Pandas wandering the rice garden');for(const spec of world.landscape.residents)resident(gardenPandas,spec,'grove');
 const festival=world.assets.festival,carriers=addGroup(festival.root,'Panda costume carriers'),band=addGroup(festival.root,'The musical pandas');
 const carrierRigs=festival.carrierPositions.map((position,i)=>resident(carriers,{id:'carrier-'+i,position,yaw:-Math.PI/2,scale:.52,color:'#bb4235',headwear:'release-manager',pose:'carrier'},'festival'));
 const players=festival.musicians.map(spec=>({...resident(band,{...spec,scale:.60,headwear:'release-manager',pose:'musician'},'festival'),id:spec.id}));
 const wood=new T.MeshStandardMaterial({color:'#d7ae77',roughness:.85}),gold=new T.MeshStandardMaterial({color:'#e6bd60',roughness:.56,metalness:.3,side:T.DoubleSide}),soft=new T.MeshStandardMaterial({color:'#bc5141',roughness:.95});
 const tools=[];
 function stick(rig,side,mallet=false){const socket=rig.bones['paw_'+side],holder=new T.Group();socket.add(holder);const shaft=new T.Mesh(new T.CylinderGeometry(.024,.021,1,12),wood);shaft.rotation.x=Math.PI/2;shaft.position.z=.5;holder.add(shaft);const tip=new T.Mesh(new T.SphereGeometry(mallet?.12:.040,16,10),mallet?soft:wood);tip.position.z=1;holder.add(tip);holder.traverse(n=>{if(n.isMesh)n.castShadow=true;});tools.push(holder);return{socket,holder,tip};}
 const drumSticks=['L','R'].map(side=>stick(players[0].rig,side)),gongMallet=stick(players[2].rig,'L',true);
 const cymbals=['L','R'].map(side=>{const socket=players[1].rig.bones['paw_'+side],holder=new T.Group();socket.add(holder);const profile=[[0,.045],[.08,.07],[.18,.03],[.50,0],[.62,-.025]].map(p=>new T.Vector2(...p)),disc=new T.Mesh(new T.LatheGeometry(profile,36),gold);disc.rotation.x=Math.PI/2;disc.position.z=.12;holder.add(disc);const boss=new T.Mesh(new T.SphereGeometry(.10,16,10),gold);boss.scale.z=.45;boss.position.z=.16;holder.add(boss);tools.push(holder);return{socket,holder};});
 function aimStick(tool,local){const target=festival.root.localToWorld(new T.Vector3(...local)),at=tool.socket.getWorldPosition(new T.Vector3()),scale=tool.socket.getWorldScale(new T.Vector3()).x;tool.holder.scale.set(1,1,1);tool.holder.lookAt(target);tool.holder.scale.z=at.distanceTo(target)/scale;tool.tip.scale.z=1/tool.holder.scale.z;}
 function poseEntry(entry,time,reduced){
  const{rig,spec,index}=entry;rig.poseIdle(time+index*.67,{reducedMotion:reduced});
  if(spec.pose==='walking'&&!reduced){
   rig.poseWaddle(time,{stride:WADDLE.stride});const angularSpeed=WADDLE.stride*spec.scale/WADDLE.duration/6.5,a=.8+angularSpeed*time;
   rig.model.position.set(6.5*Math.sin(a),GROUND+.025,6.5*Math.cos(a));rig.model.rotation.y=a+Math.PI/2;
  }
  if(spec.pose==='seated')for(const[side,sign]of[['L',1],['R',-1]]){rig.bones['Shoulder_'+side].rotation.x=-.15;rig.bones['Shoulder_'+side].rotation.z=-sign*.12;rig.bones['Elbow_'+side].rotation.x=-.025;}
  if(spec.pose==='reclining'){for(const[side,sign]of[['L',1],['R',-1]]){rig.bones['Shoulder_'+side].rotation.z=-sign*.16;rig.bones['Elbow_'+side].rotation.x=-.12;}rig.bones.Neck.rotation.x=.10;rig.bones.Head.rotation.x=.22;}
  if(spec.pose==='carrier'){rig.poseWaddle(time+index*.13,{stride:.24,lift:.07,sway:.025});for(const[side,sign]of[['L',1],['R',-1]]){rig.bones['Shoulder_'+side].rotation.x=-2.5;rig.bones['Shoulder_'+side].rotation.z=-sign*.55;}}
  if(spec.pose==='musician'){
   const beat=Math.sin(time*Math.PI*2/1.2);for(const[side,sign]of[['L',1],['R',-1]]){const shoulder=rig.bones['Shoulder_'+side];shoulder.rotation.z=-sign*(spec.id==='cymbals'?.85+.10*beat:.61);shoulder.rotation.x=spec.id==='cymbals'?-.95:spec.id==='gong'&&side==='R'?-.30:-1.02;rig.bones['Elbow_'+side].rotation.x=-.08;if(spec.id==='drummer')shoulder.rotation.x+=.08*Math.sin(time*Math.PI*2/1.2+(side==='L'?0:Math.PI));}rig.bones.Head.rotation.x=.015*beat;
  }
  entry.gesture?.pose(reduced?null:entry.place,time+index*.67);
  rig.model.updateMatrixWorld(true);rig.skeleton.update();
 }
 function pose(time,focused=null,reduced=false){
  for(const entry of rigs)if(!focused||entry.place===focused)poseEntry(entry,time,reduced);
  if(!focused||focused==='festival'){
   festival.pose(time);drumSticks.forEach((tool,i)=>{const up=.05+.12*(1+Math.sin(time*Math.PI*2/1.2+i*Math.PI))/2;aimStick(tool,[-3.5+(i?-.21:.21),1.975+up,-.55]);});aimStick(gongMallet,[4.08,2.31,-.89-.1*(1+Math.sin(time*Math.PI*2/2.4))]);
   const offset=new T.Vector3(0,.12,.65).applyQuaternion(festival.root.getWorldQuaternion(new T.Quaternion()));cymbals.forEach((tool,i)=>tool.holder.lookAt(cymbals[1-i].socket.getWorldPosition(new T.Vector3()).add(offset)));
  }
 }
 pose(0);
 // Drape in the asset's local coordinates, after its world rotation and translation.
 const sleepy=world.assets.sleepy,resting=rigs.find(e=>e.place==='sleepy').rig,bins=new Map(),point=new T.Vector3();
 for(const m of resting.meshes){const positions=m.geometry.attributes.position;for(let i=0;i<positions.count;i++){point.fromBufferAttribute(positions,i);m.applyBoneTransform(i,point);m.localToWorld(point);sleepy.root.worldToLocal(point);if(Math.abs(point.x)>1.0||point.z<-.35||point.z>1.0)continue;const key=`${Math.round(point.x*12)},${Math.round(point.z*12)}`;bins.set(key,Math.max(bins.get(key)||0,point.y));}}
 sleepy.drapeQuilt((x,z)=>{let h=.80+.18*(Math.abs(x)/.86)**2;const ix=Math.round(x*12),iz=Math.round(z*12);for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)h=Math.max(h,bins.get(`${ix+dx},${iz+dz}`)||0);return h;});
 return{rigs,groups,carrierRigs,players,outfits,props,pose,
  setVisible(visible){groups.forEach(g=>g.visible=visible);},
  dispose(){tools.forEach(t=>props.add(t));rigs.forEach(({rig,gesture})=>{gesture?.dispose();rig.dispose();});groups.forEach(g=>g.removeFromParent());},
 };
}
