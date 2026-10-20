const fs=require('node:fs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/Derek/AppData/Local/Temp/den-cast-23/22-runtime/node_modules/playwright');
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
 const output=process.env.OUTPUT||__dirname,port=process.env.PORT||4425,results={kind:'native appearance capture; not a performance acceptance run',viewport:{width:1440,height:900},dpr:1,writes:[],errors:[],captures:[]};
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-precise-memory-info']});
 try{
  results.browser=browser.version();results.gpu=(await (await browser.newBrowserCDPSession()).send('SystemInfo.getInfo')).gpu;
  for(const theme of ['light','dark']){
   const context=await browser.newContext({viewport:results.viewport,deviceScaleFactor:1,colorScheme:theme,reducedMotion:'reduce'});await context.addInitScript(instrumentation);
   const page=await context.newPage(),snapshot=fixture(true,true);
   snapshot.agents.push({id:'bao-main',ref:'bao24/working',role:'orchestrator',runtime:'claude',state:'working',task:'Bao appearance fixture',startedAt:new Date().toISOString()});
   await page.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(req.method()!=='GET'){results.writes.push(u.pathname);return route.abort();}
    if(u.pathname==='/events')return route.fulfill({contentType:'text/event-stream',body:'event: snapshot\ndata: '+JSON.stringify(snapshot)+'\n\n'});
    if(u.pathname==='/state')return route.fulfill({json:snapshot});
    if(u.pathname==='/metrics')return route.fulfill({json:{throughput:{windows:[]},tokensByRole:{},incidentsByTool:{}}});
    if(u.pathname==='/session'||u.pathname.startsWith('/api/'))return route.fulfill({status:404,json:{}});
    return route.continue();});
   page.on('pageerror',e=>results.errors.push({theme,error:e.message}));
   await page.goto('http://127.0.0.1:'+port+'/',{waitUntil:'load',timeout:45000});await page.waitForFunction(()=>globalThis.__cast22?.stage.camera,null,{timeout:60000});await page.waitForTimeout(1500);
   async function shot(name){await page.waitForTimeout(600);const file='den-'+theme+'-'+name+'.png';await page.screenshot({path:output+'/'+file});results.captures.push({theme,name,file,...await page.evaluate(()=>{const p=__cast22;return {meta:null,actorCount:p.agents.actors.size,baoCount:[...p.agents.actors.values()].filter(a=>a.panda.model.userData.species==='giant-panda').length,characterLoad:p.den.characterLoad,camera:{position:p.stage.camera.position.toArray(),zoom:__cast22Camera.getZoom(),target:__cast22Camera.getTarget()},residents:p.weigh(p.den.residents),scene:p.weigh(p.scene)};})});}
   results.meta=await page.evaluate(()=>fetch('/__meta').then(r=>r.json()));
   await shot('far-meeting');
   await page.evaluate(()=>{__cast22Camera.goToLevel(3);__cast22Camera.setTarget([-1.75,1.5,-.6]);});await shot('near-working');
   await page.getByRole('button',{name:'Team',exact:true}).click();await shot('portraits');
   results.portraitSizes=await page.locator('.forest-portrait').evaluateAll(nodes=>nodes.slice(0,4).map(n=>({width:n.clientWidth,height:n.clientHeight,source:n.querySelector('img').getAttribute('src')})));
   await page.getByRole('button',{name:'Close panel',exact:true}).click();
   await page.getByRole('button',{name:'Enter the den',exact:true}).click();
   await page.evaluate(()=>{const e=__cast22.stage.explorer;e.camera.position.set(-1.75,2.1,6.2);e.camera.lookAt(-1.75,1.9,-.6);});await shot('first-person');
   await context.close();
  }
  if(results.errors.length||results.writes.length)throw Error(JSON.stringify({errors:results.errors,writes:results.writes}));
 }finally{await browser.close();fs.writeFileSync(output+'/review-results.json',JSON.stringify(results,null,2));}
 console.log(JSON.stringify({captures:results.captures.length,errors:results.errors,writes:results.writes}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
