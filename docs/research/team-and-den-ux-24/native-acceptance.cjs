const fs=require('node:fs'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/Derek/AppData/Local/Temp/den-cast-23/22-runtime/node_modules/playwright');
const reference=fs.readFileSync(__dirname+'/capture-review.cjs','utf8');
const instrumentation=new Function('return ('+reference.slice(reference.indexOf('function instrumentation()'),reference.indexOf('\nfunction fixture('))+')')();
const output=process.argv[2]||__dirname,url='http://127.0.0.1:4425/',result={states:[],cycles:[],errors:[],requests:[],limitations:['Fixture responses exercise mounted UI, session and bridge-client requests; they do not start real agents or test the installed bridge backend.']};
function track(){
 sessionStorage.setItem('den.session-token','fixture-bao-acceptance');
 const intervals=new Set(),timeouts=new Set(),events=new Set(),contexts=[];
 for(const [set,clear,ids,once]of [['setInterval','clearInterval',intervals,false],['setTimeout','clearTimeout',timeouts,true]]){
  const orig=window[set],stop=window[clear];window[set]=function(fn,delay,...args){let id;id=orig.call(this,typeof fn==='function'?function(...args){if(once)ids.delete(id);return fn(...args);}:fn,delay,...args);ids.add(id);return id;};window[clear]=function(id){ids.delete(id);return stop.call(this,id);};
 }
 const ES=window.EventSource;window.EventSource=class extends ES{constructor(...args){super(...args);events.add(this);}close(){events.delete(this);return super.close();}};
 const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(...args){const gl=get.apply(this,args);if(!gl?.createBuffer||gl.__baoResourceTrack)return gl;gl.__baoResourceTrack=true;const counts={lost:false};contexts.push(counts);
  for(const kind of ['Buffer','Texture','Framebuffer','Renderbuffer','Program','Shader','VertexArray','Sampler','Query']){const create=gl['create'+kind],del=gl['delete'+kind];if(!create||!del)continue;let count=0;const seen=new WeakSet();counts[kind]=0;gl['create'+kind]=function(...args){const obj=create.apply(this,args);if(obj){seen.add(obj);counts[kind]=++count;}return obj;};gl['delete'+kind]=function(obj){if(obj&&seen.delete(obj))counts[kind]=--count;return del.call(this,obj);};}
  this.addEventListener('webglcontextlost',()=>{counts.lost=true;});return gl;};
 window.__baoResourceCounts=()=>({intervals:intervals.size,timeouts:timeouts.size,eventSources:events.size,subscriptions:window.__baoSubscriptions||0,contexts:contexts.map(c=>({...c}))});
}
const snapshot=state=>({schema:1,seq:1,tickets:[],frontier:[],usage:null,requests:[],placements:[],meetings:[],approvals:[],agents:state==='resident'?[]:[
 {id:'bao-main',role:'orchestrator',runtime:'claude',ref:'acceptance/main',state,task:'Host task',capabilities:{send:true,stop:true,approve:true}},
 {id:'bao-visitor',role:'orchestrator',runtime:'claude',ref:'acceptance/visitor',state:'working',task:'Visitor task',capabilities:{send:true,stop:true}},
 {id:'jiao',role:'orchestrator',runtime:'codex',ref:'acceptance/main',state:'working',capabilities:{send:true,approve:true}},
 {id:'foreign',role:'orchestrator',runtime:'claude',projectId:'foreign',ref:'acceptance/main',state:'working'},
]});
async function routes(page,{state='working',baseline=false,fail=false,offline=false}={}){
 const snap=snapshot(state);if(state==='waiting_on_user')snap.approvals=[{id:'permission-own',agentId:'bao-main',tool:'Read',status:'pending'}];
 await page.route('**/*',async route=>{const req=route.request(),u=new URL(req.url()),p=u.pathname;
  if(p==='/den/manifest.json'&&baseline){const response=await route.fetch(),m=await response.json();delete m.assets['characters.bao'];return route.fulfill({json:m});}
  if(p==='/den/models/characters/bao.glb.gz'&&fail)return route.abort();
  if(p==='/den/portraits/bao-jade.webp'&&(fail||baseline))return route.fulfill({status:404,body:''});
  if(p==='/events')return offline?route.abort():route.continue({url:req.url()+'?fixture='+encodeURIComponent(JSON.stringify(snap))});
  if(p==='/state')return offline?route.abort():route.fulfill({json:snap});
  if(p==='/metrics')return route.fulfill({json:{throughput:{windows:[]},tokensByRole:{},incidentsByTool:{}}});
  if(p==='/session')return route.fulfill({json:{ok:true}});
  if(p.startsWith('/conversations/')){if(req.method()==='POST'){const body=req.postDataJSON();result.requests.push({p,body});return route.fulfill({status:202,json:{ok:true,runId:body.runId||'bao-main',messageId:'fixture-message',resumed:false}});}return route.fulfill({json:{entries:[],more:false,before:null}});}
  if(p.startsWith('/agents/'))return route.fulfill({json:{entries:[],more:false,before:null}});
  if(p.startsWith('/api/'))return route.fulfill({status:404,json:{}});
  if(req.method()!=='GET')throw Error('Unexpected fixture write: '+p);
  return route.continue();
 });return snap;
}
const camera=page=>page.evaluate(()=>({target:__cast22Camera.getTarget(),zoom:__cast22Camera.getZoom(),position:__cast22.stage.camera.position.toArray()}));
async function ready(page){await page.waitForFunction(()=>globalThis.__cast22?.stage.camera&&typeof __cast22.den.world.__r3f?.handlers.onClick==='function',null,{timeout:60000});await page.waitForTimeout(1200);}
(async()=>{let browser;const deadline=setTimeout(()=>{console.error('Acceptance deadline');process.exit(2);},480000);
 try{browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-precise-memory-info','--js-flags=--expose-gc']});result.browser=browser.version();result.gpu=(await(await browser.newBrowserCDPSession()).send('SystemInfo.getInfo')).gpu;
  for(const baseline of [true,false])for(const state of ['resident','working','waiting_on_user']){
   const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,reducedMotion:'reduce'});await context.addInitScript(instrumentation);await context.addInitScript(track);const page=await context.newPage();page.on('pageerror',e=>result.errors.push(e.message));await routes(page,{baseline,state});await page.goto(url);await ready(page);
   const before=await camera(page);await page.locator('[data-rail=team]').click();const profile=page.locator('.forest-profile');
   const entry={baseline,state,text:await profile.innerText(),camera:before,buttons:await profile.locator('button').evaluateAll(ns=>ns.map(n=>({text:n.textContent,disabled:n.disabled}))),actors:await page.evaluate(()=>[...__cast22.agents.actors].filter(([k])=>k.includes('orchestrator')).map(([k,a])=>({k,agentId:a.live?.agentId,ref:a.live?.ref,runtime:a.runtime,species:a.panda.model.userData.species||null,position:a.panda.model.position.toArray()})))};
   assert.match(entry.text,state==='resident'?/At home/:state==='working'?/Working/:/Needs you/);
   if(state==='working'){
    await page.getByRole('button',{name:/^Bao, orchestrator, Claude, current project identity unavailable, visitor on acceptance\/visitor/}).click();await profile.getByRole('button',{name:'Talk to Bao',exact:true}).click();await page.locator('.thread-box').fill('Verify own visitor binding.');await page.locator('[data-sheet=side]').getByRole('button',{name:'Send',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.thread-box')?.value==='');
    assert.equal(result.requests.at(-1).body.runId,'bao-visitor');entry.request=result.requests.at(-1);await page.keyboard.press('Escape');
    await page.getByRole('button',{name:/^Jiao, orchestrator, Codex/}).click();assert.equal(await profile.getByRole('button',{name:'Talk to Jiao',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:/^Bao, orchestrator, Claude, current project identity unavailable, Working/}).click();assert.match(await profile.innerText(),/acceptance\/main/);
   }
   await page.keyboard.press('Escape');assert.deepEqual(await camera(page),before);entry.afterCamera=await camera(page);await page.screenshot({path:output+'/'+(baseline?'before':'after')+'-'+state+'.png'});result.states.push(entry);await context.close();
  }
  // Five real React root unmount/mount cycles. Existing component cleanup owns
  // intervals, subscriptions, actors and WebGL disposal; no manual den disposal.
  for(const baseline of [true,false]){const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,reducedMotion:'reduce'});await context.addInitScript(instrumentation);await context.addInitScript(track);const page=await context.newPage();page.on('pageerror',e=>result.errors.push(e.message));await routes(page,{baseline});await page.goto(url);await ready(page);const cdp=await context.newCDPSession(page);
  for(let cycle=1;cycle<=5;cycle++){
   await cdp.send('HeapProfiler.collectGarbage');const loaded=await page.evaluate(()=>({resources:__baoResourceCounts(),actors:__cast22.agents.actors.size,rigs:__cast22.den.pandaRigs.size,renderer:{...__cast22.renderer.info.memory},heap:performance.memory.usedJSHeapSize}));
   await page.evaluate(()=>{__baoUnmount();globalThis.__cast22=null;globalThis.__cast22Camera=null;});await page.waitForTimeout(1600);await cdp.send('HeapProfiler.collectGarbage');const disposed=await page.evaluate(()=>({resources:__baoResourceCounts(),heap:performance.memory.usedJSHeapSize,canvas:document.querySelectorAll('canvas').length}));
   assert.equal(disposed.resources.subscriptions,0);assert.equal(disposed.resources.eventSources,0);assert.equal(disposed.canvas,0);result.cycles.push({baseline,cycle,loaded,disposed});console.log(JSON.stringify({baseline,cycle,loaded:loaded.renderer,disposed:disposed.resources}));
   if(cycle<5){await page.evaluate(()=>__baoMount());await ready(page);}
  }await context.close();}
  for(const mode of ['fallback','offline','error','loading']){
   const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});await context.addInitScript(instrumentation);const page=await context.newPage();await routes(page,{fail:mode==='fallback',offline:mode==='offline'});
   if(mode==='error')await page.route('**/den/manifest.json',r=>r.fulfill({status:503,body:'fixture failure'}));
   if(mode==='loading')await page.route('**/den/manifest.json',async r=>{await new Promise(resolve=>setTimeout(resolve,1800));await r.continue();});
   await page.goto(url);if(mode==='loading')await page.getByText('Preparing Bao, the workspaces and their props.').waitFor();else if(mode==='error')await page.getByRole('alert').filter({hasText:'garden models could not load'}).waitFor();else await ready(page);
   await page.locator('[data-rail=team]').click();const text=await page.locator('.forest-profile').innerText();assert.match(text,/Bao/);const entry={mode,text,body:await page.locator('body').innerText()};if(mode==='fallback'){entry.camera=await camera(page);entry.model=await page.evaluate(()=>{const a=__cast22.agents.actors.get('orchestrator');return {species:a.panda.model.userData.species||null,scale:a.panda.model.scale.x,home:a.panda.model.position.toArray()};});assert.equal(entry.model.species,null);assert.equal(entry.model.scale,1.35);await page.waitForFunction(()=>document.querySelector('.forest-profile img').src.endsWith('/den/portraits/orchestrator.webp'));}result.states.push(entry);await page.screenshot({path:output+'/'+mode+'.png'});await context.close();
  }
  assert.deepEqual(result.errors,[]);
 }finally{clearTimeout(deadline);await browser?.close();fs.writeFileSync(output+'/acceptance-results.json',JSON.stringify(result,null,2));}
 console.log(JSON.stringify({states:result.states.length,cycles:result.cycles.length,requests:result.requests,errors:result.errors}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
