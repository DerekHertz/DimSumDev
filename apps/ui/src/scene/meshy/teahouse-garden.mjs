import * as T from 'three';
import {fitTeahouseProp} from './teahouse.mjs';

export function treeStructureConflicts(trees,structures){
 const buildings=structures.map(root=>({root,bounds:new T.Box3().setFromObject(root,true)})),conflicts=[];
 for(const tree of trees){
  const bounds=new T.Box3().setFromObject(tree,true);
  for(const building of buildings)if(bounds.intersectsBox(building.bounds))conflicts.push({tree:tree.name,structure:building.root.name});
 }
 return conflicts;
}

export function buildTeahouseGarden(kit,{props={}}={}){
 const root=kit.group('Restrained teahouse garden accents'),trees=[],lanterns=[],lotus=[];
 if(props.tree)for(const [x,z,yaw]of [[-50.5,-28,.12],[50.5,-28,-.12],[-50.5,25.5,-.12],[50.5,25.5,.12]]){
  const tree=fitTeahouseProp(props.tree,[5.6,6.8,1.45]);tree.name='Approved bonsai at '+x+','+z;tree.position.set(x,.165,z);tree.rotation.y=yaw;root.add(tree);trees.push(tree);
 }
 if(props.lantern)for(const [x,z]of [[-38.5,-10],[29.8,4.6],[48,-19.5],[5.65,18.4],[-6.5,-22]]){
  const lantern=fitTeahouseProp(props.lantern,[1.1,2.2,1.1]);lantern.name='Ambient stone lantern';lantern.position.set(x,.31,z);root.add(lantern);lanterns.push(lantern);
 }
 const fountain=kit.group('Shishi-odoshi at the existing pond',root,[27,.5,-5.8]);
 for(const x of [-.45,.45])kit.beam(fountain,[x,0,0],[x,1.35,0],.065,'jade');
 kit.beam(fountain,[-.6,1.05,0],[.6,1.05,0],.055,'honey');
 const rocker=kit.cyl(fountain,.13,1.65,[0,1.14,0],'jadeLight');rocker.rotation.x=Math.PI/2-.2;
 const mouth=kit.ring(fountain,.11,.025,[0,1.3,-.81],'jadeDeep');mouth.rotation.x=-.2;
 kit.beam(fountain,[.55,0,.35],[.55,1.85,.35],.09,'jade');kit.beam(fountain,[.55,1.85,.35],[0,1.85,0],.08,'jade');
 const water=new T.MeshStandardMaterial({color:'#91c1c4',transparent:true,opacity:.65,roughness:.2});
 kit.beam(fountain,[0,1.79,0],[0,1.25,0],.025,water);kit.orb(fountain,.35,[0,.05,-1.02],'stone',[1.5,.55,1]);
 for(const [x,z]of [[21.4,-6.6],[24.5,-4],[22.5,-3.6]]){
  const flower=kit.group('Lotus flower on the existing pond',root,[x,.52,z]);
  const pad=kit.cyl(flower,.5,.025,[0,0,0],'jade');pad.scale.z=.8;
  for(let ring=0;ring<2;ring++)for(let index=0;index<7;index++){
   const angle=index*Math.PI*2/7+ring*.35,radius=ring?.11:.22;
   const petal=kit.orb(flower,.16,[Math.sin(angle)*radius,.09+ring*.08,Math.cos(angle)*radius],ring?'cream':'pink',[.55,.65,1.5]);petal.rotation.y=angle;
  }
  kit.orb(flower,.075,[0,.24,0],'gold',[1,.5,1]);lotus.push(flower);
 }
 root.traverse(node=>{if(node.isMesh)node.castShadow=false;});
 return {root,trees,lanterns,fountain,lotus};
}
