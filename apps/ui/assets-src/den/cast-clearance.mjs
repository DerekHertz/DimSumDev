// team-and-den-ux/35: CPU clearance for a cast character on its deformed triangles at the live scene scale, the method of
// bao-clearance.mjs (kept as is for Bao). For each of the character's homes (both runtimes), its desk and stool, the meeting
// table's seats and a navigation route to every home. node apps/ui/assets-src/den/cast-clearance.mjs <characterId> <out.json>
import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import * as T from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {readGlbGeometry} from './read-glb-geometry.mjs';
import {createPandaAppearanceFactory} from '../../src/scene/meshy/panda-appearance.mjs';
import {createLeisureGesture} from '../../src/scene/meshy/leisure-gesture.mjs';
import {createDenScene,GROUND} from '../../src/scene/meshy/plush/assembly.mjs';
import {residentHomes} from '../../src/scene/meshy/resident-homes.mjs';
import {createGardenNavigation} from '../../src/scene/meshy/garden-navigation.mjs';
import {gardenRoute} from '../../src/scene/meshy/garden-route.mjs';
import {historicalSeatSpots} from './historical-seats.mjs';
import {CAST_PROFILES} from '../../src/scene/meshy/cast-profiles.mjs';

const [id,out]=process.argv.slice(2),profile=CAST_PROFILES[id];
if(!profile||!out)throw Error('usage: node cast-clearance.mjs <characterId> <output.json>; ids: '+Object.keys(CAST_PROFILES).join(', '));
globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};
const publicRoot=new URL('../../public/',import.meta.url),manifest=JSON.parse(fs.readFileSync(new URL('den/manifest.json',publicRoot)));
const source=readGlbGeometry(gunzipSync(fs.readFileSync(new URL('.'+manifest.assets['characters.'+id].url,publicRoot))));
const factory=createPandaAppearanceFactory({characters:{[id]:source}}),garden=createDenScene(),world=createGardenNavigation(garden);
const runtimes=id==='jiao'?['codex']:['claude','codex'],gestures=[];
const box=(position,size)=>new T.Box3().setFromCenterAndSize(new T.Vector3(...position),new T.Vector3(...size));
const solids=[...garden.welcomeFurniture,{id:'meeting-table',position:[0,GROUND+.55,3.15],size:[4,1.1,2.35]}].map(s=>({id:s.id,box:box(s.position,s.size)}));
// Exact convex solids (outward planes) for the visible table and stool, so a conservative proxy corner is not a crossing.
function convex(geometry,at,scale=[1,1,1]){
 const mesh=new T.Mesh(geometry);mesh.position.copy(at);mesh.scale.fromArray(scale);mesh.updateMatrixWorld(true);
 const p=geometry.attributes.position,idx=geometry.index,planes=[];
 for(let i=0;i<(idx?.count??p.count);i+=3){const pts=[0,1,2].map(j=>new T.Vector3().fromBufferAttribute(p,idx?idx.getX(i+j):i+j).applyMatrix4(mesh.matrixWorld)),plane=new T.Plane().setFromCoplanarPoints(...pts);if(plane.normal.lengthSq()<.9)continue;if(plane.distanceToPoint(mesh.position)>0)plane.negate();if(!planes.some(q=>q.normal.distanceTo(plane.normal)<1e-5&&Math.abs(q.constant-plane.constant)<1e-5))planes.push(plane);}
 geometry.dispose();return planes;
}
function touches(triangle,planes){
 let points=[triangle.a,triangle.b,triangle.c];
 for(const plane of planes){const clipped=[];for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length],da=plane.distanceToPoint(a),db=plane.distanceToPoint(b);if(da<=1e-8)clipped.push(a);if((da<0)!==(db<0))clipped.push(a.clone().lerp(b,da/(da-db)));}points=clipped;if(!points.length)return false;}return true;
}
const tableParts=[[1,.13,[0,GROUND+1.04,3.15],[2,1,1.18]],[.09,.98,[-1.3,GROUND+.49,3.15],[1,1,1]],[.09,.98,[1.3,GROUND+.49,3.15],[1,1,1]]].map(([r,h,at,s])=>convex(new T.CylinderGeometry(r,r,h,16),new T.Vector3(...at),s));
const homes=residentHomes(garden),mine=homes.filter(h=>h.role===profile.role&&runtimes.includes(h.runtime));
// The desk probe: the character's own team bay for its role if the pavilion has one, else the Product bay (as Bao's probe).
const bayRoles={pass:['product','architect'],pantry:['qa','security'],front:['designer','herald']};
function workstation(home){
 const team=bayRoles[home.teamId]?.includes(home.role)?home.teamId:'pass',role=bayRoles[team].includes(home.role)?home.role:'product';
 const bay=garden.assets[team].bays[bayRoles[team].indexOf(role)],occupant=homes.find(h=>h.role===role&&h.runtime==='claude'),stool=bay.getObjectByName('Padded personal stool').getWorldPosition(new T.Vector3());
 const desk=[['top',[0,1.14,-.64],[3.48,.18,1.4]],['drawers',[1.13,.66,-.64],[.78,.73,1]],['stool-cushion',[.6,.39,1.64],[.8,.17,.75]],['stool-base',[.6,.22,1.64],[.84,.18,.84]]].map(([n,at,size])=>({id:n,box:box(bay.localToWorld(new T.Vector3(...at)).toArray(),size)}));
 const stoolParts=[[new T.CylinderGeometry(.42,.42,.18,16),.22],[new RoundedBoxGeometry(.8,.17,.75,2,.0408),.39]].map(([g,dy])=>convex(g,stool.clone().add(new T.Vector3(0,dy,0))));
 return {team,role,occupant,stool,desk,stoolParts};
}
const result={method:'Deformed indexed triangles versus furniture: conservative Box3 proxies for the welcome furniture and desk, exact convex planes for the table and stool seat.',character:id,role:profile.role,envelopes:profile.envelope,homes:[],seats:[],navigation:[]};
try{
 const poses=['idle','work','walk','sit','greeting','tea'];
 for(const home of mine){
  const {model,rig}=factory.createPanda(profile.role,{runtime:home.runtime}),gesture=createLeisureGesture(rig),ws=workstation(home);gestures.push(gesture);
  const geometry=()=>{model.updateMatrixWorld(true);const triangles=[],bounds=new T.Box3(),v=new T.Vector3();
   model.traverse(m=>{if(!m.isMesh)return;for(let a=m;a;a=a.parent)if(!a.visible)return;const p=m.geometry.attributes.position,idx=m.geometry.index,pts=[];
    for(let i=0;i<p.count;i++){v.fromBufferAttribute(p,i);if(m.isSkinnedMesh)m.applyBoneTransform(i,v);v.applyMatrix4(m.matrixWorld);pts.push(v.clone());bounds.expandByPoint(v);}
    for(let i=0;i<(idx?.count??p.count);i+=3)triangles.push(new T.Triangle(...[0,1,2].map(j=>pts[idx?idx.getX(i+j):i+j])));});return {triangles,bounds};};
  const pose=(kind,t)=>{gesture.pose(null,0);if(kind==='walk')rig.poseWaddle(t);else if(kind==='sit')rig.poseSit(t);else{rig.poseIdle(t);if(['greeting','tea'].includes(kind))gesture.pose(kind,t);}};
  const count=(triangles,list)=>list.map(s=>({id:s.id,triangles:triangles.filter(t=>s.box.intersectsTriangle(t)).length})).filter(s=>s.triangles);
  const row={runtime:home.runtime,position:home.position,scale:model.scale.x,furniture:[],desk:[],stool:[],floorMin:Infinity};
  for(const kind of poses)for(let frame=0;frame<13;frame++){
   const t=frame*.4;pose(kind,t);model.position.fromArray(home.position);model.rotation.y=home.yaw;
   const {triangles,bounds}=geometry();row.floorMin=Math.min(row.floorMin,bounds.min.y);
   row.furniture.push(...count(triangles,solids).map(s=>({kind,t,...s})));
   // Standing at the workstation's occupant spot, then sitting on its real stool at the floor anchor (no root lift).
   model.position.fromArray(ws.occupant.position);model.rotation.y=ws.occupant.yaw;pose(kind,t);
   row.desk.push(...count(geometry().triangles,ws.desk).map(s=>({kind,t,...s})));
  }
  for(let frame=0;frame<13;frame++){
   const t=frame*.4;rig.poseSit(t);model.position.set(ws.stool.x,ws.occupant.position[1],ws.stool.z);model.rotation.y=ws.occupant.yaw;
   const n=geometry().triangles.filter(tri=>ws.stoolParts.some(p=>touches(tri,p))).length;if(n)row.stool.push({t,triangles:n});
  }
  row.workstation={team:ws.team,role:ws.role};result.homes.push(row);
  // This historical acceptance fixture retains the legacy table and its seat ring.
  for(let n=1;n<=6;n++)for(const [seat,spot] of historicalSeatSpots(n).entries()){
   rig.poseSit(0,{reducedMotion:true});gesture.pose(null,0);model.position.set(spot.x,GROUND,spot.z);model.rotation.y=spot.yaw;
   const {triangles}=geometry(),crossings=triangles.filter(tri=>tableParts.some(p=>touches(tri,p))).length;
   if(home.runtime===mine[0].runtime||crossings)result.seats.push({runtime:home.runtime,count:n,seat,crossings,reachable:gardenRoute(world,{x:0,y:GROUND,z:6},spot).length>0});
  }
  const route=gardenRoute(world,{x:0,y:GROUND,z:6},{x:home.position[0],z:home.position[2]});
  result.navigation.push({runtime:home.runtime,ground:world.navigation.groundAt(home.position[0],home.position[2],home.position[1],.45),routeLength:route.length});
  factory.destroyPanda(model);
 }
 const sum=(rows,key)=>rows.reduce((n,r)=>n+r[key].reduce((m,x)=>m+x.triangles,0),0);
 result.summary={homes:result.homes.length,furnitureCrossings:sum(result.homes,'furniture'),deskCrossings:sum(result.homes,'desk'),stoolCrossings:sum(result.homes,'stool'),seatCrossings:result.seats.reduce((n,s)=>n+s.crossings,0),unreachableHomes:result.navigation.filter(n=>!n.routeLength||n.ground===null).length,unreachableSeats:result.seats.filter(s=>!s.reachable).length,lowestPoint:Math.min(...result.homes.map(h=>h.floorMin))};
 fs.writeFileSync(out,JSON.stringify(result,null,1)+'\n');console.log(JSON.stringify(result.summary));
}finally{gestures.forEach(g=>g.dispose());factory.dispose();garden.dispose();}
