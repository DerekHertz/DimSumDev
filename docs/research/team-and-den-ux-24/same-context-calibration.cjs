// Prepared A/A driver: one browser page and WebGL context throughout all six
// blocks. Running requires fresh quiet-host readiness; preparation does not.
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {validateRow,combinedCpu}=require('./performance-resume.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function loadCollectors(){
 const original=fs.readFileSync(__dirname+'/native-performance.cjs','utf8'),reference=fs.readFileSync(__dirname+'/capture-review.cjs','utf8');
 const start=original.indexOf('let source=reference'),end=original.indexOf('const fixture=');assert.ok(start>0&&end>start,'Known unchanged collector seam');
 const instrumentation=new Function('reference',original.slice(start,end)+'return instrumentation;')(reference);
 const fixture=new Function('return ('+reference.slice(reference.indexOf('function fixture('),reference.indexOf('\n(async()=>{'))+')')();
 return {instrumentation,fixture};
}
async function runBlocks(plan,ops){for(const block of plan.blocks){await ops.switchBody(block);await ops.warm(plan.warmupMs);await ops.sample(plan.sampleMs);await ops.drain();const row=await ops.read(block);ops.persist(row);ops.validate(row);}}
const q=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*p)-1];
const difference=(A,B)=>({A,B,percent:100*(B/A-1),absoluteWithinFivePercent:Math.abs(100*(B/A-1))<=5});
function summarizeCalibration(rows){
 assert.equal(rows.length,6);const labels=['A','B','B','A','A','B'];
 const evaluated=rows.map((row,i)=>{assert.equal(row.label,labels[i]);assert.equal(row.rep,Math.floor(i/2)+1);validateRow(row);return {label:row.label,rep:row.rep,gpu:q(row.gpuMs,.95),combinedCpu:q(combinedCpu(row),.95)};});
 const medianOfThree=Object.fromEntries(['gpu','combinedCpu'].map(key=>[key,difference(q(evaluated.filter(r=>r.label==='A').map(r=>r[key]),.5),q(evaluated.filter(r=>r.label==='B').map(r=>r[key]),.5))]));
 const pairs=[1,2,3].map(rep=>{const runs=evaluated.filter(r=>r.rep===rep),a=runs.find(r=>r.label==='A'),b=runs.find(r=>r.label==='B');return {rep,order:runs.map(r=>r.label),gpu:difference(a.gpu,b.gpu),combinedCpu:difference(a.combinedCpu,b.combinedCpu)};});
 const allMedianWithinFivePercent=Object.values(medianOfThree).every(r=>r.absoluteWithinFivePercent),allPairedRepeatabilityWithinFivePercent=pairs.every(p=>p.gpu.absoluteWithinFivePercent&&p.combinedCpu.absoluteWithinFivePercent);
 return {kind:'A/A calibration only',runs:evaluated,medianOfThree,pairs,allMedianWithinFivePercent,allPairedRepeatabilityWithinFivePercent,pairedGuardIsDiagnosticOnly:true,calibrationPass:allMedianWithinFivePercent&&allPairedRepeatabilityWithinFivePercent,acceptanceVerdict:'Original failed60 remains failed; this calibration cannot accept Bao'};
}
async function prepare(output){
 assert.ok(output&&!fs.existsSync(output),'Explicit new output directory required');
 const {calibrationPlan}=await import('./same-context-observer.mjs');const plan={...calibrationPlan(),recordedAt:new Date().toISOString(),overallBoundMs:420000,files:{}};
 fs.mkdirSync(output,{recursive:true});for(const file of ['same-context-calibration.cjs','native-performance.cjs','capture-review.cjs','performance-resume.cjs']){const bytes=fs.readFileSync(__dirname+'/'+file);plan.files[file]=hash(bytes);fs.writeFileSync(output+'/'+file,bytes);}
 fs.writeFileSync(output+'/calibration-plan.json',JSON.stringify(plan,null,2)+'\n');return plan;
}
async function run(output){
 assert.ok(process.argv.includes('--ready-confirmed'),'Fresh user quiet-host readiness is required before timing');
 const plan=JSON.parse(fs.readFileSync(output+'/calibration-plan.json'));
 for(const [file,sha]of Object.entries(plan.files))assert.equal(hash(fs.readFileSync(__dirname+'/'+file)),sha,'Frozen harness '+file);
 assert.deepEqual(plan.blocks.map(b=>[b.label,b.body]),[['A','original'],['B','original'],['B','original'],['A','original'],['A','original'],['B','original']]);assert.equal(plan.warmupMs,10000);assert.equal(plan.sampleMs,30000);assert.equal(plan.overallBoundMs,420000);
 const result={schema:1,kind:'Same-context original/original calibration ONLY',startedAt:new Date().toISOString(),plan,scenarios:[],errors:[],writes:[]},rawFile=output+'/calibration-raw.json';assert.ok(!fs.existsSync(rawFile),'Refuse overwrite/retry');
 const save=()=>fs.writeFileSync(rawFile,JSON.stringify(result)),{instrumentation,fixture}=loadCollectors();let browser,poll;
 let rejectDeadline;const expired=new Promise((_,reject)=>{rejectDeadline=reject;});
 const deadline=setTimeout(()=>rejectDeadline(Error('420000ms calibration deadline')),420000);
 try{await Promise.race([expired,(async()=>{
  const {chromium}=require('C:/Users/Derek/AppData/Local/Temp/den-cast-23/22-runtime/node_modules/playwright');browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-precise-memory-info']});result.browser=browser.version();result.nativeNode=process.version;result.gpu=(await(await browser.newBrowserCDPSession()).send('SystemInfo.getInfo')).gpu;
  const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,colorScheme:'light',reducedMotion:'no-preference'});await context.addInitScript(instrumentation);const page=await context.newPage(),snapshot=fixture(true,true);
  page.on('pageerror',e=>result.errors.push(e.message));await page.route('**/*',async route=>{const req=route.request(),u=new URL(req.url()),p=u.pathname;if(req.method()!=='GET'){result.writes.push({method:req.method(),path:p});return route.abort();}if(p==='/events')return route.continue({url:req.url()+'?fixture='+encodeURIComponent(JSON.stringify(snapshot))});if(p==='/state')return route.fulfill({json:snapshot});if(p==='/metrics')return route.fulfill({json:{throughput:{windows:[]},tokensByRole:{},incidentsByTool:{}}});if(p==='/session'||p.startsWith('/api/'))return route.fulfill({status:404,json:{}});return route.continue();});
  await page.goto('http://127.0.0.1:4425/',{waitUntil:'load',timeout:45000});await page.waitForFunction(()=>globalThis.__cast22?.stage.camera&&__cast22.agents.actors.size===42,null,{timeout:60000});
  result.meta=await page.evaluate(()=>fetch('/__meta').then(r=>r.json()));assert.equal(result.meta.kind,'Temporary same-context feasibility observer; not normal resource acceptance');
  // Warm both shader/material paths in this context, outside timing. Keep the
  // logical scene clock continuous. Only original is active for all six blocks.
  await page.waitForTimeout(1000);await page.evaluate(()=>{const p=__cast22,o=p.den.__bao24Observer;o.assertHostOnlyCoverage();p.__calibrationContext=p.renderer.getContext();p.__calibrationCamera=p.stage.camera;});
  const cdp=await context.newCDPSession(page);let before,clocks=[];
  const clock=()=>({at:new Date().toISOString(),csv:execFileSync('C:/Windows/System32/nvidia-smi.exe',['--query-gpu=timestamp,pstate,clocks.current.graphics,clocks.current.memory,power.draw,temperature.gpu,utilization.gpu,utilization.memory','--format=csv,noheader,nounits'],{encoding:'utf8',timeout:5000}).trim()});
  await runBlocks(plan,{
   switchBody:async block=>{before=await page.evaluate(body=>{const p=__cast22;assertNotCollecting();function assertNotCollecting(){if(p.collect||p.pending.length)throw Error('Switch while collecting/pending');}return p.den.__bao24Observer.switchTo(body);},block.body);await cdp.send('HeapProfiler.collectGarbage');},
   warm:ms=>page.waitForTimeout(ms),
   sample:async ms=>{clocks=[clock()];poll=setInterval(()=>clocks.push(clock()),5000);try{await page.evaluate(()=>{const p=__cast22;p.records=[];p.gpu=[];p.anim=[];p.disjoint=0;p.den.__bao24Observer.setCollecting(true);p.collect=true;});await page.waitForTimeout(ms);}finally{await page.evaluate(()=>{__cast22.collect=false;__cast22.den.__bao24Observer.setCollecting(false);});clearInterval(poll);poll=null;clocks.push(clock());}},
   drain:async()=>{await page.waitForTimeout(250);await cdp.send('HeapProfiler.collectGarbage');},
   read:async block=>{const row=await page.evaluate(()=>{const p=__cast22,o=p.den.__bao24Observer,gl=p.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');const camera=p.stage.camera;camera.updateMatrixWorld(true);return {ownership:o.snapshot(),sameWebGLContext:gl===p.__calibrationContext,sameCamera:camera===p.__calibrationCamera,actorCount:p.agents.actors.size,visitors:[...p.agents.actors.values()].filter(a=>a.visitor).length,meetingGuests:[...p.agents.actors.values()].filter(a=>a.guest).length,bao:p.den.characterLoad,baoSpecies:p.agents.actors.get('orchestrator').panda.model.userData.species??null,scene:p.weigh(p.scene),garden:p.weigh(p.den.garden.root),records:p.records,gpuMs:p.gpu,animationCpu:p.anim,disjoint:p.disjoint,pendingQueries:p.pending.length,heap:{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize},camera:{type:camera.type,position:camera.position.toArray(),matrixWorld:camera.matrixWorld.toArray(),projection:camera.projectionMatrix.toArray(),target:__cast22Camera.getTarget(),zoom:__cast22Camera.getZoom(),drawingBuffer:{width:p.renderer.domElement.width,height:p.renderer.domElement.height}},renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,css:{width:p.renderer.domElement.clientWidth,height:p.renderer.domElement.clientHeight}};});return {...row,label:block.label,rep:block.pair,baseline:true,name:'meeting-light',theme:'light',reducedMotion:false,walkMode:false,clocks,before};},
   persist:row=>{result.scenarios.push(row);save();},
   validate:row=>{validateRow(row);assert.equal(row.sameWebGLContext,true);assert.equal(row.sameCamera,true);assert.equal(row.visitors,4);assert.equal(row.meetingGuests,6);assert.equal(row.ownership.active,'original');assert.equal(row.ownership.activeBodyRoots,1);assert.equal(row.ownership.activeSkeletons,1);assert.equal(row.ownership.parkedAttached,false);assert.equal(row.ownership.parkedVisible,false);assert.equal(row.ownership.baoRepresentations.length,1);assert.deepEqual(row.ownership.updates.selected,row.before.updates.selected,'parked rig received updates');assert.deepEqual(row.camera,result.scenarios[0].camera);assert.deepEqual(result.errors,[]);assert.deepEqual(result.writes,[]);console.log(JSON.stringify({rep:row.rep,label:row.label,frames:row.records.length,queries:row.gpuMs.length,originalActive:true}));},
  });
  result.finishedAt=new Date().toISOString();result.summary=summarizeCalibration(result.scenarios);save();console.log(JSON.stringify(result.summary));
 })()]);
 }catch(error){result.failure=error.stack;save();throw error;}finally{if(poll)clearInterval(poll);clearTimeout(deadline);await browser?.close();save();}
}
module.exports={loadCollectors,runBlocks,summarizeCalibration,prepare};
if(require.main===module)(process.argv[2]==='--prepare'?prepare(process.argv[3]):run(process.argv[2])).then(value=>{if(value)console.log(JSON.stringify(value));}).catch(e=>{console.error(e.stack);process.exitCode=1;});
