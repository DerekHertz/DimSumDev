// Production App + real live-store, with synthetic normalized bridge observations.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build,preview} from 'vite';
import {chromium} from 'playwright';
import {buildLaunchOptions} from '../../../ci-cd/launch-options.mjs';
import {lightenScene} from '../../../ci-cd/light-scene.mjs';
const run='c-0011223344556642';
const secret='sk-proj-'+ 'A'.repeat(80);
const source=id=>({project:'den',runtime:'claude',role:'orchestrator',runId:run,entryId:id});
const tool=(id,extra={})=>({id,kind:'tool',name:'Read',summary:`inspect safe source ${id}`,status:'running',invocationId:`call-${id}`,source:source(id),...extra});
test('42 production App: real observations, exact/count keyboard inspection, lifecycle, themes, narrow and cleanup',{timeout:180000},async t=>{
 let server,browser,outDir;
 try{
  outDir=await mkdtemp(path.join(tmpdir(),'tool42-production-'));
  const config={configFile:'apps/ui/vite.config.mjs',configLoader:'native',build:{outDir,emptyOutDir:true},logLevel:'silent'};
  await build(config);
  server=await preview({...config,preview:{port:0,host:'127.0.0.1'}});
  browser=await chromium.launch(buildLaunchOptions());
  const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
  await lightenScene(context,{skipDraws:!process.env.TOOL42_EVIDENCE_DIR,frameDelayMs:150});
  const agent={id:run,role:'orchestrator',runtime:'claude',project:'den',state:'working',ref:'fx/42',capabilities:{send:true,stop:true}};
  const snapshot={schema:1,seq:1,tickets:[],frontier:[],placements:[],agents:[agent],approvals:[],meetings:[],usage:null,requests:[],transcripts:{[run]:{entries:[{id:1,kind:'message',role:'user',text:'Synthetic inspection evidence',source:source(1)},tool(2),tool(3)],dropped:0}}};
  for(const [id,role,runtime,ref]of [['developer42','developer','claude','fx/43'],['visitor42','developer','claude','fx/44'],['dragon42','orchestrator','codex','fx/45']]){
   snapshot.agents.push({...agent,id,role,runtime,ref});snapshot.transcripts[id]={entries:[tool(2,{source:{...source(2),runId:id,role,runtime},summary:'Synthetic correlated source inspection'})],dropped:0};
  }
  snapshot.transcripts[run].entries[2]=tool(3,{summary:'Inspect source '+ 'safe '.repeat(7)+secret,input:{command:'Read safe source '+secret}});
  await context.addInitScript(s=>{
   window.tool42streams=new Set();window.tool42closed=0;
   window.EventSource=class{
    constructor(){this.listeners={};window.tool42streams.add(this);setTimeout(()=>{this.onopen?.();this.emit('snapshot',s);},0);}
    addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
    emit(type,value){for(const fn of this.listeners[type]??[])fn({data:JSON.stringify(value)});}
    close(){window.tool42streams.delete(this);window.tool42closed++;}
   };
   window.tool42emit=(type,value)=>{for(const es of window.tool42streams)es.emit(type,value);};
   window.tool42offline=()=>{for(const es of window.tool42streams)es.onerror?.();};
  },snapshot);
  const page=await context.newPage(),errors=[],posts=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts.push(r.url());});
  for(const path of ['state','metrics','session','library'])await page.route(`**/${path}`,r=>r.fulfill({json:path==='state'?snapshot:path==='metrics'?{throughput:{windows:[]},tokensByRole:{},incidentsByTool:{}}:path==='library'?{entries:[]}:{}}));
  await page.route('**/conversations/**',r=>r.fulfill({json:{entries:[],more:false,before:0}}));
  await page.goto(server.resolvedUrls.local[0],{timeout:60000});
  await page.waitForFunction(()=>document.querySelector('.den-entry button')?.getAttribute('aria-disabled')===null,null,{timeout:60000});
  const bubble=page.locator('.tool-bubble').first();await bubble.waitFor({state:'attached'});
  assert.match(await bubble.getAttribute('aria-label'),/2 active tool calls/);
  assert.equal(await bubble.getAttribute('title'),null);
  assert.equal((await bubble.evaluate(el=>el.outerHTML)).includes(secret.slice(0,12)),false);
  // Overview count is inspectable; closer view uses the safe text preview.
  await page.getByRole('button',{name:'1 · Den',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.tool-bubble')?.dataset.compact==='true');
  if(process.env.TOOL42_EVIDENCE_DIR){await mkdir(process.env.TOOL42_EVIDENCE_DIR,{recursive:true});for(const colorScheme of ['light','dark']){await page.emulateMedia({colorScheme});await page.screenshot({path:`${process.env.TOOL42_EVIDENCE_DIR}/far-${colorScheme}.png`});}}
  await page.getByRole('button',{name:'3 · Panda',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.tool-bubble')?.dataset.compact==='false');
  if(process.env.TOOL42_EVIDENCE_DIR)for(const colorScheme of ['light','dark']){await page.emulateMedia({colorScheme});await page.screenshot({path:`${process.env.TOOL42_EVIDENCE_DIR}/near-${colorScheme}.png`});}
  const before=await bubble.evaluate(el=>[el.style.left,el.style.top]);
  await bubble.focus();await page.keyboard.press('Enter');
  const panel=page.locator('[data-sheet=side]');await panel.waitFor();
  assert.equal(await panel.locator('.transcript-tool-head[aria-expanded=true]').count(),2);
  assert.equal(await panel.locator('[aria-current=location]').getAttribute('data-source'),JSON.stringify(['den','claude','orchestrator',run,3]));
  assert.equal(await panel.locator('[aria-current=location]').evaluate(el=>el===document.activeElement),true);
  assert.equal((await panel.evaluate(el=>el.outerHTML)).includes(secret.slice(0,12)),false);
  assert.equal((await panel.ariaSnapshot()).includes(secret.slice(0,12)),false);
  await panel.getByRole('button',{name:'Call 2',exact:true}).click();
  assert.equal(await panel.locator('[aria-current=location]').getAttribute('data-source'),JSON.stringify(['den','claude','orchestrator',run,2]));
  assert.deepEqual(await bubble.evaluate(el=>[el.style.left,el.style.top]),before);
  if(process.env.TOOL42_EVIDENCE_DIR)for(const colorScheme of ['light','dark']){await page.emulateMedia({colorScheme});await page.screenshot({path:`${process.env.TOOL42_EVIDENCE_DIR}/near-inspection-${colorScheme}.png`});}
  // Team is an accessible alternative and keeps its topic beside the same conversation.
  await page.getByRole('button',{name:'Close conversation',exact:true}).click();
  await page.locator('[data-rail=team]').click();
  await page.locator('.forest-profile').getByRole('button',{name:'Inspect 2 active tool calls',exact:true}).click();
  assert.equal(await page.locator('[data-sheet=topic]').count(),1);assert.equal(await page.locator('[data-sheet=side]').count(),1);
  for(const colorScheme of ['light','dark']){await page.setViewportSize({width:390,height:844});await page.emulateMedia({colorScheme});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);if(process.env.TOOL42_EVIDENCE_DIR)await page.screenshot({path:`${process.env.TOOL42_EVIDENCE_DIR}/narrow-${colorScheme}.png`});}
  // Actual SSE terminal frames update live assertions immediately without a dwell timer.
  await page.evaluate(e=>window.tool42emit('change',e),{seq:2,type:'transcript',agentId:run,entry:tool(3,{status:'failed'})});
  await page.waitForFunction(()=>document.querySelector('.tool-bubble')?.getAttribute('aria-label').includes('1 active tool call'));
  await page.evaluate(()=>window.tool42offline());await page.waitForFunction(()=>document.querySelectorAll('.tool-bubble').length===0);
  await page.evaluate(s=>window.tool42emit('snapshot',s),{...snapshot,seq:3,transcripts:{[run]:{entries:[tool(2,{status:'ended'}),tool(3,{status:'failed'})]}}});
  assert.equal(await page.locator('.tool-bubble').count(),0);
  // The real scene seats a busy role's meeting run on meeting:developer. The
  // production bubble must join that guest's actual anchor and inspect its run.
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('button',{name:'Close conversation',exact:true}).click();
  await page.locator('[data-rail=team]').click();
  const guestRun='c-0011223344556643',guestSource={project:'den',runtime:'claude',role:'developer',runId:guestRun,entryId:7};
  const busy=snapshot.agents.find(a=>a.id==='developer42'),guest={...busy,id:guestRun,ref:'fx/46'};
  const guestSnapshot={...snapshot,seq:4,agents:[busy,guest],meetings:[{id:'meeting42',ref:guest.ref,state:'running',startedAt:'2026-10-20T01:00:00Z',seats:[{role:'developer',status:'waiting'}],live:{role:'developer'}}],transcripts:{
   [busy.id]:snapshot.transcripts[busy.id],
   [guestRun]:{entries:[tool(7,{source:guestSource,invocationId:'guest-own-call42',summary:'Guest42 own source'})],dropped:0},
  }};
  // Owned admission may leave the guest at its fitting home while its seat
  // route is unavailable. Inspect its actual anchor in the garden overview.
  await page.getByRole('button',{name:'1 · Den',exact:true}).click();
  await page.evaluate(s=>window.tool42emit('snapshot',s),guestSnapshot);
  const guestBubble=page.getByRole('button',{name:'Inspect 1 active tool call for developer: Read · Guest42 own source',exact:true});
  await guestBubble.waitFor({state:'visible'});
  await guestBubble.focus();assert.equal(await guestBubble.evaluate(el=>el===document.activeElement),true,'guest tool action receives native keyboard focus');await page.keyboard.press('Enter');
  await page.locator('[data-sheet=side] [aria-current=location]').waitFor();
  assert.equal(await page.locator('[data-sheet=side] [aria-current=location]').getAttribute('data-source'),JSON.stringify(['den','claude','developer',guestRun,7]));
  assert.equal(await page.locator('[data-sheet=side] .transcript-tool-head[aria-expanded=true]').count(),1);
  if(process.env.TOOL42_EVIDENCE_DIR)for(const colorScheme of ['light','dark']){await page.emulateMedia({colorScheme});await page.screenshot({path:`${process.env.TOOL42_EVIDENCE_DIR}/guest-inspection-${colorScheme}.png`});}
  assert.deepEqual(errors,[]);assert.deepEqual(posts,[]);assert.equal(await page.evaluate(()=>window.tool42streams.size),1);
  t.diagnostic(process.env.TOOL42_EVIDENCE_DIR?'Production WebGL captures with synthetic correlated observations; actual assets rendered.':'Production App interactions, rasterization omitted; no pixel evidence claimed.');
  await context.close();
 }finally{await browser?.close();await new Promise(resolve=>server?.httpServer.close(resolve)??resolve());if(outDir)await rm(outDir,{recursive:true,force:true});}
});
