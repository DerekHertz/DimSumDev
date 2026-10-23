import * as T from 'three';
import {gardenKit} from './garden-kit-budget.mjs';

export const directions={
 A:{name:'1 · Lightly carved',description:'Keep the rounded layered hills. Add broad shallow grooves, two broken ledges and a little moss; no hero pillars.'},
 B:{name:'2 · A few hero pillars',description:'Three taller rock pillars rise from the soft rear ridge. Deeper grooves, irregular shelves and restrained mossy crowns.'},
 C:{name:'3 · Stronger pillar ridge',description:'Seven taller pillars, deeper clefts and more visible ledges. The strongest option here, still matte and stylized—not photoreal.'},
};
const levels={A:{relief:.28,grooves:.07,ledges:2,heroes:[]},B:{relief:.65,grooves:.16,ledges:3,heroes:[2,7,12]},C:{relief:1,grooves:.24,ledges:5,heroes:[1,3,5,7,9,11,13]}};

function material(color){return new T.MeshStandardMaterial({color,roughness:.98,side:T.DoubleSide});}
const leafMaterials=[material('#587e51'),material('#7d9b5c'),material('#416d4d')];
const leafGeometry=new T.BufferGeometry();
const leafVertices=[],leafIndices=[];
for(let index=0;index<=8;index++){
 const fraction=index/8,width=Math.sin(fraction*Math.PI)*.13;
 leafVertices.push(-width,-fraction*fraction*.16,fraction,width,-fraction*fraction*.16,fraction);
 if(index<8){const offset=index*2;leafIndices.push(offset,offset+1,offset+2,offset+1,offset+3,offset+2);}
}
leafGeometry.setAttribute('position',new T.Float32BufferAttribute(leafVertices,3));leafGeometry.setIndex(leafIndices);leafGeometry.computeVertexNormals();

function foliage(kit,parent,position,angle,scale=1,color=0){
 const blade=kit.mesh(parent,leafGeometry,leafMaterials[color%3],position);blade.rotation.set(-.12,angle,.12*Math.sin(angle));blade.scale.setScalar(scale);return blade;
}

function bambooCluster(kit,parent,id,x,z,scale){
 const plant=kit.group(id+' bamboo planting',parent,[x,.15,z]);plant.scale.setScalar(scale);
 if(id==='A')kit.bamboo(plant,[0,0,0],1,false);
 if(id==='B'){
  for(const [offsetX,offsetZ,height]of[[-.30,.1,.92],[.26,-.1,1.1],[0,.30,.83]])kit.bamboo(plant,[offsetX,0,offsetZ],height,false);
  for(let tier=0;tier<6;tier++){
   const angle=tier*2.4,height=1.4+tier*.11,end=[Math.cos(angle)*.48,height,Math.sin(angle)*.42];
   kit.beam(plant,[0,height-.1,0],end,.016,'jadeDeep');
   for(let leaf=0;leaf<4;leaf++)foliage(kit,plant,end,angle+(leaf-1.5)*.55,.55+leaf*.08,tier+leaf);
  }
 }
 if(id==='C')for(let stem=0;stem<5;stem++){
  const angle=stem*2.4,offsetX=Math.cos(angle)*.29,offsetZ=Math.sin(angle)*.24,height=2.4+stem*.19;
  kit.beam(plant,[offsetX,0,offsetZ],[offsetX+.09,height,offsetZ],.038,'jade');
  for(let node=.3;node<height;node+=.34)kit.cyl(plant,.049,.027,[offsetX+.09*node/height,node,offsetZ],'jadeDeep');
  for(let branch=0;branch<4;branch++){
   const phase=angle+branch*1.8,branchHeight=height-.22-branch*.32,end=[offsetX+Math.cos(phase)*.46,branchHeight+.06,offsetZ+Math.sin(phase)*.46];
   kit.beam(plant,[offsetX,branchHeight-.08,offsetZ],end,.012,'jadeDeep');
   for(let leaf=0;leaf<3;leaf++)foliage(kit,plant,end,phase+(leaf-1)*.58,.72,stem+branch+leaf);
  }
 }
 return plant;
}

