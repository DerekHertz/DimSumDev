import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {buildLaunchOptions} from '../../../ci-cd/launch-options.mjs';
import {lightenScene} from '../../../ci-cd/light-scene.mjs';

test('actual live garden and keyboard roster expose both crews while Codex actions stay unavailable',{timeout:180000},async t=>{
 let server,browser;
 try{
  server=await createServer({configFile:'apps/ui/vite.config.mjs',configLoader:'native',server:{port:0,host:'127.0.0.1'},logLevel:'silent'});await server.listen();
  browser=await chromium.launch(buildLaunchOptions());
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[],writes=[];
  // Pixel evidence uses real draws. CI asserts the same mounted world and actions
  // without spending its two cores on unasserted SwiftShader rasterisation.
  await lightenScene(page,{skipDraws:!process.env.RESIDENT_EVIDENCE_DIR,frameDelayMs:250});
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')writes.push(r.url());});
  const snapshot={schema:1,seq:1,tickets:[],frontier:[],usage:null,requests:[],agents:[],placements:[],meetings:[]};
  await page.route('**/events',r=>r.fulfill({contentType:'text/event-stream',body:`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`}));
  await page.route('**/state',r=>r.fulfill({json:snapshot}));await page.route('**/metrics',r=>r.fulfill({json:{throughput:{windows:[]},tokensByRole:{},incidentsByTool:{}}}));await page.route('**/session',r=>r.fulfill({status:404,json:{}}));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(()=>{const button=document.querySelector('.den-entry button');return button&&button.getAttribute('aria-disabled')!=='true';},null,{timeout:60000});
  const world=await page.evaluate(async()=>{
   const fiber=performance.getEntriesByType('resource').find(r=>r.name.includes('/@react-three_fiber.js'));
   const {_roots}=await import(fiber.name),state=_roots.get(document.querySelector('canvas')).store.getState();
   const world=state.scene.getObjectByName('Dim Sum Dev · plush bamboo garden'),pandas={};
   world.traverse(p=>{if(p.userData.actorKey)pandas[p.userData.actorKey]=p;});window.pairedProbe={state,world,pandas,mountedFrame:state.gl.info.render.frame};
   return Object.fromEntries(Object.entries(pandas).map(([id,p])=>[id,{runtime:p.userData.runtime,role:p.userData.roleId,scale:p.scale.x,position:p.position.toArray()}]));
  });
  assert.equal(Object.keys(world).length,32);assert.equal(world['codex:orchestrator'].scale,world.orchestrator.scale);
  assert.equal(world['codex:orchestrator'].position[1],world.orchestrator.position[1]);
  assert.equal(world['codex:runner'].runtime,'codex');assert.equal(world.runner.runtime,'claude');
  if(process.env.RESIDENT_EVIDENCE_DIR)await mkdir(process.env.RESIDENT_EVIDENCE_DIR,{recursive:true});
  for(const colorScheme of ['light','dark']){
   await page.emulateMedia({colorScheme});
   if(process.env.RESIDENT_EVIDENCE_DIR)await page.screenshot({path:process.env.RESIDENT_EVIDENCE_DIR+'/garden-'+colorScheme+'.png',fullPage:true});
  }
  // Use the live scene's own picking handler, as roofs occlude overview ray targets.
  // Model readiness precedes the first mounted actor/proximity frame. Observe that
  // frame explicitly instead of relying on evidence screenshots to yield to it.
  await page.waitForFunction(()=>{const p=window.pairedProbe;return p.pandas['codex:orchestrator']&&typeof p.world.__r3f?.handlers.onClick==='function'&&p.state.gl.info.render.frame>p.mountedFrame;},null,{timeout:15000});
  const drawCalls=await page.evaluate(()=>window.pairedProbe.state.gl.info.render.calls);
  assert.ok(drawCalls>0,'the mounted world submits render calls');
  t.diagnostic(process.env.RESIDENT_EVIDENCE_DIR?'Real WebGL evidence mode: '+drawCalls+' draw calls; captures enabled.':'CI interaction mode: rasterisation skipped; render counters are not pixel evidence.');
  const pickStarted=Date.now();
  await page.evaluate(()=>{const {world,pandas}=window.pairedProbe;world.__r3f.handlers.onClick({object:pandas['codex:orchestrator'],stopPropagation(){}});});
  const card=page.getByRole('region',{name:'Selected panda'});await card.waitFor({timeout:15000});assert.match(await card.innerText(),/Jiao/);assert.match(await card.innerText(),/Codex/);assert.match(await card.innerText(),/unavailable/);
  t.diagnostic('Mounted-scene selection visible after '+(Date.now()-pickStarted)+'ms; actor frame observed before pick.');
  assert.equal(await card.locator('button[data-key]:disabled').count(),4);
  for(const key of ['KeyT','KeyR','KeyQ','KeyE'])await page.keyboard.press(key);
  assert.equal(await page.locator('.message-composer,.transcript-panel').count(),0);
  await page.getByRole('button',{name:'Close panda card'}).click();
  await page.locator('[data-rail=team]').click();
  const choices=page.getByRole('list',{name:'Residents and visitors'}).getByRole('button');assert.ok(await choices.count()>=32,'the roster includes the charter roles and their current agents');
  const jiao=page.getByRole('button',{name:/^Jiao, orchestrator, Codex/});await jiao.focus();await page.keyboard.press('Enter');
  const profile=page.locator('.forest-profile');assert.match(await profile.innerText(),/Jiao/);assert.match(await profile.innerText(),/orchestrator · Codex/);assert.match(await profile.innerText(),/Project identity unavailable/);
  assert.equal(await profile.getByRole('button',{name:'Talk to Jiao'}).isDisabled(),true);assert.match(await profile.innerText(),/Codex conversations and tasks are unavailable/);
  assert.ok(await page.locator('.forest-profile img').evaluate(img=>img.complete&&img.naturalWidth===512));
  for(const width of [1440,375])for(const colorScheme of ['light','dark']){
   await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no page overflow at '+width);
   assert.equal(await jiao.getAttribute('aria-pressed'),'true');
   if(width===375)await profile.scrollIntoViewIfNeeded();
   if(process.env.RESIDENT_EVIDENCE_DIR)await page.screenshot({path:process.env.RESIDENT_EVIDENCE_DIR+'/jiao-'+width+'-'+colorScheme+'.png',fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
  if(process.env.RESIDENT_EVIDENCE_DIR){
   // Close-ups use the mounted live world, with its actual geometry and wardrobe.
   // Pause only the test camera while taking the frame; app state is unchanged.
   for(const [id,target,half] of [['coordinators',[0,2,-.6],5],['pass',[0,1,-17.4],8],['steamers',[-20.2,1,-11.9],8],['pantry',[20.2,1,-11.9],8],['front',[21,1,5],8]]){
    await page.evaluate(({target,half})=>{const {state}=window.pairedProbe;state.setFrameloop('never');const c=state.camera;c.position.set(target[0],target[1]+9,target[2]+16);c.lookAt(...target);c.left=-half*1.6;c.right=half*1.6;c.top=half;c.bottom=-half;c.updateProjectionMatrix();c.updateMatrixWorld();state.gl.render(state.scene,c);},{target,half});
    await page.locator('.forest-canvas canvas').screenshot({path:process.env.RESIDENT_EVIDENCE_DIR+'/live-'+id+'.png'});
   }
   await page.evaluate(()=>window.pairedProbe.state.setFrameloop('always'));
  }
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 }finally{await browser?.close();await server?.close();}
});

test('mounted scene and roster keep concurrent runtime tasks and visitors separate',{timeout:90000},async()=>{
 let server,browser;
 try{
  server=await createServer({configFile:'apps/ui/vite.config.mjs',configLoader:'native',server:{port:0,host:'127.0.0.1'},logLevel:'silent'});await server.listen();
  browser=await chromium.launch(buildLaunchOptions());const page=await browser.newPage({viewport:{width:1200,height:900},reducedMotion:'reduce'});await lightenScene(page);
  const writes=[],errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')writes.push(r.url());});
  const snapshot={schema:1,seq:1,tickets:[],frontier:[],usage:null,requests:[],placements:[],agents:[
   {id:'claude-dev',role:'developer',ref:'paired/01',state:'working'},
   {id:'codex-dev',role:'developer',runtime:'codex',ref:'paired/01',state:'working'},
   {id:'codex-visitor',role:'developer',runtime:'codex',ref:'paired/03',state:'waiting_on_user'},
   {id:'foreign',role:'developer',runtime:'codex',projectId:'foreign',ref:'paired/04',state:'working'},
  ]};
  await page.route('**/events',r=>r.fulfill({contentType:'text/event-stream',body:`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`}));await page.route('**/state',r=>r.fulfill({json:snapshot}));await page.route('**/metrics',r=>r.fulfill({json:{throughput:{windows:[]},tokensByRole:{},incidentsByTool:{}}}));await page.route('**/session',r=>r.fulfill({status:404,json:{}}));
  await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>{const b=document.querySelector('.den-entry button');return b&&b.getAttribute('aria-disabled')!=='true';},null,{timeout:60000});
  await page.waitForFunction(async()=>{const f=performance.getEntriesByType('resource').find(r=>r.name.includes('/@react-three_fiber.js'));const {_roots}=await import(f.name);const scene=_roots.get(document.querySelector('canvas')).store.getState().scene,pandas={};scene.traverse(p=>{if(p.userData.actorKey)pandas[p.userData.actorKey]=p;});window.bindingProbe=pandas;return pandas['codex:developer']?.userData.ticketRef==='paired/01';});
  const refs=await page.evaluate(()=>Object.fromEntries(Object.entries(window.bindingProbe).map(([id,p])=>[id,p.userData.ticketRef])));
  assert.equal(Object.keys(refs).length,32);assert.equal(refs.developer,'paired/01');assert.equal(refs['codex:developer'],'paired/01');assert.equal(refs['codex:developer#paired/03'],undefined);assert.ok(!Object.values(refs).includes('paired/04'));
  await page.locator('[data-rail=team]').click();
  await page.getByRole('button',{name:/^The Maker, developer, Codex, current project identity unavailable, Working/}).click();assert.match(await page.locator('.forest-profile').innerText(),/paired\/01/);
  assert.equal(await page.getByRole('button',{name:'Talk to Maker'}).isDisabled(),true);
  await page.getByRole('button',{name:/^The Maker, developer, Codex, current project identity unavailable, visitor on paired\/03/}).click();assert.match(await page.locator('.forest-profile').innerText(),/paired\/03/);
  await page.locator('.forest-profile').getByText('Scene visitor deferred — available in Team',{exact:true}).waitFor();
  await page.getByRole('button',{name:/^The Maker, developer, Claude/}).click();assert.match(await page.locator('.forest-profile').innerText(),/paired\/01/);
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 }finally{await browser?.close();await server?.close();}
});
