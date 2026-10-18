import * as T from 'three';
import {COLORS} from './plush/garden-kit.mjs';

export function createLeisureGesture(rig){
 const cup=new T.Group();cup.name='Little leisure tea cup';cup.visible=false;rig.bones.paw_L.add(cup);
 const cream=new T.MeshStandardMaterial({color:COLORS.cream,roughness:.87}),soil=new T.MeshStandardMaterial({color:COLORS.soil,roughness:.87});
 const bowl=new T.Mesh(new T.CylinderGeometry(.12,.09,.16,16),cream),tea=new T.Mesh(new T.CircleGeometry(.105,16),soil);
 bowl.position.set(0,.08,.08);tea.rotation.x=-Math.PI/2;tea.position.set(0,.164,.08);cup.add(bowl,tea);
 function pose(kind,time){
  cup.visible=kind==='tea';if(!kind)return;
  const lift=(1-Math.cos(time*Math.PI*2/5))*.5,b=rig.bones;
  if(kind==='tea'){
   b.Shoulder_L.rotation.x=-.5-lift*.65;b.Shoulder_L.rotation.z=-.55;
   b.Elbow_L.rotation.x=-.35-lift*.65;b.Head.rotation.x=.08*lift;
  }else if(kind==='pond'){
   b.Head.rotation.x=.22;b.Shoulder_L.rotation.x=-.75-.16*Math.sin(time*3);b.Shoulder_L.rotation.z=-.35;b.Elbow_L.rotation.x=-.25;
  }else if(kind==='greeting'){
   b.Shoulder_L.rotation.z=-1.7-.17*Math.sin(time*5);b.Shoulder_L.rotation.x=-.5;b.Elbow_L.rotation.x=-.25;
  }else if(kind==='mahjong'){
   b.Shoulder_R.rotation.x=-.6-.22*lift;b.Shoulder_R.rotation.z=.4;b.Elbow_R.rotation.x=-.3;
  }
  rig.model.updateMatrixWorld(true);rig.skeleton.update();
 }
 return {cup,pose,dispose(){cup.removeFromParent();bowl.geometry.dispose();tea.geometry.dispose();cream.dispose();soil.dispose();}};
}