function hill(kit,parent,x,z,radiusX,radiusZ,height,color,seed,yaw=0){
 const radial=10,angular=40,vertices=[],indices=[];
 for(let ring=0;ring<=radial;ring++)for(let spoke=0;spoke<=angular;spoke++){
  const fraction=ring/radial,angle=spoke/angular*Math.PI*2,lift=(1-fraction*fraction)**1.45;
  const ripple=1+.025*Math.sin(angle*3+seed)+.02*Math.cos(angle*5-seed);
  vertices.push(Math.cos(angle)*radiusX*fraction*ripple+.2*lift*Math.sin(seed),height*lift*(1+.035*Math.sin(angle*3+seed)*Math.sin(fraction*Math.PI)),Math.sin(angle)*radiusZ*fraction*ripple);
  if(ring<radial&&spoke<angular){const offset=ring*(angular+1)+spoke;indices.push(offset,offset+1,offset+angular+1,offset+1,offset+angular+2,offset+angular+1);}
 }
 const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(vertices,3));geometry.setIndex(indices);geometry.computeVertexNormals();
 const peak=kit.mesh(parent,geometry,color,[x,.1,z]);peak.rotation.y=yaw;return peak;
}

function rockPeak(kit,parent,x,z,radiusX,radiusZ,height,baseColor,seed,yaw,level,pillar=false){
 const settings=levels[level],rows=16,columns=48,vertices=[],colors=[],indices=[];
 const jade=new T.Color('#739176'),stone=new T.Color('#aaa696'),base=new T.Color(baseColor);
 for(let row=0;row<=rows;row++)for(let column=0;column<=columns;column++){
  const fraction=row/rows,angle=column/columns*Math.PI*2;
  const rounded=Math.sqrt(Math.max(0,1-fraction**(1/1.45)));
  const shaft=fraction<.93?.99-.15*fraction+.055*Math.sin(fraction*15+seed)+.035*Math.tanh(5*Math.sin(fraction*19+seed)):.85*Math.max(0,1-(fraction-.93)/.07)**.4;
  const profile=pillar?shaft:rounded;
  const cleft=T.MathUtils.clamp(.5+.28*Math.cos(angle*5+seed+.55*Math.sin(fraction*4))+.22*Math.cos(angle*8-seed+fraction*.7),0,1)**4;
  let ledge=0;
  for(let tier=0;tier<settings.ledges;tier++){
   const shelfHeight=.19+tier*(.61/Math.max(1,settings.ledges-1))+.035*Math.sin(angle*2+tier+seed);
   ledge+=Math.exp(-(((fraction-shelfHeight)/.024)**2))*.075*settings.relief*Math.max(0,.3+.7*Math.cos(angle+tier*1.6));
  }
  const detail=1-settings.grooves*cleft+.025*Math.sin(angle*3+seed)+ledge;
  const radius=profile*detail;
  vertices.push(Math.cos(angle)*radiusX*radius+.28*Math.sin(fraction*5+seed)*fraction,height*fraction,Math.sin(angle)*radiusZ*radius);
  const color=base.clone().lerp(stone,.75+.10*cleft);
  const moss=T.MathUtils.smoothstep(fraction,.81,.98)*(.52+.30*Math.sin(angle*3+seed)**2);
  color.lerp(jade,moss);color.multiplyScalar(1-.055*settings.relief*Math.sin(fraction*47+2*Math.sin(fraction*9+seed)+angle*.25+seed));colors.push(color.r,color.g,color.b);
  if(row<rows&&column<columns){const offset=row*(columns+1)+column;indices.push(offset,offset+columns+1,offset+1,offset+1,offset+columns+1,offset+columns+2);}
 }
 const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(vertices,3));geometry.setAttribute('color',new T.Float32BufferAttribute(colors,3));geometry.setIndex(indices);geometry.computeVertexNormals();
 const surface=new T.MeshStandardMaterial({vertexColors:true,roughness:.98,side:T.DoubleSide});
 const peak=kit.mesh(parent,geometry,surface,[x,.1,z]);peak.rotation.y=yaw;
 if(pillar){
  const crown=kit.group('Restrained mossy crown',parent,[x,height*.97,z]);
  for(let patch=0;patch<(level==='C'?3:2);patch++){
   const angle=seed+patch*2.4;
   kit.orb(crown,.48,[Math.cos(angle)*radiusX*.62,patch*.08,Math.sin(angle)*radiusZ*.57],'jade',[1.3,.35,.9]);
  }
 }
 return peak;
}

function rimZ(x){return -5-52*(1-Math.abs(x/57)**(2/.58))**(.58/2);}
function borderPoint(x,offset=0){
 const slope=(rimZ(x+.05)-rimZ(x-.05))/.1,normal=new T.Vector2(slope,-1).normalize();
 return{x:x+normal.x*offset,z:rimZ(x)+normal.y*offset,yaw:-Math.atan(slope)};
}

