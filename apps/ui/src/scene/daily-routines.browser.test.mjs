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
   return {pandas:Object.fromEntries(Object.entries(pandas).map(([id,p])=>[id,p.position.toArray()])),fish:window.routineProbe.fish.map(f=>f.position.toArray())};
  });
  assert.equal(initial.fish.length,3);assert.equal(Object.keys(initial.pandas).length,14);
  await page.waitForFunction(before=>{
   const p=window.routineProbe;
   return p.fish.every((f,i)=>f.position.toArray().some((v,j)=>Math.abs(v-before.fish[i][j])>.02))&&Object.entries(p.pandas).some(([id,a])=>a.position.toArray().some((v,j)=>Math.abs(v-before.pandas[id][j])>.1));
  },initial,{timeout:15000});
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
