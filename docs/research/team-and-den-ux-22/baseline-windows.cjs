const fs=require('node:fs');
const {chromium}=require('./22-runtime/node_modules/playwright');
const output=__dirname+'\\22-baseline-results.json';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function instrumentation(){
 HTMLCanvasElement.prototype.requestPointerLock=undefined;
 globalThis.__cast22Attach=({den,agents,scene,renderer,stage})=>{
  const gl=renderer.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const p={den,agents,scene,renderer,stage,records:[],gpu:[],pending:[],anim:[],collect:false,seq:0};globalThis.__cast22=p;
  for(const [object,key] of [[agents,'update'],[den.ambient,'pose'],[den.garden.assets.tea.koi,'update']]){
   const original=object[key];object[key]=function(...args){const t=performance.now();try{return original.apply(this,args);}finally{if(p.collect)p.anim.push({key,ms:performance.now()-t});}};
  }
  const original=renderer.render;
  renderer.render=function(...args){
   const sample=p.collect&&ext&&p.seq++%3===0,q=sample?gl.createQuery():null;
   if(q)gl.beginQuery(ext.TIME_ELAPSED_EXT,q);
   const t=performance.now();let result;
   try{result=original.apply(this,args);}finally{
    if(q){gl.endQuery(ext.TIME_ELAPSED_EXT);p.pending.push(q);}
    if(p.collect)p.records.push({at:t,cpuMs:performance.now()-t,calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures});
    while(p.pending.length&&gl.getQueryParameter(p.pending[0],gl.QUERY_RESULT_AVAILABLE)){
     const next=p.pending.shift();if(!gl.getParameter(ext.GPU_DISJOINT_EXT))p.gpu.push(gl.getQueryParameter(next,gl.QUERY_RESULT)/1e6);gl.deleteQuery(next);
    }
   }return result;
  };
  p.weigh=(root)=>{
   let triangles=0,shadowTriangles=0,meshes=0,skinned=0;const geometries=new Set(),materials=new Set(),textures=new Map();let geometryBytes=0;
   root.traverse(n=>{if(!n.isMesh)return;meshes++;skinned+=n.isSkinnedMesh?1:0;const g=n.geometry,k=(g.index?.count??g.attributes.position?.count??0)/3;triangles+=k;if(n.castShadow)shadowTriangles+=k;
    if(!geometries.has(g)){geometries.add(g);const arrays=new Set();for(const a of [g.index,...Object.values(g.attributes)]){if(a?.array&&!arrays.has(a.array.buffer)){arrays.add(a.array.buffer);geometryBytes+=a.array.buffer.byteLength;}}}
    for(const m of Array.isArray(n.material)?n.material:[n.material]){materials.add(m);for(const v of Object.values(m)){if(v?.isTexture)textures.set(v.uuid,v);}}
   });
   const images=[...textures.values()].map(t=>({name:t.name,width:t.image?.width??0,height:t.image?.height??0,mipmaps:t.generateMipmaps}));
   return {triangles,shadowTriangles,meshes,skinnedMeshes:skinned,uniqueGeometries:geometries.size,uniqueMaterials:materials.size,geometryBufferBytes:geometryBytes,uniqueMaterialTextures:textures.size,estimatedRgbaTextureBytes:images.reduce((n,t)=>n+t.width*t.height*4*(t.mipmaps?4/3:1),0),textureImages:images};
  };
 };
}
function fixture(crowded,meeting){
 const roles=['developer','qa','security','architect','product','designer'];
 const agents=crowded?roles.map((role,i)=>({id:'baseline-'+i,ref:'baseline/'+String(i+1).padStart(2,'0'),role,runtime:'claude',state:'working',task:'Performance fixture',startedAt:new Date().toISOString()})):[];
 if(crowded)for(let i=0;i<4;i++)agents.push({id:'visitor-'+i,ref:'baseline/'+(20+i),role:i<2?'developer':'qa',runtime:i%2?'codex':'claude',state:'working',task:'Extra visitor fixture',startedAt:new Date().toISOString()});
 // Two extra calls of each same role/runtime produce actual visitor bodies.
 if(crowded)agents.push({id:'visitor-repeat-a',ref:'baseline/30',role:'developer',runtime:'claude',state:'working'},{id:'visitor-repeat-b',ref:'baseline/31',role:'qa',runtime:'claude',state:'working'});
 return {schema:1,seq:1,tickets:[],frontier:[],usage:null,requests:[],approvals:[],agents,placements:[],meetings:meeting?[{id:'baseline-meeting',ref:'baseline/meeting',state:'running',startedAt:new Date().toISOString(),seats:roles.map(role=>({role,status:'waiting'})),live:{role:'developer'}}]:[]};
}
(async()=>{
 let browser;const results={schema:1,measuredAt:new Date().toISOString(),viewport:{width:1440,height:900},deviceScaleFactor:1,warmupMs:4000,sampleMs:12000,frameCap:30,scenarios:[],errors:[],writes:[]};
 const watchdog=setTimeout(()=>{console.error('Baseline runner deadline 300 seconds');process.exit(2);},300000);
 try{
  browser=await chromium.launch({executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true,timeout:30000,args:['--enable-precise-memory-info']});results.browser=browser.version();
  const system=await browser.newBrowserCDPSession();results.gpu=(await system.send('SystemInfo.getInfo')).gpu;
  const cases=[['idle-light',false,false,false,false,'light'],['idle-dark',false,false,false,false,'dark'],['crowded-light',true,false,false,false,'light'],['crowded-dark',true,false,false,false,'dark'],['meeting-light',true,true,false,false,'light'],['meeting-dark',true,true,false,false,'dark'],['walk-light',true,false,true,false,'light'],['walk-dark',true,false,true,false,'dark'],['reduced-light',true,true,false,true,'light'],['reduced-dark',true,true,false,true,'dark']];
  for(const [name,crowded,meeting,walk,reduced,theme] of cases){
   const context=await browser.newContext({viewport:results.viewport,deviceScaleFactor:1,colorScheme:theme,reducedMotion:reduced?'reduce':'no-preference'});
   await context.addInitScript(instrumentation);const page=await context.newPage();const snapshot=fixture(crowded,meeting);
   await page.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(req.method()!=='GET'){results.writes.push({method:req.method(),path:u.pathname});return route.abort();}
    if(u.pathname==='/events')return route.fulfill({contentType:'text/event-stream',body:'event: snapshot\ndata: '+JSON.stringify(snapshot)+'\n\n'});
    if(u.pathname==='/state')return route.fulfill({json:snapshot});
    if(u.pathname==='/metrics')return route.fulfill({json:{throughput:{windows:[]},tokensByRole:{},incidentsByTool:{}}});
    if(u.pathname==='/session')return route.fulfill({status:404,json:{}});
    if(u.pathname.startsWith('/api/'))return route.fulfill({status:404,json:{}});
    return route.continue();});
   page.on('pageerror',e=>results.errors.push({scenario:name,error:e.message}));
   await page.goto('http://127.0.0.1:4422/',{waitUntil:'load',timeout:45000});
   if(!results.meta)results.meta=await page.evaluate(()=>fetch('/__meta').then(r=>r.json()));
   await page.waitForFunction(()=>!!globalThis.__cast22&&!!globalThis.__cast22.stage.camera,null,{timeout:60000});
   await page.waitForFunction(expected=>globalThis.__cast22.agents.actors.size===expected,crowded?(meeting?35:29):25,{timeout:10000});
   if(walk){await page.getByRole('button',{name:'Enter the den',exact:true}).click();await page.waitForTimeout(500);}
   await page.waitForTimeout(results.warmupMs);
   if(walk)await page.keyboard.down('KeyW');
   await page.evaluate(()=>{const p=__cast22;p.records=[];p.gpu=[];p.anim=[];p.collect=true;});
   await page.waitForTimeout(results.sampleMs);
   if(walk)await page.keyboard.up('KeyW');
   const item=await page.evaluate(({name,snapshot})=>{
    const p=__cast22;p.collect=false;const ext=p.renderer.getContext().getExtension('WEBGL_debug_renderer_info'),gl=p.renderer.getContext();
    return {name,inputAgents:snapshot.agents.length,actorCount:p.agents.actors.size,visitors:[...p.agents.actors.values()].filter(a=>a.visitor).length,meetingGuests:[...p.agents.actors.values()].filter(a=>a.guest).length,scene:p.weigh(p.scene),residents:p.weigh(p.den.residents),garden:p.weigh(p.den.garden.root),records:p.records,gpuMs:p.gpu,animationCpu:p.anim,heap:performance.memory?{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize,limit:performance.memory.jsHeapSizeLimit}:null,camera:{type:p.stage.camera.type,position:p.stage.camera.position.toArray(),drawingBuffer:{width:p.renderer.domElement.width,height:p.renderer.domElement.height}},renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,canvasCss:{width:p.renderer.domElement.clientWidth,height:p.renderer.domElement.clientHeight},textureMemoryNote:'RGBA8+mipmap estimate from material texture dimensions, not measured driver VRAM'};
   },{name,snapshot});
   item.theme=theme;item.reducedMotion=reduced;item.walkMode=walk;
   if(!item.records.length||item.records.every(r=>!r.calls))throw Error('No real draw records for '+name);
   if(!/NVIDIA.*3060 Ti/.test(item.renderer))throw Error('Not reference GPU '+item.renderer);
   results.scenarios.push(item);await page.screenshot({path:__dirname+'\\22-'+name+'.png'});
   fs.writeFileSync(output,JSON.stringify(results,null,2));console.log(JSON.stringify({scenario:name,frames:item.records.length,actors:item.actorCount,visitors:item.visitors,meetingGuests:item.meetingGuests,gpuSamples:item.gpuMs.length}));
   await context.close();
  }
 }finally{clearTimeout(watchdog);await browser?.close();fs.writeFileSync(output,JSON.stringify(results,null,2));}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
