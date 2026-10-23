// CPU clearance on the delivered, deformed triangles at current scene scale.
// node apps/ui/assets-src/den/bao-clearance.mjs <output.json> [--assert-chair]; bao-acceptance.test.mjs runs it.
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
import {seatSpots,TABLE} from '../../src/scene/meshy/meeting-table.mjs';

const historicalSeatSpots=count=>seatSpots(count).map(spot=>({...spot,x:spot.x-TABLE.x,z:spot.z-TABLE.z+3.15}));

globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};
const publicRoot=new URL('../../public',import.meta.url),manifest=JSON.parse(fs.readFileSync(new URL('./den/manifest.json',publicRoot+'/')));
const source=readGlbGeometry(gunzipSync(fs.readFileSync(new URL('.'+manifest.assets['characters.bao'].url,publicRoot+'/'))));
const factory=createPandaAppearanceFactory({characters:{bao:source}}),{model,rig}=factory.createPanda('orchestrator'),gesture=createLeisureGesture(rig),garden=createDenScene();
const home=residentHomes(garden).find(h=>h.id==='orchestrator'),world=createGardenNavigation(garden);
function geometry(){
 model.updateMatrixWorld(true);const triangles=[],bounds=new T.Box3(),v=new T.Vector3();
 model.traverse(m=>{if(!m.isMesh)return;for(let a=m;a;a=a.parent)if(!a.visible)return;
  const p=m.geometry.attributes.position,idx=m.geometry.index,points=[];
  for(let i=0;i<p.count;i++){v.fromBufferAttribute(p,i);if(m.isSkinnedMesh)m.applyBoneTransform(i,v);v.applyMatrix4(m.matrixWorld);points.push(v.clone());bounds.expandByPoint(v);}
  for(let i=0;i<(idx?.count??p.count);i+=3)triangles.push(new T.Triangle(...[0,1,2].map(j=>points[idx?idx.getX(i+j):i+j])));
 });return{triangles,bounds};
}
const box=(position,size)=>new T.Box3().setFromCenterAndSize(new T.Vector3(...position),new T.Vector3(...size));
// Current collision solids are conservative outer bounds of the actual furniture.
const solids=[...garden.welcomeFurniture,{id:'meeting-table',position:[0,GROUND+.55,3.15],size:[4,1.1,2.35]}].map(s=>({...s,box:box(s.position,s.size)}));
// Exact convex solids from world.mjs (the visible 16-sided tabletop and legs),
// used to resolve the navigation proxy's deliberately conservative corner hits.
const tableParts=[];
for(const [radius,height,position,scale]of [[1,.13,[0,GROUND+1.04,3.15],[2,1,1.18]],[.09,.98,[-1.3,GROUND+.49,3.15],[1,1,1]],[.09,.98,[1.3,GROUND+.49,3.15],[1,1,1]]]){
 const mesh=new T.Mesh(new T.CylinderGeometry(radius,radius,height,16));mesh.position.fromArray(position);mesh.scale.fromArray(scale);mesh.updateMatrixWorld(true);
 const p=mesh.geometry.attributes.position,idx=mesh.geometry.index,planes=[];
 for(let i=0;i<idx.count;i+=3){const points=[0,1,2].map(j=>new T.Vector3().fromBufferAttribute(p,idx.getX(i+j)).applyMatrix4(mesh.matrixWorld)),plane=new T.Plane().setFromCoplanarPoints(...points);if(plane.normal.lengthSq()<.9)continue;if(plane.distanceToPoint(mesh.position)>0)plane.negate();if(!planes.some(p=>p.normal.distanceTo(plane.normal)<1e-5&&Math.abs(p.constant-plane.constant)<1e-5))planes.push(plane);}
 tableParts.push(planes);mesh.geometry.dispose();mesh.material.dispose();
}
function touchesSolid(triangle,planes){
 let points=[triangle.a,triangle.b,triangle.c];
 for(const plane of planes){const clipped=[];for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length],da=plane.distanceToPoint(a),db=plane.distanceToPoint(b);if(da<=1e-8)clipped.push(a);if((da<0)!==(db<0))clipped.push(a.clone().lerp(b,da/(da-db)));}points=clipped;if(!points.length)return false;}return true;
}
const result={method:'Deformed indexed triangles versus current conservative furniture solids (Box3.intersectsTriangle); no vertex-only test. Negative clearance is an overlap candidate, never claimed clear.',home,scale:1.35,envelopes:rig.profile.envelope,host:[],authoringSeats:[],navigation:{},limitations:['Bao has no runtime desk or host chair; authoring seat probes do not create or validate a runtime host chair.','Navigation radius remains the current walker radius; wider actor path envelopes are checked separately.']};
try{
 for(const kind of ['idle','work','walk','sit','greeting','tea'])for(let frame=0;frame<25;frame++){
  const t=frame*.2;gesture.pose(null,0);if(kind==='walk')rig.poseWaddle(t);else if(kind==='sit')rig.poseSit(t);else{rig.poseIdle(t);if(['greeting','tea'].includes(kind))gesture.pose(kind,t);}
  model.position.fromArray(home.position);model.rotation.y=home.yaw;
  const {triangles,bounds}=geometry();
  const intersections=solids.map(s=>({id:s.id,triangles:triangles.filter(tri=>s.box.intersectsTriangle(tri)).length}));
  result.host.push({kind,t,bounds:{min:bounds.min.toArray(),max:bounds.max.toArray()},intersections});
 }
 // These are the existing table's seat coordinates, not a new Bao placement.
 for(let count=1;count<=6;count++)for(const [seat,spot]of historicalSeatSpots(count).entries()){
  rig.poseSit(0,{reducedMotion:true});gesture.pose(null,0);model.position.set(spot.x,GROUND,spot.z);model.rotation.y=spot.yaw;
  const {triangles,bounds}=geometry(),table=solids.find(s=>s.id==='meeting-table');
  result.authoringSeats.push({count,seat,spot,proxyOverlapTriangles:triangles.filter(tri=>table.box.intersectsTriangle(tri)).length,tableOverlapTriangles:triangles.filter(tri=>tableParts.some(planes=>touchesSolid(tri,planes))).length,bounds:{min:bounds.min.toArray(),max:bounds.max.toArray()}});
 }
 // Existing Product workstation, as an authoring probe only: Bao's runtime
 // anchor remains at the welcome circle. Include its actual desk and stool.
 const product=residentHomes(garden).find(h=>h.id==='product'),bay=garden.assets.pass.bays[0];
 const deskSolids=[['top',[0,1.14,-.64],[3.48,.18,1.4]],['drawers',[1.13,.66,-.64],[.78,.73,1]],['stool-cushion',[.6,.39,1.64],[.8,.17,.75]],['stool-base',[.6,.22,1.64],[.84,.18,.84]]].map(([id,at,size])=>({id,box:box(bay.localToWorld(new T.Vector3(...at)).toArray(),size)}));
 result.authoringDesk=[];
 for(const pose of ['work','sit']){gesture.pose(null,0);if(pose==='sit')rig.poseSit(0);else rig.poseIdle(0);model.position.fromArray(product.position);model.rotation.y=product.yaw;const{triangles,bounds}=geometry();result.authoringDesk.push({pose,at:product.position,yaw:product.yaw,bounds:{min:bounds.min.toArray(),max:bounds.max.toArray()},overlapCandidates:deskSolids.map(s=>({id:s.id,triangles:triangles.filter(tri=>s.box.intersectsTriangle(tri)).length}))});}
 // A resident's standing home is not its stool's seat transform. Measure the
 // real stool center separately, against its visible convex meshes, rather
 // than interpreting proximity to the stool as a chair-fitting failure.
 const stool=bay.getObjectByName('Padded personal stool'),stoolCenter=stool.getWorldPosition(new T.Vector3()),chairParts=[];
 for(const [geometry,dy]of [[new T.CylinderGeometry(.42,.42,.18,16),.22],[new RoundedBoxGeometry(.8,.17,.75,2,.0408),.39]]){
  const mesh=new T.Mesh(geometry);mesh.position.copy(stoolCenter).add(new T.Vector3(0,dy,0));mesh.updateMatrixWorld(true);const p=geometry.attributes.position,idx=geometry.index,planes=[];
  for(let i=0;i<(idx?.count??p.count);i+=3){const points=[0,1,2].map(j=>new T.Vector3().fromBufferAttribute(p,idx?idx.getX(i+j):i+j).applyMatrix4(mesh.matrixWorld)),plane=new T.Plane().setFromCoplanarPoints(...points);if(plane.normal.lengthSq()<.9)continue;if(plane.distanceToPoint(mesh.position)>0)plane.negate();if(!planes.some(p=>p.normal.distanceTo(plane.normal)<1e-5&&Math.abs(p.constant-plane.constant)<1e-5))planes.push(plane);}chairParts.push(planes);geometry.dispose();mesh.material.dispose();
 }
 result.authoringChair=[];
 for(const anchorHeight of [product.position[1],product.position[1]+.1,product.position[1]+.2]){
  rig.poseSit(0,{reducedMotion:true});model.position.set(stoolCenter.x,anchorHeight,stoolCenter.z);model.rotation.y=product.yaw;const{triangles,bounds}=geometry(),seatTop=stoolCenter.y+.475,ray=new T.Ray(new T.Vector3(stoolCenter.x,seatTop,stoolCenter.z),new T.Vector3(0,1,0)),hit=new T.Vector3();let seatGap=Infinity;
  for(const tri of triangles)if(ray.intersectTriangle(tri.a,tri.b,tri.c,false,hit))seatGap=Math.min(seatGap,hit.y-seatTop);
  result.authoringChair.push({anchor:model.position.toArray(),stoolTop:seatTop,seatCenterUpwardSurfaceGap:Number.isFinite(seatGap)?seatGap:null,actualSolidCrossingTriangles:triangles.filter(t=>chairParts.some(planes=>touchesSolid(t,planes))).length,lowestVertex:bounds.min.y,tableProxyCrossingTriangles:triangles.filter(t=>deskSolids[0].box.intersectsTriangle(t)).length});
 }
 result.seatedContactCycle=[];
 for(let frame=0;frame<25;frame++){
  const time=frame*.2,drop=rig.profile.sit.drop;model.position.set(stoolCenter.x,product.position[1],stoolCenter.z);rig.poseSit(time);const{triangles,bounds}=geometry(),crossings=triangles.filter(t=>chairParts.some(planes=>touchesSolid(t,planes))).length;
  // A positive contact test: a 0.000135 world-unit pelvis nudge toward the
  // cushion must cross it. This rejects a superficially clear floating pose.
  rig.profile.sit.drop=drop+.0001;rig.poseSit(time);const nudged=geometry();rig.profile.sit.drop=drop;
  result.seatedContactCycle.push({time,crossings,contactNudgeWorld:.000135,nudgedCrossings:nudged.triangles.filter(t=>chairParts.some(planes=>touchesSolid(t,planes))).length,floor:bounds.min.y,top:bounds.max.y});
 }
 result.chairPlacementSearch=[];
 for(const dx of [-.2,-.1,0,.1,.2])for(const dz of [-.3,-.2,-.1,0,.1,.2,.3]){
  model.position.set(stoolCenter.x+dx,product.position[1],stoolCenter.z+dz);const{triangles}=geometry(),seatTop=stoolCenter.y+.475,ray=new T.Ray(new T.Vector3(stoolCenter.x,seatTop,stoolCenter.z),new T.Vector3(0,1,0)),hit=new T.Vector3();let gap=Infinity;
  for(const tri of triangles)if(ray.intersectTriangle(tri.a,tri.b,tri.c,false,hit))gap=Math.min(gap,hit.y-seatTop);
  const crossing=triangles.filter(t=>chairParts.some(planes=>touchesSolid(t,planes))).length;
  result.chairPlacementSearch.push({dx,dz,crossing,seatCenterUpwardSurfaceGap:Number.isFinite(gap)?gap:null});
 }
 if(process.argv.includes('--search-chair')){
  const original={...rig.profile.sit};result.chairPoseSearch=[];
  for(const hip of [1.1,1.3,1.5])for(const knee of [-.1,-.3,-.5])for(const splay of [.5,.7,.9]){
   Object.assign(rig.profile.sit,{hip,knee,splay});rig.poseSit(0,{reducedMotion:true});model.position.set(stoolCenter.x,product.position[1],stoolCenter.z);model.rotation.y=product.yaw;const{triangles,bounds}=geometry(),seatTop=stoolCenter.y+.475,ray=new T.Ray(new T.Vector3(stoolCenter.x,seatTop,stoolCenter.z),new T.Vector3(0,1,0)),hit=new T.Vector3();let gap=Infinity;
   for(const tri of triangles)if(ray.intersectTriangle(tri.a,tri.b,tri.c,false,hit))gap=Math.min(gap,hit.y-seatTop);
   result.chairPoseSearch.push({hip,knee,splay,perPart:chairParts.map(planes=>triangles.filter(t=>touchesSolid(t,planes)).length),gap:Number.isFinite(gap)?gap:null,floor:bounds.min.y});
  }Object.assign(rig.profile.sit,original);
  let clearDrop=.04,collisionDrop=.06;
  for(let step=0;step<18;step++){
   const drop=(clearDrop+collisionDrop)/2;rig.profile.sit.drop=drop;rig.poseSit(0,{reducedMotion:true});model.position.set(stoolCenter.x,product.position[1],stoolCenter.z);const{triangles}=geometry();
   if(triangles.some(t=>chairParts.some(planes=>touchesSolid(t,planes))))collisionDrop=drop;else clearDrop=drop;
  }
  result.chairContactFit={clearDrop,collisionDrop,maximumSupportSeparationBound:(collisionDrop-clearDrop)*1.35,method:'Bisection of deformed surface contact with actual convex cushion; fixed stool center and floor anchor, no root lift or horizontal escape.'};Object.assign(rig.profile.sit,original);
  result.chairDropSearch=[];
  for(const drop of [0,.02,.04,.06,.08,.1,.12]){
   rig.profile.sit.drop=drop;rig.poseSit(0,{reducedMotion:true});model.position.set(stoolCenter.x,product.position[1],stoolCenter.z);const{triangles,bounds}=geometry(),seatTop=stoolCenter.y+.475,hit=new T.Vector3();let supportGap=Infinity;
   for(const dx of [-.34,-.17,0,.17,.34])for(const dz of [-.31,-.155,0,.155,.31]){const ray=new T.Ray(new T.Vector3(stoolCenter.x+dx,seatTop,stoolCenter.z+dz),new T.Vector3(0,1,0));for(const t of triangles)if(ray.intersectTriangle(t.a,t.b,t.c,false,hit))supportGap=Math.min(supportGap,hit.y-seatTop);}
   result.chairDropSearch.push({drop,perPart:chairParts.map(planes=>triangles.filter(t=>touchesSolid(t,planes)).length),supportGap:Number.isFinite(supportGap)?supportGap:null,floor:bounds.min.y,top:bounds.max.y});
  }Object.assign(rig.profile.sit,original);
 }
 model.position.fromArray(home.position);model.rotation.y=home.yaw;rig.poseIdle(0);const conversationGeometry=geometry(),visitorPosition=[-4.6,GROUND,-.6],visitorBox=box([visitorPosition[0],GROUND+.91,visitorPosition[2]],[.52,1.82,.52]);
 result.conversation={visitorPosition,bodyOverlapTriangles:conversationGeometry.triangles.filter(tri=>visitorBox.intersectsTriangle(tri)).length,ground:world.navigation.groundAt(visitorPosition[0],visitorPosition[2],GROUND,.26),route:gardenRoute(world,{x:0,y:GROUND,z:6},{x:visitorPosition[0],z:visitorPosition[2]})};
 result.navigation.hostGround=world.navigation.groundAt(home.position[0],home.position[2],home.position[1],.45);
 result.navigation.routeToHost=gardenRoute(world,{x:0,y:GROUND,z:6},{x:home.position[0],z:home.position[2]});
 result.navigation.seats=historicalSeatSpots(6).map(s=>({...s,ground:world.navigation.groundAt(s.x,s.z,GROUND,.45),route:gardenRoute(world,{x:0,y:GROUND,z:6},s)}));
 result.summary={hostCollisionSamples:result.host.filter(p=>p.intersections.some(s=>s.triangles)).map(p=>({kind:p.kind,t:p.t,intersections:p.intersections.filter(s=>s.triangles)})),authoringSeatCollisionProbes:result.authoringSeats.filter(s=>s.tableOverlapTriangles),authoringDesk:result.authoringDesk,authoringChair:result.authoringChair,conversation:result.conversation,hostNavigationReachable:result.navigation.routeToHost.length>0};
 const out=process.argv[2];if(!out||out.startsWith('--'))throw Error('usage: node bao-clearance.mjs <output.json> [--assert-chair|--search-chair]');
 fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result.chairContactFit||result.summary,null,2));
 if(process.argv.includes('--assert-chair')&&result.authoringChair[0].actualSolidCrossingTriangles)throw Error('Bao seated mesh penetrates the actual stool: '+result.authoringChair[0].actualSolidCrossingTriangles+' crossing triangles');
 if(process.argv.includes('--assert-chair')&&result.seatedContactCycle.some(p=>p.crossings||!p.nudgedCrossings||p.floor<product.position[1]))throw Error('Bao chair contact/floor cycle failed');
}finally{gesture.dispose();factory.dispose();garden.dispose();}
