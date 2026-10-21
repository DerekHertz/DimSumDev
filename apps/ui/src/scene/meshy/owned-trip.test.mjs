import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import * as T from 'three';
import {createDenScene} from './plush/assembly.mjs';
import {createGardenNavigation} from './garden-navigation.mjs';
import {residentHomes} from './resident-homes.mjs';
import {createPandaAppearanceFactory} from './panda-appearance.mjs';
import {fitRoleAsset} from './role-wardrobe.mjs';
import {createMeshyActors} from './actors.mjs';
import {gardenRoutineSpots} from './daily-routines.mjs';
import {routeSegment} from './garden-route.mjs';
import {gardenClearanceOracle} from './test-fixtures/place-clearance.mjs';
import {occupiedVertices} from './test-fixtures/occupied-vertices.mjs';

globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};

// Read the shipped single-mesh GLBs, retaining exact vertices. Texture decoding
// is unnecessary for swept-body navigation; production fitting/rigging is used.
function shippedSource(id){
 const assets=JSON.parse(readFileSync(new URL('../../../public/den/manifest.json',import.meta.url),'utf8')).assets;
 const bytes=gunzipSync(readFileSync(new URL('../../../public'+assets[id].url,import.meta.url)));
 const length=bytes.readUInt32LE(12),gltf=JSON.parse(bytes.subarray(20,20+length)),bin=bytes.subarray(28+length);
 assert.equal(gltf.meshes.length,1);assert.equal(gltf.meshes[0].primitives.length,1);
 const attribute=index=>{
  const accessor=gltf.accessors[index],view=gltf.bufferViews[accessor.bufferView],width={SCALAR:1,VEC2:2,VEC3:3}[accessor.type],Type={5126:Float32Array,5123:Uint16Array,5125:Uint32Array}[accessor.componentType];
  const offset=(view.byteOffset??0)+(accessor.byteOffset??0),data=bin.subarray(offset,offset+accessor.count*width*Type.BYTES_PER_ELEMENT);
  return new T.BufferAttribute(new Type(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)),width);
 };
 const primitive=gltf.meshes[0].primitives[0],geometry=new T.BufferGeometry();
 for(const [key,name]of [['POSITION','position'],['NORMAL','normal'],['TEXCOORD_0','uv']])if(primitive.attributes[key]!==undefined)geometry.setAttribute(name,attribute(primitive.attributes[key]));
 geometry.setIndex(attribute(primitive.indices));
 const source=new T.Group();source.add(new T.Mesh(geometry,new T.MeshStandardMaterial()));return source;
}

