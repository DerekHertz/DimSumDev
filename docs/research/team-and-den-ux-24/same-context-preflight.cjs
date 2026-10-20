// One functional browser preflight only. Never collects GPU/CPU samples.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/Derek/AppData/Local/Temp/den-cast-23/22-runtime/node_modules/playwright');
const reference=fs.readFileSync(__dirname+'/capture-review.cjs','utf8');
const instrumentation=new Function('return ('+reference.slice(reference.indexOf('function instrumentation()'),reference.indexOf('\nfunction fixture('))+')')();
const fixture=new Function('return ('+reference.slice(reference.indexOf('function fixture('),reference.indexOf('\n(async()=>{'))+')')();
const output=process.argv[2],result={kind:'Functional ownership preflight ONLY; no performance samples or verdict',deadlineMs:110000,errors:[],writes:[],startedAt:new Date().toISOString()};
assert.ok(output&&fs.existsSync(output),'Explicit precreated output directory required');
const save=()=>fs.writeFileSync(output+'/functional-preflight.json',JSON.stringify(result,null,2)+'\n');
(async()=>{let browser;const deadline=setTimeout(()=>{result.failure='Functional preflight110000ms deadline';save();browser?.close().finally(()=>process.exit(2));},110000);
 try{
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-precise-memory-info']});result.browser=browser.version();
  const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,colorScheme:'light',reducedMotion:'no-preference'});await context.addInitScript(instrumentation);
  const page=await context.newPage(),snapshot=fixture(true,true);
  page.on('pageerror',e=>result.errors.push(e.message));
  await page.route('**/*',async route=>{const req=route.request(),u=new URL(req.url()),p=u.pathname;if(req.method()!=='GET'){result.writes.push({method:req.method(),path:p});return route.abort();}
   if(p==='/events')return route.continue({url:req.url()+'?fixture='+encodeURIComponent(JSON.stringify(snapshot))});
   if(p==='/state')return route.fulfill({json:snapshot});if(p==='/metrics')return route.fulfill({json:{throughput:{windows:[]},tokensByRole:{},incidentsByTool:{}}});if(p==='/session'||p.startsWith('/api/'))return route.fulfill({status:404,json:{}});return route.continue();});
  await page.goto('http://127.0.0.1:4425/',{waitUntil:'load',timeout:45000});await page.waitForFunction(()=>globalThis.__cast22?.stage.camera&&__cast22.agents.actors.size===42,null,{timeout:45000});
  result.meta=await page.evaluate(()=>fetch('/__meta').then(r=>r.json()));
  result.setup=await page.evaluate(()=>{
   const p=__cast22,o=p.den.__bao24Observer,gl=p.renderer.getContext();o.assertHostOnlyCoverage();
   const resources=new Map(),rigDispose={original:0,selected:0},resourceDisposals=[];
   for(const [model,entry]of p.den.pandaRigs)if(model.userData.roleId==='orchestrator'&&model.userData.runtime==='claude'){
    const kind=model.userData.species==='giant-panda'?'selected':'original',dispose=entry.rig.dispose;
    entry.rig.dispose=function(...args){rigDispose[kind]++;return dispose.apply(this,args);};
    model.traverse(n=>{if(!n.isMesh)return;for(const v of [n.geometry,...(Array.isArray(n.material)?n.material:[n.material])]){resources.set(v.uuid,v);if(v.isMaterial)for(const t of Object.values(v))if(t?.isTexture)resources.set(t.uuid,t);}});
   }
   for(const v of resources.values())v.addEventListener('dispose',()=>resourceDisposals.push({uuid:v.uuid,type:v.type??v.constructor.name}));
   const camera=p.stage.camera;camera.updateMatrixWorld(true);
   p.__functional={gl,camera,rigDispose,resourceDisposals};
   return {observer:o.snapshot(),bodyEntries:Object.keys(rigDispose),trackedResources:resources.size,camera:{matrixWorld:camera.matrixWorld.toArray(),projection:camera.projectionMatrix.toArray()},canvas:{width:p.renderer.domElement.width,height:p.renderer.domElement.height},counts:{actors:p.agents.actors.size,visitors:[...p.agents.actors.values()].filter(a=>a.visitor).length,guests:[...p.agents.actors.values()].filter(a=>a.guest).length}};
  });
  result.switches=[];
  // Exercise a real switch, both A/A labels through the same entry point,
  // then restore selected. Short frame ownership probes are not timing blocks.
  for(const [label,body]of [['real-original','original'],['null-A','original'],['null-B','original'],['real-selected','selected']]){
   const before=await page.evaluate(body=>__cast22.den.__bao24Observer.switchTo(body),body);
   await page.waitForTimeout(250);
   const after=await page.evaluate(before=>{const p=__cast22,o=p.den.__bao24Observer;o.assertNoParkedUpdates(before);return {...o.snapshot(),sameWebGLContext:p.__functional.gl===p.renderer.getContext(),sameCamera:p.__functional.camera===p.stage.camera,camera:{matrixWorld:p.stage.camera.matrixWorld.toArray(),projection:p.stage.camera.projectionMatrix.toArray()},rigDispose:p.__functional.rigDispose,resourceDisposals:p.__functional.resourceDisposals,records:p.records.length,gpuQueries:p.gpu.length,pendingQueries:p.pending.length,animationSamples:p.anim.length};},before);
   result.switches.push({label,body,before,after});save();
   assert.equal(after.activeBodyRoots,1);assert.equal(after.activeSkeletons,1);assert.equal(after.parkedAttached,false);assert.equal(after.parkedVisible,false);assert.equal(after.sameWebGLContext,true);assert.equal(after.sameCamera,true);assert.equal(after.actorCount,42);assert.equal(after.baoRepresentations.length,1);
   assert.deepEqual(after.camera,result.setup.camera);assert.deepEqual(after.rigDispose,{original:0,selected:0});assert.deepEqual(after.resourceDisposals,[]);assert.equal(after.records,0);assert.equal(after.gpuQueries,0);assert.equal(after.pendingQueries,0);assert.equal(after.animationSamples,0);assert.ok(after.logicalClock>before.logicalClock);
   assert.ok(after.updates[body].pose>before.updates[body].pose);assert.ok(after.updates[body].skeleton>before.updates[body].skeleton);assert.ok(after.updates[body].gesture>before.updates[body].gesture);
  }
  result.collectionRefusal=await page.evaluate(()=>{const o=__cast22.den.__bao24Observer;o.setCollecting(true);let message;try{o.switchTo('original');}catch(e){message=e.message;}finally{o.setCollecting(false);}return {message,active:o.snapshot().active};});assert.match(result.collectionRefusal.message,/collection-time/);assert.equal(result.collectionRefusal.active,'selected');
  await page.evaluate(()=>__baoUnmount());await page.waitForTimeout(200);
  result.teardown=await page.evaluate(()=>({rigDispose:__cast22.__functional.rigDispose,resourceDisposals:__cast22.__functional.resourceDisposals,actors:__cast22.agents.actors.size,canvases:document.querySelectorAll('canvas').length}));
  assert.deepEqual(result.teardown.rigDispose,{original:1,selected:1});assert.ok(result.teardown.resourceDisposals.length>0);assert.equal(result.teardown.actors,0);assert.equal(result.teardown.canvases,0);assert.deepEqual(result.errors,[]);assert.deepEqual(result.writes,[]);result.finishedAt=new Date().toISOString();
 }catch(error){result.failure=error.stack;throw error;}finally{clearTimeout(deadline);await browser?.close();save();}
 console.log(JSON.stringify({functional:true,switches:result.switches.length,actorCounts:result.setup.counts,rigDisposals:result.teardown.rigDispose,performanceCollected:false}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
