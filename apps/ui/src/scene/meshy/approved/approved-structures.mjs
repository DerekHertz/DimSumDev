import * as T from 'three';
import {gardenKit} from './garden-kit-budget.mjs';

export function buildStructure(kind,sources,options={}){
const kit=gardenKit('Proposed '+kind+' structure');
const {root,group,box,cyl,orb,ring,beam,tube,mesh,sign,bamboo,flowers,teaSet,lantern}=kit;
const figures=group('Capacity reference residents');
const roof=group('Roof panels — cutaway for interior review');
const fixtures=[];
function actor(species,x,z,yaw=0,height=.68,lift=0,recline=false){
 fixtures.push({species,x,z,yaw,scale:height,lift,recline});return {model:new T.Group()};
}
function deck(width,depth){
 const ground=group('Moss border, foundation and fitted timber floor');
 box(ground,[width+1.1,.24,depth+1.1],[0,-.06,0],'grass',.18);
 box(ground,[width,.25,depth],[0,.12,0],'timber',.13);
 for(let index=0;index<Math.ceil(width/.6);index++)box(ground,[.56,.07,depth-.12],[-width/2+.3+index*.6,.28,0],index%5?'honey':'paleWood',.01);
 box(ground,[Math.min(5.5,width*.6),.16,.9],[0,.12,depth/2+.3],'paleWood',.07);
}
function leaf(parent,x,z,width,depth,height){
 const vertices=[],indices=[],radial=12,angular=48;
 for(let radius=0;radius<=radial;radius++)for(let angle=0;angle<=angular;angle++){
  const fraction=radius/radial,phase=angle/angular*Math.PI*2;
  vertices.push(x+Math.cos(phase)*width*fraction,height-.6*fraction**1.6+.05*Math.sin(phase*8)*fraction,z+Math.sin(phase)*depth*fraction);
  if(radius<radial&&angle<angular){const offset=radius*(angular+1)+angle;indices.push(offset,offset+angular+1,offset+1,offset+1,offset+angular+1,offset+angular+2);}
 }
 const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(vertices,3));geometry.setIndex(indices);geometry.computeVertexNormals();
 const material=kit.materials.jade.clone();material.side=T.DoubleSide;mesh(parent,geometry,material);
 for(let index=0;index<12;index++){
  const phase=index/12*Math.PI*2;
  tube(parent,Array.from({length:13},(_,step)=>{const fraction=.03+step/12*.97;return[x+Math.cos(phase)*width*fraction,height-.6*fraction**1.6+.06,z+Math.sin(phase)*depth*fraction];}),.027,'jadeLight',16);
 }
}
function shelter(width,depth,height=5.1,title='',canopy=true){
 const frame=group('Bamboo posts, caps, rafters and broad openings');
 for(const horizontal of [-width/2+.5,width/2-.5])for(const longitudinal of [-depth/2+.5,depth/2-.5]){
  cyl(frame,.16,height,[horizontal,.31+height/2,longitudinal],'timber');
  cyl(frame,.26,.16,[horizontal,.42,longitudinal],'paleWood');
  for(let level=.9;level<height;level+=.8)cyl(frame,.18,.045,[horizontal,level,longitudinal],'honey');
  for(const offset of [-.5,.5])beam(frame,[horizontal,height-.65,longitudinal],[horizontal+offset,height+.3,longitudinal],.065,'honey');
 }
 for(const longitudinal of [-depth/2+.5,depth/2-.5])beam(frame,[-width/2+.3,height+.3,longitudinal],[width/2-.3,height+.3,longitudinal],.12,'timber');
 for(const horizontal of [-width/2+.5,width/2-.5])beam(frame,[horizontal,height+.3,-depth/2+.3],[horizontal,height+.3,depth/2-.3],.12,'timber');
 if(canopy){leaf(roof,-width*.22,-.25,width*.31,depth*.56,height+1.0);leaf(roof,width*.22,.25,width*.31,depth*.56,height+1.2);}
 for(const horizontal of [-width*.34,width*.34])lantern(frame,[horizontal,height+.1,depth/2-.5],1.0);
 if(title)sign(frame,title,[0,height-.15,-depth/2+.53],Math.min(width*.5,6));
 return frame;
}
function cushion(x,z,yaw=0){
 const seat=group('Full-size resident cushion',root,[x,.31,z]);seat.rotation.y=yaw;
 box(seat,[2.15,.32,1.9],[0,.18,0],'paleWood',.12);box(seat,[2.02,.24,1.78],[0,.46,0],'jadeLight',.13);
 return seat;
}
function table(parent,x,z,width=4.7,depth=3,height=1.1){
 const furniture=group('Rounded timber table',parent,[x,.31,z]);
 box(furniture,[width,.18,depth],[0,height,0],'paleWood',.12);
 for(const horizontal of [-width/2+.4,width/2-.4])for(const longitudinal of [-depth/2+.4,depth/2-.4])cyl(furniture,.09,height-.08,[horizontal,height/2,longitudinal],'timber');
 return furniture;
}
function shelf(parent,x,z,width=3.6){
 const furniture=group('Low rear storage and personal shelf',parent,[x,.31,z]);
 for(const height of [.2,1.1,1.9])box(furniture,[width,.13,.85],[0,height,0],'paleWood');
 for(const horizontal of [-width/2+.1,width/2-.1])box(furniture,[.12,1.9,.85],[horizontal,1,0],'timber');
 for(let index=0;index<5;index++)box(furniture,[.24,.55,.5],[-width*.35+index*.3,.54,0],['jade','cream','coral','blue','lilac'][index],.02);
 return furniture;
}
function computer(parent,x,z,height=1.25){
 const device=group('Computer, monitor stand, keyboard and pointing device',parent,[x,height+.45,z]);
 box(device,[1.75,1.18,.16],[0,.66,-.18],'jadeDeep',.07);
 box(device,[1.56,.96,.015],[0,.66,-.089],'blueDeep',.025);
 for(let index=0;index<5;index++)box(device,[.7-index%2*.2,.035,.01],[-.25,.93-index*.13,-.07],'cream',.003);
 beam(device,[0,0,-.2],[0,.24,-.2],.065,'timber');box(device,[.8,.05,.48],[0,-.02,-.2],'honey');
 box(device,[1.35,.06,.48],[0,-.07,.52],'jadeDeep',.035);
 for(let row=0;row<3;row++)for(let column=0;column<9;column++)box(device,[.09,.025,.09],[-.55+column*.135,-.025,.36+row*.12],'cream',.008);
 orb(device,.12,[.94,-.035,.50],'cream',[.7,.4,1.2]);
 return device;
}
function planting(width,depth){
 for(const horizontal of [-width/2+.4,width/2-.4]){bamboo(root,[horizontal,.3,-depth/2+.4],1.2);flowers(root,[horizontal,.3,depth/2-.5],'pink',1.6);}
}

