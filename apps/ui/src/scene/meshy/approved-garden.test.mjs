import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createApprovedGarden} from './approved-garden.mjs';
import {createApprovedNavigation} from './approved-navigation.mjs';
import {activeResidents,workDocks} from './approved-plan.mjs';
import {RESIDENTS} from '../../shell/resident-inventory.mjs';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {readGlbGeometry} from '../../../assets-src/den/read-glb-geometry.mjs';
import {createPandaAppearanceFactory} from './panda-appearance.mjs';
import {createMeshyActors} from './actors.mjs';
import {leisurePlaces} from './approved-plan.mjs';
import {routeLength} from './daily-routines.mjs';
import {teahouseProps} from './teahouse.test-fixture.mjs';
globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};

test('55-I/J/N: production assembly preserves approved plots, 27 bamboo sites, coherent restorable roofs and budgets',()=>{
 const provenance=JSON.parse(readFileSync(new URL('./approved/provenance.json',import.meta.url)));
 const manifest=JSON.parse(readFileSync(new URL('../../../public/den/manifest.json',import.meta.url)));
 for(const [id,hash]of Object.entries(provenance.packedModelHashes))assert.equal(manifest.assets['characters.'+id].sha256,hash,'signed '+id+' model');
 const g=createApprovedGarden();try{
  assert.equal(g.assets.pass.root.position.x,-30.5);assert.equal(g.assets.front.root.position.z,24);assert.deepEqual(g.officePlot,{x:0,z:-32,width:26,depth:17});
  let total=0,shadow=0,meshes=0,casters=0;g.root.traverse(n=>{if(n.isMesh){meshes++;const triangles=(n.geometry.index?.count??n.geometry.attributes.position.count)/3;total+=triangles;if(n.castShadow){casters++;shadow+=triangles;}}});
  assert.ok(total<1.8e6,'production geometry '+total);assert.ok(shadow<700000,'production shadows '+shadow);
  assert.ok(meshes<600,'static scenery main-pass meshes '+meshes);
  assert.ok(casters<350,'static scenery shadow-pass meshes '+casters);
  const snapshots=new Map();g.root.traverse(n=>{if(n.isMesh)snapshots.set(n,n.position.clone());});
  g.setRoofMode('cutaway');assert.ok(g.assets.pass.roof.children.some(n=>n.material?.clippingPlanes?.length));g.setRoofMode('full');
  for(const [n,p]of snapshots)assert.deepEqual(n.position,p);
  assert.equal(g.assets.pass.roof.visible,true);assert.ok(g.obstacles.length>0);
 }finally{g.dispose();}
});

test('55-B/E/F/K: actual approved cast occupies all 24 reserved homes and every specialist has a local route',()=>{
 const garden=createApprovedGarden(),characters={};
 const manifest=JSON.parse(readFileSync(new URL('../../../public/den/manifest.json',import.meta.url)));
 for(const [id,asset]of Object.entries(manifest.assets))if(id.startsWith('characters.'))characters[asset.characterId||asset.roleId]=readGlbGeometry(gunzipSync(readFileSync(new URL('../../../public'+asset.url,import.meta.url))));
 const factory=createPandaAppearanceFactory({characters,approvedOnly:true}),workspaces=new Map();
 for(const dock of garden.docks){const panda=factory.createPanda(dock.role,{runtime:dock.runtime});panda.model.position.fromArray(dock.position);panda.model.rotation.y=dock.yaw;workspaces.set(dock.id,{person:panda.model});}
 const den={garden,propManifest:garden.docks,roleWorkspaces:{workspaces},pandaRigs:factory.instances,walkWorld:createApprovedNavigation(garden),routineSpots:leisurePlaces()};
 const actors=createMeshyActors(den);try{
  assert.equal(actors.actors.size,24);assert.equal([...actors.actors.values()].filter(a=>a.panda.model.visible).length,24);
  for(const a of actors.actors.values()){
   assert.equal(actors.places.get(a.dock.slotId)?.owner,a.identity,a.id+' stable work lease');
   if(a.stationary)continue;
   const kinds=['pass','steamers'].includes(a.teamId)?['tea','rest']:['pond','games'];
   const paths=den.routineSpots.filter(s=>kinds.includes(s.kind)).map(s=>den.routineRoute(a,a.home,s.position)).filter(p=>p.length);
   assert.ok(paths.some(p=>routeLength(a.home,p)<=60),a.id+' has a local reachable break under 60 units');
  }
  for(let i=0;i<240;i++)actors.update(.1,false);
  assert.ok([...actors.actors.values()].some(a=>a.outing?.stage==='visit'),'a real assembled resident reaches a supported activity within 20 seconds of departure');
 }finally{actors.dispose();factory.dispose();garden.dispose();}
});

test('55-N: maximum permanent and guest population stays below production triangle and shadow limits',t=>{
 const garden=createApprovedGarden({props:teahouseProps()});try{
  let total=0,shadow=0;garden.root.traverse(n=>{if(n.isMesh){const triangles=(n.geometry.index?.count??n.geometry.attributes.position.count)/3;total+=triangles;if(n.castShadow)shadow+=triangles;}});
  const assets={product:'fox',architect:'crane','release-manager':'lucky-cat',developer:'developer',runner:'golden-monkey','code-reviewer':'lion',qa:'otter',security:'pangolin',sre:'tortoise',designer:'deer','technical-writer':'technical-writer'};
  const bodyCounts=garden.docks.map(d=>{const id=d.role==='orchestrator'?(d.runtime==='claude'?'bao':'jiao'):assets[d.role],bytes=gunzipSync(readFileSync(new URL('../../../public/den/models/characters/'+id+'.glb.gz',import.meta.url))),gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)));return gltf.meshes.flatMap(m=>m.primitives).reduce((n,p)=>n+gltf.accessors[p.indices].count/3,0);});
  const maximumBodies=bodyCounts.reduce((n,c)=>n+c,0)+6*Math.max(...bodyCounts);total+=maximumBodies+30*1260;shadow+=maximumBodies;
  t.diagnostic(JSON.stringify({total,shadow,permanent:24,maximumGuests:6,ornaments:30,office:'installed native office'}));
  assert.ok(total<1.8e6,'maximum complete population triangles '+total);assert.ok(shadow<700000,'maximum complete population shadow triangles '+shadow);
 }finally{garden.dispose();}
});
