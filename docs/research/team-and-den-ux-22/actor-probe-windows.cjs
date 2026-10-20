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

(async()=>{let browser;try{
 browser=await chromium.launch({executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true,timeout:30000});
 const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});await page.addInitScript(instrumentation);const snap=fixture(false,false);
 await page.route('**/events',r=>r.fulfill({contentType:'text/event-stream',body:'event: snapshot\ndata: '+JSON.stringify(snap)+'\n\n'}));
 await page.route('**/state',r=>r.fulfill({json:snap}));await page.route('**/metrics',r=>r.fulfill({json:{throughput:{windows:[]},tokensByRole:{},incidentsByTool:{}}}));await page.route('**/session',r=>r.fulfill({status:404,json:{}}));
 await page.goto('http://127.0.0.1:4422/',{timeout:45000});await page.waitForFunction(()=>globalThis.__cast22,null,{timeout:60000});
 const result=await page.evaluate(()=>{const p=__cast22;
  function envelope(model){const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity],point=model.position.clone();model.updateMatrixWorld(true);model.traverse(n=>{if(!n.isMesh)return;if(n.isSkinnedMesh)n.computeBoundingBox();else if(!n.geometry.boundingBox)n.geometry.computeBoundingBox();const b=n.boundingBox??n.geometry.boundingBox;if(!b)return;for(const x of [b.min.x,b.max.x])for(const y of [b.min.y,b.max.y])for(const z of [b.min.z,b.max.z]){point.set(x,y,z).applyMatrix4(n.matrixWorld);const a=point.toArray();for(let i=0;i<3;i++){min[i]=Math.min(min[i],a[i]);max[i]=Math.max(max[i],a[i]);}}});return {worldMin:min,worldMax:max,size:max.map((v,i)=>v-min[i]),pose:'current idle procedural pose with clothes and tools; not a motion-swept navigation envelope'};}
  return {actors:[...p.agents.actors].map(([id,a])=>({id,role:a.role,runtime:a.runtime,...p.weigh(a.panda.model),envelope:envelope(a.panda.model)})),ambient:p.den.ambient.rigs.map(({rig,spec,place})=>({id:spec.id,place,pose:spec.pose??'idle',...p.weigh(rig.model)}))};});
 fs.writeFileSync(__dirname+'\\22-actor-costs.json',JSON.stringify(result,null,2));console.log(JSON.stringify({actors:result.actors.length,ambient:result.ambient.length,residentTriangles:result.actors.reduce((n,a)=>n+a.triangles,0),ambientTriangles:result.ambient.reduce((n,a)=>n+a.triangles,0)}));
}finally{await browser?.close();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
