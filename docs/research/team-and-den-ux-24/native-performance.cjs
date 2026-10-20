const fs=require('node:fs'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const {chromium}=require('C:/Users/Derek/AppData/Local/Temp/den-cast-23/22-runtime/node_modules/playwright');
const reference=fs.readFileSync(__dirname+'/capture-review.cjs','utf8');
let source=reference.slice(reference.indexOf('function instrumentation()'),reference.indexOf('\nfunction fixture('));
source=source.replace('p.anim.push({key,ms:performance.now()-t})','p.anim.push({key,at:t,ms:performance.now()-t})').replace('if(!gl.getParameter(ext.GPU_DISJOINT_EXT))p.gpu.push(gl.getQueryParameter(next,gl.QUERY_RESULT)/1e6);','if(!gl.getParameter(ext.GPU_DISJOINT_EXT))p.gpu.push(gl.getQueryParameter(next,gl.QUERY_RESULT)/1e6);else p.disjoint=(p.disjoint||0)+1;');
const instrumentation=new Function('return ('+source+')')();
const fixture=new Function('return ('+reference.slice(reference.indexOf('function fixture('),reference.indexOf('\n(async()=>{'))+')')();
const preflight=process.argv.includes('--preflight'),output=process.argv[2]||__dirname,results={schema:1,kind:preflight?'Metadata/layout/hardware preflight; NOT acceptance performance':'Full approved acceptance recipe',recipe:'10 scenarios x 3 repetitions x 10s warmup + 30s sample x original-shipped Bao / selected A; one Chrome, interleaved pairs with alternating order',viewport:{width:1440,height:900},canvas:{width:1384,height:856,reason:'Current04 shell reserves56px rail and44px bar'},dpr:1,frameCap:30,warmupMs:preflight?0:10000,sampleMs:preflight?1000:30000,reps:preflight?1:3,scenarios:[],errors:[],writes:[],startedAt:new Date().toISOString()};
const clock=()=>({at:new Date().toISOString(),csv:execFileSync('C:/Windows/System32/nvidia-smi.exe',['--query-gpu=timestamp,pstate,clocks.current.graphics,clocks.current.memory,power.draw,temperature.gpu','--format=csv,noheader,nounits'],{encoding:'utf8',timeout:5000}).trim()});
const save=()=>fs.writeFileSync(output+(preflight?'/performance-preflight.json':'/performance-raw.json'),JSON.stringify(results));
const cases=[['idle-light',false,false,false,false,'light'],['idle-dark',false,false,false,false,'dark'],['crowded-light',true,false,false,false,'light'],['crowded-dark',true,false,false,false,'dark'],['meeting-light',true,true,false,false,'light'],['meeting-dark',true,true,false,false,'dark'],['walk-light',true,false,true,false,'light'],['walk-dark',true,false,true,false,'dark'],['reduced-light',true,true,false,true,'light'],['reduced-dark',true,true,false,true,'dark']];
(async()=>{let browser;const deadline=setTimeout(()=>{results.failure=preflight?'Overall5-minute preflight deadline':'Overall50-minute deadline';save();console.error(results.failure);process.exit(2);},preflight?300000:3000000);
 try{browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-precise-memory-info']});results.browser=browser.version();results.gpu=(await(await browser.newBrowserCDPSession()).send('SystemInfo.getInfo')).gpu;
  for(let rep=1;rep<=results.reps;rep++)for(const [name,crowded,meeting,walk,reduced,theme]of cases)for(const baseline of rep%2?[true,false]:[false,true]){
   const context=await browser.newContext({viewport:results.viewport,deviceScaleFactor:1,colorScheme:theme,reducedMotion:reduced?'reduce':'no-preference'});await context.addInitScript(instrumentation);const page=await context.newPage(),snapshot=fixture(crowded,meeting);
   await page.route('**/*',async route=>{const req=route.request(),u=new URL(req.url()),p=u.pathname;
    if(req.method()!=='GET'){results.writes.push({method:req.method(),path:p});return route.abort();}
    if(p==='/den/manifest.json'&&baseline){const response=await route.fetch(),m=await response.json();delete m.assets['characters.bao'];return route.fulfill({json:m});}
    if(p==='/den/portraits/bao-jade.webp'&&baseline){const response=await page.request.get('http://127.0.0.1:4425/den/portraits/orchestrator.webp');return route.fulfill({response});}
    if(p==='/events')return route.continue({url:req.url()+'?fixture='+encodeURIComponent(JSON.stringify(snapshot))});
    if(p==='/state')return route.fulfill({json:snapshot});
    if(p==='/metrics')return route.fulfill({json:{throughput:{windows:[]},tokensByRole:{},incidentsByTool:{}}});
    if(p==='/session'||p.startsWith('/api/'))return route.fulfill({status:404,json:{}});
    return route.continue();});
   page.on('pageerror',e=>results.errors.push({name,rep,baseline,message:e.message}));await page.goto('http://127.0.0.1:4425/',{waitUntil:'load',timeout:45000});
   if(!results.meta)results.meta=await page.evaluate(()=>fetch('/__meta').then(r=>r.json()));
   await page.waitForFunction(()=>globalThis.__cast22?.stage.camera,null,{timeout:60000});
   await page.waitForFunction(()=>{const p=__cast22,n=p.agents.actors.size;if(n&&n===p._last)p._stable=(p._stable||0)+1;else{p._stable=0;p._last=n;}return n>0&&p._stable>20;},null,{timeout:20000,polling:50});
   if(walk){await page.getByRole('button',{name:'Enter the den',exact:true}).click();await page.waitForTimeout(500);}
   const cdp=await context.newCDPSession(page);await cdp.send('HeapProfiler.collectGarbage');await page.waitForTimeout(results.warmupMs);
   const clocks=[clock()],poll=setInterval(()=>clocks.push(clock()),5000);
   try{if(walk)await page.keyboard.down('KeyW');await page.evaluate(()=>{const p=__cast22;p.records=[];p.gpu=[];p.anim=[];p.disjoint=0;p.collect=true;});await page.waitForTimeout(results.sampleMs);if(walk)await page.keyboard.up('KeyW');await page.evaluate(()=>__cast22.collect=false);}finally{clearInterval(poll);clocks.push(clock());}
   await page.waitForTimeout(250);await cdp.send('HeapProfiler.collectGarbage');
   const item=await page.evaluate(()=>{const p=__cast22,gl=p.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');return {actorCount:p.agents.actors.size,visitors:[...p.agents.actors.values()].filter(a=>a.visitor).length,meetingGuests:[...p.agents.actors.values()].filter(a=>a.guest).length,bao:p.den.characterLoad,baoSpecies:p.agents.actors.get('orchestrator').panda.model.userData.species||null,scene:p.weigh(p.scene),residents:p.weigh(p.den.residents),garden:p.weigh(p.den.garden.root),records:p.records,gpuMs:p.gpu,animationCpu:p.anim,disjoint:p.disjoint,pendingQueries:p.pending.length,heap:{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize},camera:{type:p.stage.camera.type,position:p.stage.camera.position.toArray(),target:__cast22Camera.getTarget(),zoom:__cast22Camera.getZoom(),drawingBuffer:{width:p.renderer.domElement.width,height:p.renderer.domElement.height}},renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,css:{width:p.renderer.domElement.clientWidth,height:p.renderer.domElement.clientHeight}};});
   Object.assign(item,{name,rep,baseline,theme,reducedMotion:reduced,walkMode:walk,inputAgents:snapshot.agents.length,clocks});
   results.scenarios.push(item);save();
   assert.match(item.renderer,/NVIDIA.*3060 Ti/);assert.ok(item.records.length>(preflight?15:800),preflight?'real draw preflight':'full real draw sample');assert.ok(item.gpuMs.length>(preflight?3:250),'hardware timer samples');assert.equal(item.disjoint,0,'disjoint GPU samples invalidate comparison');assert.equal(item.baoSpecies,baseline?null:'giant-panda');assert.equal(item.bao.failed.length,0,'baseline must not use a failed-load path');assert.equal(item.camera.drawingBuffer.width,results.canvas.width);assert.equal(item.camera.drawingBuffer.height,results.canvas.height);assert.deepEqual(item.css,results.canvas&&{width:1384,height:856});assert.equal(item.actorCount,meeting?42:crowded?36:32,'current fixture count');
   console.log(JSON.stringify({preflight,rep,name,baseline,frames:item.records.length,gpuSamples:item.gpuMs.length,actors:item.actorCount,heap:item.heap.used,clocks:clocks.map(c=>c.csv)}));
   await page.screenshot({path:output+'/perf-'+(baseline?'before':'after')+'-'+name+'-'+rep+'.png'});await context.close();
  }
  assert.deepEqual(results.errors,[]);assert.deepEqual(results.writes,[]);results.finishedAt=new Date().toISOString();
 }catch(e){results.failure=e.stack;throw e;}finally{clearTimeout(deadline);await browser?.close();save();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
