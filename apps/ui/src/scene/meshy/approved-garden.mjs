// Native assembly adapted from the signed final package (2026-10-22).
import * as Three from 'three';
import {gardenKit} from './approved/garden-kit-budget.mjs';
import {createLibrary} from './plush/library.mjs';
import {createFestival} from './plush/festival.mjs';
import {buildStructure} from './approved/approved-structures.mjs';
import {buildLandscape} from './approved/approved-landscape.mjs';
import {workDocks,activeResidents,OFFICE_PLOT} from './approved-plan.mjs';
import {RESIDENTS} from '../../shell/resident-inventory.mjs';

export function createApprovedGarden(){
 // Navigation keeps the actual furniture bounding volumes before batching.
 function capture(object,roof){
  object.updateWorldMatrix(true,true);
  object.traverse(node=>{
   if(!node.isMesh)return;for(let p=node;p;p=p.parent)if(p===roof)return;
   const bounds=new Three.Box3().setFromObject(node);
   if(bounds.min.y>=6.5)return;
   const matrix=node.matrixWorld.elements,tolerance=1e-6;
   const nearZero=value=>Math.abs(value)<tolerance;
   const sx=Math.hypot(matrix[0],matrix[2]),sz=Math.hypot(matrix[8],matrix[10]);
   const upright=nearZero(matrix[1])&&nearZero(matrix[3])&&nearZero(matrix[4])&&nearZero(matrix[6])&&nearZero(matrix[7])&&nearZero(matrix[9])&&nearZero(matrix[11])&&Math.abs(matrix[15]-1)<tolerance&&matrix[5]>0&&sx>0&&sz>0&&Math.abs(matrix[0]*matrix[8]+matrix[2]*matrix[10])<tolerance&&matrix[0]*matrix[10]-matrix[2]*matrix[8]>0&&Math.abs(matrix[0]/sx-matrix[10]/sz)<tolerance&&Math.abs(-matrix[2]/sx-matrix[8]/sz)<tolerance;
   const geometry=node.geometry;if(!geometry.boundingBox)geometry.computeBoundingBox();
   const size=geometry.boundingBox.getSize(new Three.Vector3()),close=(value,expected)=>Math.abs(value-expected)<=.05,parent=node.parent;
   let support=false;
   if(parent?.name==='Full-size resident cushion')support=(close(size.x,2.15)&&close(size.y,.32)&&close(size.z,1.9))||(close(size.x,2.02)&&close(size.y,.24)&&close(size.z,1.78));
   if(parent?.name.startsWith('Reservable daybed '))support=(close(size.x,5.2)&&close(size.y,.32)&&close(size.z,4.7))||(close(size.x,4.95)&&close(size.y,.32)&&close(size.z,4.45))||(close(size.x,4.65)&&close(size.y,.16)&&close(size.z,2.9));
   const metadata={min:bounds.min.toArray(),max:bounds.max.toArray(),name:node.name||parent.name};
   if(upright){
    const local=geometry.boundingBox,midY=(local.min.y+local.max.y)/2;
    metadata.vertices=[[local.min.x,local.min.z],[local.min.x,local.max.z],[local.max.x,local.min.z],[local.max.x,local.max.z]].map(([x,z])=>{const point=new Three.Vector3(x,midY,z).applyMatrix4(node.matrixWorld);return [point.x,point.z];});
   }
   if(support){
    const position=parent.getWorldPosition(new Three.Vector3());
    metadata.support=true;metadata.supportGroup=`${parent.name}@${position.x.toFixed(3)},${position.y.toFixed(3)},${position.z.toFixed(3)}`;metadata.supportTop=bounds.max.y;
   }
   if(bounds.max.y<=.40||parent?.name==='Timber foundation and entrance steps'&&bounds.max.y<.5){surfaces.push({...metadata,supportTop:bounds.max.y});return;}
   // Fitted low floors support bodies; all taller furniture remains solid.
   obstacles.push(metadata);
  });
 }
const land=gardenKit('Accepted garden office');const root=land.root;
const {group,box,cyl,beam,mesh,sign}=land;
const buildings=[],footprints=[],paths=[],assets={},obstacles=[],surfaces=[];
const garden={radiusX:55,radiusZ:50,centerZ:-4};
const extension=longitudinal=>Math.abs(longitudinal+4)<28?18*(1-((longitudinal+4)/28)**2)**2:0;
function inside(horizontal,longitudinal){
 const fraction=Math.abs((longitudinal+4)/50)**(2/.58);
 if(fraction>1)return false;
 const edge=55*(1-fraction)**(.58/2);return horizontal>=-edge-extension(longitudinal)&&horizontal<=edge;
}
function outline(horizontalRadius,longitudinalRadius){
 const shape=new Three.Shape();
 for(let index=0;index<180;index++){
  const angle=index/180*Math.PI*2,cosine=Math.cos(angle),sine=Math.sin(angle);
  const longitudinal=-4+Math.sign(sine)*Math.abs(sine)**.58*longitudinalRadius;
  const horizontal=Math.sign(cosine)*Math.abs(cosine)**.58*horizontalRadius-(cosine<0?extension(longitudinal):0);
  if(index)shape.lineTo(horizontal,-longitudinal);else shape.moveTo(horizontal,-longitudinal);
 }
 shape.closePath();return shape;
}
for(const [horizontalRadius,longitudinalRadius,height,depth,color] of [[55,50,-.22,.22,'honey'],[54.8,49.8,.025,.08,'grass']]){
 const geometry=new Three.ExtrudeGeometry(outline(horizontalRadius,longitudinalRadius),{depth,bevelEnabled:true,bevelSize:.08,bevelThickness:.06,bevelSegments:2,curveSegments:4});geometry.rotateX(-Math.PI/2);mesh(land.root,geometry,color,[0,height,0]);
}
const paving=new Three.MeshStandardMaterial({color:'#9e967b',roughness:.95});
const edging=new Three.MeshStandardMaterial({color:'#426e59',roughness:.95});
const pathGroup=group('Defined walks and circulation');
function walk(points,width=6,kind='secondary'){
 paths.push({points,width,kind});
 for(let index=0;index<points.length-1;index++){
  const start=points[index],end=points[index+1],length=Math.hypot(end[0]-start[0],end[1]-start[1]);
  const angle=Math.atan2(end[0]-start[0],end[1]-start[1]);
  const center=[(start[0]+end[0])/2,.27,(start[1]+end[1])/2];
  box(pathGroup,[width,.065,length],center,paving,.03).rotation.y=angle;
  for(const side of [-1,1])box(pathGroup,[.16,.045,length],[center[0]+Math.cos(angle)*(width/2-.08)*side,.32,center[2]-Math.sin(angle)*(width/2-.08)*side],edging,.02).rotation.y=angle;
  for(let distance=2.4;distance<length;distance+=2.4){
   const fraction=distance/length;
   box(pathGroup,[width-.35,.012,.035],[start[0]+(end[0]-start[0])*fraction,.309,start[1]+(end[1]-start[1])*fraction],'cream',.005).rotation.y=angle;
  }
 }
 for(const point of points)cyl(pathGroup,width/2,.065,[point[0],.27,point[1]],paving);
}
function landmark(){}
function addStructure(building,id,horizontal,longitudinal,yaw,width,depth){
 building.root.position.set(horizontal,0,longitudinal);building.root.rotation.y=yaw;building.figures.removeFromParent();root.add(building.root);capture(building.root,building.roof);building.finish();assets[id]=building;
 buildings.push({id,building});footprints.push({id,x:horizontal,z:longitudinal,yaw,width,depth});return building;
}
const teams=[
 {id:'pass',name:'The Pass',x:-30.5,z:-32,yaw:0,roles:['product','architect','release-manager']},
 {id:'pantry',name:'Tea & Pantry',x:30.5,z:-32,yaw:0,roles:['code-reviewer','qa','security','sre']},
 {id:'steamers',name:'Steamers',x:-30.5,z:24,yaw:Math.PI,roles:['developer','runner']},
 {id:'front',name:'Front of House',x:30.5,z:24,yaw:Math.PI,roles:['designer','technical-writer']}
];
for(const team of teams){
 const pavilion=buildStructure('blank',[]);
 pavilion.root.userData.cutawayDepth=-9.4;
 pavilion.helpers.deck(30.4,21.6);pavilion.helpers.shelter(30.4,21.6,5.2,team.name.toUpperCase(),false);
 pavilion.helpers.leaf(pavilion.roof,-6.08,-.25,8.816,11.016,6.2);pavilion.helpers.leaf(pavilion.roof,6.08,.25,8.816,11.016,6.4);
 for(let runtimeIndex=0;runtimeIndex<2;runtimeIndex++)for(const [roleIndex,role] of team.roles.entries()){
  const runtime=runtimeIndex?'codex':'claude';
  const station=buildStructure('station',[]);
  for(const child of [...station.root.children])if(child!==station.figures&&!['Rounded timber table','Low rear storage and personal shelf','Computer, monitor stand, keyboard and pointing device'].includes(child.name))child.removeFromParent();
  if(!['developer','sre'].includes(role))station.root.children.find(child=>child.name.startsWith('Computer,'))?.removeFromParent();
  if(!['developer','sre'].includes(role)){
   const paper=station.helpers.group(role+' task surface');
   station.helpers.box(paper,[2.1,.025,1],[-.2,1.62,-1.5],role==='architect'?'blueDeep':'cream',.015);
   if(role==='designer')for(const [index,color] of ['coral','blue','lilac','gold'].entries())station.helpers.box(paper,[.27,.018,.55],[.7+index*.2,1.65,-1.4],color,.005);
  }
  let localPosition,stationYaw;
  if(team.id==='pantry'){
   localPosition=[[-12.3,-5.3,5.3,12.3][roleIndex],0,runtimeIndex?-6.8:6.8];stationYaw=runtimeIndex?0:Math.PI;
  }else{
   localPosition=[runtimeIndex?9.6:-9.6,0,team.roles.length===3?(roleIndex-1)*7:(roleIndex-.5)*9];stationYaw=runtimeIndex?-Math.PI/2:Math.PI/2;
  }
  station.root.position.set(...localPosition);station.root.rotation.y=stationYaw;station.figures.removeFromParent();pavilion.root.add(station.root);
  const actorPosition=new Three.Vector3(0,.36,role==='sre'?1.25:1.1).applyAxisAngle(new Three.Vector3(0,1,0),stationYaw).add(station.root.position);
 }
 addStructure(pavilion,team.id,team.x,team.z,team.yaw,30.4,21.6);landmark(team.name+' · '+team.roles.length*2+' desks',team.x,team.z,7.5);
}
const facilityDefinitions=[['tea',-46,-4,Math.PI/2,15,12,'Tea room · 4'],['pond',23,-4,0,17,14,'Pond · 4'],['rest',-23,-4,0,18,16,'Rest nook · 4'],['games',46,-4,-Math.PI/2,28,16,'Mahjong · 2 × 4']];
const facilities=new Map();
for(const [id,horizontal,longitudinal,yaw,width,depth,title] of facilityDefinitions){
 const building=buildStructure(id,[],{occupants:false});
 building.root.userData.cutawayDepth=id==='office'?-8:id==='games'?-6.3:id==='rest'?-6.3:-4.3;
 addStructure(building,id,horizontal,longitudinal,yaw,width,depth);facilities.set(id,building);landmark(title,horizontal,longitudinal,id==='office'?10:id==='pond'?1.8:7.1);
}
const office=buildStructure('office',[],{occupants:false});
office.root.userData.cutawayDepth=-8;
addStructure(office,'office',OFFICE_PLOT.x,OFFICE_PLOT.z,0,OFFICE_PLOT.width,OFFICE_PLOT.depth);
const commons=group('Central meeting plaza');
cyl(commons,10,.07,[0,.34,-4],'cream');cyl(commons,8.5,.045,[0,.39,-4],'jadeLight');
const meetingTable=cyl(commons,1,.18,[0,1.32,-4],'paleWood');meetingTable.scale.set(2,1,1.18);
const teaTray=land.teaSet(land.root,[0,1.42,-4],1);teaTray.name='Lazy susan';
const teaBounds=new Three.Box3().setFromObject(teaTray),teaRadius=Math.hypot(Math.max(Math.abs(teaBounds.min.x),Math.abs(teaBounds.max.x)),Math.max(Math.abs(teaBounds.min.z+4),Math.abs(teaBounds.max.z+4)));
obstacles.push({name:'Rotating meeting tea tray',min:[-teaRadius,teaBounds.min.y,-4-teaRadius],max:[teaRadius,teaBounds.max.y,-4+teaRadius]});
for(let index=0;index<6;index++){
 const angle=index*Math.PI/3;const cushion=cyl(commons,.62,.1,[Math.sin(angle)*4,.46,-4+Math.cos(angle)*3.5],'cream');cushion.scale.z=.8;
}
landmark('Meeting · exact center',0,-4,2.2);
walk([[0,-23.5],[0,-17]],8,'main');walk([[0,9],[0,19.95]],8,'main');
walk([[-35,-17],[35,-17]],8,'main');walk([[-35,9],[35,9]],8,'main');
for(const horizontal of [-10,10])walk([[horizontal,-17],[horizontal,33]],6);
for(const horizontal of [-35,35])walk([[horizontal,-17],[horizontal,9]],6);
walk([[-10,33],[10,33]],6);walk([[0,28.05],[0,42]],8,'main');
for(const horizontal of [-30.5,30.5]){walk([[horizontal,-21.2],[horizontal,-17]],6);walk([[horizontal,13.2],[horizontal,9]],6);}
walk([[-23,4],[-23,9]],6);walk([[23,3],[23,9]],6);
walk([[-23,-12],[-23,-17]],6);walk([[23,-11],[23,-17]],6);
walk([[-40,-4],[-35,-4]],6);walk([[38,-4],[35,-4]],6);
walk([[0,-17],[0,-14],[-10,-14],[-10,6],[0,6],[0,9]],6);
walk([[0,-14],[10,-14],[10,6],[0,6]],6);
box(land.root,[26,.1,17],[0,.16,24],'jadeLight',.5);
const library=createLibrary();library.root.position.set(0,.02,24);root.add(library.root);assets.library=library;capture(library.root,library.roof);landmark('Library + reading garden',0,24,6.8);
footprints.push({id:'library',x:0,z:24,yaw:0,width:10.1,depth:8.1});
const libraryRoofMaterials=[];library.roof.traverse(node=>{if(node.isMesh){node.material=node.material.clone();libraryRoofMaterials.push(node.material);}});
const festival=createFestival();festival.root.position.set(-65,0,-4);festival.root.rotation.y=Math.PI/2;root.add(festival.root);assets.festival=festival;capture(festival.root,festival.roof);landmark('Keynote stage',-65,-4,6);
footprints.push({id:'festival',x:-65,z:-4,yaw:Math.PI/2,width:13.2,depth:9});
box(land.root,[8,.055,16],[-56.5,.21,-4],'jadeLight',.3);
walk([[-35,-17],[-56.5,-17],[-56.5,9],[-35,9]],6);walk([[-60.5,-4],[-56.5,-4]],6);
for(const horizontal of [-17,17])box(land.root,[13.2,.08,9],[horizontal,.10,39.8],'jadeLight',.5);
const landscape=buildLandscape('A',{footprints,paths,inside,capture});
landscape.root.traverse(node=>{if(node.isMesh)node.castShadow=false;});
root.add(landscape.root);
sign(land.root,'WELCOME TO THE DEN',[0,3.2,44],7);for(const horizontal of [-5.1,5.1])beam(land.root,[horizontal,.1,44],[horizontal,4.1,44],.13,'timber');
// Bake only the land-owned assemblies; building kits retain independent roof materials.
capture(pathGroup,null);capture(commons,null);land.finish([pathGroup,commons,teaTray]);

 const roofMaterials=[];
 for(const asset of [library,festival])asset.roof?.traverse(node=>{if(node.isMesh){node.material=node.material.clone();roofMaterials.push({material:node.material,root:asset.root});}});
 let roofMode='full';
 function setRoofMode(mode){
  roofMode=mode;
  for(const {building} of buildings)building.setRoofMode(mode);
  for(const {material,root:buildingRoot} of roofMaterials){buildingRoot.updateMatrixWorld(true);material.clippingPlanes=mode==='full'?[]:[new Three.Plane(new Three.Vector3(0,0,-1),-1).applyMatrix4(buildingRoot.matrixWorld)];material.needsUpdate=true;}
 }
 root.updateMatrixWorld(true);
 return {approved:true,root,assets,places:footprints.map(p=>({...p,w:p.width,d:p.depth,name:p.id,rotation:p.yaw})),paths,footprints,obstacles,surfaces,inside,officePlot:OFFICE_PLOT,landscape,
  docks:workDocks(activeResidents(RESIDENTS),{office:true}),get roofMode(){return roofMode;},setRoofMode,setRoofs:visible=>setRoofMode(visible?'full':'cutaway'),
  worldPoint(id,point){return assets[id].root.localToWorld(new Three.Vector3(...point));},
  dispose(){for(const asset of Object.values(assets))asset.kit?.dispose?.();library.dispose();festival.dispose();landscape.dispose();land.dispose();root.removeFromParent();}};
}
