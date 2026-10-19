// Assemble approved source factories in the working Garden loop layout.
import * as T from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { gardenKit } from './garden-kit.mjs';
import { createPlaces, roads, routeToWalk, bounds, door } from './plan.mjs';
import { createLibrary } from './library.mjs';
import { createPavilion } from './pavilion.mjs';
import { createFestival } from './festival.mjs';
import { createMahjong } from './mahjong.mjs';
import { createTeaGarden } from './tea-garden.mjs';
import { createSleepyNook } from './sleepy-nook.mjs';
import { createWorkPavilion } from './work-pavilions.mjs';
import { createGrove } from './grove.mjs';
import { createGardenInfill } from './grounds.mjs';

export const GROUND=.26;

// The library predates assembly batching. Preserve its roof/wall/interior controls.
function batchLibrary(library){
 const originals=new Set();library.root.updateMatrixWorld(true);
 for(const assembly of [...library.root.children]){
  if(assembly.isMesh)continue;
  const batches=new Map(),old=[],inverse=assembly.matrixWorld.clone().invert();
  assembly.traverse(n=>{if(!n.isMesh)return;originals.add(n.geometry);const g=n.geometry.index?n.geometry.toNonIndexed():n.geometry.clone();g.applyMatrix4(inverse.clone().multiply(n.matrixWorld));if(!g.attributes.uv)g.setAttribute('uv',new T.Float32BufferAttribute(new Float32Array(g.attributes.position.count*2),2));const list=batches.get(n.material)||[];list.push(g);batches.set(n.material,list);old.push(n);});
  old.forEach(n=>n.removeFromParent());for(const[mat,parts]of batches){const mesh=new T.Mesh(mergeGeometries(parts,false),mat);mesh.name=assembly.name+' · assembly batch';mesh.castShadow=mesh.receiveShadow=true;assembly.add(mesh);parts.forEach(g=>g.dispose());}
 }
 originals.forEach(g=>g.dispose());
}

