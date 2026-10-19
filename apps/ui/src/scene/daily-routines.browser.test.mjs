import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {buildLaunchOptions} from '../../../ci-cd/launch-options.mjs';
import {lightenScene} from '../../../ci-cd/light-scene.mjs';

// This tests the shipped frame loop and card wiring, with only rasterisation skipped.
// The user's separate moving-build review checks appearance with real WebGL draws.
test('the actual garden moves residents and koi, holds the selected identity, and respects reduced motion', {timeout:90000},async()=>{
 let server,browser;
 try{
  server=await createServer({configFile:'apps/ui/vite.config.mjs',configLoader:'native',server:{port:0,host:'127.0.0.1'},logLevel:'silent'});await server.listen();
  browser=await chromium.launch(buildLaunchOptions());const context=await browser.newContext({reducedMotion:'no-preference',viewport:{width:1200,height:800}});
  await lightenScene(context,{frameDelayMs:16});const page=await context.newPage(),errors=[],writes=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')writes.push(r.url());});
  const snapshot={schema:1,seq:1,tickets:[],frontier:[],usage:null,requests:[],agents:[],cells:[],meetings:[]};
  await page.route('**/events',r=>r.fulfill({contentType:'text/event-stream',body:`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`}));
  await page.route('**/state',r=>r.fulfill({json:snapshot}));await page.route('**/metrics',r=>r.fulfill({json:{throughput:{windows:[]},tokensByCell:{},incidentsByTool:{}}}));await page.route('**/session',r=>r.fulfill({status:404,json:{}}));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(()=>{const button=document.querySelector('.den-entry button');return button&&button.getAttribute('aria-disabled')!=='true';},null,{timeout:60000});
  const initial=await page.evaluate(async()=>{
   const fiber=performance.getEntriesByType('resource').find(r=>r.name.includes('/@react-three_fiber.js'));
   const {_roots}=await import(fiber.name);
   const scene=_roots.get(document.querySelector('canvas')).store.getState().scene;
   const world=scene.getObjectByName('Dim Sum Dev · plush bamboo garden');
   const pandas={};world.traverse(n=>{if(n.userData.actorKey)pandas[n.userData.actorKey]=n;});
   window.routineProbe={world,pandas,fish:[1,2,3].map(i=>world.getObjectByName('Tea garden koi '+i))};
   const outfits=Object.entries(pandas).map(([id,p])=>{
    const garment=p.getObjectByName('Shared-rig outfit'),skins=[];p.traverse(n=>{if(n.isSkinnedMesh)skins.push(n);});
    return {id,count:garment.children.length,shared:skins.every(n=>n.skeleton===skins[0].skeleton),textured:skins.some(n=>(Array.isArray(n.material)?n.material:[n.material]).some(m=>m.map))};
   });
   return {pandas:Object.fromEntries(Object.entries(pandas).map(([id,p])=>[id,p.position.toArray()])),fish:window.routineProbe.fish.map(f=>f.position.toArray()),outfits};
  });
  assert.equal(initial.fish.length,3);assert.equal(Object.keys(initial.pandas).length,25);
  assert.ok(initial.outfits.every(o=>o.count>0&&o.shared&&o.textured),'all actual residents retain textured outfits on their shared skeleton');
  await page.waitForFunction(before=>{
   const p=window.routineProbe;
   return p.fish.every((f,i)=>f.position.toArray().some((v,j)=>Math.abs(v-before.fish[i][j])>.02))&&Object.entries(p.pandas).some(([id,a])=>a.position.toArray().some((v,j)=>Math.abs(v-before.pandas[id][j])>.1));
  },initial,{timeout:15000});
  const walking=await page.evaluate(before=>{
   const {pandas}=window.routineProbe,id=Object.keys(pandas).find(id=>pandas[id].position.toArray().some((v,j)=>Math.abs(v-before[id][j])>.1)),p=pandas[id];
   const skins=[];p.traverse(n=>{if(n.isSkinnedMesh)skins.push(n);});
   window.routineProbe.walking={id,p,skins,shoulder:p.getObjectByName('Shoulder_L').quaternion.clone()};
   return {id,outfitMeshes:p.getObjectByName('Shared-rig outfit').children.length};
  },initial.pandas);
  assert.ok(walking.outfitMeshes>0);
  await page.waitForFunction(()=>{const w=window.routineProbe.walking;return w.p.getObjectByName('Shoulder_L').quaternion.angleTo(w.shoulder)>.02;},null,{timeout:10000});
  assert.ok(await page.evaluate(()=>window.routineProbe.walking.skins.every(mesh=>{
   const positions=mesh.geometry.attributes.position,point=mesh.position.clone();
   for(let i=0;i<positions.count;i+=Math.max(1,Math.floor(positions.count/40))){point.fromBufferAttribute(positions,i);mesh.applyBoneTransform(i,point);if(!point.toArray().every(Number.isFinite))return false;}
   return true;
  })),'body and actual outfit vertices stay finite during the assembled garden walk');
  const key=await page.evaluate(before=>{
   const {world,pandas}=window.routineProbe,key=Object.keys(pandas).find(id=>pandas[id].position.toArray().some((v,j)=>Math.abs(v-before[id][j])>.1));
   // Invoke the real scene pick handler; overview roofs can occlude a screen-coordinate click.
   world.__r3f.handlers.onClick({object:pandas[key],stopPropagation(){}});return key;
  },initial.pandas);
  const card=page.getByRole('region',{name:'Selected panda'});await card.waitFor();assert.match(await card.innerText(),/Resident · no agent running/);
  await page.waitForTimeout(200);const held=await page.evaluate(key=>window.routineProbe.pandas[key].position.toArray(),key);
  await page.waitForTimeout(350);assert.deepEqual(await page.evaluate(key=>window.routineProbe.pandas[key].position.toArray(),key),held);
  await page.getByRole('button',{name:'Close panda card'}).click();await card.waitFor({state:'hidden'});
  await page.waitForFunction(({key,held})=>window.routineProbe.pandas[key].position.toArray().some((v,j)=>Math.abs(v-held[j])>.03),{key,held});
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(200);
  const still=()=>page.evaluate(()=>({fish:window.routineProbe.fish.map(f=>[...f.position.toArray(),...f.children.find(n=>n.name.endsWith('tail')).quaternion.toArray()]),pandas:Object.values(window.routineProbe.pandas).map(p=>p.position.toArray())}));
  const paused=await still();await page.waitForTimeout(350);assert.deepEqual(await still(),paused);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.waitForFunction(before=>window.routineProbe.fish.some((f,i)=>f.position.toArray().some((v,j)=>Math.abs(v-before.fish[i][j])>.01)),paused);
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 }finally{await browser?.close();await server?.close();}
});
