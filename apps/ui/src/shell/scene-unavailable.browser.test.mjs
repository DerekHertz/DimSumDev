import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {buildLaunchOptions} from '../../../ci-cd/launch-options.mjs';
import {lightenScene} from '../../../ci-cd/light-scene.mjs';

test('36 an unplaceable visitor remains accessible in the mounted Team profile with its real working state',{timeout:90000},async()=>{
 let server,browser;
 try{
  server=await createServer({configFile:'apps/ui/vite.config.mjs',configLoader:'native',server:{port:0,host:'127.0.0.1'},logLevel:'silent'});await server.listen();
  browser=await chromium.launch(buildLaunchOptions());
  const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),errors=[],writes=[];
  await lightenScene(page);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!['GET','HEAD'].includes(r.method()))writes.push(r.url());});
  const snapshot={schema:1,seq:1,tickets:[],frontier:[],requests:[],agents:[{id:'one',role:'developer',ref:'work/one',state:'working'},{id:'two',role:'developer',ref:'work/two',state:'working'}],placements:[],meetings:[{id:'m/no-room',ref:'meeting/no-room',state:'running',seats:[{role:'developer'}]}],approvals:[]};
  await page.addInitScript(snapshot=>{window.EventSource=class{constructor(){this.listeners={};setTimeout(()=>{this.onopen?.();for(const fn of this.listeners.snapshot??[])fn({data:JSON.stringify(snapshot)});},0);}addEventListener(t,fn){(this.listeners[t]??=[]).push(fn);}close(){}};},snapshot);
  await page.route('**/src/scene/meshy/actors.mjs*',async route=>{
   const response=await route.fetch(),source=await response.text();
   // Keep actual controller/DOM code; only the route map is deliberately unavailable.
   await route.fulfill({response,body:source+'\nconst unavailableOriginal=createMeshyActors;createMeshyActors=function(den){const c=unavailableOriginal(den);den.walkWorld.navigation.groundAt=()=>null;return c;};\n'});
  });
  await page.route('**/state',r=>r.fulfill({json:snapshot}));await page.route('**/metrics',r=>r.fulfill({json:{throughput:{windows:[]},tokensByRole:{},incidentsByTool:{}}}));await page.route('**/session',r=>r.fulfill({status:404,json:{}}));
  await page.route(url=>url.pathname.startsWith('/meetings/'),r=>r.fulfill({json:{takes:[]}}));
  await page.goto(server.resolvedUrls.local[0]);
  await page.locator('[data-rail=team]').click();
  const choice=page.getByRole('button',{name:/, developer, Claude,.*visitor on work\/two/});await choice.click();
  const profile=page.locator('.forest-profile');
  await profile.getByText('Scene place unavailable',{exact:true}).waitFor({timeout:60000});
  assert.match(await profile.innerText(),/Working/);assert.match(await profile.innerText(),/work\/two/);
  assert.equal(await profile.getByRole('button',{name:/View work/}).isEnabled(),true,'scene availability does not gate real work');
  await page.getByRole('list',{name:'Residents and visitors'}).getByRole('button',{name:/, developer, Claude,/}).first().click();
  await profile.getByText('Meeting visitor · Scene place unavailable',{exact:true}).waitFor();
  assert.match(await profile.innerText(),/Working/);assert.match(await profile.innerText(),/work\/one/,'busy resident retains its independent run');
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 }finally{await browser?.close();await server?.close();}
});