if(kind==='tea'){
 deck(15,12);shelter(15,12,5.1,'TAKE A BREATHER');
 const teaTable=table(root,0,0,5.1,3.4,1.0);teaSet(teaTable,[0,1.12,0],2.0);
 shelf(root,0,-4.85,5.2);
 for(const [x,z,species]of[[-4.7,-2.3,'red'],[4.7,-2.3,'dragon'],[-4.7,3.2,'panda'],[4.7,3.2,'panda']]){
  cushion(x,z,Math.atan2(-x,-z));actor(species,x,z,Math.atan2(-x,-z),.68,.58);
 }
 for(const horizontal of [-3.7,3.7])teaSet(root,[horizontal,1.36,-4.8],1.0);
 planting(15,12);
}else if(kind==='pond'){
 deck(17,14);
 const water=group('Koi pond, stone edging, lotus and water');
 const pond=cyl(water,1,.16,[0,.37,-.8],'stone');pond.scale.set(4.6,1,3.25);
 const surface=cyl(water,1,.025,[0,.46,-.8],'blue');surface.scale.set(4.25,1,2.95);
 for(const [x,z]of[[-1.6,-1.8],[2.4,-1.2],[1.2,.7]]){
  const pad=cyl(water,.50,.03,[x,.49,z],'jade');pad.scale.z=.8;
  for(let index=0;index<6;index++){const angle=index*Math.PI/3;orb(water,.10,[x+Math.cos(angle)*.13,.58,z+Math.sin(angle)*.13],'pink',[.6,.8,1]);}
 }
 for(const [x,z]of[[-2.6,-.4],[.3,-1.8],[2,.1]]){orb(water,.2,[x,.49,z],'coral',[1.5,.12,.5]);const tail=orb(water,.15,[x-.36,.49,z],'cream',[1,.1,1]);tail.rotation.y=.6;}
 for(const [x,z,species]of[[-6.1,-.8,'red'],[6.1,-.8,'dragon'],[-3.1,4.5,'panda'],[3.1,4.5,'panda']]){
  const yaw=Math.atan2(-x,-.8-z);cushion(x,z,yaw);actor(species,x,z,yaw,.68,.58);
 }
 for(const x of[-7.8,7.8])for(let z=-5.7;z<4;z+=2.4){cyl(root,.10,1.0,[x,.9,z],'timber');if(z<1.5)beam(root,[x,1.25,z],[x,1.25,z+2.4],.06,'honey');}
 planting(17,14);
}else if(kind==='rest'){
 deck(18,16);shelter(18,16,5.2,'DO NOT HURRY');
 for(const [index,x,z]of[[0,-5.6,-4],[1,5.6,-4],[2,-5.6,4],[3,5.6,4]]){
  const bed=group('Reservable daybed '+(index+1),root,[x,.31,z]);
  box(bed,[5.2,.32,4.7],[0,.20,0],'timber',.15);
  box(bed,[4.95,.32,4.45],[0,.50,0],'cream',.16);
  box(bed,[1.8,.30,.9],[0,.80,-1.52],'pink',.12);
  box(bed,[4.65,.16,2.9],[0,.75,.52],'lilac',.10);
  for(let stitch=-1.8;stitch<=1.8;stitch+=.6)box(bed,[.028,.012,2.5],[stitch,.837,.52],'cream',.003);
  const shelfPosition=x<0?-2.1:2.1;
  box(bed,[.8,1,.9],[shelfPosition,.52,-2.7],'paleWood',.09);
  lantern(bed,[shelfPosition,2.1,-2.7],.75);
 }
 actor('panda',-5,-4,0,.68,0,true);actor('red',5,4,Math.PI,.68,0,true);
 planting(18,16);
}else if(kind==='games'){
 deck(28,16);shelter(28,16,5.5,'ONE MORE ROUND');
 for(const center of[-6.8,6.8]){
  const game=table(root,center,0,4.8,4.8,1.25);
  box(game,[4.5,.025,4.5],[0,1.36,0],'jadeDeep',.03);
  for(let side=0;side<4;side++){
   const hand=group('Tiles for place '+(side+1),game);hand.rotation.y=side*Math.PI/2;
   for(let tile=0;tile<13;tile++){box(hand,[.17,.24,.13],[-1.15+tile*.19,1.49,1.65],'cream',.015);box(hand,[.13,.035,.012],[-1.15+tile*.19,1.52,1.724],'jade',.003);}
   const angle=side*Math.PI/2,x=center+Math.sin(angle)*4.3,z=Math.cos(angle)*4.3;
   cushion(x,z,angle+Math.PI);actor(side===1?'red':side===2?'dragon':'panda',x,z,angle+Math.PI,.68,.58);
  }
  for(const [x,z]of[[-.4,-.2],[0,.1],[.4,.3]])box(game,[.18,.10,.25],[x,1.44,z],'cream',.015);
 }
 shelf(root,0,-6.8,5);teaSet(root,[0,1.55,-6.8],1.5);planting(28,16);
}else if(kind==='station'){
 deck(7.0,8.0);shelter(7,8,4.6,'WORKSTATION');
 box(root,[6.15,.025,6.8],[0,.335,0],'jadeLight',.03);
 table(root,0,-1.65,4.2,1.75,1.20);computer(root,-.25,-1.65,1.20);
 shelf(root,0,-3.35,4.8);
 box(root,[1.05,.9,1.35],[1.45,.85,-1.65],'blue',.07);
 for(const height of[.6,.9,1.2])box(root,[.88,.18,.04],[1.45,height,-.95],'cream',.02);
 actor(options.species||'red',0,1.1,Math.PI);
 bamboo(root,[-2.8,.32,-2.7],.8);flowers(root,[2.7,.32,2.9],'pink',1.3);
}else if(kind==='office'){
 deck(26,17);shelter(26,17,6.6,'',false);
 const reception=group('Executive porch, entry arch and central aisle');
 box(reception,[27,.24,17.8],[0,-.16,0],'stone',.18);
 box(reception,[8.3,.025,15.1],[0,.34,.45],'jadeLight',.04);
 for(const horizontal of [-3.9,3.9])box(reception,[.065,.018,14.7],[horizontal,.365,.45],'gold',.01);
 for(const horizontal of [-3.45,3.45]){
  cyl(reception,.28,5.3,[horizontal,2.96,7.6],'timber');cyl(reception,.42,.18,[horizontal,.42,7.6],'paleWood');
  for(const height of[1.25,2.15,3.05,3.95,4.85])cyl(reception,.3,.065,[horizontal,height,7.6],'honey');
  tube(reception,[[horizontal,5.55,7.6],[horizontal*.64,6.15,7.6],[0,6.48,7.6]],.15,'timber',28);
 }
 sign(reception,'BAO + JIAO',[0,5.48,7.67],4.5);
 for(const horizontal of[-2.85,2.85])lantern(reception,[horizontal,5.12,7.6],1.3);
 const roofWidth=27.4,roofDepth=18.2,roofHeight=6.8;
 const roofVertices=[],roofIndices=[],roofSteps=40,roofRows=16;
 for(let row=0;row<=roofRows;row++)for(let column=0;column<=roofSteps;column++){
  const horizontal=(column/roofSteps-.5)*roofWidth,longitudinal=(row/roofRows-.5)*roofDepth;
  const fraction=Math.abs(longitudinal)/(roofDepth/2),height=roofHeight+2.1*(1-fraction)**.75+.65*fraction**8;
  roofVertices.push(horizontal,height,longitudinal);
  if(row<roofRows&&column<roofSteps){const offset=row*(roofSteps+1)+column;roofIndices.push(offset,offset+roofSteps+1,offset+1,offset+1,offset+roofSteps+1,offset+roofSteps+2);}
 }
 const roofGeometry=new T.BufferGeometry();roofGeometry.setAttribute('position',new T.Float32BufferAttribute(roofVertices,3));roofGeometry.setIndex(roofIndices);roofGeometry.computeVertexNormals();
 const roofMaterial=kit.materials.jadeDeep.clone();roofMaterial.side=T.DoubleSide;mesh(roof,roofGeometry,roofMaterial);
 for(let index=0;index<=28;index++){
  const horizontal=-roofWidth/2+index/28*roofWidth;
  tube(roof,Array.from({length:33},(_,step)=>{const longitudinal=(step/32-.5)*roofDepth,fraction=Math.abs(longitudinal)/(roofDepth/2);return[horizontal,roofHeight+2.1*(1-fraction)**.75+.65*fraction**8+.035,longitudinal];}),.035,'jade',36);
 }
 for(const longitudinal of [-roofDepth/2,roofDepth/2])tube(roof,[[-roofWidth/2,roofHeight+.65,longitudinal],[0,roofHeight+.65,longitudinal],[roofWidth/2,roofHeight+.65,longitudinal]],.12,'paleWood');
 tube(roof,[[-roofWidth/2-.2,8.97,0],[0,9.12,0],[roofWidth/2+.2,8.97,0]],.13,'gold');
 for(const [index,x,runtime,color]of[[0,-6.4,'claude','jade'],[1,6.4,'codex','blue']]){
  box(root,[8.7,.025,11.7],[x,.335,-.8],index?'blue':'jadeLight',.03);
  table(root,x,-1.8,6.4,2.8,1.1);
  box(root,[6.15,.12,2.55],[x,1.56,-1.8],index?'blue':'jadeDeep',.08);
  for(const horizontal of[x-2.35,x+2.35]){
   box(root,[1.35,.75,2.2],[horizontal,.86,-1.8],'timber',.11);
   for(const height of[.68,.9,1.12]){box(root,[1.16,.16,.045],[horizontal,height,-.67],'paleWood',.035);orb(root,.05,[horizontal,height,-.63],'gold');}
  }
  const backShelf=shelf(root,x,-7.1,7.0);
  for(const height of[2.7,3.6,4.5])box(backShelf,[7,.13,.85],[0,height,0],'paleWood');
  for(const horizontal of[-3.4,3.4])box(backShelf,[.14,4.5,.85],[horizontal,2.3,0],'timber');
  for(let item=0;item<9;item++)box(backShelf,[.3,.62,.50],[-2.7+item*.5,3.99,0],['jade','cream','blue','gold'][item%4],.025);
  const desk=group('Executive desk accessories',root,[x,1.53,-1.8]);
  box(desk,[2.7,.04,1.45],[0,.13,0],'cream',.02);
  for(let line=0;line<5;line++)box(desk,[1.4-line%2*.3,.01,.025],[-.3,.16,-.45+line*.2],color,.002);
  cyl(desk,.18,.38,[2.2,.31,-.5],color);
  sign(root,index?'JIAO':'BAO',[x,1.70,-.48],1.1,color==='blue'?'blueDeep':'jadeDeep');
  const executive=actor('panda',x,-4.9,0,1.35);
  const badge=group('Executive accent',executive.model,[0,0,0]);
  tube(badge,[[-.65,2.08,.35],[0,1.94,.85],[.65,2.08,.35]],.09,color);
  cushion(x,4.5);actor('panda',x,4.5,Math.PI,.68,.58);
  box(root,[3,.6,1.25],[x,.63,5.65],index?'blue':'jadeLight',.15);
 }
 for(const horizontal of[-11.5,11.5]){box(root,[1.15,1.0,1.15],[horizontal,.83,5.8],'cream',.13);bamboo(root,[horizontal,1.34,5.8],1.55,false);}
 planting(26,17);
}


const roofMaterials=[];
function finish(){
 kit.finish([...root.children].filter(node=>node!==figures));
 roof.traverse(node=>{if(!node.isMesh)return;node.material=node.material.clone();roofMaterials.push(node.material);});
}
function setRoofMode(mode){
 root.updateMatrixWorld(true);
 const plane=new T.Plane(new T.Vector3(0,0,-1),root.userData.cutawayDepth??-2.7).applyMatrix4(root.matrixWorld);
 for(const material of roofMaterials){material.clippingPlanes=mode==='full'?[]:[plane];material.needsUpdate=true;}
}
figures.visible=options.occupants!==false;
return {root,roof,figures,fixtures,kit,finish,setRoofMode,helpers:{deck,shelter,table,shelf,computer,actor,box,cyl,orb,ring,beam,tube,sign,bamboo,flowers,group,leaf,mesh}};
}