test('36 a shipped resident makes a reserved real-booth tea trip and returns through the assembled crowded garden',()=>{
 const garden=createDenScene(),sources=['bao','wardrobe.developer-vest','wardrobe.qa-scarf','wardrobe.developer-headphones','characters.developer','characters.technical-writer'].map(shippedSource);
 const [body,vestSource,scarfSource,headphonesSource,developer,writer]=sources;
 const vest=fitRoleAsset(vestSource,'developer-vest'),scarf=fitRoleAsset(scarfSource,'qa-scarf'),headphones=fitRoleAsset(headphonesSource,'developer-headphones'),securityVest=fitRoleAsset(vestSource,'security-vest');
 const appearances=createPandaAppearanceFactory({body,vest,scarf,headphones,securityVest,characters:{developer,'technical-writer':writer}});
 const den={residents:new T.Group(),propManifest:residentHomes(garden),roleWorkspaces:{workspaces:new Map()},walkWorld:createGardenNavigation(garden),routineSpots:gardenRoutineSpots(garden).filter(s=>s.id==='tea'),walkStart:{x:0,z:34,groundY:.26},pandaRigs:appearances.instances,createPanda:appearances.createPanda,destroyPanda:appearances.destroyPanda};
 let actors;
 try{
  for(const home of den.propManifest){const panda=den.createPanda(home.role,{runtime:home.runtime});panda.model.position.fromArray(home.position);panda.model.rotation.y=home.yaw;den.residents.add(panda.model);den.roleWorkspaces.workspaces.set(home.id,{person:panda.model});}
  const allocationStarted=performance.now();actors=createMeshyActors(den);const allocationMs=performance.now()-allocationStarted,a=actors.actors.get('qa'),home=a.home.clone();
  const physical=gardenClearanceOracle(garden);
  const outcome=a=>({id:a.id,identity:a.identity,visible:a.panda.model.visible,homePlace:a.homePlace,homeOwner:actors.places.get(a.homePlace)?.owner??null,status:a.travel?.status??'home',presentation:a.presentation});
  const assertOwned=a=>{if(a.panda.model.visible)assert.equal(actors.places.get(a.homePlace)?.owner,a.identity,'visible resident owns its home '+a.id);else{assert.match(a.presentation,/unavailable/i);assert.equal(a.homePlace,null);assert.equal([...actors.places.values()].some(p=>p.owner===a.identity),false);}};
  let measuredVertices=0;
  const assertRendered=a=>{const measured=occupiedVertices(a);assert.deepEqual(measured.unsupported,[],a.id+' supported rendered geometry');assert.ok(measured.vertices>0);assert.ok(measured.radius<=a.envelope.radius+1e-6,a.id+' actual deformed radius');assert.ok(measured.height<=a.envelope.height+1e-6,a.id+' actual deformed height');measuredVertices+=measured.vertices;};
  console.log('36 allocation '+JSON.stringify({allocationMs,actors:actors.actors.size,visible:[...actors.actors.values()].filter(a=>a.panda.model.visible).length,outcomes:[...actors.actors.values()].map(outcome)}));
  assert.equal(actors.actors.size,32);
  for(const resident of actors.actors.values()){assertOwned(resident);if(resident.panda.model.visible){physical.assertClear(resident.panda.model.position,resident.envelope);assertRendered(resident);}}
  for(const b of actors.actors.values())if(b!==a)b.live={state:'working'};
  let visited=false,departed=false,returned=false,steps=0,length=0,minSeparation=Infinity,tripUpdateMs=0,measuredWalking=false,measuredVisit=false;const tripStarted=performance.now();
  for(let i=0;i<5000&&!returned;i++){
   const before=a.panda.model.position.clone(),updateStarted=performance.now();actors.update(.1);tripUpdateMs+=performance.now()-updateStarted;const p=a.panda.model.position,step=Math.hypot(p.x-before.x,p.z-before.z);
   assert.ok(step<=.0780001,'ordinary travel never teleports');
   if(step){steps++;length+=step;departed=true;assert.notEqual(routeSegment(den.walkWorld,before,p,a.envelope),null,'every travelled segment fits model and props');}
   if(step&&!measuredWalking){assertRendered(a);measuredWalking=true;}
   physical.assertClear(p,a.envelope);
   assert.equal(actors.places.get(a.homePlace).owner,a.identity,'home stays reserved throughout');
   for(const b of actors.actors.values())if(b!==a&&b.panda.model.visible){const gap=Math.hypot(p.x-b.panda.model.position.x,p.z-b.panda.model.position.z)-a.envelope.radius-b.envelope.radius;minSeparation=Math.min(minSeparation,gap);assert.ok(gap>=-.001,'moving body never overlaps another resident');}
   if(a.routine?.stage==='visit'){visited=true;if(!measuredVisit){assertRendered(a);measuredVisit=true;}const place=actors.places.get(a.travel.placeId);assert.equal(place.owner,a.identity);assert.equal(place.occupied,true);assert.ok(Math.hypot(p.x-place.position.x,p.z-place.position.z)<.02);}
   returned=visited&&!a.routine&&p.distanceTo(home)<.02;
  }
  assert.equal(departed,true);assert.equal(visited,true);assert.equal(returned,true);
  console.log('36 assembled trip '+JSON.stringify({actor:a.id,envelope:a.envelope,home:home.toArray(),actors:actors.actors.size,visible:[...actors.actors.values()].filter(a=>a.panda.model.visible).length,allocationMs,tripMs:performance.now()-tripStarted,tripUpdateMs,steps,length,minSeparation}));
  den.routineSpots.length=0;
  const roles=['developer','qa','product','architect','security','technical-writer'];
  const rows=roles.map((role,i)=>({role,runtime:'claude',projectId:'synthetic36',agentId:'run-'+i,ref:'work/'+i,state:'working'}));
  rows.push(...roles.slice(0,4).map((role,i)=>({role,runtime:'claude',projectId:'synthetic36',agentId:'visitor-'+i,ref:'visitor/'+i,state:'working'})));
  const crowdAllocationStarted=performance.now();actors.applyLive(rows);actors.applyMeeting({id:'crowd36',ref:'meeting/36',state:'running',seats:roles.map(role=>({role}))});const crowdAllocationMs=performance.now()-crowdAllocationStarted;
  assert.equal(actors.actors.size,42);let crowdClearance=Infinity,crowdUpdateMs=0;const crowdStarted=performance.now();
  for(let step=0;step<800;step++){
   const updateStarted=performance.now();actors.update(.1);crowdUpdateMs+=performance.now()-updateStarted;const visible=[...actors.actors.values()].filter(a=>a.panda.model.visible);
   for(const actor of actors.actors.values())assertOwned(actor);
   for(const actor of visible)physical.assertClear(actor.panda.model.position,actor.envelope);
   for(let i=0;i<visible.length;i++)for(let j=i+1;j<visible.length;j++){
    const a=visible[i],b=visible[j],gap=Math.hypot(a.panda.model.position.x-b.panda.model.position.x,a.panda.model.position.z-b.panda.model.position.z)-a.envelope.radius-b.envelope.radius;
    crowdClearance=Math.min(crowdClearance,gap);assert.ok(gap>=-.001,'concurrent arrivals and meeting copies remain distinct');
   }
   for(const a of visible)if(a.travel?.status==='arrived'){
    const place=actors.places.get(a.travel.placeId);assert.equal(place.owner,a.identity);assert.equal(place.occupied,true);assert.ok(Math.hypot(a.panda.model.position.x-place.position.x,a.panda.model.position.z-place.position.z)<.02,'arrived always names a physically reached owned place');
   }
  }
  for(const actor of actors.actors.values())if(actor.panda.model.visible)assertRendered(actor);
  console.log('36 assembled crowd '+JSON.stringify({actors:actors.actors.size,visitors:[...actors.actors.values()].filter(a=>a.visitor).length,guests:[...actors.actors.values()].filter(a=>a.guest).length,crowdAllocationMs,crowdMs:performance.now()-crowdStarted,crowdUpdateMs,minSeparation:crowdClearance,measuredVertices,outcomes:[...actors.actors.values()].map(outcome),states:[...actors.actors.values()].filter(a=>a.visitor||a.guest).map(a=>({id:a.id,status:a.travel?.status??'home',presentation:a.presentation}))}));
  const removed=[...actors.actors.values()].filter(a=>a.visitor).map(a=>a.identity);actors.applyLive([]);
  for(const owner of removed)assert.equal([...actors.places.values()].some(p=>p.owner===owner),false,'ended visitor leaves no leases');
 }finally{
  actors?.dispose();appearances.dispose();garden.dispose();
  const geometries=new Set(),materials=new Set();for(const root of [...sources,vest,scarf,headphones,securityVest,appearances.outfits])root.traverse(n=>{if(n.geometry)geometries.add(n.geometry);for(const material of Array.isArray(n.material)?n.material:[n.material])if(material)materials.add(material);});for(const g of geometries)g.dispose();for(const m of materials)m.dispose();
 }
});
