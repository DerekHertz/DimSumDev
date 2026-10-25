import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {buildLaunchOptions} from '../../../ci-cd/launch-options.mjs';
import {lightenScene} from '../../../ci-cd/light-scene.mjs';

const ROLES=['code-reviewer','release-manager','sre','technical-writer'];
const quiet={schema:1,seq:1,tickets:[],frontier:[],usage:null,requests:[],agents:[],placements:[],meetings:[]};

test('four charter roles keep real home cards and exact runtime bindings while visitors stay in Team',{timeout:150000},async()=>{
 let server,browser;
 try{
  server=await createServer({configFile:'apps/ui/vite.config.mjs',configLoader:'native',server:{port:0,host:'127.0.0.1'},logLevel:'silent'});await server.listen();
  browser=await chromium.launch(buildLaunchOptions());
  const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'}),errors=[],writes=[];
  await lightenScene(page);page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(!['GET','HEAD'].includes(request.method()))writes.push(request.url());});
  await page.addInitScript(snapshot=>{
   window.EventSource=class{
    constructor(){this.listeners={};window.pushResidents=next=>{for(const fn of this.listeners.snapshot??[])fn({data:JSON.stringify(next)});};setTimeout(()=>{this.onopen?.();window.pushResidents(snapshot);},0);}
    addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
    close(){}
   };
  },quiet);
  await page.route('**/state',route=>route.fulfill({json:quiet}));
  await page.route('**/metrics',route=>route.fulfill({json:{throughput:{windows:[]},tokensByRole:{},incidentsByTool:{}}}));
  await page.route('**/session',route=>route.fulfill({status:404,json:{}}));
  await page.route('**/conversations/**',route=>route.fulfill({json:{entries:[],more:false}}));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(()=>{const button=document.querySelector('.den-entry button');return button&&button.getAttribute('aria-disabled')!=='true';},null,{timeout:60000});
  await page.waitForFunction(async()=>{
   const resource=performance.getEntriesByType('resource').find(row=>row.name.includes('/@react-three_fiber.js'));
   if(!resource)return false;
   const {_roots}=await import(resource.name),state=_roots.get(document.querySelector('canvas')).store.getState();
   const world=state.scene.getObjectByName('Dim Sum Dev · plush bamboo garden');if(!world?.__r3f?.handlers.onClick)return false;
   const pandas={};world.traverse(node=>{if(node.userData.actorKey)pandas[node.userData.actorKey]=node;});window.charterProbe={state,world,pandas,mountedFrame:state.gl.info.render.frame};return Object.keys(pandas).length===24;
  });
  // World readiness precedes walk-controller and proximity initialization.
  // Demand rendering needs an explicit frame request before this readiness gate.
  await page.evaluate(()=>window.charterProbe.state.invalidate());
  await page.waitForFunction(()=>{const probe=window.charterProbe;return probe.state.gl.info.render.frame>probe.mountedFrame;});
  const pick=async id=>{
   await page.evaluate(id=>{const {world,pandas}=window.charterProbe;world.__r3f.handlers.onClick({object:pandas[id],stopPropagation(){}});},id);
   const card=page.getByRole('region',{name:'Selected panda'});await card.waitFor();return card;
  };
  for(const role of ROLES)for(const runtime of ['claude','codex']){
   const id=runtime==='claude'?role:'codex:'+role,card=await pick(id);
   await page.waitForFunction(({role,runtime})=>document.querySelector('.proximity-team')?.textContent.includes(role+' · '+runtime),{role,runtime:runtime==='claude'?'Claude':'Codex'});
   assert.match(await card.innerText(),/Resident · no agent running/);
   assert.equal(await card.locator('button[data-key=T]').isEnabled(),runtime==='claude');
   if(runtime==='claude')assert.match(await card.locator('button[data-key=T]').innerText(),/Start task/);
   await page.getByRole('button',{name:'Close panda card'}).click();
  }
  await page.locator('[data-rail=team]').click();
  const choices=page.getByRole('list',{name:'Residents and visitors'});
  assert.equal(await choices.getByRole('button').count(),24);
  for(const role of ROLES)for(const runtime of ['Claude','Codex']){
   const choice=choices.getByRole('button',{name:new RegExp(', '+role+', '+runtime+',')});await choice.click();
   const profile=page.locator('.forest-profile');assert.match(await profile.innerText(),new RegExp(role+' · '+runtime));
   await profile.locator('img').evaluate(image=>image.decode());
   // team-and-den-ux/23 and 35: each of these roles is a species that shares one portrait across runtimes.
   const species={'code-reviewer':'code-reviewer-lion','release-manager':'release-manager-lucky-cat',sre:'sre-tortoise','technical-writer':'technical-writer-cloud-dragon'};
   assert.equal(await profile.locator('img').getAttribute('src'),'/den/portraits/'+species[role]+'.webp');
  }
  await page.locator('[data-rail=team]').click();
  const agents=ROLES.flatMap(role=>['claude','codex'].map(runtime=>({id:runtime+'-'+role,role,runtime,ref:'charter/01',state:role==='sre'?'blocked':'working',capabilities:{send:true,approve:true}})));
  const visitor={id:'release-visitor',role:'release-manager',runtime:'claude',ref:'charter/02',state:'waiting_on_user',capabilities:{send:true}};
  const foreign={id:'foreign',role:'code-reviewer',runtime:'claude',projectId:'other',ref:'charter/01',state:'working'};
  await page.evaluate(snapshot=>window.pushResidents(snapshot),{...quiet,seq:2,agents:[...agents,visitor,foreign]});
  await page.waitForFunction(()=>{
   const p=window.charterProbe;const pandas={};p.world.traverse(node=>{if(node.userData.actorKey)pandas[node.userData.actorKey]=node;});p.pandas=pandas;
   return pandas['codex:technical-writer']?.userData.ticketRef==='charter/01';
  });
  const refs=await page.evaluate(()=>Object.fromEntries(Object.entries(window.charterProbe.pandas).map(([id,node])=>[id,node.userData.ticketRef??null])));
  assert.equal(Object.keys(refs).length,24);
  for(const role of ROLES){assert.equal(refs[role],'charter/01');assert.equal(refs['codex:'+role],'charter/01');}
  assert.equal(refs.developer,null);assert.equal(refs['codex:developer'],null);assert.equal(Object.hasOwn(refs,'docs-writer'),false,'retired docs-writer has no physical body');
  assert.equal(refs['release-manager#charter/02'],undefined,'deferred visitor has no borrowed scene body');
  for(const role of ROLES){
   const card=await pick(role);await page.waitForFunction(role=>document.querySelector('.proximity-team')?.textContent.includes(role+' · Claude'),role);
   assert.match(await card.innerText(),/charter\/01/);assert.match(await card.innerText(),role==='sre'?/Blocked/:/Working/);
   await card.locator('button[data-key=R]').click();
   await page.locator('.transcript-meta code').filter({hasText:new RegExp('^claude-'+role+'$')}).waitFor();
   await page.keyboard.press('Escape');await page.getByRole('button',{name:'Close panda card'}).click();
  }
  await page.locator('[data-rail=team]').click();
  await page.getByRole('list',{name:'Residents and visitors'}).getByRole('button',{name:/, release-manager, Claude,.*visitor on charter\/02/}).click();
  const visitorCard=page.locator('.forest-profile');assert.match(await visitorCard.innerText(),/Needs you/);assert.match(await visitorCard.innerText(),/charter\/02/);
  await visitorCard.getByText('Scene visitor deferred — available in Team',{exact:true}).waitFor();
  assert.equal(await visitorCard.getByRole('button',{name:/View work/}).isEnabled(),true);
  await page.evaluate(snapshot=>window.pushResidents(snapshot),{...quiet,seq:3,agents:agents.map(agent=>({...agent,state:'done'}))});
  await page.getByRole('list',{name:'Residents and visitors'}).getByRole('button',{name:/visitor on charter\/02/}).waitFor({state:'detached'});
  await page.waitForFunction(()=>window.charterProbe.pandas['release-manager'].userData.ticketRef===undefined);
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 }finally{await browser?.close();await server?.close();}
});