export function createDenScene(){
 const root=new T.Group();root.name='Plush bamboo garden grounds';
 const places=createPlaces('garden'),walks=roads('garden'),byId=Object.fromEntries(places.map(p=>[p.id,p]));
 const assets={library:createLibrary(),steamers:createPavilion(),pass:createWorkPavilion('pass'),pantry:createWorkPavilion('pantry'),front:createWorkPavilion('front'),festival:createFestival(),mahjong:createMahjong(),tea:createTeaGarden(),sleepy:createSleepyNook()};
 batchLibrary(assets.library);
 for(const[id,asset]of Object.entries(assets)){
  const place=byId[id];asset.root.position.set(place.x,GROUND,place.z);asset.root.rotation.y=-place.rotation*Math.PI/180;asset.root.userData.placeId=id;
  asset.root.traverse(n=>{if(n.isMesh)n.castShadow=n.receiveShadow=true;});root.add(asset.root);
 }
 const landscape=createGrove({island:false});landscape.root.position.set(27,0,-25);landscape.root.userData.placeId='grove';root.add(landscape.root);
 const westMountains=landscape.mountains.clone(true);westMountains.name='Matching western mountain backdrop';westMountains.position.set(-23,0,-25);root.add(westMountains);
 const k=gardenKit('One connected garden ground'),{group,mesh,box,cyl,orb,beam,tube,sign,lantern,bamboo,flowers,teaSet,bao}=k;
 root.add(k.root);k.materials.grass.color.set('#adc98a');k.materials.jadeLight.color.set('#9abd86');
 const ground=group('Shared garden earth and rounded moss edge');
 function outline(rx,rz){const s=new T.Shape();for(let i=0;i<180;i++){const a=i/180*Math.PI*2,c=Math.cos(a),v=Math.sin(a),x=Math.sign(c)*Math.abs(c)**.58*rx,z=-4+Math.sign(v)*Math.abs(v)**.58*rz;i?s.lineTo(x,-z):s.moveTo(x,-z);}s.closePath();return s;}
 for(const[rx,rz,depth,y,bevel,color]of[[47,42,.22,-.2,.1,'honey'],[46.8,41.8,.10,.14,.02,'grass']]){
  const geometry=new T.ExtrudeGeometry(outline(rx,rz),{depth,bevelEnabled:true,bevelSize:bevel,bevelThickness:bevel,bevelSegments:3,curveSegments:4});geometry.rotateX(-Math.PI/2);mesh(ground,geometry,color,[0,y,0]);
 }
 const paths=group('Garden loop, entrance walks, and building landings');
 // Flat ribbons keep a continuous comfortable walk; seams and stones add warmth.
 function ribbon(points,width=1.6,color='paleWood'){
  const positions=[],indices=[];
  points.forEach((p,i)=>{const before=points[Math.max(0,i-1)],after=points[Math.min(points.length-1,i+1)],dx=after.x-before.x,dz=after.z-before.z,len=Math.hypot(dx,dz)||1;for(const side of[-1,1])positions.push(p.x+dz/len*width/2*side,GROUND+.022,p.z-dx/len*width/2*side);if(i<points.length-1){const v=i*2;indices.push(v,v+2,v+1,v+1,v+2,v+3);}});
  const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(positions,3));geometry.setIndex(indices);geometry.computeVertexNormals();mesh(paths,geometry,color);
 }
 walks.forEach(path=>ribbon(path,1.8));ribbon([{x:0,z:4.2},{x:0,z:2.45}],1.8);
 const connectors=places.filter(p=>p.id!=='bao').map(place=>({id:place.id,points:routeToWalk(place,places,walks)}));
 connectors.forEach(({points})=>{if(points)ribbon(points,1.45);});
 // The north-eastern garden extension is reached around the side of Tea & Pantry.
 const groveLane=[{x:11.8,z:-7.3},{x:10.5,z:-12},{x:10.5,z:-21.3},{x:14.1,z:-21.3},{x:16,z:-18.4}];ribbon(groveLane,1.45);
 const groveReturn=[{x:28.1,z:-16.4},{x:31,z:-17.1},{x:32,z:-10},{x:31,z:-3},{x:28.4,z:3},{x:27.7,z:10.5}];ribbon(groveReturn,1.25);
 for(const place of places.filter(p=>p.id!=='bao')){const at=door(place,.30);const landing=cyl(paths,.84,.035,[at.x,GROUND+.022,at.z],'stone');landing.scale.z=.70;}
 const welcome=group('Bao and Jiao’s welcome circle and small garden seats');
 const welcomeFurniture=[{id:'west-seat',position:[-3.8,GROUND+.20,.8],size:[1.06,.4,1.06]},{id:'east-seat',position:[3.8,GROUND+.20,.8],size:[1.06,.4,1.06]},{id:'tea-shelf',position:[0,GROUND+.45,-2.8],size:[1.35,.9,.69]}];
 cyl(welcome,4.2,.025,[0,GROUND+.015,-.6],'jadeLight');const ring=k.ring(welcome,4.24,.065,[0,GROUND+.04,-.6],'stone');ring.rotation.x=Math.PI/2;
 for(const seat of welcomeFurniture.slice(0,2)){const x=seat.position[0];cyl(welcome,.53,.25,[x,GROUND+.14,.8],'timber');box(welcome,[.93,.14,.80],[x,GROUND+.32,.8],'lilac',.10);}
 box(welcome,[1.35,.12,.69],[0,GROUND+.78,-2.8],'paleWood');for(const x of[-.48,.48])beam(welcome,[x,GROUND,-2.8],[x,GROUND+.72,-2.8],.045,'timber');teaSet(welcome,[0,GROUND+.85,-2.8],.75);
 for(const x of[-2.2,2.2])beam(welcome,[x,GROUND,-3.1],[x,3.6,-3.1],.07,'jadeDeep');tube(welcome,[[-2.2,3.6,-3.1],[0,3.85,-3.1],[2.2,3.6,-3.1]],.06,'jadeDeep');
 sign(welcome,'WELCOME TO THE DEN',[0,3.55,-3.02],3.2);for(const x of[-1.9,1.9])lantern(welcome,[x,3.47,-3.1],.70);
 const grounds=createGardenInfill({places,walks,connectors,extraWalks:[groveLane,groveReturn],ground:GROUND});root.add(grounds.root);
 const planting=group('Bamboo borders, soft stones, blossoms, and tiny discoveries');
 const protectedBoxes=[...places.map(p=>bounds(p,2.0)),...grounds.reserved];
 const clear=(x,z)=>!protectedBoxes.some(b=>x>b.x0&&x<b.x1&&z>b.z0&&z<b.z1)&&!walks.some(path=>path.some(p=>Math.hypot(p.x-x,p.z-z)<2.5))&&!connectors.some(({points})=>points?.some(p=>Math.hypot(p.x-x,p.z-z)<2.0));
 const bambooSites=[[-34,-18,1.8],[-31,-24,2.2],[-26,-25,1.7],[-16,-27,1.7],[-9,-27,2.0],[0,-29,1.7],[8,-28,1.9],[-35,-7,1.6],[-35,1,1.9],[-33,10,1.6],[-35,29,1.4],[-19,29,1.4],[-4,30,1.3],[16,30,1.6],[28,26,1.8],[39,20,1.9],[40,11,2.1],[39,2,1.8],[38,-10,1.6]];
 for(const[x,z,s]of bambooSites)if(clear(x,z)){bamboo(planting,[x,GROUND,z],s,false);bamboo(planting,[x+1.2,GROUND,z-.5],s*.83,false);}
 for(let i=0;i<53;i++){const a=i/53*Math.PI*2,x=40*Math.cos(a),z=-1+32*Math.sin(a);if(!clear(x,z)||z<-22)continue;orb(planting,.8,[x,GROUND+.08,z],'jadeLight',[1.6,.45,1]);if(i%2===0)flowers(planting,[x,GROUND+.35,z],i%3?'pink':'cream',1.5);}
 for(const[x,z,s]of[[-30,-4,1.3],[-8,-8,1.1],[9,-4,.8],[27,17,1.0],[-3,25,1.2],[21,27,1.0],[37,-4,1.4],[-37,16,1.3]])if(clear(x,z)){orb(planting,.67,[x,GROUND+.25,z],'stone',[1.4,.7,1]);orb(planting,.48,[x-.09,GROUND+.52,z],'jadeLight',[1.2,.13,.8]);}
 for(let i=0;i<12;i++){const a=i/12*Math.PI*2,x=18.4*Math.cos(a),z=13.6*Math.sin(a);if(!clear(x,z))continue;beam(planting,[x,GROUND,z],[x,2.15,z],.04,'timber');beam(planting,[x,2.15,z],[x+.38,2.15,z],.035,'timber');lantern(planting,[x+.34,2.10,z],.58);}
 bao(planting,[-3.2,GROUND+.13,7.9],.75);
 k.finish();
 root.updateMatrixWorld(true);
 const footprints=Object.entries(assets).map(([id,asset])=>{const b=new T.Box3().setFromObject(asset.root);return{id,min:b.min.toArray(),max:b.max.toArray()};});
 function setRoofs(visible){for(const asset of Object.values(assets)){asset.setRoofVisible?.(visible);asset.setShadeVisible?.(visible);}assets.library.setCutaway(!visible);}
 return{root,assets,landscape,westMountains,places,walks,connectors,footprints,ground,grounds,paths,planting,welcome,welcomeFurniture,
  setRoofs,
  worldPoint(id,point){return assets[id].root.localToWorld(new T.Vector3(...point));},
  dispose(){Object.values(assets).forEach(a=>a.dispose());westMountains.removeFromParent();landscape.dispose();grounds.dispose();k.dispose();root.removeFromParent();},
 };
}