function bounds(place){const swapped=Math.abs(Math.sin(place.yaw))>.5;return{x0:place.x-(swapped?place.depth:place.width)/2,x1:place.x+(swapped?place.depth:place.width)/2,z0:place.z-(swapped?place.width:place.depth)/2,z1:place.z+(swapped?place.width:place.depth)/2};}
function clearSite(x,z,radius,footprints,paths,inside){
 if(![[x-radius,z],[x+radius,z],[x,z-radius],[x,z+radius]].every(([pointX,pointZ])=>inside(pointX,pointZ)))return false;
 if(footprints.some(place=>{const area=bounds(place);return x+radius>area.x0-.25&&x-radius<area.x1+.25&&z+radius>area.z0-.25&&z-radius<area.z1+.25;}))return false;
 for(const path of paths)for(let index=0;index<path.points.length-1;index++){
  const start=new T.Vector2(...path.points[index]),end=new T.Vector2(...path.points[index+1]),point=new T.Vector2(x,z),segment=end.clone().sub(start);
  const fraction=T.MathUtils.clamp(point.clone().sub(start).dot(segment)/segment.lengthSq(),0,1);
  if(point.distanceTo(start.addScaledVector(segment,fraction))<path.width/2+radius+.15)return false;
 }
 return true;
}

export function buildLandscape(id,{footprints,paths,inside}){
 const kit=gardenKit(directions[id].name),root=kit.root,plants=kit.group('Bamboo groups'),mountains=kit.group('Rear perimeter mountain layers'),plantings=[],peaks=[];
 const palettes=['#a7bcb4','#7e9e89','#9cb28d'];
 const colors=palettes.map(material);
 const layers=[{count:15,radiusX:9.5,radiusZ:6.4,height:14.5,offset:7,color:0},{count:23,radiusX:6.6,radiusZ:4.5,height:6,offset:-.3,color:1}];
 for(const layer of layers)for(let index=0;index<layer.count;index++){
  const horizontal=-54+index/(layer.count-1)*108,point=borderPoint(horizontal,layer.offset),height=layer.height*(.78+.22*Math.cos(horizontal/54*Math.PI/2))*(1+.065*Math.cos(horizontal*.4));
  const hero=layer.color===0&&levels[id].heroes.includes(index),peakHeight=hero?height*(id==='C'?1.42:1.28):height;
  if(layer.color===0)rockPeak(kit,mountains,point.x,point.z,hero?3.5:layer.radiusX,hero?3.4:layer.radiusZ,peakHeight,palettes[0],index*.4,point.yaw,id,hero);
  else hill(kit,mountains,point.x,point.z,layer.radiusX,layer.radiusZ,height,colors[layer.color],index*.4,point.yaw);
  peaks.push({x:point.x,z:point.z,height:peakHeight,layer:layer.color,hero});
 }
 const sites=[];
 const rearXs=[-42,-36,-29,-22,-15,-8,0,8,15,22,29,36,42];
 for(const x of rearXs){const z=-4-50*(1-Math.abs(x/55)**(2/.58))**(.58/2)+2.6;sites.push([x,z,2.15]);}
 for(const side of[-1,1]){
  for(const z of[-29,-18,18,28])sites.push([side*50.1,z,2.05]);
  const offsets=[-4.2,-2.1,0,2.1,4.2];
  for(const [index,offset]of offsets.entries())sites.push([side*17+offset,39.8+(index%2?1.6:-1.4),1.45]);
 }
 for(const [x,z]of[[-63,-15],[-63,7]])sites.push([x,z,1.7]);
 for(const [index,[x,z,scale]]of sites.entries()){
  const radius=.95*scale;
  if(!clearSite(x,z,radius,footprints,paths,inside))continue;
  bambooCluster(kit,plants,'B',x,z,scale);plantings.push({x,z,radius});
  if(index%3===0){kit.orb(plants,.62,[x+.65,.28,z+.25],'stone',[1.3,.65,.9]);kit.orb(plants,.48,[x+.55,.58,z+.26],'jadeLight',[1.1,.16,.75]);}
 }
 kit.finish();
 return {root,dispose:()=>kit.dispose(),metrics:{id,name:directions[id].name,settings:levels[id],heroPillars:peaks.filter(peak=>peak.hero).length,plantings,peaks}};
}
